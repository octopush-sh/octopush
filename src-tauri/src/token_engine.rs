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

/// Normalize a raw model id to its base catalog id for pricing lookups:
/// strips provider prefixes (Bedrock/Vertex `us.anthropic.…` / `anthropic.…`),
/// a bracketed capability suffix (`claude-opus-4-8[1m]`), a Vertex `@`-version
/// separator, and a trailing dated snapshot (`-YYYYMMDD`). Exact-match pricing
/// tables would otherwise silently price these variants at $0.
pub fn normalize_model_id(model: &str) -> String {
    let mut m = model.trim();
    for prefix in ["us.anthropic.", "eu.anthropic.", "apac.anthropic.", "anthropic."] {
        if let Some(rest) = m.strip_prefix(prefix) {
            m = rest;
            break;
        }
    }
    if let Some(idx) = m.find('[') {
        m = &m[..idx];
    }
    if let Some(idx) = m.find('@') {
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

/// Per-million-token pricing. Returns $/token (i.e. already divided by 1M).
///
/// Interim catalog (Phase 0): kept in sync with the ProviderRouter builtin
/// catalog so both pricing paths agree until Phase 1 unifies them. Cache prices
/// follow Anthropic's standard economics — cache-read ≈ 0.1× input, cache-write
/// (5-minute TTL) ≈ 1.25× input. Older ids are retained so historical events
/// still re-price correctly.
pub fn cost_per_token(model: &str, tt: TokenType) -> f64 {
    let model = normalize_model_id(model);
    let per_m = match (model.as_str(), tt) {
        // Claude Fable 5
        ("claude-fable-5", TokenType::Input) => 10.0,
        ("claude-fable-5", TokenType::Output) => 50.0,
        ("claude-fable-5", TokenType::CacheRead) => 1.0,
        ("claude-fable-5", TokenType::CacheCreation) => 12.5,
        // Claude Opus 4.8 / 4.7 (same price tier)
        ("claude-opus-4-8", TokenType::Input) | ("claude-opus-4-7", TokenType::Input) => 5.0,
        ("claude-opus-4-8", TokenType::Output) | ("claude-opus-4-7", TokenType::Output) => 25.0,
        ("claude-opus-4-8", TokenType::CacheRead) | ("claude-opus-4-7", TokenType::CacheRead) => 0.5,
        ("claude-opus-4-8", TokenType::CacheCreation) | ("claude-opus-4-7", TokenType::CacheCreation) => 6.25,
        // Claude Opus 4.6 (legacy)
        ("claude-opus-4-6", TokenType::Input) => 15.0,
        ("claude-opus-4-6", TokenType::Output) => 75.0,
        ("claude-opus-4-6", TokenType::CacheRead) => 1.5,
        ("claude-opus-4-6", TokenType::CacheCreation) => 18.75,
        // Claude Sonnet 5 (standard sticker; intro discount not modeled)
        ("claude-sonnet-5", TokenType::Input) => 3.0,
        ("claude-sonnet-5", TokenType::Output) => 15.0,
        ("claude-sonnet-5", TokenType::CacheRead) => 0.3,
        ("claude-sonnet-5", TokenType::CacheCreation) => 3.75,
        // Claude Sonnet 4.6 (legacy)
        ("claude-sonnet-4-6", TokenType::Input) => 3.0,
        ("claude-sonnet-4-6", TokenType::Output) => 15.0,
        ("claude-sonnet-4-6", TokenType::CacheRead) => 0.3,
        ("claude-sonnet-4-6", TokenType::CacheCreation) => 3.75,
        // Claude Haiku 4.5
        ("claude-haiku-4-5", TokenType::Input) => 1.0,
        ("claude-haiku-4-5", TokenType::Output) => 5.0,
        ("claude-haiku-4-5", TokenType::CacheRead) => 0.10,
        ("claude-haiku-4-5", TokenType::CacheCreation) => 1.25,
        // GPT-4o
        ("gpt-4o", TokenType::Input) => 2.50,
        ("gpt-4o", TokenType::Output) => 10.0,
        ("gpt-4o", TokenType::CacheRead) => 1.25,
        ("gpt-4o", TokenType::CacheCreation) => 2.50,
        // GPT-4o-mini
        ("gpt-4o-mini", TokenType::Input) => 0.15,
        ("gpt-4o-mini", TokenType::Output) => 0.60,
        ("gpt-4o-mini", TokenType::CacheRead) => 0.075,
        ("gpt-4o-mini", TokenType::CacheCreation) => 0.15,
        // Unknown / local models — free
        (_, _) => 0.0,
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

/// Resolve a model's prices, catalog-first. `None` means the model is unknown
/// to both the ProviderRouter catalog and the builtin table (so its spend is
/// genuinely unpriced — distinct from a known local model priced at $0, which
/// the catalog returns as `Some(zeros)`).
pub fn prices_for(model: &str) -> Option<ModelPrices> {
    if let Ok(router) = crate::provider_router::ProviderRouter::load() {
        if let Some((_, mi)) = router.find_model(model) {
            return Some(ModelPrices {
                input_per_m: mi.input_cost_per_m,
                output_per_m: mi.output_cost_per_m,
                cache_read_per_m: mi.cache_read_cost_per_m,
                cache_creation_per_m: mi.cache_creation_cost_per_m,
            });
        }
    }
    // Hardcoded fallback: a positive input price is the "known" discriminator
    // (every builtin entry is nonzero; unknown/local ids fall through to $0).
    let norm = normalize_model_id(model);
    let input_per_m = cost_per_token(&norm, TokenType::Input) * 1_000_000.0;
    if input_per_m > 0.0 {
        return Some(ModelPrices {
            input_per_m,
            output_per_m: cost_per_token(&norm, TokenType::Output) * 1_000_000.0,
            cache_read_per_m: cost_per_token(&norm, TokenType::CacheRead) * 1_000_000.0,
            cache_creation_per_m: cost_per_token(&norm, TokenType::CacheCreation) * 1_000_000.0,
        });
    }
    None
}

/// Canonical cost for a usage tuple, via [`prices_for`]. An unpriced model
/// yields `0.0` — callers that care about the distinction should consult
/// [`prices_for`] directly.
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
    pub fn record_in_thread(
        &self,
        mut event: TokenEvent,
        surface: &str,
        thread_id: Option<&str>,
        origin: Option<&str>,
    ) -> AppResult<()> {
        if event.cost_usd == 0.0 {
            // Single pricing authority (catalog-first, cache-aware).
            event.cost_usd = cost_for(
                &event.model,
                event.input_tokens,
                event.output_tokens,
                event.cache_read_tokens,
                event.cache_creation_tokens,
            );
        }
        if event.timestamp.is_empty() {
            event.timestamp = Utc::now().to_rfc3339();
        }
        let db = self.db.lock();
        db.record_token_spend_in_thread(&event, surface, thread_id, origin)?;
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
        if let Some((ev, cumulative)) = scan_pty_output_kind(session_id, buf) {
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
            // The summary is the session's running total: record only what
            // it adds over the last one seen for this source.
            let total = cumulative.then(|| format!("{},{},{}", ev.cost_usd, ev.input_tokens, ev.output_tokens));
            let ev = if cumulative {
                let last = self.db.lock().meta_get(&pty_total_key(session_id)).ok().flatten();
                match cumulative_delta(ev, last.as_deref()) {
                    Some(ev) => ev,
                    None => {
                        let _ = self.db.lock().meta_set(&key, &seq.to_string());
                        return;
                    }
                }
            } else {
                ev
            };
            // PTY scraping is the RUN-mode (terminal CLI agent) path.
            if let Err(e) = self.record(ev, "run") {
                tracing::warn!(session_id = %session_id, error = %e, "token scan record failed");
                return;
            }
            let db = self.db.lock();
            if let Some(total) = total {
                let _ = db.meta_set(&pty_total_key(session_id), &total);
            }
            let _ = db.meta_set(&key, &seq.to_string());
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
    scan_pty_output_kind(session_id, buf).map(|(ev, _)| ev)
}

/// [`scan_pty_output`] plus whether the event is a session-CUMULATIVE
/// total (Claude Code's `Total cost:` summary — printed again by every
/// `/cost` and on a redraw) rather than one call's usage.
fn scan_pty_output_kind(session_id: &str, buf: &[u8]) -> Option<(TokenEvent, bool)> {
    let text = std::str::from_utf8(buf).ok()?;

    // Pattern 1: JSON `"usage"` block from API response logging.
    // e.g. {"usage":{"input_tokens":1234,"output_tokens":567}}
    if let Some(ev) = try_parse_api_usage_json(session_id, text) {
        return Some((ev, false));
    }

    // Pattern 2: Claude Code cost summary line.
    // e.g. "Total cost: $1.23 | Input: 45.2K | Output: 12.1K"
    if let Some(ev) = try_parse_claude_code_summary(session_id, text) {
        return Some((ev, true));
    }

    None
}

/// Meta key holding the last cumulative `Total cost:` recorded for a source
/// (`cost,input,output`), so a repeated summary records nothing and a grown
/// one records only the growth.
fn pty_total_key(session_id: &str) -> String {
    format!("pty_scan_total:{session_id}")
}

/// Turn a cumulative summary into the spend not yet recorded: `None` when
/// it repeats the last one (a second `/cost`, a redraw); the difference when
/// it grew; the whole summary when it is lower (a new `claude` run in the
/// same terminal starts again from zero).
fn cumulative_delta(mut ev: TokenEvent, last: Option<&str>) -> Option<TokenEvent> {
    let Some(last) = last else { return Some(ev) };
    let mut parts = last.split(',').map(|p| p.trim().parse::<f64>().unwrap_or(0.0));
    let (cost, input, output) = (
        parts.next().unwrap_or(0.0),
        parts.next().unwrap_or(0.0) as u64,
        parts.next().unwrap_or(0.0) as u64,
    );
    if (ev.cost_usd - cost).abs() < 1e-9 {
        return None;
    }
    if ev.cost_usd > cost {
        ev.cost_usd -= cost;
        ev.input_tokens = ev.input_tokens.saturating_sub(input);
        ev.output_tokens = ev.output_tokens.saturating_sub(output);
    }
    Some(ev)
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
        // hardcoded table, matching every other ledger path.
        cost_usd: cost_for(&model, input, output, cache_read, cache_create),
    })
}

fn try_parse_claude_code_summary(session_id: &str, text: &str) -> Option<TokenEvent> {
    // Look for pattern like: "Total cost: $X.XX"
    // And optionally "Input: NNK" / "Output: NNK"
    // Claude Code's TUI positions words with cursor moves (`ESC[<col>G`)
    // rather than spaces, so the raw PTY bytes never contain the literal
    // "Total cost:" — match against the text as the screen shows it. The
    // words themselves arrive intact, so a chunk without "Total" is skipped
    // before any normalisation (the scan runs on every PTY chunk).
    if !text.contains("Total") {
        return None;
    }
    let screen;
    let text = if text.contains('\x1b') {
        screen = screen_text(text);
        screen.as_str()
    } else {
        text
    };
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

/// PTY bytes → the text a terminal would show, roughly: CSI sequences are
/// dropped, except horizontal cursor moves (`ESC[<n>G` absolute column,
/// `ESC[<n>C` forward), which Claude Code's renderer uses between words and
/// which become one space. OSC (`ESC]…BEL`) and DCS/SOS/PM/APC strings
/// (`ESC P|X|^|_ … ESC\\`) are dropped whole, charset designators
/// (`ESC ( B`, `ESC ) 0`, `ESC * X`, `ESC + X`) with their final byte, and
/// any other escape with its one following byte.
pub(crate) fn screen_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('[') => {
                // Parameter/intermediate bytes, then one final byte 0x40–0x7E.
                for f in chars.by_ref() {
                    if ('\x40'..='\x7e').contains(&f) {
                        if f == 'G' || f == 'C' {
                            out.push(' ');
                        }
                        break;
                    }
                }
            }
            Some(']') | Some('P') | Some('X') | Some('^') | Some('_') => {
                // String sequences end at BEL (OSC) or ST (`ESC \\`).
                while let Some(f) = chars.next() {
                    if f == '\x07' {
                        break;
                    }
                    if f == '\x1b' {
                        chars.next();
                        break;
                    }
                }
            }
            Some('(') | Some(')') | Some('*') | Some('+') => {
                chars.next(); // the charset's final byte
            }
            _ => {}
        }
    }
    out
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

#[cfg(test)]
mod pty_scan_tests {
    use super::*;
    use crate::db::Db;
    use tempfile::NamedTempFile;

    const ALL: (&str, &str) = ("2000-01-01T00:00:00+00:00", "2100-01-01T00:00:00+00:00");

    fn engine_with_terminal() -> (TokenEngine, Arc<Mutex<Db>>, NamedTempFile) {
        let tmp = NamedTempFile::new().unwrap();
        let db = Arc::new(Mutex::new(Db::open(tmp.path()).unwrap()));
        {
            let d = db.lock();
            d.insert_project("p1", "Atlas", "/tmp/atlas-pty-scan").unwrap();
            d.insert_workspace("w1", "p1", "ws", "", "main", Some("/tmp/atlas-pty-scan/wt/one"), "", None).unwrap();
            d.conn_ref()
                .execute(
                    "INSERT INTO terminals (id, workspace_id, label, position, created_at) VALUES ('term-1','w1','Terminal',0,0)",
                    [],
                )
                .unwrap();
        }
        (TokenEngine::new(Arc::clone(&db)), db, tmp)
    }

    fn totals(db: &Arc<Mutex<Db>>) -> (i64, f64) {
        let rep = db.lock().usage_report(ALL.0, ALL.1, None, 0).unwrap();
        (rep.totals.calls, rep.totals.cost_usd)
    }

    #[test]
    fn a_repeated_cost_summary_is_recorded_once_and_growth_only_as_the_difference() {
        let (engine, db, _tmp) = engine_with_terminal();
        engine.scan_and_record("term-1", 1, b"Total cost: $1.00 | Input: 10K | Output: 1K");
        assert_eq!(totals(&db).0, 1);
        // A second `/cost` (or a redraw) prints the same running total.
        engine.scan_and_record("term-1", 2, b"Total cost: $1.00 | Input: 10K | Output: 1K");
        engine.scan_and_record("term-1", 3, b"\x1b[2GTotal\x1b[8Gcost:\x1b[24G$1.00");
        assert_eq!(totals(&db).0, 1, "a repeated running total adds nothing");
        // The total grew: only the growth is new spend.
        engine.scan_and_record("term-1", 4, b"Total cost: $1.50 | Input: 15K | Output: 2K");
        let (calls, cost) = totals(&db);
        assert_eq!(calls, 2);
        assert!((cost - 1.50).abs() < 1e-9, "ledger holds the running total, not the sum of summaries: {cost}");
        // A lower total is a new `claude` run in the same terminal.
        engine.scan_and_record("term-1", 5, b"Total cost: $0.20");
        let (calls, cost) = totals(&db);
        assert_eq!(calls, 3);
        assert!((cost - 1.70).abs() < 1e-9, "{cost}");
    }

    #[test]
    fn cumulative_delta_rules() {
        let ev = |c: f64| TokenEvent {
            id: None,
            session_id: "s".into(),
            timestamp: String::new(),
            input_tokens: 100,
            output_tokens: 10,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            model: "unknown".into(),
            cost_usd: c,
        };
        assert!((cumulative_delta(ev(1.0), None).unwrap().cost_usd - 1.0).abs() < 1e-9);
        assert!(cumulative_delta(ev(1.0), Some("1,100,10")).is_none());
        let d = cumulative_delta(ev(1.25), Some("1,40,4")).unwrap();
        assert!((d.cost_usd - 0.25).abs() < 1e-9);
        assert_eq!((d.input_tokens, d.output_tokens), (60, 6));
        assert!((cumulative_delta(ev(0.5), Some("1,100,10")).unwrap().cost_usd - 0.5).abs() < 1e-9);
        // A garbled stored total never panics.
        assert!(cumulative_delta(ev(0.5), Some("garbage")).is_some());
    }

    #[test]
    fn screen_text_turns_cursor_moves_into_spaces() {
        assert_eq!(screen_text("Total\x1b[8Gcost:\x1b[3C$1"), "Total cost: $1");
        assert_eq!(screen_text("\x1b[31mred\x1b[39m \x1b[?25lx"), "red x");
    }

    #[test]
    fn screen_text_drops_charset_designators_whole() {
        assert_eq!(screen_text("\x1b(BTotal\x1b)0 cost"), "Total cost");
        assert_eq!(screen_text("a\x1b*Ab\x1b+Bc"), "abc");
    }

    #[test]
    fn screen_text_skips_dcs_and_osc_strings() {
        assert_eq!(screen_text("a\x1bP1$r0m\x1b\\b"), "ab");
        assert_eq!(screen_text("a\x1b]0;title\x07b\x1b]8;;http://x\x1b\\c"), "abc");
        assert_eq!(screen_text("a\x1b_apc\x1b\\b\x1b^pm\x1b\\c"), "abc");
        // Unterminated strings and a trailing ESC end quietly.
        assert_eq!(screen_text("a\x1bPnever"), "a");
        assert_eq!(screen_text("a\x1b"), "a");
    }

    #[test]
    fn summary_scan_needs_the_word_total() {
        assert!(scan_pty_output("s", b"\x1b[2Gcost:\x1b[8G$1.00").is_none());
        assert!(scan_pty_output("s", b"\x1b[2GTotal\x1b[8Gcost:\x1b[24G$1.00").is_some());
    }
}
