//! OpenAI Chat Completions API implementation of the LlmProvider trait.
//!
//! Used by OpenAI proper, DeepSeek, Ollama (via /v1/chat/completions), and
//! any self-hosted server that speaks the OpenAI Chat Completions protocol
//! (vllm, llama.cpp server, LMStudio, LocalAI, etc.).
//!
//! GPT-6 models on OpenAI itself (`api.openai.com`) go to the Responses API
//! instead (`/responses`): on Chat Completions they take no tools at all
//! (GPT-6 Astra, GPT-6.1 Sol/Terra) or only with `reasoning_effort: "none"`
//! (GPT-6 Sol/Luna), and every API stage sends tools. A GPT-6 id behind any
//! other base URL (LiteLLM, OpenRouter, a custom gateway) stays on Chat
//! Completions, since such a gateway may not speak Responses. See
//! `uses_responses_api`.

use super::{
    Effort, LlmContent, LlmMessage, LlmProvider, LlmRequest, LlmResponse, LlmRole,
    LlmStopReason, LlmToolUse,
};
use crate::error::{AppError, AppResult, ProviderErrorKind};
use async_trait::async_trait;
use serde_json::{json, Value};

pub struct OpenAICompatibleProvider {
    /// The configured provider's name (`openai`, a custom provider…). With
    /// the endpoint it tells which key, and so which OpenAI org, produced a
    /// Responses turn's encrypted reasoning (see `responses_replay`).
    pub provider: String,
}

#[async_trait]
impl LlmProvider for OpenAICompatibleProvider {
    async fn complete(
        &self,
        api_base: &str,
        api_key: Option<&str>,
        req: &LlmRequest,
        client: &reqwest::Client,
    ) -> AppResult<LlmResponse> {
        let responses = uses_responses_api(&req.model, api_base);
        let (body, url) = if responses {
            (build_responses_request(req, &self.provider, api_base), responses_url(api_base))
        } else {
            (build_request(req), chat_completions_url(api_base))
        };

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
            .map_err(|e| super::request_error("OpenAI-compat request failed", &e))?;

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

        Ok(if responses {
            parse_responses_response(response, &req.model, &self.provider, api_base)
        } else {
            parse_response(response)
        })
    }
}

/// Resolve the chat-completions endpoint from a configured base URL. The
/// conventional base already includes `/v1` (`https://api.openai.com/v1`);
/// strip a pasted full endpoint so we never double the path.
pub fn chat_completions_url(api_base: &str) -> String {
    let base = api_base.trim_end_matches('/');
    let base = base.strip_suffix("/chat/completions").unwrap_or(base);
    format!("{base}/chat/completions")
}

/// Resolve the Responses endpoint from a configured base URL, stripping a
/// pasted full endpoint (either API's) so we never double the path.
pub fn responses_url(api_base: &str) -> String {
    let base = api_base.trim_end_matches('/');
    let base = base.strip_suffix("/chat/completions").unwrap_or(base);
    let base = base.strip_suffix("/responses").unwrap_or(base);
    format!("{base}/responses")
}

/// GPT-6 models (Sol, Luna, Astra, 6.1 Terra, 6.1 Sol). Their model pages
/// accept every effort level up to `max`, and their tool calls need the
/// Responses API.
fn is_gpt6(model_id: &str) -> bool {
    model_id.to_ascii_lowercase().contains("gpt-6")
}

/// Whether this request is sent to the Responses API rather than Chat
/// Completions. Per OpenAI's model pages and reasoning guide, GPT-6.1 Terra
/// "requires the Responses API" for tool calling, GPT-6 Astra and GPT-6.1 Sol
/// get no function calling on Chat Completions, and GPT-6 Sol/Luna only with
/// `reasoning_effort: "none"`, which would throw the stage's effort away.
///
/// Only when the base URL is OpenAI's own API host, though: a GPT-6 id behind
/// LiteLLM, OpenRouter, a custom OpenAI-compatible provider or a base-URL
/// override goes to whatever that gateway speaks, and many speak Chat
/// Completions only, where `/responses` would fail every request. Those keep
/// the pre-Responses behaviour (Chat Completions).
pub fn uses_responses_api(model_id: &str, api_base: &str) -> bool {
    is_gpt6(model_id) && is_openai_api_host(api_base)
}

/// Whether a configured base URL points at `api.openai.com` (host compared
/// case-insensitively; scheme, port and path don't matter). An unparseable
/// base is not OpenAI.
fn is_openai_api_host(api_base: &str) -> bool {
    reqwest::Url::parse(api_base.trim())
        .ok()
        .and_then(|u| u.host_str().map(|h| h.eq_ignore_ascii_case("api.openai.com")))
        .unwrap_or(false)
}

/// The OpenAI effort level for a reasoning model. GPT-6 takes all five levels
/// as-is; the older reasoning models (o-series, GPT-5) stop at `high`, so
/// `xhigh` and `max` fold to it there.
pub fn reasoning_effort_level(model_id: &str, effort: Effort) -> &'static str {
    match effort {
        Effort::Xhigh | Effort::Max if !is_gpt6(model_id) => "high",
        _ => effort.as_str(),
    }
}

/// What a Responses request sends for a stage with effort off. GPT-6 runs at
/// its API default (`medium`) when `reasoning` is omitted, so off has to be
/// `effort: "none"` — but only GPT-6 Sol, GPT-6 Luna and GPT-6.1 Terra accept
/// it; GPT-6 Astra and GPT-6.1 Sol return a 400, so they (and any GPT-6 id
/// not listed here) get no `reasoning` and keep that default. Matches the bare
/// id or a dated snapshot (`gpt-6-sol-2026-08-01`) only: another variant
/// (`gpt-6-sol-pro`) may not accept `none`, and `gpt-6-sol` is not a prefix
/// of `gpt-6.1-sol`.
pub fn effort_off_level(model_id: &str) -> Option<&'static str> {
    let id = model_id.to_ascii_lowercase();
    let id = id.rsplit('/').next().unwrap_or(&id);
    ["gpt-6-sol", "gpt-6-luna", "gpt-6.1-terra"]
        .iter()
        .any(|m| id.strip_prefix(m).is_some_and(|rest| rest.is_empty() || is_snapshot_suffix(rest)))
        .then_some("none")
}

/// Whether `rest` is a dated snapshot suffix, `-YYYY-MM-DD`.
fn is_snapshot_suffix(rest: &str) -> bool {
    let b = rest.as_bytes();
    b.len() == 11
        && b.iter().enumerate().all(|(i, c)| match i {
            0 | 5 | 8 => *c == b'-',
            _ => c.is_ascii_digit(),
        })
}

/// Whether an OpenAI-family model actually honors `reasoning_effort`. Only the
/// reasoning models do (o1/o3/o4 series, GPT-5, GPT-6); on a chat model like
/// gpt-4o the field is at best a no-op and at worst a 400, so we omit it there.
fn openai_supports_reasoning(model_id: &str) -> bool {
    let id = model_id.to_ascii_lowercase();
    id.starts_with("o1")
        || id.starts_with("o3")
        || id.starts_with("o4")
        || id.contains("gpt-5")
        || id.contains("gpt-6")
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

    let reasoning = openai_supports_reasoning(&req.model);

    let mut body = json!({
        "model": req.model,
        "messages": messages,
    });
    // Token cap key differs by model class: reasoning models (o1/o3/o4, GPT-5/6)
    // reject `max_tokens` with a 400 and want `max_completion_tokens`; chat
    // models want `max_tokens`. Either way the budget passes through UNCLAMPED —
    // TALK "deep" legitimately sends 64000, and the effort bump wants the larger
    // ceiling (a small-context model would already 400 on its own bump).
    if reasoning {
        body["max_completion_tokens"] = json!(req.max_tokens);
    } else {
        body["max_tokens"] = json!(req.max_tokens);
    }
    if !tools.is_empty() {
        body["tools"] = Value::Array(tools);
    }
    if let Some(name) = &req.tool_choice {
        body["tool_choice"] = json!({ "type": "function", "function": { "name": name } });
    }
    // Reasoning effort → OpenAI's `reasoning_effort`, but ONLY on models that
    // honor it (o1/o3/o4, GPT-5, GPT-6), at the level each one takes (see
    // `reasoning_effort_level`).
    if let Some(effort) = req.effort {
        if reasoning {
            body["reasoning_effort"] = json!(reasoning_effort_level(&req.model, effort));
        }
    }
    body
}

/// Build a Responses API body (GPT-6 on OpenAI, see `uses_responses_api`). Stateless:
/// `store: false` keeps OpenAI from retaining the conversation (Chat
/// Completions doesn't store by default either), so every turn re-sends the
/// whole history as input items, and tool calls are replayed by `call_id`.
/// `include: ["reasoning.encrypted_content"]` has the API return each
/// reasoning item's content encrypted, so a tool turn can pass it back
/// (function-calling guide: reasoning items returned with tool calls "must
/// also be passed back with tool call outputs"). `provider` and `api_base`
/// say where this request goes, so reasoning from elsewhere is not replayed.
pub fn build_responses_request(req: &LlmRequest, provider: &str, api_base: &str) -> Value {
    let base = responses_url(api_base);
    let here = ResponsesOrigin { model: &req.model, provider, base: &base };
    let mut input: Vec<Value> = Vec::with_capacity(req.messages.len());
    for m in &req.messages {
        input.extend(message_to_responses(m, &here));
    }

    // `strict: false` explicitly: an omitted `strict` makes Responses try to
    // normalize the schema into strict mode, while Chat Completions (and every
    // other provider here) is non-strict by default (function-calling guide,
    // "Strict mode"). Our tool schemas aren't written for strict mode.
    let tools: Vec<Value> = req.tools.iter().map(|t| json!({
        "type": "function",
        "name": t.name,
        "description": t.description,
        "parameters": t.input_schema,
        "strict": false,
    })).collect();

    let mut body = json!({
        "model": req.model,
        "input": input,
        // Unclamped, like `max_completion_tokens` on Chat Completions.
        "max_output_tokens": req.max_tokens,
        "store": false,
        "include": ["reasoning.encrypted_content"],
    });
    if !req.system.is_empty() {
        body["instructions"] = json!(req.system);
    }
    if !tools.is_empty() {
        body["tools"] = Value::Array(tools);
    }
    if let Some(name) = &req.tool_choice {
        body["tool_choice"] = json!({ "type": "function", "name": name });
    }
    let effort = match req.effort {
        Some(effort) => Some(reasoning_effort_level(&req.model, effort)),
        None => effort_off_level(&req.model),
    };
    if let Some(effort) = effort {
        body["reasoning"] = json!({ "effort": effort });
    }
    body
}

/// The first item of a Responses turn's `raw_content`: which model, provider
/// and endpoint produced the encrypted reasoning behind it. Never sent; see
/// `responses_replay`.
const RESPONSES_ORIGIN: &str = "octopush.responses_origin";

/// Where a Responses turn runs: its model, configured provider and
/// `/responses` endpoint (`responses_url`).
struct ResponsesOrigin<'a> {
    model: &'a str,
    provider: &'a str,
    base: &'a str,
}

/// Whether a captured `raw` array came from the Responses API (so the
/// Anthropic serializer must not replay it as content blocks).
pub fn is_responses_raw(raw: &[Value]) -> bool {
    raw.first().and_then(|v| v.get("type")).and_then(|t| t.as_str()) == Some(RESPONSES_ORIGIN)
}

/// The output items to replay verbatim for an assistant tool turn, when its
/// `raw` was captured from a Responses turn of this same model, provider and
/// endpoint. Encrypted reasoning only decrypts for the org that produced it,
/// so reasoning from another model (an escalation swap), another provider or
/// key (a resumed transcript under another org), another endpoint, or an
/// origin missing any of them is never sent: those turns fall back to the
/// rebuilt items.
fn responses_replay<'a>(raw: &'a [Value], here: &ResponsesOrigin) -> Option<&'a [Value]> {
    let (origin, items) = raw.split_first()?;
    let field = |k: &str| origin.get(k).and_then(|v| v.as_str());
    let same = field("model")?.eq_ignore_ascii_case(here.model)
        && field("provider")? == here.provider
        && field("base")?.eq_ignore_ascii_case(here.base);
    (is_responses_raw(raw) && same && !items.is_empty()).then_some(items)
}

/// Model-visible size (chars) of a Responses turn's `raw`, for the context
/// guard: the origin item is never sent, and each `encrypted_content` is left
/// out. That base64 blob is far longer than the reasoning it carries, so
/// counting it at chars/4 would set off compaction early, and compacting
/// older tool results rewrites the history that reasoning came after.
pub fn responses_raw_chars(raw: &[Value]) -> usize {
    raw.iter()
        .skip(1)
        .map(|item| {
            let enc = item.get("encrypted_content").and_then(|c| c.as_str()).map_or(0, str::len);
            item.to_string().len().saturating_sub(enc)
        })
        .sum()
}

/// Returns 1 or more Responses input items from a normalized LlmMessage. An
/// assistant turn with tools replays its captured output items (reasoning,
/// message, `function_call`, in order) when they came from `here`, else
/// becomes its text (if any) plus one `function_call` item per call; each
/// tool result is a `function_call_output`.
fn message_to_responses(msg: &LlmMessage, here: &ResponsesOrigin) -> Vec<Value> {
    match (&msg.role, &msg.content) {
        (LlmRole::User, LlmContent::Text(t)) => vec![json!({ "role": "user", "content": t })],
        (_, LlmContent::Multimodal(blocks)) => {
            let parts: Vec<Value> = blocks
                .iter()
                .map(|b| match b {
                    crate::providers::LlmBlock::Text(t) => json!({ "type": "input_text", "text": t }),
                    crate::providers::LlmBlock::Image { media_type, data } => json!({
                        "type": "input_image",
                        "image_url": format!("data:{media_type};base64,{data}"),
                    }),
                })
                .collect();
            vec![json!({ "role": "user", "content": parts })]
        }
        (LlmRole::Assistant, LlmContent::Text(t)) => vec![json!({ "role": "assistant", "content": t })],
        (LlmRole::Assistant, LlmContent::AssistantWithTools { raw, text, tool_uses }) => {
            // Verbatim: the reasoning items sit right before the
            // `function_call` items they produced, and those keep their
            // `fc_…` ids, which the API ties to that reasoning.
            if let Some(items) = responses_replay(raw, here) {
                return items.to_vec();
            }
            let mut items = Vec::with_capacity(tool_uses.len() + 1);
            if !text.is_empty() {
                items.push(json!({ "role": "assistant", "content": text }));
            }
            // No item `id`: an `fc_…` id would make the API look for the
            // reasoning item it came with, which this rebuilt turn lacks.
            items.extend(tool_uses.iter().map(|u| json!({
                "type": "function_call",
                "call_id": u.id,
                "name": u.name,
                "arguments": serde_json::to_string(&u.input).unwrap_or_else(|_| "{}".into()),
            })));
            items
        }
        (LlmRole::User, LlmContent::ToolResults(results)) => results.iter().map(|r| json!({
            "type": "function_call_output",
            "call_id": r.tool_use_id,
            "output": r.content,
        })).collect(),
        // Defensive: malformed combinations
        _ => vec![json!({ "role": "user", "content": "" })],
    }
}

/// Parse a Responses API body: `output_text` parts of `message` items are the
/// text, `function_call` items the tool uses (keyed by `call_id`, which the
/// next turn's `function_call_output` answers). A `refusal` part's
/// explanation becomes visible text and the turn stops as
/// `Other("refusal")`, never an empty EndTurn.
///
/// When the turn carries reasoning, `raw_content` keeps its reasoning,
/// message and `function_call` items verbatim and in order, behind an origin
/// item naming `model`, `provider` and the endpoint for `api_base` (see
/// `responses_replay`), so the next tool turn passes the reasoning back. A
/// reasoning item without `encrypted_content` can't be replayed statelessly
/// (its id points at nothing stored), so then nothing is kept and the turn is
/// rebuilt from text + tool uses.
pub fn parse_responses_response(response: Value, model: &str, provider: &str, api_base: &str) -> LlmResponse {
    let mut text = String::new();
    let mut tool_uses: Vec<LlmToolUse> = Vec::new();
    let mut refused = false;
    let mut replay: Vec<Value> = Vec::new();
    let mut reasoning = false;
    let mut replayable = true;

    let items = response.get("output").and_then(|o| o.as_array());
    for item in items.into_iter().flatten() {
        match item.get("type").and_then(|t| t.as_str()) {
            Some("reasoning") => {
                reasoning = true;
                replayable &= item.get("encrypted_content").and_then(|c| c.as_str()).is_some();
                replay.push(item.clone());
            }
            Some("message") => {
                replay.push(item.clone());
                let parts = item.get("content").and_then(|c| c.as_array());
                for part in parts.into_iter().flatten() {
                    match part.get("type").and_then(|t| t.as_str()) {
                        Some("output_text") => {
                            if let Some(t) = part.get("text").and_then(|t| t.as_str()) {
                                text.push_str(t);
                            }
                        }
                        // `{ "type": "refusal", "refusal": "<explanation>" }`
                        Some("refusal") => {
                            refused = true;
                            let why = part.get("refusal").and_then(|r| r.as_str()).unwrap_or("");
                            if !text.is_empty() && !why.is_empty() {
                                text.push_str("\n\n");
                            }
                            text.push_str(why);
                        }
                        _ => {}
                    }
                }
            }
            Some("function_call") => {
                replay.push(item.clone());
                let field = |k: &str| item.get(k).and_then(|v| v.as_str()).unwrap_or("");
                let input: Value = serde_json::from_str(field("arguments")).unwrap_or_else(|_| json!({}));
                tool_uses.push(LlmToolUse {
                    id: field("call_id").to_string(),
                    name: field("name").to_string(),
                    input,
                });
            }
            _ => {}
        }
    }

    // A response cut at `max_output_tokens` is `incomplete`, even when it
    // got as far as a (possibly truncated) tool call.
    let stop_reason = match response.get("status").and_then(|s| s.as_str()) {
        Some("incomplete") => match response
            .get("incomplete_details")
            .and_then(|d| d.get("reason"))
            .and_then(|r| r.as_str())
        {
            Some("max_output_tokens") => LlmStopReason::MaxTokens,
            Some(other) => LlmStopReason::Other(other.to_string()),
            None => LlmStopReason::Other("incomplete".to_string()),
        },
        Some(s) if s != "completed" => LlmStopReason::Other(s.to_string()),
        _ if !tool_uses.is_empty() => LlmStopReason::ToolUse,
        _ if refused => LlmStopReason::Other("refusal".to_string()),
        _ => LlmStopReason::EndTurn,
    };

    // Same accounting as Chat Completions under the Responses names:
    // `input_tokens` includes the `input_tokens_details` cached / written
    // slices (see `split_cached_input`).
    let usage = response.get("usage");
    let count = |k: &str| usage.and_then(|u| u.get(k)).and_then(|v| v.as_u64()).unwrap_or(0);
    let (input_tokens, cache_read_tokens, cache_creation_tokens) =
        split_cached_input(count("input_tokens"), usage.and_then(|u| u.get("input_tokens_details")));

    let raw_content = if reasoning && replayable {
        let mut raw = vec![json!({
            "type": RESPONSES_ORIGIN,
            "model": model,
            "provider": provider,
            "base": responses_url(api_base),
        })];
        raw.extend(replay);
        raw
    } else {
        vec![]
    };

    LlmResponse {
        text,
        tool_uses,
        stop_reason,
        input_tokens,
        output_tokens: count("output_tokens"),
        cache_read_tokens,
        cache_creation_tokens,
        rate_limit: None,
        raw_content,
    }
}

/// Split a full prompt count into `(fresh input, cache read, cache write)`
/// from its details block (`cached_tokens`, `cache_write_tokens`). Both slices
/// are inside the prompt count, so each is capped by what is left of it.
fn split_cached_input(prompt_tokens: u64, details: Option<&Value>) -> (u64, u64, u64) {
    let detail = |k: &str| details.and_then(|d| d.get(k)).and_then(|v| v.as_u64()).unwrap_or(0);
    let cache_read = detail("cached_tokens").min(prompt_tokens);
    let cache_write = detail("cache_write_tokens").min(prompt_tokens - cache_read);
    (prompt_tokens - cache_read - cache_write, cache_read, cache_write)
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
        // OpenAI has no verbatim content-block replay, so `raw` is ignored.
        (LlmRole::Assistant, LlmContent::AssistantWithTools { text, tool_uses, .. }) => {
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

/// Parse a Chat Completions body. A `message.refusal` explanation becomes
/// visible text and, with no tool calls, the turn stops as
/// `Other("refusal")` (as on the Responses path), never an empty EndTurn.
pub fn parse_response(response: Value) -> LlmResponse {
    let mut text = String::new();
    let mut tool_uses: Vec<LlmToolUse> = Vec::new();
    let mut refused = false;

    let choice = response.get("choices")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.first());

    if let Some(choice) = choice {
        if let Some(msg) = choice.get("message") {
            if let Some(t) = msg.get("content").and_then(|c| c.as_str()) {
                text.push_str(t);
            }
            if let Some(why) = msg.get("refusal").and_then(|r| r.as_str()).filter(|r| !r.is_empty()) {
                refused = true;
                if !text.is_empty() {
                    text.push_str("\n\n");
                }
                text.push_str(why);
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
        // A cut (`length`) or filtered turn keeps that reason, as on Responses.
        Some("stop") | None if refused && tool_uses.is_empty() => {
            LlmStopReason::Other("refusal".to_string())
        }
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
    // `usage.prompt_tokens_details.cached_tokens` (DeepSeek uses the same key)
    // and, on GPT-5.6 and later, tokens written to the prompt cache under
    // `usage.prompt_tokens_details.cache_write_tokens` (Chat Completions API
    // reference, checked 2026-11-10). Crucially, `prompt_tokens` is the FULL
    // prompt count and already INCLUDES both slices ("input tokens use the
    // uncached-input, cached-input, or cache-write rate", prompt-caching
    // guide), so we subtract them to get the billable (fresh) input and
    // surface each slice separately — otherwise cached input is priced at the
    // full input rate and cache writes (1.25x input on GPT-5.6+) are
    // under-counted. Providers that omit a field report 0 (no change).
    let details = response.get("usage").and_then(|u| u.get("prompt_tokens_details"));
    let (input_tokens, cache_read_tokens, cache_creation_tokens) =
        split_cached_input(prompt_tokens, details);

    LlmResponse {
        text,
        tool_uses,
        stop_reason,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        // Our requests set no `prompt_cache_options.ttl`, so every write is
        // at the default 30-minute retention: the catalog's write price.
        cache_creation_tokens,
        // Header-based rate-limit hints are Anthropic-specific; none here.
        rate_limit: None,
        // OpenAI-compat returns no verbatim content-block array to replay.
        raw_content: vec![],
    }
}
