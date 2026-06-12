//! Anthropic Messages API implementation of the LlmProvider trait.

use super::{
    network_error, LlmContent, LlmMessage, LlmProvider, LlmRequest, LlmResponse, LlmRole,
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
        let url = format!("{}/v1/messages", api_base.trim_end_matches('/'));

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
    body
}

fn message_to_anthropic(msg: &LlmMessage) -> Value {
    let role = match msg.role {
        LlmRole::User => "user",
        LlmRole::Assistant => "assistant",
    };
    let content = match &msg.content {
        LlmContent::Text(t) => Value::String(t.clone()),
        LlmContent::AssistantWithTools { text, tool_uses } => {
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

    if let Some(content) = response.get("content").and_then(|c| c.as_array()) {
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
    }
}
