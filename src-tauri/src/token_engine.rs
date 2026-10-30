//! Token tracking, pricing, budgets, and reporting.
//!
//! The engine has two modes for recording token usage:
//!
//! 1. **Manual** — the frontend or an IPC command explicitly records a
//!    `TokenEvent`. Useful when the UI parses structured agent output.
//!
//! 2. **PTY interception** — a lightweight scanner looks for known
//!    token-usage patterns in the raw PTY output stream (e.g. Claude
//!    Code's cost summary, API JSON `usage` blocks). This runs on the
//!    reader thread and calls `record()` when it finds a match.
//!
//! The pricing table is in-process for now; Phase 3+ will load it from
//! a user-editable config file.

use crate::db::Db;
use crate::error::AppResult;
use chrono::Utc;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

// ─── Models ───────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TokenEvent {
    pub id: Option<i64>,
    pub session_id: String,
    pub timestamp: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub model: String,
    pub cost_usd: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TokenReport {
    pub total_input: u64,
    pub total_output: u64,
    pub total_cached: u64,
    pub total_cost_usd: f64,
    pub cost_by_session: Vec<CostEntry>,
    pub cost_by_model: Vec<CostEntry>,
    pub hourly_trend: Vec<TrendPoint>,
    pub budget_remaining: Option<u64>,
    pub projected_daily_cost: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CostEntry {
    pub label: String,
    pub cost_usd: f64,
    pub tokens: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrendPoint {
    pub hour: String,
    pub tokens: u64,
    pub cost_usd: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BudgetStatus {
    pub session_id: String,
    pub budget: Option<u64>,
    pub used: u64,
    pub remaining: Option<u64>,
    pub percent_used: Option<f64>,
}

// ─── Pricing ──────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug)]
pub enum TokenType {
    Input,
    Output,
    CacheRead,
    CacheCreation,
}

/// Normalize a raw model id to its base catalog id for pricing lookups.
/// In order, it strips:
/// - a `provider/` path prefix (LiteLLM `bedrock/…`, `anthropic/…`,
///   `ollama/…`; an inference-profile ARN's `…/` too) — everything up to the
///   last `/`;
/// - a cross-region Bedrock prefix (`us.` / `eu.` / `apac.` / `global.` /
///   `jp.` / `au.` / `ca.` / `us-gov.`) in front of `anthropic.`, and the
///   `anthropic.` vendor prefix itself;
/// - a bracketed capability suffix (`claude-opus-4-8[1m]`) and a Vertex
///   `@`-version;
/// - a Bedrock model version (`-v1:0`; a bare `-v1` only on an
///   `anthropic.` id);
/// - an Ollama `:tag` (`qwen2.5-coder:7b`, `llama3.3:latest`);
/// - a trailing dated snapshot (`-YYYYMMDD`).
///
/// Lookups stay exact-match on the result: `us.anthropic.claude-opus-5-5-20261001-v1:0`
/// and `bedrock/us.anthropic.claude-sonnet-5-5-v1:0` price as their base model,
/// while an id that is merely similar does not.
pub fn normalize_model_id(model: &str) -> String {
    let mut m = model.trim();
    if let Some(idx) = m.rfind('/') {
        m = &m[idx + 1..];
    }
    for region in ["us.", "eu.", "apac.", "global.", "jp.", "au.", "ca.", "us-gov."] {
        if let Some(rest) = m.strip_prefix(region) {
            if rest.starts_with("anthropic.") {
                m = rest;
                break;
            }
        }
    }
    let bedrock = m.starts_with("anthropic.");
    if let Some(rest) = m.strip_prefix("anthropic.") {
        m = rest;
    }
    if let Some(idx) = m.find('[') {
        m = &m[..idx];
    }
    if let Some(idx) = m.find('@') {
        m = &m[..idx];
    }
    // Bedrock version: `-v<digits>:<digits>`, or a bare `-v<digits>` on a
    // Bedrock `anthropic.` id (a bare `-v3` elsewhere is part of the name —
    // `deepseek-v3`).
    if let Some(idx) = m.rfind("-v") {
        let ver = &m[idx + 2..];
        let (major, minor) = match ver.split_once(':') {
            Some((a, b)) => (a, Some(b)),
            None => (ver, None),
        };
        let digits = |s: &str| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit());
        let versioned = match minor {
            Some(minor) => digits(major) && digits(minor),
            None => bedrock && digits(major),
        };
        if versioned {
            m = &m[..idx];
        }
    }
    // Ollama tag.
    if let Some(idx) = m.find(':') {
        m = &m[..idx];
    }
    // Trailing `-YYYYMMDD` (dash + exactly 8 digits at the very end).
    if m.len() > 9 {
        let tail = &m[m.len() - 9..];
        if tail.starts_with('-') && tail[1..].bytes().all(|c| c.is_ascii_digit()) {
            m = &m[..m.len() - 9];
        }
    }
    m.to_string()
}

/// Builtin per-million-token prices for a normalized model id, or `None` when
/// the id is not in the table.
///
/// Source: Anthropic's official pricing page
/// (<https://platform.claude.com/docs/en/about-claude/pricing>, fetched
/// 2026-10-29). Columns are input / 5-minute cache write / cache hit / output.
/// Every ProviderRouter builtin catalog model must appear here at the same
/// price (asserted by `builtin_catalog_matches_pricing_table` in `tests.rs`);
/// this table additionally carries older ids the catalog does not list, so
/// historical events still re-price correctly.
///
/// A model that is not here (and not in the catalog) is *unpriced* — callers
/// get `None` from [`prices_for`] and must not treat it as free. Explicitly
/// free models (Ollama, or a catalog entry priced at $0) come from the
/// catalog, not here.
pub fn builtin_prices(model: &str) -> Option<ModelPrices> {
    // (input, cache write 5m, cache hit, output) — USD per million tokens.
    let (input, cache_write, cache_hit, output) = match normalize_model_id(model).as_str() {
        // Claude Fable
        "claude-fable-5-1" => (10.0, 12.50, 0.25, 50.0),
        "claude-fable-5" => (10.0, 12.50, 1.0, 50.0),
        // Claude Opus
        "claude-opus-5-5" => (4.0, 5.0, 0.20, 20.0),
        "claude-opus-5" => (5.0, 6.25, 0.50, 25.0),
        "claude-opus-4-8" | "claude-opus-4-7" | "claude-opus-4-6" | "claude-opus-4-5" => {
            (5.0, 6.25, 0.50, 25.0)
        }
        "claude-opus-4-1" | "claude-opus-4" => (15.0, 18.75, 1.50, 75.0),
        // Claude Sonnet
        "claude-sonnet-5-5" => (2.0, 2.50, 0.10, 10.0),
        "claude-sonnet-5" => (2.0, 2.50, 0.20, 10.0),
        "claude-sonnet-4-6" | "claude-sonnet-4-5" | "claude-sonnet-4" => (3.0, 3.75, 0.30, 15.0),
        // Claude Haiku
        //
        // Haiku 5.5 is tiered per request: prompts over 100,000 tokens (input
        // + cache reads + cache writes) cost 0.50 / 0.625 / 0.05 / 2.50. This
        // is the <=100K tier; per-request paths (Talk director rounds, one-shot
        // AI calls, Claude Code transcripts, the PTY usage block) apply the
        // long tier via `request_prices`. Aggregated usage (DIRECT stages,
        // sub-agent attempts) keeps this tier — the size of each request
        // inside it is unknown — so long-prompt requests there are
        // under-counted.
        "claude-haiku-5-5" => (0.10, 0.125, 0.01, 0.50),
        "claude-haiku-4-5" => (1.0, 1.25, 0.10, 5.0),
        "claude-3-5-haiku" => (0.80, 1.0, 0.08, 4.0),
        // OpenAI
        "gpt-4o" => (2.50, 2.50, 1.25, 10.0),
        "gpt-4o-mini" => (0.15, 0.15, 0.075, 0.60),
        // Anything else is unknown — unpriced, not free.
        _ => return None,
    };
    Some(ModelPrices {
        input_per_m: input,
        output_per_m: output,
        cache_read_per_m: cache_hit,
        cache_creation_per_m: cache_write,
    })
}

/// Builtin price of one token type, in $/token (already divided by 1M).
/// Returns `0.0` for a model the builtin table does not know — callers that
/// must tell "unknown" from "free" use [`builtin_prices`] / [`prices_for`].
pub fn cost_per_token(model: &str, tt: TokenType) -> f64 {
    let Some(p) = builtin_prices(model) else { return 0.0 };
    let per_m = match tt {
        TokenType::Input => p.input_per_m,
        TokenType::Output => p.output_per_m,
        TokenType::CacheRead => p.cache_read_per_m,
        TokenType::CacheCreation => p.cache_creation_per_m,
    };
    per_m / 1_000_000.0
}

pub fn compute_cost(
    model: &str,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_creation: u64,
) -> f64 {
    input as f64 * cost_per_token(model, TokenType::Input)
        + output as f64 * cost_per_token(model, TokenType::Output)
        + cache_read as f64 * cost_per_token(model, TokenType::CacheRead)
        + cache_creation as f64 * cost_per_token(model, TokenType::CacheCreation)
}

/// Compute cost using explicit per-million prices from `ModelInfo`.
///
/// When `cache_read_per_m` / `cache_creation_per_m` are 0 (e.g. non-Anthropic
/// providers), those token counts are treated as normal input tokens (this is
/// the correct fall-back: if the provider doesn't track cache separately, the
/// caller already passes 0 for those counts anyway).
pub fn compute_cost_with_prices(
    input_per_m: f64,
    output_per_m: f64,
    cache_read_per_m: f64,
    cache_creation_per_m: f64,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_creation: u64,
) -> f64 {
    let eff_cache_read_per_m = if cache_read_per_m > 0.0 { cache_read_per_m } else { input_per_m };
    let eff_cache_creation_per_m = if cache_creation_per_m > 0.0 { cache_creation_per_m } else { input_per_m };

    (input as f64 * input_per_m
        + output as f64 * output_per_m
        + cache_read as f64 * eff_cache_read_per_m
        + cache_creation as f64 * eff_cache_creation_per_m)
        / 1_000_000.0
}

// ─── Pricing authority ────────────────────────────────────────────────
//
// One resolver every cost path funnels through, so the ledger, the DIRECT
// run meter, one-shot AI calls, and the PTY scanner can never disagree on a
// model's price. Resolution is catalog-first (the user-editable, cache-aware
// ProviderRouter), then the builtin hardcoded table as a legacy fallback,
// then `None` — a genuinely unknown model so the caller can flag the spend as
// unpriced instead of silently charging $0.

/// Per-million-token prices for one model.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ModelPrices {
    pub input_per_m: f64,
    pub output_per_m: f64,
    pub cache_read_per_m: f64,
    pub cache_creation_per_m: f64,
}

impl ModelPrices {
    pub fn cost(&self, input: u64, output: u64, cache_read: u64, cache_creation: u64) -> f64 {
        compute_cost_with_prices(
            self.input_per_m,
            self.output_per_m,
            self.cache_read_per_m,
            self.cache_creation_per_m,
            input,
            output,
            cache_read,
            cache_creation,
        )
    }
}

/// The provider catalog, loaded once and reused until `providers.json`
/// changes on disk (modified time + size), keyed by path. Pricing used to
/// call `ProviderRouter::load()` — a read, migrations and a write-back of the
/// file — on every lookup, including under the DB lock; this makes a lookup a
/// `stat` plus a map read.
pub fn catalog() -> Option<Arc<crate::provider_router::ProviderRouter>> {
    use std::collections::HashMap;
    use std::path::PathBuf;
    type Stamp = (Option<std::time::SystemTime>, u64);
    type Entry = (Stamp, Arc<crate::provider_router::ProviderRouter>);
    static CACHE: std::sync::OnceLock<Mutex<HashMap<PathBuf, Entry>>> = std::sync::OnceLock::new();
    let path = crate::provider_router::config_path();
    let stamp = |p: &PathBuf| -> Option<Stamp> {
        let md = std::fs::metadata(p).ok()?;
        Some((md.modified().ok(), md.len()))
    };
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(now) = stamp(&path) {
        let hit = cache.lock().get(&path).filter(|(s, _)| *s == now).map(|(_, r)| Arc::clone(r));
        if hit.is_some() {
            return hit;
        }
    }
    let router = Arc::new(crate::provider_router::ProviderRouter::load().ok()?);
    if let Some(after) = stamp(&path) {
        cache.lock().insert(path, (after, Arc::clone(&router)));
    }
    Some(router)
}

/// Resolve a model's prices against a given catalog (or none): a catalog
/// entry is an explicit price — `$0` included (a local Ollama model, or one
/// the user deliberately priced at zero). A `provider/model` id whose prefix
/// names a **local** catalog provider is free even when the model itself is
/// not listed. Then the builtin table; `None` means genuinely unknown.
pub fn prices_in(router: Option<&crate::provider_router::ProviderRouter>, model: &str) -> Option<ModelPrices> {
    if let Some(router) = router {
        if let Some((_, mi)) = router.find_model(model) {
            return Some(ModelPrices {
                input_per_m: mi.input_cost_per_m,
                output_per_m: mi.output_cost_per_m,
                cache_read_per_m: mi.cache_read_cost_per_m,
                cache_creation_per_m: mi.cache_creation_cost_per_m,
            });
        }
        if router.provider_for_prefix(model).is_some_and(|p| p.local) {
            return Some(ModelPrices { input_per_m: 0.0, output_per_m: 0.0, cache_read_per_m: 0.0, cache_creation_per_m: 0.0 });
        }
    }
    builtin_prices(model)
}

/// Resolve a model's prices, catalog-first (see [`prices_in`]). `None` means
/// the model is unknown to both the catalog and the builtin table — its
/// spend is unpriced, distinct from an explicit `$0`.
pub fn prices_for(model: &str) -> Option<ModelPrices> {
    prices_in(catalog().as_deref(), model)
}

/// Whether a model resolves to a price (catalog or builtin table). A local
/// or deliberately-$0 catalog model is priced — explicitly free, not unknown.
pub fn is_priced(model: &str) -> bool {
    prices_for(model).is_some()
}

/// Per-request price tiers: `(prompt-token threshold, multiplier)`. Above the
/// threshold — prompt = input + cache reads + cache writes of ONE request —
/// every column costs `multiplier`× the base price (official pricing,
/// 2026-10-29: Haiku 5.5 prompts over 100K tokens cost 5× — 0.50 / 0.625 /
/// 0.05 / 2.50). Applied as a multiplier so a user-edited base price scales.
fn long_prompt_tier(model: &str) -> Option<(u64, f64)> {
    match normalize_model_id(model).as_str() {
        "claude-haiku-5-5" => Some((100_000, 5.0)),
        _ => None,
    }
}

/// The prices that apply to ONE request of `prompt_tokens` (input + cache
/// read + cache write). Only per-request callers use this; aggregated usage
/// (a DIRECT stage, a sub-agent attempt) keeps the base tier, since the
/// size of each request inside the aggregate is unknown.
pub fn request_prices(model: &str, base: ModelPrices, prompt_tokens: u64) -> ModelPrices {
    match long_prompt_tier(model) {
        Some((threshold, k)) if prompt_tokens > threshold => ModelPrices {
            input_per_m: base.input_per_m * k,
            output_per_m: base.output_per_m * k,
            cache_read_per_m: base.cache_read_per_m * k,
            cache_creation_per_m: base.cache_creation_per_m * k,
        },
        _ => base,
    }
}

/// Cost of ONE request with [`request_prices`] on top of `base`.
pub fn request_cost(model: &str, base: ModelPrices, input: u64, output: u64, cache_read: u64, cache_creation: u64) -> f64 {
    request_prices(model, base, input + cache_read + cache_creation).cost(input, output, cache_read, cache_creation)
}

/// [`cost_for`] for ONE provider request: applies per-request price tiers.
pub fn request_cost_for(model: &str, input: u64, output: u64, cache_read: u64, cache_creation: u64) -> f64 {
    prices_for(model)
        .map(|p| request_cost(model, p, input, output, cache_read, cache_creation))
        .unwrap_or(0.0)
}

/// The ledger `cost_basis` of a computed row, from whether its model had a
/// price: `'unpriced'` when it carries tokens at $0 with no price — so the
/// Usage page can flag it and savings leave it out — else `'computed'`.
pub fn basis_for(priced: bool, cost_usd: f64, tokens: i64) -> &'static str {
    if !priced && cost_usd == 0.0 && tokens > 0 {
        "unpriced"
    } else {
        "computed"
    }
}

/// [`basis_for`] resolving the model's price (cached catalog lookup — no
/// `providers.json` reload). Only consults the catalog in the rare
/// $0-with-tokens case.
pub fn ledger_cost_basis(model: &str, cost_usd: f64, tokens: i64) -> &'static str {
    if cost_usd == 0.0 && tokens > 0 {
        basis_for(is_priced(model), cost_usd, tokens)
    } else {
        "computed"
    }
}

/// Canonical cost for a usage tuple, via [`prices_for`], at the base tier
/// (safe for aggregated usage). An unpriced model yields `0.0` — callers
/// that care about the distinction consult [`prices_for`] directly.
pub fn cost_for(
    model: &str,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_creation: u64,
) -> f64 {
    prices_for(model)
        .map(|p| p.cost(input, output, cache_read, cache_creation))
        .unwrap_or(0.0)
}

// ─── Engine ───────────────────────────────────────────────────────────

pub struct TokenEngine {
    db: Arc<Mutex<Db>>,
}

impl TokenEngine {
    pub fn new(db: Arc<Mutex<Db>>) -> Self {
        Self { db }
    }

    /// Record a token usage event into the canonical `spend_events` ledger, and
    /// update the session's aggregate counters. `surface` names the mode that
    /// produced the spend ('talk' | 'run' | 'review' | 'adhoc') — the ledger
    /// carries it explicitly instead of overloading `session_id`, and attribution
    /// (workspace/project) is derived from what `session_id` actually is.
    pub fn record(&self, event: TokenEvent, surface: &str) -> AppResult<()> {
        self.record_in_thread(event, surface, None, None)
    }

    /// [`record`](Self::record) with Talk attribution: the thread the spend
    /// belongs to and whether the director or a sub-agent
    /// (`subagent:<call id>`) spent it.
    ///
    /// The event may aggregate several requests (a sub-agent attempt), so a
    /// $0 event is priced at the base tier; use
    /// [`record_request_in_thread`](Self::record_request_in_thread) for ONE
    /// provider response.
    pub fn record_in_thread(
        &self,
        event: TokenEvent,
        surface: &str,
        thread_id: Option<&str>,
        origin: Option<&str>,
    ) -> AppResult<()> {
        self.record_priced(event, surface, thread_id, origin, false)
    }

    /// [`record_in_thread`](Self::record_in_thread) for an event that is ONE
    /// provider request: a $0 event is priced with per-request tiers (Haiku
    /// 5.5's >100K-prompt tier).
    pub fn record_request_in_thread(
        &self,
        event: TokenEvent,
        surface: &str,
        thread_id: Option<&str>,
        origin: Option<&str>,
    ) -> AppResult<()> {
        self.record_priced(event, surface, thread_id, origin, true)
    }

    fn record_priced(
        &self,
        mut event: TokenEvent,
        surface: &str,
        thread_id: Option<&str>,
        origin: Option<&str>,
        single_request: bool,
    ) -> AppResult<()> {
        let tokens = (event.input_tokens + event.output_tokens + event.cache_read_tokens + event.cache_creation_tokens) as i64;
        // Resolve the price ONCE, before the DB lock (single pricing
        // authority, catalog-first, cache-aware); its absence is what marks
        // the row unpriced.
        let mut priced = true;
        if event.cost_usd == 0.0 && tokens > 0 {
            match prices_for(&event.model) {
                Some(p) => {
                    let (i, o, cr, cc) = (event.input_tokens, event.output_tokens, event.cache_read_tokens, event.cache_creation_tokens);
                    event.cost_usd = if single_request {
                        request_cost(&event.model, p, i, o, cr, cc)
                    } else {
                        p.cost(i, o, cr, cc)
                    };
                }
                None => priced = false,
            }
        }
        let basis = basis_for(priced, event.cost_usd, tokens);
        if event.timestamp.is_empty() {
            event.timestamp = Utc::now().to_rfc3339();
        }
        let db = self.db.lock();
        db.record_token_spend_with_basis(&event, surface, thread_id, origin, basis)?;
        db.increment_session_tokens(
            &event.session_id,
            event.input_tokens,
            event.output_tokens,
        )?;
        Ok(())
    }

    /// Scan a PTY output chunk for a token-usage pattern and record it, gated by
    /// a persisted per-session high-water sequence number so replayed scrollback
    /// is never double-counted.
    ///
    /// A daemon reattach (pane reopen or app restart) replays the whole
    /// scrollback from seq 0, feeding every historical chunk back through this
    /// hook. The `octopush-pty-server` daemon outlives the app and its `seq` is
    /// monotonic across restarts, so a chunk whose `seq` is at or below the last
    /// seq we recorded a usage event for is guaranteed to be already-counted
    /// history — skip it. We advance the high-water mark only when a chunk
    /// actually yields an event, which both prevents duplicate recording and
    /// keeps DB writes rare (a match is uncommon; a plain re-scan of an
    /// unmatched replayed chunk is a cheap string search with no side effect).
    pub fn scan_and_record(&self, session_id: &str, seq: u64, buf: &[u8]) {
        let key = format!("pty_scan_seq:{session_id}");
        let last = self
            .db
            .lock()
            .meta_get(&key)
            .ok()
            .flatten()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        if seq <= last {
            return;
        }
        if let Some(ev) = scan_pty_output(session_id, buf) {
            // Once Claude Code's transcript meters this session (exact model
            // and cache split per API call — see `transcripts.rs`), the
            // screen-scraped summary would count the same run twice: honour
            // the high-water mark and drop the event.
            let metered_by_transcript = {
                let db = self.db.lock();
                let flagged = db
                    .meta_get(&format!("transcript_seen:{session_id}"))
                    .ok()
                    .flatten()
                    .is_some();
                // The flag lags one ingestion pass; the transcript directory
                // exists from the moment `claude` starts in that cwd, so a
                // first run that prints its summary before the next pass is
                // still caught here.
                flagged
                    || db
                        .run_cwd_for_source(session_id)
                        .ok()
                        .flatten()
                        .is_some_and(|cwd| crate::transcripts::has_transcript_dir(&cwd))
            };
            if metered_by_transcript {
                let _ = self.db.lock().meta_set(&key, &seq.to_string());
                return;
            }
            // PTY scraping is the RUN-mode (terminal CLI agent) path.
            if let Err(e) = self.record(ev, "run") {
                tracing::warn!(session_id = %session_id, error = %e, "token scan record failed");
                return;
            }
            let _ = self.db.lock().meta_set(&key, &seq.to_string());
        }
    }

    /// Build an aggregate report, optionally filtered to a single session.
    pub fn report(&self, session_id: Option<&str>) -> AppResult<TokenReport> {
        self.db.lock().token_report(session_id)
    }

    /// Return the budget status for a session.
    pub fn budget_status(&self, session_id: &str) -> AppResult<BudgetStatus> {
        let db = self.db.lock();
        let session = db
            .get_session(session_id)?
            .ok_or_else(|| crate::error::AppError::SessionNotFound(session_id.to_string()))?;
        let used = session.tokens_input + session.tokens_output;
        let remaining = session.token_budget.map(|b| b.saturating_sub(used));
        let pct = session
            .token_budget
            .map(|b| if b == 0 { 100.0 } else { used as f64 / b as f64 * 100.0 });
        Ok(BudgetStatus {
            session_id: session_id.to_string(),
            budget: session.token_budget,
            used,
            remaining,
            percent_used: pct,
        })
    }

    /// Set (or clear) the token budget for a session.
    pub fn set_budget(&self, session_id: &str, budget: Option<u64>) -> AppResult<()> {
        self.db.lock().set_session_budget(session_id, budget)
    }
}

// ─── PTY Output Scanner ──────────────────────────────────────────────
//
// Scans raw PTY output for known token-usage patterns. This is best-effort;
// the patterns are fragile and will need updating as agent UIs evolve.

/// Try to extract a `TokenEvent` from a chunk of PTY output.
/// Returns `None` if no usage pattern is found.
pub fn scan_pty_output(session_id: &str, buf: &[u8]) -> Option<TokenEvent> {
    let text = std::str::from_utf8(buf).ok()?;

    // Pattern 1: JSON `"usage"` block from API response logging.
    // e.g. {"usage":{"input_tokens":1234,"output_tokens":567}}
    if let Some(ev) = try_parse_api_usage_json(session_id, text) {
        return Some(ev);
    }

    // Pattern 2: Claude Code cost summary line.
    // e.g. "Total cost: $1.23 | Input: 45.2K | Output: 12.1K"
    if let Some(ev) = try_parse_claude_code_summary(session_id, text) {
        return Some(ev);
    }

    None
}

fn try_parse_api_usage_json(session_id: &str, text: &str) -> Option<TokenEvent> {
    // Look for a JSON object containing "usage" with token counts.
    let usage_start = text.find("\"usage\"")?;
    // Walk back to find the enclosing {
    let block_start = text[..usage_start].rfind('{')?;
    // Find matching } — simple brace counting.
    let rest = &text[block_start..];
    let block = extract_json_object(rest)?;

    let v: serde_json::Value = serde_json::from_str(block).ok()?;
    let usage = v.get("usage")?;

    let input = usage.get("input_tokens")?.as_u64()?;
    let output = usage.get("output_tokens")?.as_u64()?;
    let cache_read = usage
        .get("cache_read_input_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let cache_create = usage
        .get("cache_creation_input_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let model = v
        .get("model")
        .and_then(|m| m.as_str())
        .unwrap_or("unknown")
        .to_string();

    Some(TokenEvent {
        id: None,
        session_id: session_id.to_string(),
        timestamp: Utc::now().to_rfc3339(),
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cache_read,
        cache_creation_tokens: cache_create,
        model: model.clone(),
        // Price via the single authority (catalog-first) rather than the raw
        // hardcoded table, matching every other ledger path. One API
        // response = one request, so per-request tiers apply.
        cost_usd: request_cost_for(&model, input, output, cache_read, cache_create),
    })
}

fn try_parse_claude_code_summary(session_id: &str, text: &str) -> Option<TokenEvent> {
    // Look for pattern like: "Total cost: $X.XX"
    // And optionally "Input: NNK" / "Output: NNK"
    let cost_idx = text.find("Total cost:")?;
    let line = text[cost_idx..].lines().next()?;

    let cost = parse_dollar_amount(line)?;

    let input_tokens = parse_k_value(line, "Input:").unwrap_or(0);
    let output_tokens = parse_k_value(line, "Output:").unwrap_or(0);

    Some(TokenEvent {
        id: None,
        session_id: session_id.to_string(),
        timestamp: Utc::now().to_rfc3339(),
        input_tokens,
        output_tokens,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        model: "unknown".to_string(),
        cost_usd: cost,
    })
}

fn extract_json_object(s: &str) -> Option<&str> {
    if !s.starts_with('{') {
        return None;
    }
    let mut depth = 0i32;
    let mut in_str = false;
    let mut escape = false;
    for (i, ch) in s.char_indices() {
        if escape {
            escape = false;
            continue;
        }
        if ch == '\\' && in_str {
            escape = true;
            continue;
        }
        if ch == '"' {
            in_str = !in_str;
            continue;
        }
        if in_str {
            continue;
        }
        match ch {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&s[..=i]);
                }
            }
            _ => {}
        }
    }
    None
}

/// Upper bounds guarding against garbled/hostile PTY text. A single event
/// cannot realistically exceed these; without the caps a huge parsed value
/// saturates on the `as u64` cast and then wraps NEGATIVE on the later
/// `as i64` DB insert, poisoning aggregates.
const MAX_EVENT_TOKENS: u64 = 1_000_000_000_000; // 1e12
const MAX_EVENT_COST_USD: f64 = 1_000_000.0;

fn parse_dollar_amount(s: &str) -> Option<f64> {
    let dollar = s.find('$')?;
    let rest = &s[dollar + 1..];
    let end = rest
        .find(|c: char| !c.is_ascii_digit() && c != '.')
        .unwrap_or(rest.len());
    let v: f64 = rest[..end].parse().ok()?;
    if !v.is_finite() || v < 0.0 {
        return None;
    }
    Some(v.min(MAX_EVENT_COST_USD))
}

fn parse_k_value(s: &str, prefix: &str) -> Option<u64> {
    let idx = s.find(prefix)?;
    let rest = s[idx + prefix.len()..].trim_start();
    let end = rest
        .find(|c: char| !c.is_ascii_digit() && c != '.' && c != 'K' && c != 'k')
        .unwrap_or(rest.len());
    let raw = &rest[..end];
    let value = if raw.ends_with('K') || raw.ends_with('k') {
        let num: f64 = raw[..raw.len() - 1].parse().ok()?;
        if !num.is_finite() || num < 0.0 {
            return None;
        }
        (num * 1000.0) as u64
    } else {
        raw.parse().ok()?
    };
    Some(value.min(MAX_EVENT_TOKENS))
}
