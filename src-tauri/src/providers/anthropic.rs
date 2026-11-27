//! Anthropic Messages API implementation of the LlmProvider trait.

use super::sse::{ByteSource, SseReader};
use super::{
    Effort, LlmContent, LlmMessage, LlmProvider, LlmRequest, LlmResponse, LlmRole,
    LlmStopReason, LlmToolUse, RateLimitSnapshot, StreamEvent,
};
use crate::error::{AppError, AppResult, ProviderErrorKind};
use async_trait::async_trait;
use reqwest::header::HeaderMap;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

pub struct AnthropicProvider;

/// How a request error's message opens.
const WHAT: &str = "Anthropic request failed";

/// How long an Anthropic stream may send nothing (`super::stream_idle`): the
/// API sends `ping`s while it works, so a silent minute means it is gone.
pub const STREAM_IDLE: Duration = Duration::from_secs(60);

#[async_trait]
impl LlmProvider for AnthropicProvider {
    async fn complete(
        &self,
        api_base: &str,
        api_key: Option<&str>,
        req: &LlmRequest,
        client: &reqwest::Client,
    ) -> AppResult<LlmResponse> {
        let resp = post_messages(api_base, api_key, &build_request(req), client).await?;

        // Snapshot the rate-limit headers before the body consumes `resp`.
        let rate_limit = parse_rate_limit(resp.headers());
        // Read the body first: a connection lost mid-answer is not a JSON error.
        let bytes = resp.bytes().await.map_err(|e| super::body_error(WHAT, &e))?;
        let response: Value = serde_json::from_slice(&bytes)
            .map_err(|e| AppError::Other(format!("JSON parse error: {e}")))?;

        let mut parsed = parse_response(response);
        parsed.rate_limit = rate_limit;
        Ok(parsed)
    }

    /// The same request with `stream: true`, read by `read_stream`.
    async fn stream(
        &self,
        api_base: &str,
        api_key: Option<&str>,
        req: &LlmRequest,
        client: &reqwest::Client,
        sink: &mut (dyn FnMut(StreamEvent) + Send),
    ) -> AppResult<LlmResponse> {
        let mut body = build_request(req);
        body["stream"] = Value::Bool(true);
        let resp = post_messages(api_base, api_key, &body, client).await?;
        let rate_limit = parse_rate_limit(resp.headers());
        // A model server on this Mac may think for longer than any bound.
        let idle = super::stream_idle(api_base, STREAM_IDLE);
        let mut parsed = read_stream(super::sse::Body(resp, WHAT), idle, sink).await?;
        parsed.rate_limit = rate_limit;
        Ok(parsed)
    }
}

/// POST `body` to the Messages endpoint; a non-success status becomes the
/// classified provider error. Shared by `complete` and `stream`.
async fn post_messages(
    api_base: &str,
    api_key: Option<&str>,
    body: &Value,
    client: &reqwest::Client,
) -> AppResult<reqwest::Response> {
    // An auth failure, so Talk's error card offers to configure the key.
    let key = api_key.ok_or_else(|| AppError::Provider {
        kind: ProviderErrorKind::Auth,
        retry_after: None,
        message: "Anthropic API key not configured.".into(),
    })?;

    let url = messages_url(api_base);
    // A model server on this Mac gets the loopback client (no read bound).
    let client = super::client_for(api_base, client);

    let resp = client
        .post(&url)
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", "output-128k-2025-02-19")
        .header("content-type", "application/json")
        .json(body)
        .send()
        .await
        // Only a connection that never opened is transient (the retry
        // layer sends it again); a request that went out and wasn't
        // answered is final (`request_error`).
        .map_err(|e| super::request_error(WHAT, api_base, &e))?;

    if !resp.status().is_success() {
        return Err(super::status_error("Anthropic API error", resp).await);
    }
    Ok(resp)
}

/// Read a Messages stream to its end and assemble the answer. Apart from
/// `stream` so fixture transcripts can drive it with no network.
pub async fn read_stream<S: ByteSource>(
    source: S,
    idle: Option<Duration>,
    sink: &mut (dyn FnMut(StreamEvent) + Send),
) -> AppResult<LlmResponse> {
    let mut reader = SseReader::new(source, idle, WHAT);
    let mut message = StreamedMessage::default();
    while let Some(event) = reader.next().await? {
        if message.apply(&event.data, sink)? {
            break;
        }
    }
    message.finish()
}

/// A Messages stream folded back into the message a non-streamed request
/// returns whole, so both end in `parse_response`. Per the streaming format:
/// `message_start` holds the message with empty `content`; each block opens
/// at its final `index`, grows by deltas and closes; `message_delta` sets
/// `stop_reason` and cumulative `usage`; `message_stop` ends it. `ping` and
/// unknown event types are skipped.
#[derive(Default)]
struct StreamedMessage {
    message: Option<Value>,
    blocks: BTreeMap<usize, Value>,
    /// Each block's input JSON so far (a `tool_use` sends it in pieces).
    input: BTreeMap<usize, String>,
    /// Blocks announced to the sink as tool calls.
    tools: BTreeSet<usize>,
    complete: bool,
}

impl StreamedMessage {
    /// Apply one event's `data`. `Ok(true)` once the message is complete.
    fn apply(&mut self, data: &str, sink: &mut (dyn FnMut(StreamEvent) + Send)) -> AppResult<bool> {
        let event: Value = serde_json::from_str(data)
            .map_err(|e| AppError::Other(format!("Anthropic stream: unreadable event ({e}): {data}")))?;
        let index = event.get("index").and_then(Value::as_u64).map(|i| i as usize);
        match str_at(&event, "type") {
            "message_start" => self.message = event.get("message").cloned(),
            "content_block_start" => {
                let (Some(i), Some(block)) = (index, event.get("content_block")) else { return Ok(false) };
                if str_at(block, "type") == "tool_use" {
                    self.tools.insert(i);
                    sink(StreamEvent::ToolStart { index: i, id: str_at(block, "id").into(), name: str_at(block, "name").into() });
                }
                self.blocks.insert(i, block.clone());
            }
            "content_block_delta" => {
                let (Some(i), Some(delta)) = (index, event.get("delta")) else { return Ok(false) };
                let Some(block) = self.blocks.get_mut(&i).and_then(Value::as_object_mut) else { return Ok(false) };
                match str_at(delta, "type") {
                    "text_delta" => {
                        let text = str_at(delta, "text");
                        append(block, "text", text);
                        if !text.is_empty() {
                            sink(StreamEvent::Text(text.into()));
                        }
                    }
                    "input_json_delta" => {
                        let partial = str_at(delta, "partial_json");
                        self.input.entry(i).or_default().push_str(partial);
                        if self.tools.contains(&i) && !partial.is_empty() {
                            sink(StreamEvent::ToolInput { index: i, partial: partial.into() });
                        }
                    }
                    "thinking_delta" => append(block, "thinking", str_at(delta, "thinking")),
                    "signature_delta" => append(block, "signature", str_at(delta, "signature")),
                    _ => {}
                }
            }
            "content_block_stop" => {
                let Some(i) = index else { return Ok(false) };
                // Pieces that add up to nothing leave the block's own `{}`.
                if let Some(json) = self.input.remove(&i).filter(|j| !j.trim().is_empty()) {
                    let input: Value = serde_json::from_str(&json).map_err(|e| {
                        AppError::Other(format!("Anthropic stream: a tool call's input isn't valid JSON ({e}): {json}"))
                    })?;
                    if let Some(block) = self.blocks.get_mut(&i).and_then(Value::as_object_mut) {
                        block.insert("input".into(), input);
                    }
                }
                if self.tools.contains(&i) {
                    sink(StreamEvent::ToolEnd { index: i });
                }
            }
            "message_delta" => {
                let message = self.message.get_or_insert_with(|| json!({}));
                if let Some(message) = message.as_object_mut() {
                    if let Some(delta) = event.get("delta").and_then(Value::as_object) {
                        merge(message, delta);
                    }
                    if let Some(usage) = event.get("usage").and_then(Value::as_object) {
                        let total = message.entry("usage").or_insert_with(|| json!({}));
                        if let Some(total) = total.as_object_mut() {
                            // A null never replaces a count `message_start` gave.
                            let counts = usage.iter().filter(|(_, v)| !v.is_null());
                            total.extend(counts.map(|(k, v)| (k.clone(), v.clone())));
                        }
                    }
                }
            }
            "message_stop" => {
                self.complete = true;
                return Ok(true);
            }
            "error" => return Err(stream_error(&event, data)),
            _ => {}
        }
        Ok(false)
    }

    /// The assembled answer, parsed as `complete` parses a whole response.
    fn finish(self) -> AppResult<LlmResponse> {
        if !self.complete {
            return Err(super::cut_off_error(WHAT));
        }
        let mut message = match self.message {
            Some(Value::Object(message)) => message,
            _ => Map::new(),
        };
        message.insert("content".into(), Value::Array(self.blocks.into_values().collect()));
        Ok(parse_response(Value::Object(message)))
    }
}

/// `value[key]` as a string, empty when absent.
fn str_at<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

/// Append `piece` to the string field `key` of a block.
fn append(block: &mut Map<String, Value>, key: &str, piece: &str) {
    match block.get_mut(key) {
        Some(Value::String(text)) => text.push_str(piece),
        _ => {
            block.insert(key.into(), Value::String(piece.into()));
        }
    }
}

fn merge(into: &mut Map<String, Value>, from: &Map<String, Value>) {
    for (key, value) in from {
        into.insert(key.clone(), value.clone());
    }
}

/// An `error` event in the stream, classified like the HTTP status its
/// documented error type stands for (`overloaded_error` is a 529), so the
/// retry layer treats it the same way.
fn stream_error(event: &Value, data: &str) -> AppError {
    let kind = match event.get("error").map(|e| str_at(e, "type")).unwrap_or("") {
        "overloaded_error" => ProviderErrorKind::Overloaded,
        "rate_limit_error" => ProviderErrorKind::RateLimit,
        "api_error" => ProviderErrorKind::ServerError,
        "authentication_error" | "permission_error" => ProviderErrorKind::Auth,
        "invalid_request_error" | "not_found_error" | "request_too_large" => ProviderErrorKind::BadRequest,
        _ => ProviderErrorKind::Other,
    };
    AppError::Provider { kind, retry_after: None, message: format!("Anthropic API error in the stream: {data}") }
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
/// would 400) — it gets no thinking at all (see `thinking_json`). Every entry
/// is a model Claude's thinking table lists as taking `adaptive` and the
/// effort page lists as taking effort (Opus 4.6–5.5, Sonnet 4.6–5.5, Haiku
/// 5.5, Fable 5–5.2, Mythos 5–5.2); an id that can't be checked against those
/// tables stays out of every list.
fn is_effort_model(id: &str) -> bool {
    [
        "opus-4-6", "opus-4-7", "opus-4-8", "opus-5",
        "sonnet-4-6", "sonnet-5", "haiku-5", "fable-5", "mythos-5",
    ]
    .iter()
    .any(|m| id.contains(m))
}

/// Whether a model takes the legacy `thinking:{enabled, budget_tokens}` path:
/// the models whose only thinking mode is that manual form and which reject
/// `adaptive` with a 400 (Claude's thinking table: Opus 4.5, Haiku 4.5,
/// Sonnet 4.5, and Sonnet 4). They get no `output_config`.
fn is_budget_model(id: &str) -> bool {
    ["opus-4-5", "haiku-4-5", "sonnet-4-5", "sonnet-4-0"]
        .iter()
        .any(|m| id.contains(m))
}

/// Whether a model accepts the top `xhigh` effort level. Only the newest
/// families do (Opus 4.7/4.8, Sonnet 5, Haiku 5.5, Fable 5, Mythos 5); Opus 4.6 / Sonnet
/// 4.6 cap at `max` (no `xhigh`).
fn supports_xhigh(id: &str) -> bool {
    ["opus-4-7", "opus-4-8", "opus-5", "sonnet-5", "haiku-5", "fable-5", "mythos-5"]
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
/// default):
/// - `xhigh`-capable (Opus 4.7/4.8, Sonnet 5, Haiku 5.5, Fable 5, Mythos 5) → pass as-is.
/// - `max`-capable (Opus 4.6, Sonnet 4.6) → `xhigh` folds to `high`; `max` kept.
/// - otherwise (an unknown effort-path id) → both `xhigh` and `max` fold to `high`.
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
        Effort::Least | Effort::Low => 4096,
        Effort::Medium => 8192,
        Effort::High => 16384,
        Effort::Xhigh | Effort::Max => 24576,
    }
}

/// Resolve `(thinking, output_config)` JSON for a request, per the
/// model-capability matrix. Pure + unit-tested. Three-way, allowlist-based:
///
/// - `None` effort ⇒ `(None, None)` — no thinking params at all.
/// - `Least` (Talk's Swift) ⇒ `output_config:{effort:"low"}` alone on an
///   effort model, so thinking stays at the model's default, and nothing on
///   any other model.
/// - Effort model (Opus 4.6–5, Sonnet 4.6/5, Haiku 5.5, Fable 5, Mythos 5) ⇒
///   `thinking:{type:"adaptive"}` + `output_config:{effort:"<level>"}`, the
///   level clamped per model (`effective_effort_level`).
/// - Budget model (Opus 4.5, Haiku 4.5, Sonnet 4.5/4.0) ⇒
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
    // Talk's Swift never reasons more than the model's default: lower the
    // effort, never turn thinking on (Opus 4.6–4.8 and Sonnet 4.6 think only
    // when asked). A budget-only or unknown model gets nothing.
    if effort == Effort::Least {
        return if is_effort_model(&id) { (None, Some(json!({ "effort": "low" }))) } else { (None, None) };
    }
    if is_effort_model(&id) {
        (
            Some(json!({ "type": "adaptive" })),
            // Clamp the LEVEL to what this specific effort model accepts.
            Some(json!({ "effort": effective_effort_level(model_id, effort) })),
        )
    } else if is_budget_model(&id) {
        // `low` on a model whose thinking is off unless asked for (Haiku 4.5,
        // Sonnet 4.5) means the cheapest thing that works: no thinking at
        // all — the fast tier's sub-agents must not pay for a budget they
        // never had. Medium and up buy one.
        if effort == Effort::Low {
            return (None, None);
        }
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
    let mut messages: Vec<Value> = req.messages.iter().map(message_to_anthropic).collect();
    let mut tools: Vec<Value> = req.tools.iter().map(|t| json!({
        "name": t.name,
        "description": t.description,
        "input_schema": t.input_schema,
    })).collect();

    // Prompt caching (Anthropic-native, opt-in per `req.cache`). Mark the stable
    // prefixes with ephemeral cache breakpoints so context re-sent within the
    // cache TTL is billed at ~0.1× on a hit instead of full input price. The API
    // caches in request order — tools → system → messages — so we drop a
    // breakpoint at the tail of each: the last tool, the system block, and the
    // last block of the last message (≤4 breakpoints; we use ≤3). Each request's
    // trailing breakpoint becomes the next request's cached prefix, which is what
    // makes an agentic loop's growing history cache incrementally. Below the
    // model's minimum cacheable prefix the API silently skips caching — no error,
    // no charge. Cache-hit tokens are already parsed (`parse_response`) and priced
    // cache-aware (`token_engine::cost_for`). Disabled for one-shots so we never
    // pay a 1.25× write we won't read back.
    if req.cache {
        if let Some(last_tool) = tools.last_mut() {
            last_tool["cache_control"] = json!({ "type": "ephemeral" });
        }
        if let Some(last_msg) = messages.last_mut() {
            mark_message_cache_breakpoint(last_msg);
        }
    }
    // A non-empty system prompt becomes a text-block array so it can carry its
    // own breakpoint (caching tools + system); an empty one stays a plain string.
    let system_value = if req.cache && !req.system.is_empty() {
        json!([{ "type": "text", "text": req.system, "cache_control": { "type": "ephemeral" } }])
    } else {
        Value::String(req.system.clone())
    };

    let mut body = json!({
        "model": req.model,
        "max_tokens": req.max_tokens,
        "system": system_value,
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

/// Attach an ephemeral cache breakpoint to the final content block of an
/// already-serialized Anthropic message, normalizing a plain-string body to a
/// one-element text block so it can carry the marker. Anthropic accepts
/// `cache_control` on any block type (text, image, tool_use, tool_result), so
/// the tail block is always a valid anchor.
fn mark_message_cache_breakpoint(message: &mut Value) {
    let content = &mut message["content"];
    if content.is_string() {
        let text = content.as_str().unwrap_or_default().to_string();
        *content = json!([{
            "type": "text",
            "text": text,
            "cache_control": { "type": "ephemeral" },
        }]);
    } else if let Some(blocks) = content.as_array_mut() {
        if let Some(last) = blocks.last_mut() {
            if last.is_object() {
                last["cache_control"] = json!({ "type": "ephemeral" });
            }
        }
    }
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
            // (TALK, the truncation path, OpenAI-origin turns: a Responses
            // turn's raw holds OpenAI output items, never content blocks).
            if !raw.is_empty() && !super::openai_compat::is_responses_raw(raw) {
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
        usage_unreported: false,
    }
}
