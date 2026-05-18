//! Anthropic Messages API implementation of the LlmProvider trait.

use super::{
    LlmContent, LlmMessage, LlmProvider, LlmRequest, LlmResponse, LlmRole,
    LlmStopReason, LlmToolUse,
};
use crate::error::{AppError, AppResult};
use async_trait::async_trait;
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
            .map_err(|e| AppError::Other(format!("Anthropic request failed: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(AppError::Other(format!("Anthropic API error {status}: {text}")));
        }

        let response: Value = resp.json().await
            .map_err(|e| AppError::Other(format!("JSON parse error: {e}")))?;

        Ok(parse_response(response))
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

    json!({
        "model": req.model,
        "max_tokens": req.max_tokens,
        "system": req.system,
        "tools": tools,
        "messages": messages,
    })
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

    let input_tokens = response.get("usage")
        .and_then(|u| u.get("input_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let output_tokens = response.get("usage")
        .and_then(|u| u.get("output_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    LlmResponse {
        text,
        tool_uses,
        stop_reason,
        input_tokens,
        output_tokens,
    }
}
