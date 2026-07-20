//! Anthropic Messages API implementation of the LlmProvider trait.

use super::{
    network_error, Effort, LlmContent, LlmMessage, LlmProvider, LlmRequest, LlmResponse, LlmRole,
    LlmStopReason, LlmToolUse, RateLimitSnapshot,
};
use crate::error::{AppError, AppResult, ProviderErrorKind};
use async_trait::async_trait;
use reqwest::header::HeaderMap;
use serde_json::{json, Value};

pub struct AnthropicProvider;

#[async_trait]
impl LlmProvider for AnthropicProvider {
    async fn complete(
        &self,
        api_base: &str,
        api_key: Option<&str>,
        req: &LlmRequest,
        client: &reqwest::Client,
    ) -> AppResult<LlmResponse> {
        let key = api_key.ok_or_else(|| {
            AppError::Other("Anthropic API key not configured.".into())
        })?;

        let body = build_request(req);
        let url = messages_url(api_base);

        let resp = client
            .post(&url)
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01")
            .header("anthropic-beta", "output-128k-2025-02-19")
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            // A request that never reached the server is transient — let the
            // retry layer ride it out rather than halting the stage.
            .map_err(|e| network_error(format!("Anthropic request failed: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            // Read `retry-after` BEFORE the body consumes the response.
            let retry_after = parse_retry_after(resp.headers());
            let text = resp.text().await.unwrap_or_default();
            return Err(AppError::Provider {
                kind: ProviderErrorKind::from_http_status(status.as_u16()),
                retry_after,
                // Keep the historical message shape — the UI and journals
                // already key off the embedded status + body text.
                message: format!("Anthropic API error {status}: {text}"),
            });
        }

        // Snapshot the rate-limit headers before the body consumes `resp`.
        let rate_limit = parse_rate_limit(resp.headers());
        let response: Value = resp
            .json()
            .await
            .map_err(|e| AppError::Other(format!("JSON parse error: {e}")))?;

        let mut parsed = parse_response(response);
        parsed.rate_limit = rate_limit;
        Ok(parsed)
    }
}

/// Resolve the Messages endpoint from a configured base URL. Users paste bases
/// in several shapes — bare host (`https://api.anthropic.com`), OpenAI-style
/// with `/v1`, or the full endpoint — so strip a trailing `/v1` or
/// `/v1/messages` before appending, never producing `/v1/v1/messages`.
/// Gateway subpaths (e.g. Moonshot's `/anthropic`) are preserved.
pub fn messages_url(api_base: &str) -> String {
    let base = api_base.trim_end_matches('/');
    let base = base
        .strip_suffix("/v1/messages")
        .or_else(|| base.strip_suffix("/v1"))
        .unwrap_or(base);
    format!("{base}/v1/messages")
}

/// Parse a `retry-after` header (delta-seconds form, per RFC 9110) into a
/// whole-second delay. Anthropic sends an integer-seconds value on 429.
fn parse_retry_after(headers: &HeaderMap) -> Option<u64> {
    headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
}

/// Extract Anthropic's input-token rate-limit headroom: how many input tokens
/// remain in the current window, and how long until it resets (converted from
/// the absolute RFC3339 `*-reset` timestamp to a forward-looking delay).
fn parse_rate_limit(headers: &HeaderMap) -> Option<RateLimitSnapshot> {
    let header_str = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());

    let input_tokens_remaining = header_str("anthropic-ratelimit-input-tokens-remaining")
        .and_then(|s| s.trim().parse::<u64>().ok());

    let reset_after_secs = header_str("anthropic-ratelimit-input-tokens-reset")
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s.trim()).ok())
        .map(|reset| {
            let delta = reset.timestamp_millis() - chrono::Utc::now().timestamp_millis();
            // Never report a negative (already-passed) reset as a wait.
            (delta as f64 / 1000.0).max(0.0)
        });

    if input_tokens_remaining.is_none() && reset_after_secs.is_none() {
        return None;
    }
    Some(RateLimitSnapshot {
        input_tokens_remaining,
        reset_after_secs,
    })
}

/// Whether a model takes the GA `output_config.effort` + `thinking:{adaptive}`
/// path. This is an ALLOWLIST, not "anything that isn't budget-only": a legacy
/// id (`claude-3-5-sonnet`) or an unknown id must NOT get thinking params (it
/// would 400) — it gets no thinking at all (see `thinking_json`).
fn is_effort_model(id: &str) -> bool {
    [
        "opus-4-5", "opus-4-6", "opus-4-7", "opus-4-8",
        "sonnet-4-6", "sonnet-5", "fable-5", "mythos-5",
    ]
    .iter()
    .any(|m| id.contains(m))
}

/// Whether a model takes the legacy `thinking:{enabled, budget_tokens}` path —
/// the thinking-but-not-effort models, which 400 on `output_config.effort`.
fn is_budget_model(id: &str) -> bool {
    ["haiku-4-5", "sonnet-4-5", "sonnet-4-0"]
        .iter()
        .any(|m| id.contains(m))
}

/// Whether a model accepts the top `xhigh` effort level. Only the newest
/// families do (Opus 4.7/4.8, Sonnet 5, Fable 5, Mythos 5); Opus 4.6 / Sonnet
/// 4.6 cap at `max` (no `xhigh`), and Opus 4.5 caps at `high`.
fn supports_xhigh(id: &str) -> bool {
    ["opus-4-7", "opus-4-8", "sonnet-5", "fable-5", "mythos-5"]
        .iter()
        .any(|m| id.contains(m))
}

/// Whether an effort-path model that isn't `xhigh`-capable still accepts `max`
/// (Opus 4.6 / Sonnet 4.6). Everything else on the effort path caps at `high`.
fn supports_max(id: &str) -> bool {
    id.contains("opus-4-6") || id.contains("sonnet-4-6")
}

/// Clamp a requested effort to the highest LEVEL a given effort-path model
/// actually accepts, so we never 400 by sending `xhigh` to Sonnet 4.6 (the
/// default) or `max` to Opus 4.5:
/// - `xhigh`-capable (Opus 4.7/4.8, Sonnet 5, Fable 5, Mythos 5) → pass as-is.
/// - `max`-capable (Opus 4.6, Sonnet 4.6) → `xhigh` folds to `high`; `max` kept.
/// - otherwise (Opus 4.5, unknown effort-path) → both `xhigh` and `max` fold to `high`.
pub fn effective_effort_level(model_id: &str, effort: Effort) -> &'static str {
    let id = model_id.to_ascii_lowercase();
    if supports_xhigh(&id) {
        effort.as_str()
    } else if supports_max(&id) {
        match effort {
            Effort::Xhigh => "high",
            other => other.as_str(),
        }
    } else {
        match effort {
            Effort::Xhigh | Effort::Max => "high",
            other => other.as_str(),
        }
    }
}

/// Thinking token budget for the legacy `budget_tokens` path (Haiku / Sonnet
/// 4.5). Only consulted for `is_budget_model` models.
fn budget_for_effort(effort: Effort) -> u32 {
    match effort {
        Effort::Low => 4096,
        Effort::Medium => 8192,
        Effort::High => 16384,
        Effort::Xhigh | Effort::Max => 24576,
    }
}

/// Resolve `(thinking, output_config)` JSON for a request, per the
/// model-capability matrix. Pure + unit-tested. Three-way, allowlist-based:
///
/// - `None` effort ⇒ `(None, None)` — no thinking params at all.
/// - Effort model (Opus 4.5–4.8, Sonnet 4.6/5, Fable 5, Mythos 5) ⇒
///   `thinking:{type:"adaptive"}` + `output_config:{effort:"<level>"}`, the
///   level clamped per model (`effective_effort_level`).
/// - Budget model (Haiku 4.5, Sonnet 4.5/4.0) ⇒
///   `thinking:{type:"enabled", budget_tokens:N}` with N clamped to
///   `[1024, max_tokens-1]`, and no `output_config` (it would 400).
/// - Otherwise (legacy `claude-3-5-*`, unknown id) ⇒ `(None, None)`: effort is
///   silently ignored rather than 400ing on a model that can't think.
pub fn thinking_json(
    model_id: &str,
    effort: Option<Effort>,
    max_tokens: u32,
) -> (Option<Value>, Option<Value>) {
    let Some(effort) = effort else {
        return (None, None);
    };
    let id = model_id.to_ascii_lowercase();
    if is_effort_model(&id) {
        (
            Some(json!({ "type": "adaptive" })),
            // Clamp the LEVEL to what this specific effort model accepts.
            Some(json!({ "effort": effective_effort_level(model_id, effort) })),
        )
    } else if is_budget_model(&id) {
        // budget_tokens must be < max_tokens and >= the 1024 API floor.
        let ceiling = max_tokens.saturating_sub(1).max(1024);
        let budget = budget_for_effort(effort).clamp(1024, ceiling);
        (
            Some(json!({ "type": "enabled", "budget_tokens": budget })),
            None,
        )
    } else {
        // Legacy / unknown model: can't take either thinking form — omit both.
        (None, None)
    }
}

/// Build the Anthropic Messages API JSON body from a normalized `LlmRequest`.
/// Exported so tests in Task 6 can call it directly.
pub fn build_request(req: &LlmRequest) -> Value {
    let messages: Vec<Value> = req.messages.iter().map(message_to_anthropic).collect();
    let tools: Vec<Value> = req.tools.iter().map(|t| json!({
        "name": t.name,
        "description": t.description,
        "input_schema": t.input_schema,
    })).collect();

    let mut body = json!({
        "model": req.model,
        "max_tokens": req.max_tokens,
        "system": req.system,
        "tools": tools,
        "messages": messages,
    });
    if let Some(name) = &req.tool_choice {
        body["tool_choice"] = json!({ "type": "tool", "name": name });
    }
    // Reasoning effort → thinking / output_config, per the model matrix. NOTE:
    // `temperature` stays ABSENT — current models 400 when it accompanies
    // thinking, and this builder has never sent it. Keep it that way.
    let (thinking, output_config) = thinking_json(&req.model, req.effort, req.max_tokens);
    if let Some(thinking) = thinking {
        body["thinking"] = thinking;
    }
    if let Some(output_config) = output_config {
        body["output_config"] = output_config;
    }
    body
}

fn message_to_anthropic(msg: &LlmMessage) -> Value {
    let role = match msg.role {
        LlmRole::User => "user",
        LlmRole::Assistant => "assistant",
    };
    let content = match &msg.content {
        LlmContent::Text(t) => Value::String(t.clone()),
        LlmContent::Multimodal(blocks) => {
            let arr: Vec<Value> = blocks
                .iter()
                .map(|b| match b {
                    crate::providers::LlmBlock::Text(t) => json!({ "type": "text", "text": t }),
                    crate::providers::LlmBlock::Image { media_type, data } => json!({
                        "type": "image",
                        "source": { "type": "base64", "media_type": media_type, "data": data },
                    }),
                })
                .collect();
            Value::Array(arr)
        }
        LlmContent::AssistantWithTools { raw, text, tool_uses } => {
            // Replay the captured content array VERBATIM and in order — signed
            // thinking survives and interleaved thinking/tool_use ordering is
            // preserved (reordering 400s the next request). Fall back to
            // rebuilding from text + tool_uses when no raw array was captured
            // (TALK, the truncation path, OpenAI-origin turns).
            if !raw.is_empty() {
                return json!({ "role": role, "content": Value::Array(raw.clone()) });
            }
            let mut arr: Vec<Value> = Vec::new();
            if !text.is_empty() {
                arr.push(json!({ "type": "text", "text": text }));
            }
            for u in tool_uses {
                arr.push(json!({
                    "type": "tool_use",
                    "id": u.id,
                    "name": u.name,
                    "input": u.input,
                }));
            }
            Value::Array(arr)
        }
        LlmContent::ToolResults(results) => {
            let arr: Vec<Value> = results.iter().map(|r| json!({
                "type": "tool_result",
                "tool_use_id": r.tool_use_id,
                "content": r.content,
                "is_error": r.is_error,
            })).collect();
            Value::Array(arr)
        }
    };
    json!({ "role": role, "content": content })
}

/// Parse an Anthropic Messages API JSON response into a normalized `LlmResponse`.
/// Exported so tests in Task 6 can call it directly.
pub fn parse_response(response: Value) -> LlmResponse {
    let mut text = String::new();
    let mut tool_uses = Vec::new();
    let mut raw_content: Vec<Value> = Vec::new();

    if let Some(content) = response.get("content").and_then(|c| c.as_array()) {
        // Keep the ENTIRE content array verbatim (every block, in order) so the
        // next assistant turn can replay it unchanged — signed thinking survives
        // and interleaved thinking/tool_use ordering is preserved.
        raw_content = content.clone();
        for block in content {
            match block.get("type").and_then(|t| t.as_str()) {
                Some("text") => {
                    if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                        text.push_str(t);
                    }
                }
                Some("tool_use") => {
                    let id = block.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let input = block.get("input").cloned().unwrap_or(json!({}));
                    tool_uses.push(LlmToolUse { id, name, input });
                }
                _ => {}
            }
        }
    }

    let stop_reason = match response.get("stop_reason").and_then(|s| s.as_str()) {
        Some("end_turn") => LlmStopReason::EndTurn,
        Some("tool_use") => LlmStopReason::ToolUse,
        Some("max_tokens") => LlmStopReason::MaxTokens,
        Some(other) => LlmStopReason::Other(other.to_string()),
        None => LlmStopReason::EndTurn,
    };

    let usage = response.get("usage");
    let input_tokens = usage
        .and_then(|u| u.get("input_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let output_tokens = usage
        .and_then(|u| u.get("output_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let cache_read_tokens = usage
        .and_then(|u| u.get("cache_read_input_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let cache_creation_tokens = usage
        .and_then(|u| u.get("cache_creation_input_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    LlmResponse {
        text,
        tool_uses,
        stop_reason,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_creation_tokens,
        // Filled by `complete()` from response headers; the pure parser has none.
        rate_limit: None,
        raw_content,
    }
}
