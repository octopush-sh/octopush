//! The append-only transcript of Talk's director (Talk engine v2, B2).
//!
//! On a turn run with `talkEngine: "v2"` (settings.json), the history the
//! turn starts from is built here instead of by `chat_history::build_history`,
//! and every stored row renders as a function of itself, never of its age. So
//! the prefix a thread sends only grows, and the first request of a turn
//! extends the last request of the turn before it:
//! - A tool result is capped once, when it is written ([`model_view`], sized
//!   from the model's window). The loop sends that text, the row keeps it
//!   (`chat_messages.model_view`) and later turns replay it byte for byte. The
//!   full output stays in `content`, for recall and the card.
//! - A tool round's assistant turn is kept verbatim with its origin model
//!   (`raw_json`, [`RoundRecord`]) and each result names its call
//!   (`tool_use_id`), so a finished turn replays as the same tool_use and
//!   tool_result pairs the loop sent. The verbatim blocks (signed thinking
//!   among them) go only to the model that wrote them; after a model switch
//!   the round is rebuilt from its text and tool calls.
//! - A turn that can't replay as pairs renders as text, the way
//!   `chat_history` does, with every tool row at the settled allowance: a
//!   legacy row without these columns, a stopped or failed turn (no answer
//!   closes its last round), or a round missing a column.
//!
//! The one accepted exception is an `@` block of 8k chars or more: it goes
//! out whole in its own turn and shortened from the next turn on
//! (`chat_history::abridge_context`), one change and byte-stable after it.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::chat_history::{
    abridge_context, excerpt_head_tail, recall_hint, strip_tool_calls_suffix, summarize_tool_row, TOOL_RESULT_SETTLED,
};
use crate::context::budget::CHARS_PER_TOKEN;
use crate::providers::{LlmContent, LlmMessage, LlmResponse, LlmRole, LlmToolResult, LlmToolUse};

/// Share (%) of the model's window that one tool result may take.
pub const VIEW_SHARE_PCT: u64 = 5;
/// The bounds of that share (chars): a small local window still gets a
/// useful excerpt, and a large one never more than a whole `read_file`.
pub const VIEW_MIN_CHARS: usize = 2_000;
pub const VIEW_MAX_CHARS: usize = 100_000;

/// A stored chat row as the transcript reads it.
#[derive(Debug, Clone, Copy, Default)]
pub struct Row<'a> {
    pub id: i64,
    pub role: &'a str,
    pub content: &'a str,
    /// A user row's `@` context spans (`context_blocks`).
    pub context: Option<&'a str>,
    /// An `assistant_tool_use` row's [`RoundRecord`].
    pub raw_json: Option<&'a str>,
    /// A `tool` row's call: the id of the tool_use it answers.
    pub tool_use_id: Option<&'a str>,
    /// A `tool` row's result as the model was given it.
    pub model_view: Option<&'a str>,
}

/// A thread's stored rows as the transcript reads them.
pub fn rows(history: &[crate::db::ChatMessageRow]) -> Vec<Row<'_>> {
    history
        .iter()
        .map(|m| Row {
            id: m.id,
            role: &m.role,
            content: &m.content,
            context: m.context_blocks.as_deref(),
            raw_json: m.raw_json.as_deref(),
            tool_use_id: m.tool_use_id.as_deref(),
            model_view: m.model_view.as_deref(),
        })
        .collect()
}

/// A tool round's assistant turn as the provider returned it, kept on its
/// `assistant_tool_use` row (`raw_json`).
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RoundRecord {
    /// The model that wrote the round. Its verbatim blocks go to it alone.
    pub model: String,
    /// The response's content blocks, verbatim (`LlmResponse::raw_content`).
    pub raw: Vec<Value>,
    pub text: String,
    pub tool_uses: Vec<LlmToolUse>,
}

impl RoundRecord {
    pub fn of(model: &str, response: &LlmResponse) -> Self {
        Self {
            model: model.to_string(),
            raw: response.raw_content.clone(),
            text: response.text.clone(),
            tool_uses: response.tool_uses.clone(),
        }
    }

    /// The assistant turn the round replays as on `model`: verbatim to its
    /// origin model, else rebuilt from its text and tool calls.
    fn turn(self, model: &str) -> LlmMessage {
        let raw = if self.model == model { self.raw } else { Vec::new() };
        LlmMessage {
            role: LlmRole::Assistant,
            content: LlmContent::AssistantWithTools { raw, text: self.text, tool_uses: self.tool_uses },
        }
    }
}

/// The most of one tool result (chars) a model with a `window`-token
/// context is given: [`VIEW_SHARE_PCT`] of the window, within bounds.
pub fn view_cap(window: u64) -> usize {
    let chars = window as f64 * CHARS_PER_TOKEN * VIEW_SHARE_PCT as f64 / 100.0;
    (chars as usize).clamp(VIEW_MIN_CHARS, VIEW_MAX_CHARS)
}

/// What the model is given for one tool result, decided once, when the
/// result is written: at most [`view_cap`] (and the MCP cap for an MCP tool),
/// head and tail, with the row that recalls the rest. A recall is already
/// the model's own window onto a stored output (`offset`/`limit`), so it goes
/// out as it came. A pure function of its inputs; the row keeps the result.
pub fn model_view(tool: &str, result: &str, row: Option<i64>, window: u64) -> String {
    if tool == crate::chat_engine::RECALL_TOOL_NAME {
        return result.to_string();
    }
    let mut cap = view_cap(window);
    if crate::mcp::is_mcp_tool(tool) {
        cap = cap.min(crate::orchestrator::agentic::TOOL_RESULT_CAP_BYTES);
    }
    excerpt_head_tail(result, cap, &row.map(recall_hint).unwrap_or_default())
}

/// Each answered call's stored row, by its tool_use id: the row a context
/// stub names for recall.
pub fn tool_rows(rows: &[Row<'_>]) -> HashMap<String, i64> {
    rows.iter().filter_map(|r| Some((r.tool_use_id?.to_string(), r.id))).collect()
}

/// The history a v2 turn starts from, on `model`. The ask being answered
/// (the last user row) goes out whole; `error`, `stopped` and unknown rows
/// are never replayed; consecutive text turns of one role merge, so roles
/// alternate.
pub fn build(rows: &[Row<'_>], model: &str) -> Vec<LlmMessage> {
    let current = rows.iter().rposition(|r| r.role == "user");
    let mut out: Vec<LlmMessage> = Vec::new();
    let mut pending: Vec<String> = Vec::new();
    let mut i = 0;
    while i < rows.len() {
        let row = &rows[i];
        i += 1;
        match row.role {
            "user" => {
                let text = match row.context {
                    Some(ctx) if Some(i - 1) != current => abridge_context(row.id, row.content, ctx),
                    _ => row.content.to_string(),
                };
                push_text(&mut out, LlmRole::User, flush(&mut pending, &text));
                let after_user = out.last().is_some_and(|m| m.role == LlmRole::User);
                if let Some((turn, next)) = paired(rows, i, model).filter(|_| after_user) {
                    out.extend(turn);
                    i = next;
                }
            }
            "assistant_tool_use" => {
                let lead = strip_tool_calls_suffix(row.content);
                if !lead.is_empty() {
                    pending.push(lead.to_string());
                }
            }
            "tool" => pending.extend(summarize_tool_row(row.id, row.content, TOOL_RESULT_SETTLED)),
            "assistant" => push_text(&mut out, LlmRole::Assistant, flush(&mut pending, row.content.trim())),
            _ => {}
        }
    }
    out
}

/// A turn's rounds as tool_use and tool_result pairs, then its answer,
/// from `rows[start]`, and the index after the answer. `None` unless every
/// round has its record, each of its calls has a result the model was
/// given (in call order, right after it) and an answer closes the last
/// round. Rows after the answer (a `$` command's output) render as text.
fn paired(rows: &[Row<'_>], start: usize, model: &str) -> Option<(Vec<LlmMessage>, usize)> {
    let mut turn = Vec::new();
    let mut i = start;
    loop {
        let row = rows.get(i)?;
        match row.role {
            "assistant" if !turn.is_empty() => {
                turn.push(LlmMessage { role: LlmRole::Assistant, content: LlmContent::Text(row.content.trim().to_string()) });
                return Some((turn, i + 1));
            }
            "assistant_tool_use" => {
                let round: RoundRecord = serde_json::from_str(row.raw_json?).ok()?;
                if round.tool_uses.is_empty() {
                    return None;
                }
                let mut results = Vec::with_capacity(round.tool_uses.len());
                for (k, call) in round.tool_uses.iter().enumerate() {
                    let r = rows.get(i + 1 + k).filter(|r| r.role == "tool" && r.tool_use_id == Some(call.id.as_str()))?;
                    results.push(LlmToolResult { tool_use_id: call.id.clone(), content: r.model_view?.to_string(), is_error: false });
                }
                i += 1 + results.len();
                turn.push(round.turn(model));
                turn.push(LlmMessage { role: LlmRole::User, content: LlmContent::ToolResults(results) });
            }
            _ => return None,
        }
    }
}

/// `pending` (narration and tool summaries), then `tail`.
fn flush(pending: &mut Vec<String>, tail: &str) -> String {
    let mut text = pending.join("\n");
    pending.clear();
    if !text.is_empty() && !tail.is_empty() {
        text.push_str("\n\n");
    }
    text.push_str(tail);
    text
}

fn push_text(out: &mut Vec<LlmMessage>, role: LlmRole, text: String) {
    if text.is_empty() {
        return;
    }
    if let Some(LlmMessage { role: last, content: LlmContent::Text(t) }) = out.last_mut() {
        if *last == role {
            t.push_str("\n\n");
            t.push_str(&text);
            return;
        }
    }
    out.push(LlmMessage { role, content: LlmContent::Text(text) });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_history::{build_history, HistoryRow, TOOL_RESULT_FRESH};
    use crate::db::Db;
    use crate::providers::{anthropic, openai_compat, LlmRequest};
    use serde_json::json;

    fn text(m: &LlmMessage) -> &str {
        match &m.content {
            LlmContent::Text(t) => t.as_str(),
            other => panic!("not text: {other:?}"),
        }
    }

    fn tool_record(call: &str, name: &str, result: &str) -> String {
        json!({ "callId": call, "toolName": name, "toolInput": { "command": "npm test" }, "result": result }).to_string()
    }

    /// The messages of a request on `model` as a provider receives them.
    fn sent(model: &str, messages: &[LlmMessage], openai: bool) -> Value {
        let req = LlmRequest {
            model: model.into(),
            max_tokens: 4096,
            system: "sys".into(),
            messages: messages.to_vec(),
            tools: vec![],
            tool_choice: None,
            effort: None,
            cache: false,
        };
        if openai { openai_compat::build_request(&req)["messages"].clone() } else { anthropic::build_request(&req)["messages"].clone() }
    }

    fn thread(db: &Db) -> String {
        db.insert_project("p", "P", "/tmp/p").unwrap();
        db.insert_workspace("ws", "p", "ws", "", "main", None, "", None).unwrap();
        db.create_chat_thread("ws", "T").unwrap().id
    }

    #[test]
    fn legacy_rows_render_without_model_view() {
        // Rows written before B2: none of the new columns.
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let db = Db::open(tmp.path()).unwrap();
        let t = thread(&db);
        let insert = |role: &str, content: &str| db.insert_chat_message("ws", &t, role, content, None, None, None, None).unwrap();
        insert("user", "run the tests");
        insert("assistant_tool_use", "I'll run them.\n\n[tool_calls: [{\"toolName\":\"run_command\"}]]");
        let tool = insert("tool", &tool_record("c1", "run_command", &"x".repeat(10_000)));
        insert("assistant", "Two failures.");
        insert("user", "fix them");
        let history = db.list_chat_messages(&t).unwrap();
        assert!(history.iter().all(|m| m.raw_json.is_none() && m.tool_use_id.is_none() && m.model_view.is_none()));

        let turn2 = build(&rows(&history), "claude-sonnet-5-5");
        assert_eq!(turn2.iter().map(|m| m.role.clone()).collect::<Vec<_>>(), [LlmRole::User, LlmRole::Assistant, LlmRole::User]);
        // The tool row renders at the settled allowance even in the turn just
        // after it ran, with the row to recall the rest.
        let summary = summarize_tool_row(tool, &history[2].content, TOOL_RESULT_SETTLED).unwrap();
        assert_eq!(text(&turn2[1]), format!("I'll run them.\n{summary}\n\nTwo failures."));
        assert!(summary.contains(&format!("call recall_tool_output with message_id {tool}")));

        // A turn later, the same bytes: a function of the row, never of its age.
        insert("assistant", "Fixed.");
        insert("user", "thanks");
        let history = db.list_chat_messages(&t).unwrap();
        let turn3 = build(&rows(&history), "claude-sonnet-5-5");
        assert_eq!(sent("m", &turn3[..2], false), sent("m", &turn2[..2], false));
        // Where the legacy builder rewrites the row once it settles.
        let legacy = |h: &[crate::db::ChatMessageRow]| {
            let rows: Vec<HistoryRow> = h.iter().map(|m| HistoryRow { id: m.id, role: &m.role, content: &m.content, context: None }).collect();
            build_history(&rows)[1].text.clone()
        };
        assert!(legacy(&history[..5]).len() > TOOL_RESULT_FRESH, "fresh at first");
        assert_ne!(legacy(&history[..5]), legacy(&history));
    }

    #[test]
    fn a_turn_that_cant_replay_as_pairs_renders_as_text() {
        let round = serde_json::to_string(&RoundRecord {
            model: "m".into(),
            raw: vec![],
            text: "Looking.".into(),
            tool_uses: vec![LlmToolUse { id: "tu_1".into(), name: "read_file".into(), input: json!({}) }],
        })
        .unwrap();
        let record = tool_record("tu_1", "read_file", "contents");
        let user = |id, content| Row { id, role: "user", content, ..Row::default() };
        let atu = Row { id: 2, role: "assistant_tool_use", content: "Looking.\n\n[tool_calls: []]", raw_json: Some(round.as_str()), ..Row::default() };
        let tool = Row { id: 3, role: "tool", content: &record, tool_use_id: Some("tu_1"), model_view: Some("contents"), ..Row::default() };
        let answer = Row { id: 4, role: "assistant", content: "Done.", ..Row::default() };
        // Paired: the round, its result, the answer.
        let paired = build(&[user(1, "read it"), atu, tool, answer, user(5, "next")], "m");
        assert!(matches!(paired[1].content, LlmContent::AssistantWithTools { .. }));
        assert!(matches!(paired[2].content, LlmContent::ToolResults(_)));
        assert_eq!(paired.len(), 5);
        // Stopped before an answer, a result without its model view, a stray
        // row inside the turn: text, and the roles still alternate.
        let stray = Row { id: 9, role: "tool", content: &record, ..Row::default() };
        let cases: [Vec<Row>; 3] = [
            vec![user(1, "read it"), atu, tool, Row { role: "stopped", ..answer }, user(5, "continue")],
            vec![user(1, "read it"), atu, Row { model_view: None, ..tool }, answer, user(5, "next")],
            vec![user(1, "read it"), atu, stray, tool, answer, user(5, "next")],
        ];
        for rows in cases {
            let out = build(&rows, "m");
            assert!(out.iter().all(|m| matches!(m.content, LlmContent::Text(_))), "{out:?}");
            assert!(out.windows(2).all(|w| w[0].role != w[1].role), "{out:?}");
            assert!(out.iter().any(|m| text(m).contains("[Tool #3: read_file")), "{out:?}");
        }
    }

    #[test]
    fn raw_replayed_only_to_origin_model() {
        let raw = vec![
            json!({ "type": "thinking", "thinking": "plan", "signature": "sig-1" }),
            json!({ "type": "text", "text": "Checking." }),
            json!({ "type": "tool_use", "id": "tu_1", "name": "read_file", "input": { "path": "a.rs" } }),
        ];
        let round = serde_json::to_string(&RoundRecord {
            model: "claude-opus-5-5".into(),
            raw: raw.clone(),
            text: "Checking.".into(),
            tool_uses: vec![LlmToolUse { id: "tu_1".into(), name: "read_file".into(), input: json!({ "path": "a.rs" }) }],
        })
        .unwrap();
        let record = tool_record("tu_1", "read_file", "fn main() {}");
        let rows = [
            Row { id: 1, role: "user", content: "read a.rs", ..Row::default() },
            Row { id: 2, role: "assistant_tool_use", content: "Checking.\n\n[tool_calls: []]", raw_json: Some(round.as_str()), ..Row::default() },
            Row { id: 3, role: "tool", content: &record, tool_use_id: Some("tu_1"), model_view: Some("fn main() {}"), ..Row::default() },
            Row { id: 4, role: "assistant", content: "It's empty.", ..Row::default() },
            Row { id: 5, role: "user", content: "and now?", ..Row::default() },
        ];
        // The origin model gets the blocks as they came, signed thinking first.
        let same = build(&rows, "claude-opus-5-5");
        assert_eq!(sent("claude-opus-5-5", &same, false)[1]["content"], Value::Array(raw.clone()));
        // Another model: rebuilt from the text and tool calls, no thinking,
        // and every tool_use keeps its result.
        let other = build(&rows, "claude-sonnet-5-5");
        let LlmContent::AssistantWithTools { raw: replayed, text: t, tool_uses } = &other[1].content else { panic!("{other:?}") };
        assert!(replayed.is_empty());
        assert_eq!((t.as_str(), tool_uses[0].id.as_str()), ("Checking.", "tu_1"));
        assert_eq!(sent("claude-sonnet-5-5", &other, false)[1]["content"], Value::Array(raw[1..].to_vec()));
        let openai = sent("gpt-6", &build(&rows, "gpt-6"), true);
        assert_eq!(openai[2]["tool_calls"][0]["id"], "tu_1");
        assert_eq!((openai[3]["role"].as_str(), openai[3]["tool_call_id"].as_str()), (Some("tool"), Some("tu_1")));
        assert!(!openai.to_string().contains("sig-1"));
        // A record that doesn't parse is no record: the turn renders as text.
        let broken = [rows[0], Row { raw_json: Some("{"), ..rows[1] }, rows[2], rows[3], rows[4]];
        assert!(build(&broken, "claude-opus-5-5").iter().all(|m| matches!(m.content, LlmContent::Text(_))));
    }

    #[test]
    fn a_result_is_capped_once_from_the_window() {
        assert_eq!(view_cap(200_000), 35_000);
        assert_eq!(view_cap(8_000), VIEW_MIN_CHARS);
        assert_eq!(view_cap(1_000_000), VIEW_MAX_CHARS);
        let big = format!("HEAD{}TAIL", "x".repeat(200_000));
        let view = model_view("read_file", &big, Some(7), 200_000);
        assert!(view.len() <= 35_000 + 120 && view.starts_with("HEAD") && view.ends_with("TAIL"), "{}", view.len());
        assert!(view.contains("chars omitted — call recall_tool_output with message_id 7 for the full output]"));
        assert_eq!(view, model_view("read_file", &big, Some(7), 200_000), "pure");
        // An MCP result keeps the MCP cap; a recall goes out as it came.
        assert!(model_view("mcp__docs__search", &big, Some(7), 1_000_000).len() <= crate::orchestrator::agentic::TOOL_RESULT_CAP_BYTES + 120);
        assert_eq!(model_view("recall_tool_output", &big, Some(7), 200_000), big);
        assert_eq!(model_view("run_command", "ok", Some(7), 200_000), "ok");
    }
}
