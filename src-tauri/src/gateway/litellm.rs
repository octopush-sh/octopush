//! LiteLLM — the proxy's own accounting, read with the same virtual key the
//! provider calls use.
//!
//! Three readings, best first, each a documented LiteLLM proxy endpoint:
//! - `GET /key/info` — who the key is (its hash, alias, running spend and
//!   budget). Answering this with an `info` object is what identifies a
//!   base URL as LiteLLM.
//! - `GET /spend/logs?api_key=<hash>&start_date&end_date` — one row per
//!   request, with the provider's response id: the reading that lets a
//!   request be matched against the ledger. Readable by the key for its own
//!   rows; an admin-only deployment answers 401/403 and we fall through.
//! - `GET /user/daily/activity?start_date&end_date` — per-day, per-model
//!   totals for the key's user. Whole UTC days, so the period is approximate.
//!
//! Every field is read tolerantly: a deployment a version ahead or behind
//! degrades to fewer figures, never to an error.

use super::{GatewayIdentity, GatewayModelSpend, GatewayRequest, GatewaySpend, SpendGateway};
use chrono::{DateTime, Duration, NaiveDateTime, Utc};
use serde_json::Value;
use std::collections::HashMap;

pub struct LiteLlm;

/// The proxy root the management endpoints hang off. Users paste the
/// Anthropic-style base (`https://llm.corp`, `…/v1`, `…/v1/messages`, or a
/// gateway subpath like `…/anthropic`); the management API lives at the
/// root of all of them.
pub fn root_url(base_url: &str) -> String {
    let mut base = base_url.trim().trim_end_matches('/');
    for suffix in ["/v1/messages", "/v1", "/anthropic", "/openai"] {
        if let Some(rest) = base.strip_suffix(suffix) {
            base = rest;
            break;
        }
    }
    base.trim_end_matches('/').to_string()
}

async fn get_json(client: &reqwest::Client, url: &str, api_key: &str) -> Result<(u16, Value), String> {
    let resp = client
        .get(url)
        .header("authorization", format!("Bearer {api_key}"))
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("{e}"))?;
    let status = resp.status().as_u16();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    Ok((status, body))
}

fn f64_of(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn i64_of(v: Option<&Value>) -> i64 {
    match v {
        Some(Value::Number(n)) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)).unwrap_or(0),
        Some(Value::String(s)) => s.trim().parse::<i64>().unwrap_or(0),
        _ => 0,
    }
}

fn str_of(v: Option<&Value>) -> Option<String> {
    v.and_then(|x| x.as_str()).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

/// `/key/info` → identity fields. `None` when the body is not LiteLLM's.
pub fn parse_key_info(body: &Value, host: &str, provider: &str) -> Option<GatewayIdentity> {
    let info = body.get("info")?.as_object()?;
    let g = |k: &str| info.get(k);
    // The hash LiteLLM keys its spend tables on. `token` in every version;
    // a raw `sk-` value in `key` (older builds echo the key) is never it.
    let key_hash = str_of(g("token")).or_else(|| str_of(body.get("key")).filter(|k| !k.starts_with("sk-")));
    Some(GatewayIdentity {
        kind: "litellm".into(),
        label: "LiteLLM".into(),
        host: host.to_string(),
        provider: provider.to_string(),
        key_alias: str_of(g("key_alias")).or_else(|| str_of(g("key_name"))),
        key_hash,
        key_spend_usd: f64_of(g("spend")),
        key_max_budget_usd: f64_of(g("max_budget")),
        budget_reset_at: str_of(g("budget_reset_at")),
    })
}

/// A LiteLLM timestamp (`2026-09-30T15:04:39.302000+00:00`, `…Z`, or a
/// naive `2026-09-30 15:04:39.302` meaning UTC) as a UTC instant.
pub fn parse_ts(s: &str) -> Option<DateTime<Utc>> {
    let s = s.trim();
    if let Ok(d) = DateTime::parse_from_rfc3339(s) {
        return Some(d.with_timezone(&Utc));
    }
    for fmt in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d %H:%M:%S"] {
        if let Ok(n) = NaiveDateTime::parse_from_str(s, fmt) {
            return Some(DateTime::<Utc>::from_naive_utc_and_offset(n, Utc));
        }
    }
    None
}

/// `/spend/logs` rows → requests within `[start, end]`.
pub fn parse_spend_logs(body: &Value, start: DateTime<Utc>, end: DateTime<Utc>) -> Option<Vec<GatewayRequest>> {
    let rows = body.as_array().or_else(|| body.get("data").and_then(|d| d.as_array()))?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let Some(id) = str_of(r.get("request_id")).or_else(|| str_of(r.get("id"))) else { continue };
        let Some(ts) = str_of(r.get("startTime")).or_else(|| str_of(r.get("start_time"))).and_then(|s| parse_ts(&s)) else { continue };
        if ts < start || ts > end {
            continue;
        }
        let model = str_of(r.get("model_group"))
            .or_else(|| str_of(r.get("model")))
            .unwrap_or_else(|| "unknown".into());
        let status = str_of(r.get("status")).unwrap_or_else(|| "success".into());
        out.push(GatewayRequest {
            id,
            ts_utc: ts.to_rfc3339(),
            model,
            cost_usd: f64_of(r.get("spend")).or_else(|| f64_of(r.get("cost"))).unwrap_or(0.0),
            prompt_tokens: i64_of(r.get("prompt_tokens")),
            completion_tokens: i64_of(r.get("completion_tokens")),
            success: !status.eq_ignore_ascii_case("failure") && !status.eq_ignore_ascii_case("failed"),
        });
    }
    Some(out)
}

/// Fold request rows into a spend (successful requests only — a failed
/// request carries no tokens and no charge).
pub fn spend_from_requests(rows: Vec<GatewayRequest>) -> GatewaySpend {
    let mut by: HashMap<String, GatewayModelSpend> = HashMap::new();
    let mut total = GatewaySpend { basis: "logs".into(), ..Default::default() };
    for r in rows.iter().filter(|r| r.success) {
        total.cost_usd += r.cost_usd;
        total.requests += 1;
        total.prompt_tokens += r.prompt_tokens;
        total.completion_tokens += r.completion_tokens;
        let e = by.entry(r.model.clone()).or_insert_with(|| GatewayModelSpend { model: r.model.clone(), ..Default::default() });
        e.cost_usd += r.cost_usd;
        e.requests += 1;
        e.prompt_tokens += r.prompt_tokens;
        e.completion_tokens += r.completion_tokens;
    }
    let mut by_model: Vec<GatewayModelSpend> = by.into_values().collect();
    by_model.sort_by(|a, b| b.cost_usd.partial_cmp(&a.cost_usd).unwrap_or(std::cmp::Ordering::Equal));
    total.by_model = by_model;
    total.requests_detail = Some(rows);
    total
}

/// `/user/daily/activity` → a spend over the UTC days that overlap the
/// period. `start_day`/`end_day` are `YYYY-MM-DD`.
pub fn parse_daily_activity(body: &Value, start_day: &str, end_day: &str) -> Option<GatewaySpend> {
    let results = body.get("results")?.as_array()?;
    let mut spend = GatewaySpend {
        basis: "daily".into(),
        note: Some("The gateway reports whole UTC days; the ledger follows your local day, so the edges of the period can differ.".into()),
        ..Default::default()
    };
    let mut by: HashMap<String, GatewayModelSpend> = HashMap::new();
    let mut any = false;
    for day in results {
        let Some(date) = str_of(day.get("date")) else { continue };
        if date.as_str() < start_day || date.as_str() > end_day {
            continue;
        }
        any = true;
        let m = day.get("metrics").cloned().unwrap_or(Value::Null);
        spend.cost_usd += f64_of(m.get("spend")).unwrap_or(0.0);
        spend.requests += {
            let ok = i64_of(m.get("successful_requests"));
            if ok > 0 { ok } else { i64_of(m.get("api_requests")) }
        };
        spend.prompt_tokens += i64_of(m.get("prompt_tokens"));
        spend.completion_tokens += i64_of(m.get("completion_tokens"));
        if let Some(models) = day.get("breakdown").and_then(|b| b.get("models")).and_then(|x| x.as_object()) {
            for (name, entry) in models {
                let mm = entry.get("metrics").cloned().unwrap_or_else(|| entry.clone());
                let e = by.entry(name.clone()).or_insert_with(|| GatewayModelSpend { model: name.clone(), ..Default::default() });
                e.cost_usd += f64_of(mm.get("spend")).unwrap_or(0.0);
                e.requests += {
                    let ok = i64_of(mm.get("successful_requests"));
                    if ok > 0 { ok } else { i64_of(mm.get("api_requests")) }
                };
                e.prompt_tokens += i64_of(mm.get("prompt_tokens"));
                e.completion_tokens += i64_of(mm.get("completion_tokens"));
            }
        }
    }
    if !any {
        return Some(spend);
    }
    let mut by_model: Vec<GatewayModelSpend> = by.into_values().collect();
    by_model.sort_by(|a, b| b.cost_usd.partial_cmp(&a.cost_usd).unwrap_or(std::cmp::Ordering::Equal));
    spend.by_model = by_model;
    Some(spend)
}

#[async_trait::async_trait]
impl SpendGateway for LiteLlm {
    fn kind(&self) -> &'static str {
        "litellm"
    }
    fn label(&self) -> &'static str {
        "LiteLLM"
    }

    async fn identify(&self, client: &reqwest::Client, base_url: &str, api_key: &str, provider: &str) -> Option<GatewayIdentity> {
        let root = root_url(base_url);
        let (status, body) = get_json(client, &format!("{root}/key/info"), api_key).await.ok()?;
        if status != 200 {
            return None;
        }
        parse_key_info(&body, &super::host_of(base_url), provider)
    }

    async fn spend(
        &self,
        client: &reqwest::Client,
        base_url: &str,
        api_key: &str,
        identity: &GatewayIdentity,
        start_utc: &str,
        end_utc: &str,
    ) -> Result<GatewaySpend, String> {
        let root = root_url(base_url);
        let start = parse_ts(start_utc).ok_or_else(|| format!("bad start {start_utc}"))?;
        let end = parse_ts(end_utc).ok_or_else(|| format!("bad end {end_utc}"))?;
        // The logs endpoint filters by UTC date; ask a day wide on each side
        // and cut to the instant here.
        let day_before = (start - Duration::days(1)).format("%Y-%m-%d").to_string();
        let day_after = (end + Duration::days(1)).format("%Y-%m-%d").to_string();
        if let Some(hash) = identity.key_hash.as_deref() {
            let url = format!("{root}/spend/logs?api_key={hash}&start_date={day_before}&end_date={day_after}");
            if let Ok((200, body)) = get_json(client, &url, api_key).await {
                if let Some(rows) = parse_spend_logs(&body, start, end) {
                    return Ok(spend_from_requests(rows));
                }
            }
        }
        let start_day = start.format("%Y-%m-%d").to_string();
        let end_day = end.format("%Y-%m-%d").to_string();
        let url = format!("{root}/user/daily/activity?start_date={start_day}&end_date={end_day}");
        if let Ok((200, body)) = get_json(client, &url, api_key).await {
            if let Some(spend) = parse_daily_activity(&body, &start_day, &end_day) {
                return Ok(spend);
            }
        }
        // Last resort: the key's running total, with no period at all.
        Ok(GatewaySpend {
            cost_usd: identity.key_spend_usd.unwrap_or(0.0),
            basis: "key".into(),
            note: Some(
                "Only the key's running total was readable. Per-period figures need the key to read its own spend logs on the gateway."
                    .into(),
            ),
            ..Default::default()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn root_url_strips_the_messages_base_but_keeps_ports_and_paths() {
        assert_eq!(root_url("https://llm.corp:4000/v1/messages"), "https://llm.corp:4000");
        assert_eq!(root_url("https://llm.corp/v1/"), "https://llm.corp");
        assert_eq!(root_url("https://llm.corp/anthropic"), "https://llm.corp");
        assert_eq!(root_url("https://llm.corp"), "https://llm.corp");
        assert_eq!(root_url("https://llm.corp/gateway/v1"), "https://llm.corp/gateway");
    }

    #[test]
    fn key_info_identifies_the_key_and_its_budget() {
        let body = json!({
            "key": "330d5a380095b897498ec17190c990677961950fa3dd7c79147cff732279f7f5",
            "info": {
                "token": "330d5a380095b897498ec17190c990677961950fa3dd7c79147cff732279f7f5",
                "key_alias": "johnatan@corp",
                "spend": 7061.178652579986,
                "max_budget": 5400.0,
                "budget_reset_at": "2026-10-01T00:00:00+00:00",
                "model_max_budget": {}
            }
        });
        let id = parse_key_info(&body, "llm.corp", "anthropic").expect("litellm");
        assert_eq!(id.kind, "litellm");
        assert_eq!(id.key_alias.as_deref(), Some("johnatan@corp"));
        assert_eq!(id.key_hash.as_deref().map(|h| &h[..6]), Some("330d5a"));
        assert_eq!(id.key_max_budget_usd, Some(5400.0));
        assert!((id.key_spend_usd.unwrap() - 7061.178652579986).abs() < 1e-9);
        // Not LiteLLM: no `info` object.
        assert!(parse_key_info(&json!({"error": "not found"}), "h", "p").is_none());
        // A raw key echoed in `key` is never taken as the hash.
        let raw = json!({"key": "sk-abc", "info": {"key_alias": "a"}});
        assert_eq!(parse_key_info(&raw, "h", "p").unwrap().key_hash, None);
    }

    #[test]
    fn timestamps_in_every_shape_litellm_emits() {
        assert!(parse_ts("2026-09-30T15:04:39.302000+00:00").is_some());
        assert!(parse_ts("2026-09-30T15:04:39Z").is_some());
        assert_eq!(parse_ts("2026-09-30 15:04:39.302").unwrap().to_rfc3339(), "2026-09-30T15:04:39.302+00:00");
        assert!(parse_ts("yesterday").is_none());
    }

    #[test]
    fn spend_logs_become_requests_cut_to_the_period_and_folded_by_model() {
        let body = json!([
            {"request_id": "msg_a", "startTime": "2026-09-30T18:00:00+00:00", "model": "bedrock/eu.anthropic.claude-sonnet-5", "model_group": "claude-sonnet-5", "spend": 0.06, "prompt_tokens": 271465, "completion_tokens": 18},
            {"request_id": "msg_b", "startTime": "2026-09-30T18:05:00+00:00", "model": "bedrock/eu-north-1/moonshotai.kimi-k2.5", "spend": 0.03, "prompt_tokens": 42000, "completion_tokens": 900, "status": "success"},
            {"request_id": "msg_old", "startTime": "2026-09-29T18:00:00+00:00", "model": "claude-sonnet-5", "spend": 5.0, "prompt_tokens": 1, "completion_tokens": 1},
            {"request_id": "msg_fail", "startTime": "2026-09-30T18:06:00+00:00", "model": "claude-sonnet-5", "spend": 0, "prompt_tokens": 0, "completion_tokens": 0, "status": "failure"},
            {"startTime": "2026-09-30T18:07:00+00:00", "model": "claude-sonnet-5", "spend": 1.0}
        ]);
        let start = parse_ts("2026-09-30T05:00:00Z").unwrap();
        let end = parse_ts("2026-09-30T23:00:00Z").unwrap();
        let rows = parse_spend_logs(&body, start, end).expect("array");
        assert_eq!(rows.len(), 3, "the old row and the id-less row are dropped");
        let spend = spend_from_requests(rows);
        assert_eq!(spend.basis, "logs");
        assert_eq!(spend.requests, 2, "the failed request is not a billed one");
        assert!((spend.cost_usd - 0.09).abs() < 1e-9);
        assert_eq!(spend.prompt_tokens, 271465 + 42000);
        assert_eq!(spend.by_model[0].model, "claude-sonnet-5");
        assert_eq!(spend.by_model[1].model, "bedrock/eu-north-1/moonshotai.kimi-k2.5");
        assert_eq!(spend.requests_detail.as_ref().unwrap().len(), 3);
        // A wrapped body works too.
        assert!(parse_spend_logs(&json!({"data": []}), start, end).is_some());
        assert!(parse_spend_logs(&json!({"error": "forbidden"}), start, end).is_none());
    }

    #[test]
    fn daily_activity_sums_the_overlapping_utc_days() {
        let body = json!({
            "results": [
                {"date": "2026-09-29", "metrics": {"spend": 102.7, "prompt_tokens": 1, "completion_tokens": 1, "api_requests": 613, "successful_requests": 613}},
                {"date": "2026-09-30", "metrics": {"spend": 9.85, "prompt_tokens": 21130035, "completion_tokens": 150592, "api_requests": 119, "successful_requests": 113, "failed_requests": 6},
                 "breakdown": {"models": {
                    "claude-sonnet-5": {"metrics": {"spend": 9.43, "successful_requests": 99, "prompt_tokens": 20500000, "completion_tokens": 130000}},
                    "kimi-k2-5": {"metrics": {"spend": 0.42, "successful_requests": 14, "prompt_tokens": 630035, "completion_tokens": 20592}}
                 }}}
            ]
        });
        let s = parse_daily_activity(&body, "2026-09-30", "2026-09-30").expect("results");
        assert_eq!(s.basis, "daily");
        assert!((s.cost_usd - 9.85).abs() < 1e-9);
        assert_eq!(s.requests, 113);
        assert_eq!(s.by_model[0].model, "claude-sonnet-5");
        assert_eq!(s.by_model[1].requests, 14);
        assert!(s.note.is_some());
        // No day in range: an empty spend, still on the daily basis.
        let none = parse_daily_activity(&body, "2026-10-05", "2026-10-06").unwrap();
        assert_eq!(none.requests, 0);
        assert!(parse_daily_activity(&json!({"detail": "unauthorized"}), "a", "b").is_none());
    }
}
