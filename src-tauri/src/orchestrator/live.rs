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
    /// The Claude plan windows a `rate_limit_event` reported — not a journal
    /// entry: `PersistingSink` keeps them as the plan snapshot.
    pub fn plan_windows(&self, windows: &[crate::orchestrator::cli_runner::PlanWindow]) {
        self.events.emit(crate::claude_plan::PLAN_EVENT, json!({ "windows": windows }));
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

/// tool_result `content` is a string OR an array of `{type,text}` blocks.
fn content_to_text(v: &serde_json::Value) -> String {
    if let Some(s) = v.as_str() { return s.to_string(); }
    if let Some(arr) = v.as_array() {
        return arr.iter().filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>().join(" ");
    }
    String::new()
}

/// Best-effort: does an in-band tool result string look like a failure?
/// (execute_tool returns errors as strings; the agentic loop has no error flag.)
pub fn looks_like_error(result: &str) -> bool {
    let lower = result.trim_start().to_ascii_lowercase();
    lower.starts_with("error") || lower.starts_with("failed")
        || lower.starts_with("could not") || lower.starts_with("cannot")
}

/// Claude Code's sub-agent tool names in its own stream (`Agent`, formerly
/// `Task`): a `tool_use` of one of these opens a nested session whose events
/// carry `parent_tool_use_id` = that block's id.
fn is_cli_subagent_tool(name: &str) -> bool {
    name == "Agent" || name == "Task"
}

/// First line of an upstream message, capped to 200 chars.
fn one_line(s: &str) -> String {
    s.trim().lines().next().unwrap_or("").trim().chars().take(200).collect()
}

/// The first non-empty string among `keys` of `v`.
fn first_str<'v>(v: &'v Value, keys: &[&str]) -> Option<&'v str> {
    keys.iter().find_map(|k| v.get(*k).and_then(Value::as_str)).map(str::trim).filter(|s| !s.is_empty())
}

/// `system/api_retry` → "retrying · {error} · attempt {n}/{max} · in {s}s".
/// Missing fields drop their segment; an unknown `error` prints as-is.
fn api_retry_notice(v: &Value) -> String {
    let mut parts = vec!["retrying".to_string()];
    if let Some(e) = first_str(v, &["error"]) {
        parts.push(one_line(e));
    }
    if let Some(n) = v.get("attempt").and_then(Value::as_u64) {
        match v.get("max_retries").and_then(Value::as_u64) {
            Some(max) => parts.push(format!("attempt {n}/{max}")),
            None => parts.push(format!("attempt {n}")),
        }
    }
    if let Some(ms) = v.get("retry_delay_ms").and_then(Value::as_u64) {
        parts.push(format!("in {}s", ms.div_ceil(1000)));
    }
    parts.join(" · ")
}

/// `system/init` → one notice per `mcp_server_errors[]` / `plugin_errors[]`
/// entry. A host that captures stderr gets no other warning that a stage
/// runs without those tools.
fn init_error_notices(v: &Value) -> Vec<String> {
    let mut out = Vec::new();
    let list = |key: &str| v.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
    for e in list("mcp_server_errors") {
        let name = first_str(&e, &["name", "server", "server_name"]).unwrap_or("?");
        let msg = first_str(&e, &["message", "error"]).or_else(|| e.as_str()).map(one_line);
        out.push(match msg {
            Some(m) => format!("MCP server '{name}' skipped: {m}"),
            None => format!("MCP server '{name}' skipped"),
        });
    }
    for e in list("plugin_errors") {
        let name = first_str(&e, &["plugin", "name"]).unwrap_or("?");
        let msg = first_str(&e, &["message", "error", "type"]).or_else(|| e.as_str()).map(one_line);
        out.push(match msg {
            Some(m) => format!("plugin '{name}' failed to load: {m}"),
            None => format!("plugin '{name}' failed to load"),
        });
    }
    out
}

/// The cause of a `system/api_retry` event (its `error`, "" when absent);
/// `None` for any other event.
pub fn api_retry_cause(v: &Value) -> Option<String> {
    if v.get("type").and_then(Value::as_str) != Some("system")
        || v.get("subtype").and_then(Value::as_str) != Some("api_retry")
    {
        return None;
    }
    Some(first_str(v, &["error"]).unwrap_or("").to_string())
}

/// How long consecutive retries for one cause share a single notice.
pub const RETRY_NOTICE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(10);

/// Throttles `api_retry` notices: a retry for the same cause as the last one
/// shown, within `RETRY_NOTICE_INTERVAL`, is not journaled again. Any
/// non-`system` event (the model answered, the run ended) ends the streak.
#[derive(Default)]
pub struct RetryThrottle {
    last: Option<(String, std::time::Instant)>,
}

impl RetryThrottle {
    /// Should this event's entries be journaled? Always true except for a
    /// throttled retry.
    pub fn allow(&mut self, v: &Value, now: std::time::Instant) -> bool {
        let Some(cause) = api_retry_cause(v) else {
            if v.get("type").and_then(Value::as_str) != Some("system") {
                self.last = None;
            }
            return true;
        };
        if let Some((last, at)) = &self.last {
            if *last == cause && now.duration_since(*at) < RETRY_NOTICE_INTERVAL {
                return false;
            }
        }
        self.last = Some((cause, now));
        true
    }
}

/// Map ONE claude `--output-format stream-json` event to zero or more entries
/// (as the JSON values `LiveEmitter` would emit). `assistant` → text + tool
/// entries; `user` tool_result → tool_result entries; `system/api_retry` →
/// a retry notice; `system/init` → a notice per MCP server / plugin that
/// failed to load; everything else → none.
///
/// Sub-agent hierarchy: an event that belongs to a Claude Code sub-agent
/// carries a top-level `parent_tool_use_id` (the `Agent`/`Task` block that
/// spawned it); every entry from such an event gets `"parent": <that id>`
/// so the journal can indent it under its spawner. The spawning `tool`
/// entry itself carries `"agentId": <block id>` and shows the sub-agent's
/// `description` as its hint (the input's first string would otherwise be
/// the multi-line prompt).
pub fn entries_from_stream_event(v: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    let kind = v.get("type").and_then(Value::as_str);
    let parent = v
        .get("parent_tool_use_id")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty())
        .map(str::to_string);
    if kind == Some("system") {
        let notices = match v.get("subtype").and_then(Value::as_str) {
            Some("api_retry") => vec![api_retry_notice(v)],
            Some("init") => init_error_notices(v),
            _ => Vec::new(),
        };
        for text in notices {
            let mut entry = json!({ "kind": "notice", "text": text });
            if let Some(p) = &parent {
                entry["parent"] = json!(p);
            }
            out.push(entry);
        }
        return out;
    }
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
                        let input = block.get("input");
                        let mut entry = if is_cli_subagent_tool(name) {
                            let hint = input
                                .and_then(|i| i.get("description"))
                                .and_then(Value::as_str)
                                .map(|d| d.chars().take(120).collect::<String>())
                                .or_else(|| input.map(tool_hint))
                                .unwrap_or_default();
                            json!({ "kind": "tool", "tool": name, "hint": hint })
                        } else {
                            let hint = input.map(tool_hint).unwrap_or_default();
                            json!({ "kind": "tool", "tool": name, "hint": hint })
                        };
                        if is_cli_subagent_tool(name) {
                            if let Some(id) = block.get("id").and_then(Value::as_str) {
                                entry["agentId"] = json!(id);
                            }
                        }
                        out.push(entry);
                    }
                    _ => {}
                }
            }
        }
        Some("user") => {
            for block in content {
                if block.get("type").and_then(Value::as_str) == Some("tool_result") {
                    let ok = !block.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                    let detail = block.get("content").map(content_to_text).map(|s| summarize(&s)).unwrap_or_default();
                    out.push(json!({ "kind": "tool_result", "ok": ok, "detail": detail }));
                }
            }
        }
        _ => {}
    }
    if let Some(parent) = parent {
        for entry in &mut out {
            entry["parent"] = json!(parent);
        }
    }
    out
}
