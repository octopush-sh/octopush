//! Gateway reconciliation — what the gateway billed against what the ledger
//! recorded, for the same period.
//!
//! When a provider's base URL fronts an LLM gateway (LiteLLM today), the
//! gateway is the only party that sees every request. Claude Code's service
//! calls and its prompt-cache upkeep are billed there but never written to
//! its transcripts, so RUN's ledger can only account for the turns; a
//! gateway-side key budget can refuse a call the ledger never saw coming.
//! This module asks the gateway for the period the Usage page shows and
//! reports the gap: totals, per model, and — when the gateway's request
//! logs are readable — per request, matched by the ids the ledger knows
//! (Claude Code's request id and the provider's message id per row).
//!
//! Extensible by design: [`SpendGateway`] is the contract, [`gateways`]
//! lists the known implementations. A new gateway is one file and one line.
//! Nothing here is configured: a gateway is *detected* from the provider's
//! base URL and key, and the result is cached so the page's 10s poll never
//! turns into a probe storm.

use crate::db::ModelUsage;
use crate::token_engine::normalize_model_id;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

pub mod litellm;

/// Who the key is at the gateway, and which Octopush provider it fronts.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GatewayIdentity {
    /// `litellm` — the implementation's id.
    pub kind: String,
    /// `LiteLLM` — what the UI calls it.
    pub label: String,
    /// The gateway's host, as the user would recognize it.
    pub host: String,
    /// The Octopush provider whose base URL is this gateway.
    pub provider: String,
    pub key_alias: Option<String>,
    /// The gateway's identifier for the key (LiteLLM: its SHA-256).
    pub key_hash: Option<String>,
    /// The key's running spend since its last budget reset.
    pub key_spend_usd: Option<f64>,
    pub key_max_budget_usd: Option<f64>,
    pub budget_reset_at: Option<String>,
}

/// One billed request as the gateway logged it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GatewayRequest {
    /// The request's id as the gateway logged it — matched against the
    /// ledger's request and message ids.
    pub id: String,
    pub ts_utc: String,
    pub model: String,
    pub cost_usd: f64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub success: bool,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GatewayModelSpend {
    pub model: String,
    pub cost_usd: f64,
    pub requests: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
}

/// A gateway's spend over a period, at whatever granularity it let us read.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct GatewaySpend {
    pub cost_usd: f64,
    pub requests: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub by_model: Vec<GatewayModelSpend>,
    /// Per-request rows, when the gateway's logs were readable.
    pub requests_detail: Option<Vec<GatewayRequest>>,
    /// `logs` (per request) · `daily` (whole UTC days) · `key` (the key's
    /// running total only).
    pub basis: String,
    /// A caveat the UI should show with the figures.
    pub note: Option<String>,
}

/// The contract a gateway implements. Both calls are network-bound and must
/// fail soft: a gateway that is down hides the section, never the page.
#[async_trait::async_trait]
pub trait SpendGateway: Send + Sync {
    fn kind(&self) -> &'static str;
    fn label(&self) -> &'static str;
    /// Whether `base_url` fronts this gateway and who `api_key` is there.
    /// `None` when it is not this gateway (or could not be reached).
    async fn identify(
        &self,
        client: &reqwest::Client,
        base_url: &str,
        api_key: &str,
        provider: &str,
    ) -> Option<GatewayIdentity>;
    /// The key's spend between two RFC3339 UTC instants.
    async fn spend(
        &self,
        client: &reqwest::Client,
        base_url: &str,
        api_key: &str,
        identity: &GatewayIdentity,
        start_utc: &str,
        end_utc: &str,
    ) -> Result<GatewaySpend, String>;
}

/// Every gateway Octopush knows how to read. Order is probe order.
pub fn gateways() -> Vec<Box<dyn SpendGateway>> {
    vec![Box::new(litellm::LiteLlm)]
}

/// Hosts that are a provider's own API, never a gateway — not worth a probe.
const FIRST_PARTY_HOSTS: &[&str] = &[
    "api.anthropic.com",
    "api.openai.com",
    "api.deepseek.com",
    "generativelanguage.googleapis.com",
    "api.x.ai",
    "api.mistral.ai",
    "api.groq.com",
    "openrouter.ai",
];

/// The host of a base URL (`https://llm.corp:4000/v1` → `llm.corp:4000`).
pub fn host_of(base_url: &str) -> String {
    let rest = base_url
        .trim()
        .split_once("://")
        .map(|(_, r)| r)
        .unwrap_or(base_url.trim());
    rest.split('/').next().unwrap_or("").to_string()
}

/// Whether a base URL could be a gateway at all: not a first-party API, not
/// a local model server.
pub fn worth_probing(base_url: &str) -> bool {
    let host = host_of(base_url).to_ascii_lowercase();
    if host.is_empty() {
        return false;
    }
    let name = host.split(':').next().unwrap_or("");
    if FIRST_PARTY_HOSTS.iter().any(|h| name == *h) {
        return false;
    }
    !(name == "localhost" || name == "127.0.0.1" || name == "0.0.0.0")
}

/// The name both sides are compared under: the last path segment of a
/// gateway model (`bedrock/eu.anthropic.claude-sonnet-5`), then the same
/// normalization the price catalog applies (region/vendor prefixes, dated
/// snapshots, bracket suffixes), lowercased.
pub fn canonical_model(model: &str) -> String {
    let last = model.trim().rsplit('/').next().unwrap_or(model.trim());
    normalize_model_id(last).to_ascii_lowercase()
}

// ─── Reconciliation ───────────────────────────────────────────────

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReconciledModel {
    pub model: String,
    pub gateway_cost_usd: f64,
    pub gateway_requests: i64,
    pub ledger_cost_usd: f64,
    pub ledger_calls: i64,
}

/// What the Usage page shows: the gateway's figures, the ledger's, and the
/// gap between them for one period.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GatewayReconciliation {
    pub gateway: GatewayIdentity,
    pub start: String,
    pub end: String,
    pub gateway_cost_usd: f64,
    pub gateway_requests: i64,
    /// Prompt + completion, as the gateway counts them (cache included).
    pub gateway_tokens: i64,
    /// Ledger rows for the models the gateway served.
    pub ledger_cost_usd: f64,
    pub ledger_calls: i64,
    /// All four buckets, so it compares with the gateway's count.
    pub ledger_tokens: i64,
    pub unaccounted_cost_usd: f64,
    pub unaccounted_requests: i64,
    pub by_model: Vec<ReconciledModel>,
    /// Ledger models with no gateway counterpart — left out of the totals.
    pub ledger_only_models: Vec<String>,
    /// With `logs` basis: gateway requests whose id is in no ledger row.
    pub unmatched_requests: Option<i64>,
    pub unmatched_cost_usd: Option<f64>,
    pub unmatched_by_model: Vec<GatewayModelSpend>,
    pub basis: String,
    pub note: Option<String>,
    pub fetched_at: String,
}

/// The ledger's side of the comparison, as the command gathers it.
#[derive(Clone, Debug, Default)]
pub struct LedgerSide {
    pub by_model: Vec<ModelUsage>,
    /// Every id the ledger's rows in the period carry, bare: the request id
    /// a row is keyed on (`cc:<request id>` → `<request id>`, `cc:msg:<id>`
    /// → `<id>`) and the provider's message id recorded beside it. A
    /// gateway request is accounted for when its id is one of them.
    pub ids: HashSet<String>,
}

/// A ledger dedupe key without its `cc:` / `cc:msg:` prefix — the bare
/// provider id. Keys of other shapes come back unchanged.
pub fn bare_ledger_id(key: &str) -> &str {
    key.strip_prefix("cc:msg:").or_else(|| key.strip_prefix("cc:")).unwrap_or(key)
}

/// Pure: fold the two sides into the report. Tested without a network.
pub fn reconcile(
    gateway: GatewayIdentity,
    start: &str,
    end: &str,
    spend: &GatewaySpend,
    ledger: &LedgerSide,
    fetched_at: &str,
) -> GatewayReconciliation {
    // Gateway models, keyed by canonical name (several gateway routes can
    // fold into one: `bedrock/eu.…-sonnet-5` and `claude-sonnet-5`).
    let mut gw: HashMap<String, GatewayModelSpend> = HashMap::new();
    for m in &spend.by_model {
        let key = canonical_model(&m.model);
        let e = gw.entry(key.clone()).or_insert_with(|| GatewayModelSpend { model: key, ..Default::default() });
        e.cost_usd += m.cost_usd;
        e.requests += m.requests;
        e.prompt_tokens += m.prompt_tokens;
        e.completion_tokens += m.completion_tokens;
    }
    let mut ledger_by: HashMap<String, (f64, i64, i64)> = HashMap::new();
    let mut ledger_only: Vec<String> = Vec::new();
    for m in &ledger.by_model {
        let key = canonical_model(&m.model);
        if !gw.contains_key(&key) {
            ledger_only.push(m.model.clone());
            continue;
        }
        let e = ledger_by.entry(key).or_insert((0.0, 0, 0));
        e.0 += m.usage.cost_usd;
        e.1 += m.usage.calls;
        e.2 += m.usage.input_tokens
            + m.usage.output_tokens
            + m.usage.cache_read_tokens
            + m.usage.cache_creation_tokens;
    }
    ledger_only.sort();
    let mut by_model: Vec<ReconciledModel> = gw
        .values()
        .map(|g| {
            let l = ledger_by.get(&g.model).copied().unwrap_or((0.0, 0, 0));
            ReconciledModel {
                model: g.model.clone(),
                gateway_cost_usd: g.cost_usd,
                gateway_requests: g.requests,
                ledger_cost_usd: l.0,
                ledger_calls: l.1,
            }
        })
        .collect();
    by_model.sort_by(|a, b| b.gateway_cost_usd.partial_cmp(&a.gateway_cost_usd).unwrap_or(std::cmp::Ordering::Equal));

    let ledger_cost_usd: f64 = ledger_by.values().map(|v| v.0).sum();
    let ledger_calls: i64 = ledger_by.values().map(|v| v.1).sum();
    let ledger_tokens: i64 = ledger_by.values().map(|v| v.2).sum();
    // On the `key` basis the gateway's figure is the key's running total
    // since its last budget reset, not this period's spend: there is no gap
    // to compute, and claiming one would colour the page over nothing.
    let comparable = spend.basis != "key";

    // Request-level matching, when the gateway gave us rows: a gateway id
    // is accounted for when a ledger row carries it (as its request id or
    // its message id); every other successful request is spend the ledger
    // never saw (service calls, cache upkeep, retries).
    let (unmatched_requests, unmatched_cost_usd, unmatched_by_model) = match &spend.requests_detail {
        Some(rows) => {
            let mut n = 0i64;
            let mut cost = 0.0f64;
            let mut by: HashMap<String, GatewayModelSpend> = HashMap::new();
            for r in rows {
                if !r.success {
                    continue;
                }
                if ledger.ids.contains(&r.id) {
                    continue;
                }
                n += 1;
                cost += r.cost_usd;
                let key = canonical_model(&r.model);
                let e = by.entry(key.clone()).or_insert_with(|| GatewayModelSpend { model: key, ..Default::default() });
                e.cost_usd += r.cost_usd;
                e.requests += 1;
                e.prompt_tokens += r.prompt_tokens;
                e.completion_tokens += r.completion_tokens;
            }
            let mut v: Vec<GatewayModelSpend> = by.into_values().collect();
            v.sort_by(|a, b| b.cost_usd.partial_cmp(&a.cost_usd).unwrap_or(std::cmp::Ordering::Equal));
            (Some(n), Some(cost), v)
        }
        None => (None, None, Vec::new()),
    };

    GatewayReconciliation {
        gateway,
        start: start.to_string(),
        end: end.to_string(),
        gateway_cost_usd: spend.cost_usd,
        gateway_requests: spend.requests,
        gateway_tokens: spend.prompt_tokens + spend.completion_tokens,
        ledger_cost_usd,
        ledger_calls,
        ledger_tokens,
        unaccounted_cost_usd: if comparable { (spend.cost_usd - ledger_cost_usd).max(0.0) } else { 0.0 },
        unaccounted_requests: if comparable { (spend.requests - ledger_calls).max(0) } else { 0 },
        by_model,
        ledger_only_models: ledger_only,
        unmatched_requests,
        unmatched_cost_usd,
        unmatched_by_model,
        basis: spend.basis.clone(),
        note: spend.note.clone(),
        fetched_at: fetched_at.to_string(),
    }
}

// ─── Detection + caching ──────────────────────────────────────────

/// One provider's base URL and key, as the command resolves them.
#[derive(Clone, Debug)]
pub struct ProviderEndpoint {
    pub provider: String,
    pub base_url: String,
    pub api_key: String,
}

/// How long a detection (positive or negative) is trusted before the
/// provider is probed again.
const IDENTITY_TTL: Duration = Duration::from_secs(10 * 60);
/// How long a period's reconciliation is served from memory: the Usage
/// page polls every 10s, the gateway is asked at most once a minute.
const SPEND_TTL: Duration = Duration::from_secs(60);

/// Session-lived memory of which providers are gateways and the last
/// reconciliation per period.
#[derive(Default)]
pub struct GatewayCache {
    identities: parking_lot::Mutex<HashMap<String, (Instant, Option<GatewayIdentity>)>>,
    spends: parking_lot::Mutex<HashMap<(String, String, String), (Instant, GatewayReconciliation)>>,
}

/// The cache key of a period: its start, and its end to the minute. A
/// preset's end is "now" and moves with every 10s poll; truncating it
/// keeps the poll on the cached answer within the minute the TTL allows,
/// while a changed custom range (a different end day) is never served
/// the previous range's figures.
fn period_key(provider: &str, start: &str, end: &str) -> (String, String, String) {
    let end_minute: String = end.chars().take("2026-09-30T22:59".len()).collect();
    (provider.to_string(), start.to_string(), end_minute)
}

impl GatewayCache {
    pub fn cached_identity(&self, provider: &str) -> Option<Option<GatewayIdentity>> {
        let map = self.identities.lock();
        map.get(provider)
            .filter(|(at, _)| at.elapsed() < IDENTITY_TTL)
            .map(|(_, id)| id.clone())
    }

    pub fn remember_identity(&self, provider: &str, identity: Option<GatewayIdentity>) {
        self.identities.lock().insert(provider.to_string(), (Instant::now(), identity));
    }

    /// Forget every detection — the user changed a provider's URL or key.
    pub fn invalidate(&self) {
        self.identities.lock().clear();
        self.spends.lock().clear();
    }

    pub fn cached_spend(&self, provider: &str, start: &str, end: &str) -> Option<GatewayReconciliation> {
        let map = self.spends.lock();
        map.get(&period_key(provider, start, end))
            .filter(|(at, _)| at.elapsed() < SPEND_TTL)
            .map(|(_, r)| r.clone())
    }

    pub fn remember_spend(&self, provider: &str, start: &str, end: &str, r: GatewayReconciliation) {
        self.spends.lock().insert(period_key(provider, start, end), (Instant::now(), r));
    }
}

/// One shared client with a short timeout: a gateway that hangs must not
/// hold the Usage page.
pub fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

/// Find the first gateway among the given provider endpoints, using and
/// filling the cache. Probes only endpoints worth probing.
pub async fn detect(cache: &GatewayCache, endpoints: &[ProviderEndpoint]) -> Option<(ProviderEndpoint, GatewayIdentity)> {
    let client = http_client();
    for ep in endpoints {
        if !worth_probing(&ep.base_url) || ep.api_key.trim().is_empty() {
            continue;
        }
        if let Some(cached) = cache.cached_identity(&ep.provider) {
            if let Some(id) = cached {
                return Some((ep.clone(), id));
            }
            continue;
        }
        let mut found: Option<GatewayIdentity> = None;
        for gw in gateways() {
            if let Some(id) = gw.identify(client, &ep.base_url, &ep.api_key, &ep.provider).await {
                found = Some(id);
                break;
            }
        }
        cache.remember_identity(&ep.provider, found.clone());
        if let Some(id) = found {
            return Some((ep.clone(), id));
        }
    }
    None
}

/// Ask the identified gateway for the period.
pub async fn fetch_spend(
    ep: &ProviderEndpoint,
    identity: &GatewayIdentity,
    start_utc: &str,
    end_utc: &str,
) -> Result<GatewaySpend, String> {
    let client = http_client();
    let gw = gateways()
        .into_iter()
        .find(|g| g.kind() == identity.kind)
        .ok_or_else(|| format!("unknown gateway kind {}", identity.kind))?;
    gw.spend(client, &ep.base_url, &ep.api_key, identity, start_utc, end_utc).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::UsageSlice;

    fn identity() -> GatewayIdentity {
        GatewayIdentity {
            kind: "litellm".into(),
            label: "LiteLLM".into(),
            host: "llm.corp".into(),
            provider: "anthropic".into(),
            key_alias: Some("me@corp".into()),
            key_hash: Some("330d5a".into()),
            key_spend_usd: Some(7061.0),
            key_max_budget_usd: Some(5400.0),
            budget_reset_at: None,
        }
    }

    fn ledger_model(model: &str, cost: f64, calls: i64, tokens: i64) -> ModelUsage {
        ModelUsage { model: model.into(), usage: UsageSlice::new(tokens, 0, 0, 0, cost, calls) }
    }

    #[test]
    fn host_and_probe_worthiness() {
        assert_eq!(host_of("https://llm.corp:4000/v1"), "llm.corp:4000");
        assert_eq!(host_of("llm.corp"), "llm.corp");
        assert!(worth_probing("https://llm.corp:4000"));
        assert!(!worth_probing("https://api.anthropic.com"));
        assert!(!worth_probing("http://localhost:11434/v1"));
        assert!(!worth_probing(""));
    }

    #[test]
    fn canonical_model_folds_gateway_routes_onto_catalog_names() {
        assert_eq!(canonical_model("bedrock/eu.anthropic.claude-sonnet-5"), "claude-sonnet-5");
        assert_eq!(canonical_model("claude-sonnet-5"), "claude-sonnet-5");
        assert_eq!(canonical_model("Claude-Sonnet-5[1m]"), "claude-sonnet-5");
        assert_eq!(canonical_model("bedrock/eu-north-1/moonshotai.kimi-k2.5"), "moonshotai.kimi-k2.5");
    }

    #[test]
    fn reconcile_reports_the_gap_per_model_and_per_request() {
        let spend = GatewaySpend {
            cost_usd: 9.85,
            requests: 114,
            prompt_tokens: 21_130_035,
            completion_tokens: 150_592,
            by_model: vec![
                GatewayModelSpend { model: "bedrock/eu.anthropic.claude-sonnet-5".into(), cost_usd: 9.43, requests: 100, prompt_tokens: 20_500_000, completion_tokens: 130_000 },
                GatewayModelSpend { model: "bedrock/eu-north-1/moonshotai.kimi-k2.5".into(), cost_usd: 0.42, requests: 14, prompt_tokens: 630_035, completion_tokens: 20_592 },
            ],
            requests_detail: Some(vec![
                GatewayRequest { id: "msg_a".into(), ts_utc: "2026-09-30T18:00:00Z".into(), model: "bedrock/eu.anthropic.claude-sonnet-5".into(), cost_usd: 0.10, prompt_tokens: 1, completion_tokens: 1, success: true },
                GatewayRequest { id: "msg_b".into(), ts_utc: "2026-09-30T18:01:00Z".into(), model: "bedrock/eu.anthropic.claude-sonnet-5".into(), cost_usd: 0.06, prompt_tokens: 1, completion_tokens: 1, success: true },
                GatewayRequest { id: "msg_c".into(), ts_utc: "2026-09-30T18:02:00Z".into(), model: "bedrock/eu-north-1/moonshotai.kimi-k2.5".into(), cost_usd: 0.03, prompt_tokens: 1, completion_tokens: 1, success: true },
                GatewayRequest { id: "msg_fail".into(), ts_utc: "2026-09-30T18:03:00Z".into(), model: "bedrock/eu.anthropic.claude-sonnet-5".into(), cost_usd: 0.0, prompt_tokens: 0, completion_tokens: 0, success: false },
            ]),
            basis: "logs".into(),
            note: None,
        };
        let ledger = LedgerSide {
            by_model: vec![
                ledger_model("claude-sonnet-5", 7.28, 75, 15_400_000),
                ledger_model("local-llm", 0.0, 3, 1000),
            ],
            ids: ["msg_a".to_string()].into_iter().collect(),
        };
        let r = reconcile(identity(), "s", "e", &spend, &ledger, "now");
        assert_eq!(r.gateway_requests, 114);
        assert_eq!(r.ledger_calls, 75);
        assert_eq!(r.ledger_tokens, 15_400_000);
        assert!((r.unaccounted_cost_usd - 2.57).abs() < 1e-9);
        assert_eq!(r.unaccounted_requests, 39);
        assert_eq!(r.ledger_only_models, vec!["local-llm".to_string()]);
        assert_eq!(r.by_model[0].model, "claude-sonnet-5");
        assert_eq!(r.by_model[0].ledger_calls, 75);
        assert_eq!(r.by_model[1].model, "moonshotai.kimi-k2.5");
        assert_eq!(r.by_model[1].ledger_calls, 0);
        // msg_a is in the ledger; the failed one never counts.
        assert_eq!(r.unmatched_requests, Some(2));
        assert!((r.unmatched_cost_usd.unwrap() - 0.09).abs() < 1e-9);
        assert_eq!(r.unmatched_by_model[0].model, "claude-sonnet-5");
        assert_eq!(r.unmatched_by_model[1].model, "moonshotai.kimi-k2.5");
        assert_eq!(r.basis, "logs");
    }

    #[test]
    fn reconcile_without_logs_has_no_request_matching_and_never_goes_negative() {
        let spend = GatewaySpend {
            cost_usd: 5.0,
            requests: 10,
            by_model: vec![GatewayModelSpend { model: "claude-sonnet-5".into(), cost_usd: 5.0, requests: 10, ..Default::default() }],
            basis: "daily".into(),
            note: Some("UTC days".into()),
            ..Default::default()
        };
        let ledger = LedgerSide {
            by_model: vec![ledger_model("claude-sonnet-5", 6.0, 12, 100)],
            ids: HashSet::new(),
        };
        let r = reconcile(identity(), "s", "e", &spend, &ledger, "now");
        assert_eq!(r.unmatched_requests, None);
        assert_eq!(r.unaccounted_cost_usd, 0.0);
        assert_eq!(r.unaccounted_requests, 0);
        assert_eq!(r.note.as_deref(), Some("UTC days"));
    }

    #[test]
    fn key_basis_is_a_running_total_so_it_reports_no_gap() {
        // The key's total since its last reset dwarfs any period's ledger;
        // that difference is not a gap and must not be shown as one.
        let spend = GatewaySpend { cost_usd: 7061.0, basis: "key".into(), ..Default::default() };
        let ledger = LedgerSide { by_model: vec![ledger_model("claude-sonnet-5", 40.0, 12, 100)], ids: HashSet::new() };
        let r = reconcile(identity(), "s", "e", &spend, &ledger, "now");
        assert_eq!(r.gateway_cost_usd, 7061.0, "the total itself is still shown");
        assert_eq!(r.unaccounted_cost_usd, 0.0);
        assert_eq!(r.unaccounted_requests, 0);
        assert_eq!(r.basis, "key");
    }

    #[test]
    fn bare_ids_drop_the_ledger_prefixes() {
        assert_eq!(bare_ledger_id("cc:req_1"), "req_1");
        assert_eq!(bare_ledger_id("cc:msg:msg_1"), "msg_1");
        assert_eq!(bare_ledger_id("direct:abc"), "direct:abc");
    }

    #[test]
    fn spend_cache_is_per_period_with_the_end_to_the_minute() {
        let cache = GatewayCache::default();
        let spend = GatewaySpend { basis: "logs".into(), ..Default::default() };
        let r = reconcile(identity(), "s", "e", &spend, &LedgerSide::default(), "now");
        cache.remember_spend("anthropic", "2026-09-01T00:00:00Z", "2026-09-30T22:59:11.000Z", r);
        // Same minute, later second: the poll is served from memory.
        assert!(cache.cached_spend("anthropic", "2026-09-01T00:00:00Z", "2026-09-30T22:59:41.000Z").is_some());
        // The next minute, or a different end day: asked again.
        assert!(cache.cached_spend("anthropic", "2026-09-01T00:00:00Z", "2026-09-30T23:00:01.000Z").is_none());
        assert!(cache.cached_spend("anthropic", "2026-09-01T00:00:00Z", "2026-09-05T22:59:59.999Z").is_none());
    }

    #[test]
    fn cache_serves_within_ttl_and_forgets_on_invalidate() {
        let cache = GatewayCache::default();
        assert!(cache.cached_identity("anthropic").is_none());
        cache.remember_identity("anthropic", None);
        assert_eq!(cache.cached_identity("anthropic"), Some(None));
        cache.remember_identity("anthropic", Some(identity()));
        assert_eq!(cache.cached_identity("anthropic").flatten().map(|i| i.host), Some("llm.corp".into()));
        cache.invalidate();
        assert!(cache.cached_identity("anthropic").is_none());
    }
}
