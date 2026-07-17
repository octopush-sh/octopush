//! OpenAI Chat Completions API implementation of the LlmProvider trait.
//!
//! Used by OpenAI proper, DeepSeek, Ollama (via /v1/chat/completions), and
//! any self-hosted server that speaks the OpenAI Chat Completions protocol
//! (vllm, llama.cpp server, LMStudio, LocalAI, etc.).

use super::{
    network_error, LlmContent, LlmMessage, LlmProvider, LlmRequest, LlmResponse, LlmRole,
    LlmStopReason, LlmToolUse,
};
use crate::error::{AppError, AppResult, ProviderErrorKind};
use async_trait::async_trait;
use serde_json::{json, Value};

pub struct OpenAICompatibleProvider;

#[async_trait]
impl LlmProvider for OpenAICompatibleProvider {
    async fn complete(
        &self,
        api_base: &str,
        api_key: Option<&str>,
        req: &LlmRequest,
        client: &reqwest::Client,
    ) -> AppResult<LlmResponse> {
        let body = build_request(req);
        let url = format!("{}/chat/completions", api_base.trim_end_matches('/'));

        let mut request = client.post(&url)
            .header("content-type", "application/json")
            .json(&body);

        // Some local providers (Ollama) don't require an Authorization header.
        if let Some(key) = api_key {
            if !key.is_empty() {
                request = request.header("Authorization", format!("Bearer {}", key));
            }
        }

        let resp = request.send().await
            // A request that never reached the server is transient.
            .map_err(|e| network_error(format!("OpenAI-compat request failed: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let retry_after = resp
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.trim().parse::<u64>().ok());
            let text = resp.text().await.unwrap_or_default();
            return Err(AppError::Provider {
                kind: ProviderErrorKind::from_http_status(status.as_u16()),
                retry_after,
                message: format!("OpenAI-compat API error {status}: {text}"),
            });
        }

        let response: Value = resp.json().await
            .map_err(|e| AppError::Other(format!("JSON parse error: {e}")))?;

        Ok(parse_response(response))
    }
}

pub fn build_request(req: &LlmRequest) -> Value {
    // OpenAI puts system prompt as the first message with role="system" rather
    // than a top-level field.
    let mut messages: Vec<Value> = Vec::with_capacity(req.messages.len() + 1);
    if !req.system.is_empty() {
        messages.push(json!({
            "role": "system",
            "content": req.system,
        }));
    }
    for m in &req.messages {
        messages.extend(message_to_openai(m));
    }

    // OpenAI tools use a different wrapper shape.
    let tools: Vec<Value> = req.tools.iter().map(|t| json!({
        "type": "function",
        "function": {
            "name": t.name,
            "description": t.description,
            "parameters": t.input_schema,
        },
    })).collect();

    let mut body = json!({
        "model": req.model,
        "messages": messages,
        "max_tokens": req.max_tokens,
    });
    if !tools.is_empty() {
        body["tools"] = Value::Array(tools);
    }
    if let Some(name) = &req.tool_choice {
        body["tool_choice"] = json!({ "type": "function", "function": { "name": name } });
    }
    body
}

/// Returns 1 or more OpenAI-format messages from a normalized LlmMessage.
/// A single ToolResults entry can produce multiple `role=tool` messages.
fn message_to_openai(msg: &LlmMessage) -> Vec<Value> {
    match (&msg.role, &msg.content) {
        (LlmRole::User, LlmContent::Text(t)) => vec![json!({
            "role": "user",
            "content": t,
        })],
        (_, LlmContent::Multimodal(blocks)) => {
            // OpenAI vision: text parts + image_url parts with base64 data URLs.
            let parts: Vec<Value> = blocks
                .iter()
                .map(|b| match b {
                    crate::providers::LlmBlock::Text(t) => json!({ "type": "text", "text": t }),
                    crate::providers::LlmBlock::Image { media_type, data } => json!({
                        "type": "image_url",
                        "image_url": { "url": format!("data:{media_type};base64,{data}") },
                    }),
                })
                .collect();
            vec![json!({ "role": "user", "content": parts })]
        }
        (LlmRole::Assistant, LlmContent::Text(t)) => vec![json!({
            "role": "assistant",
            "content": t,
        })],
        (LlmRole::Assistant, LlmContent::AssistantWithTools { text, tool_uses }) => {
            // Single assistant message with tool_calls array.
            let tool_calls: Vec<Value> = tool_uses.iter().map(|u| json!({
                "id": u.id,
                "type": "function",
                "function": {
                    "name": u.name,
                    // OpenAI expects arguments as a STRING containing JSON, not a
                    // structured object — undocumented but consistent across vendors.
                    "arguments": serde_json::to_string(&u.input).unwrap_or_else(|_| "{}".into()),
                },
            })).collect();
            let mut obj = json!({
                "role": "assistant",
                "tool_calls": tool_calls,
            });
            if !text.is_empty() {
                obj["content"] = Value::String(text.clone());
            } else {
                // OpenAI allows null content when tool_calls is set.
                obj["content"] = Value::Null;
            }
            vec![obj]
        }
        (LlmRole::User, LlmContent::ToolResults(results)) => {
            // Each tool result becomes its own role=tool message.
            results.iter().map(|r| json!({
                "role": "tool",
                "tool_call_id": r.tool_use_id,
                "content": r.content,
            })).collect()
        }
        // Defensive: malformed combinations
        _ => vec![json!({ "role": "user", "content": "" })],
    }
}

pub fn parse_response(response: Value) -> LlmResponse {
    let mut text = String::new();
    let mut tool_uses: Vec<LlmToolUse> = Vec::new();

    let choice = response.get("choices")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.first());

    if let Some(choice) = choice {
        if let Some(msg) = choice.get("message") {
            if let Some(t) = msg.get("content").and_then(|c| c.as_str()) {
                text.push_str(t);
            }
            if let Some(calls) = msg.get("tool_calls").and_then(|c| c.as_array()) {
                for call in calls {
                    let id = call.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let func = call.get("function");
                    let name = func.and_then(|f| f.get("name")).and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let args_str = func.and_then(|f| f.get("arguments")).and_then(|v| v.as_str()).unwrap_or("{}");
                    let input: Value = serde_json::from_str(args_str).unwrap_or_else(|_| json!({}));
                    tool_uses.push(LlmToolUse { id, name, input });
                }
            }
        }
    }

    let stop_reason = match choice
        .and_then(|c| c.get("finish_reason"))
        .and_then(|s| s.as_str())
    {
        Some("stop") => LlmStopReason::EndTurn,
        Some("tool_calls") => LlmStopReason::ToolUse,
        Some("length") => LlmStopReason::MaxTokens,
        Some(other) => LlmStopReason::Other(other.to_string()),
        None => {
            // Ollama omits finish_reason but if tool_calls were present we treat as ToolUse.
            if !tool_uses.is_empty() {
                LlmStopReason::ToolUse
            } else {
                LlmStopReason::EndTurn
            }
        }
    };

    let prompt_tokens = response.get("usage")
        .and_then(|u| u.get("prompt_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let output_tokens = response.get("usage")
        .and_then(|u| u.get("completion_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    // OpenAI-compatible providers report cached prompt tokens under
    // `usage.prompt_tokens_details.cached_tokens` (DeepSeek uses the same key).
    // Crucially, `prompt_tokens` is the FULL prompt count and already INCLUDES
    // the cached ones, so we subtract to get the billable (fresh) input and
    // surface the cached slice separately — otherwise cached input is priced at
    // the full input rate. Providers that omit the field report 0 (no change).
    let cache_read_tokens = response.get("usage")
        .and_then(|u| u.get("prompt_tokens_details"))
        .and_then(|d| d.get("cached_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0)
        .min(prompt_tokens);
    let input_tokens = prompt_tokens - cache_read_tokens;

    LlmResponse {
        text,
        tool_uses,
        stop_reason,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        // OpenAI-style caching has no separate cache-write line — only reads.
        cache_creation_tokens: 0,
        // Header-based rate-limit hints are Anthropic-specific; none here.
        rate_limit: None,
    }
}
