//! Streamed OpenAI-compatible answers, Chat Completions chunks and Responses
//! events alike, folded back into the body a whole response carries, so both
//! paths end in the same parser (`parse_response`, `parse_responses_response`)
//! and can't drift.

use super::super::sse::{ByteSource, SseReader};
use super::super::{cut_off_error, LlmResponse, StreamEvent};
use super::{parse_json, Api, WHAT};
use crate::error::{AppError, AppResult, ProviderErrorKind};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

type Sink<'s> = &'s mut (dyn FnMut(StreamEvent) + Send);

/// Read the answer to a `stream: true` request and assemble it. `whole`: the
/// server answered with a whole JSON body anyway, parsed as `complete` parses
/// it, its text handed over as one `Text`. An answer that carried no `usage`
/// is `usage_unreported`, never priced as $0. Apart so fixtures can drive it.
pub async fn read_stream<S: ByteSource>(
    mut source: S,
    whole: bool,
    idle: Option<Duration>,
    api: &Api<'_>,
    sink: &mut (dyn FnMut(StreamEvent) + Send),
) -> AppResult<LlmResponse> {
    if whole {
        let mut bytes = Vec::new();
        while let Some(chunk) = source.next_chunk().await? {
            bytes.extend_from_slice(&chunk);
        }
        let resp = assemble(api, parse_json(&bytes)?);
        if !resp.text.is_empty() {
            sink(StreamEvent::Text(resp.text.clone()));
        }
        return Ok(resp);
    }
    let mut reader = SseReader::new(source, idle, WHAT);
    let body = match api {
        Api::Chat => fold::<ChatChunks, S>(&mut reader, sink).await?,
        Api::Responses { .. } => fold::<ResponsesEvents, S>(&mut reader, sink).await?,
    };
    Ok(assemble(api, body))
}

/// `body` parsed by `api`'s parser, flagged when it carried no usage (a Chat
/// Completions server that ignored or refused `include_usage`).
fn assemble(api: &Api<'_>, body: Value) -> LlmResponse {
    let reported = body.get("usage").is_some_and(Value::is_object);
    let mut resp = api.parse(body);
    resp.usage_unreported = !reported;
    resp
}

/// One API's events, folded into the body a whole response carries.
trait Fold: Default + Send {
    /// Apply one event's `data`; `Ok(true)` once the answer is complete.
    fn apply(&mut self, data: &str, sink: Sink<'_>) -> AppResult<bool>;
    /// The assembled body; a stream that never finished is cut off.
    fn finish(self) -> AppResult<Value>;
}

async fn fold<F: Fold, S: ByteSource>(reader: &mut SseReader<S>, sink: Sink<'_>) -> AppResult<Value> {
    let mut fold = F::default();
    while let Some(event) = reader.next().await? {
        // An empty `data:` (a keep-alive some servers send) carries nothing.
        if !event.data.trim().is_empty() && fold.apply(&event.data, sink)? {
            break;
        }
    }
    fold.finish()
}

fn parse_event(data: &str) -> AppResult<Value> {
    serde_json::from_str(data)
        .map_err(|e| AppError::Other(format!("OpenAI-compat stream: unreadable event ({e}): {data}")))
}

/// `value[key]` as a string, empty when absent.
fn str_at<'a>(value: Option<&'a Value>, key: &str) -> &'a str {
    value.and_then(|v| v.get(key)).and_then(Value::as_str).unwrap_or("")
}

/// A failure reported inside the stream, after its 200, classified like the
/// HTTP status it stands for so the retry layer treats it the same way: a
/// numeric `code` is that status (some gateways send one), otherwise the
/// documented codes and types. Anything else is final, never retried.
fn stream_error(error: &Value, shown: &str) -> AppError {
    let code = error.get("code");
    let kind = match code.and_then(Value::as_u64) {
        Some(status) => ProviderErrorKind::from_http_status(u16::try_from(status).unwrap_or(0)),
        None => [code.and_then(Value::as_str).unwrap_or(""), str_at(Some(error), "type")]
            .into_iter()
            .find_map(|name| match name {
                "rate_limit_exceeded" => Some(ProviderErrorKind::RateLimit),
                "server_error" => Some(ProviderErrorKind::ServerError),
                "invalid_request_error" | "invalid_prompt" => Some(ProviderErrorKind::BadRequest),
                _ => None,
            })
            .unwrap_or(ProviderErrorKind::Other),
    };
    AppError::Provider { kind, retry_after: None, message: format!("OpenAI-compat API error in the stream: {shown}") }
}

/// Chat Completions chunks folded back into a `chat.completion` body: each
/// `delta` carries `content`, `refusal` and `tool_calls` by `index` (a call's
/// first piece holds its `id` and `name`, its `arguments` come in pieces); the
/// `finish_reason` comes last, then (with `include_usage`) a chunk with the
/// `usage`, then `[DONE]`. Only choice 0 is read, as `parse_response` does.
#[derive(Default)]
struct ChatChunks {
    content: Option<String>,
    refusal: Option<String>,
    calls: BTreeMap<usize, Call>,
    finish_reason: Option<String>,
    usage: Option<Value>,
    done: bool,
    /// Every started call got its `ToolEnd`.
    ended: bool,
}

#[derive(Default)]
struct Call {
    id: String,
    name: String,
    arguments: String,
    /// `ToolStart` was sent (once the name was known).
    started: bool,
}

impl ChatChunks {
    /// One `tool_calls` piece; `position` is its place in the chunk's array,
    /// the call's index when a server leaves `index` out.
    fn call(&mut self, position: usize, piece: &Value, sink: Sink<'_>) {
        let index = piece.get("index").and_then(Value::as_u64).map_or(position, |i| i as usize);
        let call = self.calls.entry(index).or_default();
        let function = piece.get("function");
        // The first id and name stand: a server may repeat them in every piece.
        if call.id.is_empty() {
            call.id = str_at(Some(piece), "id").into();
        }
        if call.name.is_empty() {
            call.name = str_at(function, "name").into();
        }
        let partial = str_at(function, "arguments");
        call.arguments.push_str(partial);
        if !call.started && !call.name.is_empty() {
            call.started = true;
            sink(StreamEvent::ToolStart { index, id: call.id.clone(), name: call.name.clone() });
            // Everything so far: pieces sent before the name, or a whole call
            // in one piece, as some local servers send it.
            if !call.arguments.is_empty() {
                sink(StreamEvent::ToolInput { index, partial: call.arguments.clone() });
            }
        } else if call.started && !partial.is_empty() {
            sink(StreamEvent::ToolInput { index, partial: partial.into() });
        }
    }

    /// The format never marks one call's end and doesn't promise that calls
    /// arrive one after another, so they all end with the choice.
    fn end_calls(&mut self, sink: Sink<'_>) {
        if !std::mem::replace(&mut self.ended, true) {
            for (index, _) in self.calls.iter().filter(|(_, call)| call.started) {
                sink(StreamEvent::ToolEnd { index: *index });
            }
        }
    }
}

impl Fold for ChatChunks {
    fn apply(&mut self, data: &str, sink: Sink<'_>) -> AppResult<bool> {
        if data.trim() == "[DONE]" {
            self.done = true;
            self.end_calls(sink);
            return Ok(true);
        }
        let chunk = parse_event(data)?;
        if let Some(error) = chunk.get("error").filter(|e| !e.is_null()) {
            return Err(stream_error(error, &error.to_string()));
        }
        if let Some(usage) = chunk.get("usage").filter(|u| u.is_object()) {
            self.usage = Some(usage.clone());
        }
        let mut choices = chunk.get("choices").and_then(Value::as_array).into_iter().flatten();
        let Some(choice) = choices.find(|c| c.get("index").and_then(Value::as_u64).unwrap_or(0) == 0) else {
            return Ok(false);
        };
        let delta = choice.get("delta");
        let text = str_at(delta, "content");
        if !text.is_empty() {
            self.content.get_or_insert_with(String::new).push_str(text);
            sink(StreamEvent::Text(text.into()));
        }
        let why = str_at(delta, "refusal");
        if !why.is_empty() {
            // `parse_response` sets the explanation apart after the content.
            let refusal = self.refusal.get_or_insert_with(String::new);
            if refusal.is_empty() && self.content.as_deref().is_some_and(|c| !c.is_empty()) {
                sink(StreamEvent::Text("\n\n".into()));
            }
            refusal.push_str(why);
            sink(StreamEvent::Text(why.into()));
        }
        let pieces = delta.and_then(|d| d.get("tool_calls")).and_then(Value::as_array).into_iter().flatten();
        for (position, piece) in pieces.enumerate() {
            self.call(position, piece, sink);
        }
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.finish_reason = Some(reason.into());
            self.end_calls(sink);
        }
        Ok(false)
    }

    fn finish(self) -> AppResult<Value> {
        // A body that ends after the choice finished but without `[DONE]`
        // has still answered in full.
        if !self.done && self.finish_reason.is_none() {
            return Err(cut_off_error(WHAT));
        }
        let mut message = json!({ "role": "assistant", "content": self.content, "refusal": self.refusal });
        if !self.calls.is_empty() {
            let calls = self.calls.into_values().map(|c| {
                json!({ "id": c.id, "type": "function", "function": { "name": c.name, "arguments": c.arguments } })
            });
            message["tool_calls"] = Value::Array(calls.collect());
        }
        Ok(json!({
            "choices": [{ "index": 0, "message": message, "finish_reason": self.finish_reason }],
            "usage": self.usage,
        }))
    }
}

/// Responses events folded back into the response a whole request returns:
/// output items open (`response.output_item.added`) and close whole
/// (`response.output_item.done`) at their `output_index`; text, refusals and
/// `function_call` arguments grow by deltas; `response.completed` or
/// `response.incomplete` holds the whole response; `response.failed` and
/// `error` end it in failure.
#[derive(Default)]
struct ResponsesEvents {
    /// Items as they closed, should the final response leave `output` out.
    items: BTreeMap<usize, Value>,
    /// `function_call` items started and not yet ended.
    tools: BTreeSet<usize>,
    /// Some text was handed over: a refusal after it is set apart.
    texted: bool,
    /// The refusal part being streamed: (`output_index`, `content_index`).
    refusal: Option<(usize, u64)>,
    response: Option<Value>,
}

impl Fold for ResponsesEvents {
    fn apply(&mut self, data: &str, sink: Sink<'_>) -> AppResult<bool> {
        let event = parse_event(data)?;
        let index = event.get("output_index").and_then(Value::as_u64).map(|i| i as usize);
        let (item, delta) = (event.get("item"), str_at(Some(&event), "delta"));
        match str_at(Some(&event), "type") {
            "response.output_item.added" => {
                let Some(i) = index.filter(|_| str_at(item, "type") == "function_call") else { return Ok(false) };
                self.tools.insert(i);
                sink(StreamEvent::ToolStart { index: i, id: str_at(item, "call_id").into(), name: str_at(item, "name").into() });
                let arguments = str_at(item, "arguments");
                if !arguments.is_empty() {
                    sink(StreamEvent::ToolInput { index: i, partial: arguments.into() });
                }
            }
            "response.output_text.delta" if !delta.is_empty() => {
                self.texted = true;
                sink(StreamEvent::Text(delta.into()));
            }
            "response.refusal.delta" if !delta.is_empty() => {
                // `parse_responses_response` sets each refusal part apart
                // from the text before it.
                let part = Some((index.unwrap_or(0), event.get("content_index").and_then(Value::as_u64).unwrap_or(0)));
                if std::mem::replace(&mut self.refusal, part) != part && self.texted {
                    sink(StreamEvent::Text("\n\n".into()));
                }
                self.texted = true;
                sink(StreamEvent::Text(delta.into()));
            }
            "response.function_call_arguments.delta" if !delta.is_empty() => {
                if let Some(i) = index.filter(|i| self.tools.contains(i)) {
                    sink(StreamEvent::ToolInput { index: i, partial: delta.into() });
                }
            }
            "response.output_item.done" => {
                let (Some(i), Some(item)) = (index, item) else { return Ok(false) };
                self.items.insert(i, item.clone());
                if self.tools.remove(&i) {
                    sink(StreamEvent::ToolEnd { index: i });
                }
            }
            "response.completed" | "response.incomplete" => {
                self.response = Some(event.get("response").cloned().unwrap_or_else(|| json!({})));
                return Ok(true);
            }
            "response.failed" => {
                let error = event.get("response").and_then(|r| r.get("error")).cloned().unwrap_or(Value::Null);
                return Err(stream_error(&error, &error.to_string()));
            }
            "error" => return Err(stream_error(&event, data)),
            _ => {}
        }
        Ok(false)
    }

    fn finish(self) -> AppResult<Value> {
        let Some(mut response) = self.response else { return Err(cut_off_error(WHAT)) };
        let has_output = response.get("output").and_then(Value::as_array).is_some_and(|o| !o.is_empty());
        if !has_output && !self.items.is_empty() && response.is_object() {
            response["output"] = Value::Array(self.items.into_values().collect());
        }
        Ok(response)
    }
}
