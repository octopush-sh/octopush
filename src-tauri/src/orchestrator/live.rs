//! The structured live-activity channel for Direct runs. Both substrates emit
//! `run://log` entries through `LiveEmitter`; the frontend renders the cards.

use crate::orchestrator::events::EventSink;
use serde_json::{json, Value};

/// Frontend event name for live per-stage activity (mirrors `RUN_EVENTS.log`).
pub const RUN_LOG_EVENT: &str = "run://log";

/// Tool-input keys to surface as the one-line hint, in priority order.
const TOOL_HINT_KEYS: &[&str] = &["command", "file_path", "path", "pattern", "query", "url", "prompt"];

/// Emits structured `run://log` activity entries for one stage.
pub struct LiveEmitter<'a> {
    events: &'a dyn EventSink,
    run_id: &'a str,
    stage_id: &'a str,
}

impl<'a> LiveEmitter<'a> {
    pub fn new(events: &'a dyn EventSink, run_id: &'a str, stage_id: &'a str) -> Self {
        Self { events, run_id, stage_id }
    }
    fn emit_entry(&self, entry: Value) {
        self.events.emit(
            RUN_LOG_EVENT,
            json!({ "runId": self.run_id, "stageId": self.stage_id, "entry": entry }),
        );
    }
    pub fn text(&self, s: &str) {
        let t = s.trim();
        if !t.is_empty() {
            self.emit_entry(json!({ "kind": "text", "text": t }));
        }
    }
    pub fn tool(&self, name: &str, hint: &str) {
        self.emit_entry(json!({ "kind": "tool", "tool": name, "hint": hint }));
    }
    pub fn tool_result(&self, ok: bool, detail: &str) {
        self.emit_entry(json!({ "kind": "tool_result", "ok": ok, "detail": detail }));
    }
    pub fn notice(&self, s: &str) {
        let t = s.trim();
        if !t.is_empty() {
            self.emit_entry(json!({ "kind": "notice", "text": t }));
        }
    }
    /// Emit an already-shaped entry value (from `entries_from_stream_event`).
    pub fn emit_raw_entry(&self, entry: serde_json::Value) {
        self.emit_entry(entry);
    }
}

/// A descriptive one-line hint from a tool-call input object (path/command/…),
/// else the first string value, else "".
pub fn tool_hint(input: &Value) -> String {
    let Some(obj) = input.as_object() else { return String::new() };
    let pick = TOOL_HINT_KEYS
        .iter()
        .find_map(|k| obj.get(*k).and_then(Value::as_str))
        .or_else(|| obj.values().find_map(Value::as_str))
        .unwrap_or("");
    let first = pick.lines().next().unwrap_or(pick);
    first.chars().take(120).collect()
}

/// First line of a tool result, capped to 120 chars — for the result detail line.
pub fn summarize(result: &str) -> String {
    let first = result.trim().lines().next().unwrap_or("").trim();
    first.chars().take(120).collect()
}

/// Map ONE claude `--output-format stream-json` event to zero or more entries
/// (as the JSON values `LiveEmitter` would emit). `assistant` → text + tool
/// entries; `user` tool_result → tool_result entries; everything else → none.
pub fn entries_from_stream_event(v: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    let kind = v.get("type").and_then(Value::as_str);
    let content = v.get("message").and_then(|m| m.get("content")).and_then(Value::as_array);
    let Some(content) = content else { return out };
    match kind {
        Some("assistant") => {
            for block in content {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(t) = block.get("text").and_then(Value::as_str) {
                            let t = t.trim();
                            if !t.is_empty() {
                                out.push(json!({ "kind": "text", "text": t }));
                            }
                        }
                    }
                    Some("tool_use") => {
                        let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
                        let hint = block.get("input").map(tool_hint).unwrap_or_default();
                        out.push(json!({ "kind": "tool", "tool": name, "hint": hint }));
                    }
                    _ => {}
                }
            }
        }
        Some("user") => {
            for block in content {
                if block.get("type").and_then(Value::as_str) == Some("tool_result") {
                    let ok = !block.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                    let detail = block.get("content").and_then(Value::as_str).map(summarize).unwrap_or_default();
                    out.push(json!({ "kind": "tool_result", "ok": ok, "detail": detail }));
                }
            }
        }
        _ => {}
    }
    out
}
