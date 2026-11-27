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
//!   tool_result pairs the loop sent, minus its thinking: a prior turn's
//!   thinking isn't replayed (the loop sends the current turn's rounds with
//!   theirs). Its blocks go only to the model that wrote them; after a model
//!   switch the round is rebuilt from its text and tool calls.
//! - A turn that can't replay as pairs renders as text, the way
//!   `chat_history` does: a legacy row without these columns, a stopped or
//!   failed turn (no answer closes its last round), a fork's copies, or a
//!   round missing a column. Those tool rows keep legacy's thread-wide bound
//!   (the settled allowance, the oldest collapsing to stubs in blocks).
//!
//! Each row changes at most once more, and is byte-stable after it: an `@`
//! block of 8k chars or more goes out whole in its own turn and shortened
//! from the next turn on (`chat_history::abridge_context`), and a result
//! the context guard stubs keeps its stub as its model view
//! (`db::set_chat_tool_stub`). A prior turn's rounds lose their thinking
//! once, when the turn ends.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::chat_history::{
    abridge_context, excerpt_head_tail, mark_untrusted, plan_tool_history_with, recall_hint, shortened_context_len,
    strip_tool_calls_suffix, summarize_tool_row, TOOL_HISTORY_STUB,
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

    /// The assistant turn the round replays as in a later turn on `model`:
    /// to its origin model, its blocks as they came minus thinking; else (or
    /// for an OpenAI Responses round) rebuilt from its text and tool calls.
    /// Thinking isn't re-sent across turns, so a round costs no thinking
    /// tokens later and reads the same whether or not this turn thinks.
    fn turn(self, model: &str) -> LlmMessage {
        let raw = if self.model != model || crate::providers::openai_compat::is_responses_raw(&self.raw) {
            Vec::new()
        } else {
            self.raw.into_iter().filter(|b| !matches!(b["type"].as_str(), Some("thinking" | "redacted_thinking"))).collect()
        };
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

/// Room a recall's own position line and cut note take past its window.
const RECALL_SLACK: usize = 200;

/// The most one `recall_tool_output` call returns on a v2 turn (chars):
/// under [`view_cap`], so the recall's model view is never cut.
pub fn recall_limit(window: u64) -> usize {
    view_cap(window) - RECALL_SLACK
}

/// What the model is given for one tool result, decided once, when the
/// result is written: at most [`view_cap`] (and the MCP cap for an MCP tool),
/// head and tail, with the row that recalls the rest. A recall is capped the
/// same way; on a v2 turn its window fits ([`recall_limit`]). `mark` is the
/// tool the output came from: the capped text goes under its untrusted
/// header, with forged records and marks in it neutralized
/// (`chat_history::mark_untrusted`, #1147). `None` for a denial or refusal,
/// which is Octopush's own text. A pure function of its inputs; the row
/// keeps the result, mark and all, so the mark is byte-stable too.
pub fn model_view(tool: &str, result: &str, row: Option<i64>, window: u64, mark: Option<&str>) -> String {
    let mut cap = view_cap(window);
    if crate::mcp::is_mcp_tool(tool) {
        cap = cap.min(crate::orchestrator::agentic::TOOL_RESULT_CAP_BYTES);
    }
    let capped = excerpt_head_tail(result, cap, &row.map(recall_hint).unwrap_or_default());
    match mark {
        Some(source) => mark_untrusted(source, &capped),
        None => capped,
    }
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
    build_landing(rows, model, &HashSet::new()).0
}

/// [`build`], and for each message the user rows of `with_images` (asks
/// that carry images, #1159) it holds, for `chat_attachments::attach`. Such
/// an ask makes a message even when its text is empty; with no such ask the
/// messages are [`build`]'s.
pub fn build_landing(rows: &[Row<'_>], model: &str, with_images: &HashSet<i64>) -> (Vec<LlmMessage>, Vec<Vec<i64>>) {
    let current = rows.iter().rposition(|r| r.role == "user");
    // The turns that replay as pairs, by their ask's index. An empty ask
    // (an image alone) renders as text, so pairs always follow a user message.
    let mut pairs: HashMap<usize, (Vec<LlmMessage>, usize)> = rows
        .iter()
        .enumerate()
        .filter(|(_, r)| r.role == "user" && !r.content.is_empty())
        .filter_map(|(i, _)| Some((i, paired(rows, i + 1, model)?)))
        .collect();
    // Tool rows rendered as text keep legacy's thread-wide bound: the settled
    // allowance, the oldest collapsing to stubs in blocks once the settled
    // total (shortened `@` blocks counted) passes the budget. It only moves
    // forward as rows are appended.
    let covered: HashSet<usize> = pairs.iter().flat_map(|(&ask, (_, next))| ask + 1..*next).collect();
    let text_tools: Vec<(usize, usize)> = rows
        .iter()
        .enumerate()
        .filter(|&(i, r)| r.role == "tool" && !covered.contains(&i))
        .map(|(_, r)| (1, result_len(r.content)))
        .collect();
    let shortened: usize = rows.iter().filter(|r| r.role == "user").filter_map(|r| Some(shortened_context_len(r.content, r.context?))).sum();
    let mut allowance = plan_tool_history_with(&text_tools, shortened).into_iter();
    let mut out: Vec<LlmMessage> = Vec::new();
    let mut landing: Vec<Vec<i64>> = Vec::new();
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
                let ask = Some(row.id).filter(|id| with_images.contains(id));
                push_text(&mut out, &mut landing, LlmRole::User, flush(&mut pending, &text), ask);
                if let Some((turn, next)) = pairs.remove(&(i - 1)) {
                    landing.extend(turn.iter().map(|_| Vec::new()));
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
            "tool" => pending.extend(summarize_tool_row(row.id, row.content, allowance.next().unwrap_or(TOOL_HISTORY_STUB))),
            "assistant" => push_text(&mut out, &mut landing, LlmRole::Assistant, flush(&mut pending, row.content.trim()), None),
            _ => {}
        }
    }
    // A turn continued with no new message (the error card's "Try again"):
    // what it did before it failed rides on its ask, as on a next one.
    push_text(&mut out, &mut landing, LlmRole::User, flush(&mut pending, ""), None);
    (out, landing)
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
                    let is_error = serde_json::from_str::<Value>(r.content).is_ok_and(|v| tool_row_is_error(&v));
                    results.push(LlmToolResult { tool_use_id: call.id.clone(), content: r.model_view?.to_string(), is_error });
                }
                i += 1 + results.len();
                turn.push(round.turn(model));
                turn.push(LlmMessage { role: LlmRole::User, content: LlmContent::ToolResults(results) });
            }
            // A quiet note between rounds (a mode change, #1231) is the
            // user's, never the model's: the rounds around it still pair.
            "stopped" if !turn.is_empty() => i += 1,
            _ => return None,
        }
    }
}

/// Whether a tool row's result goes to the model as an error: the call
/// failed or was denied (the row's stamped `ok` is false). A row from before
/// the stamp carries no `ok` and reads as it was sent then, not an error.
/// The live round and its replay both read it here, so a later turn
/// re-sends the round byte for byte and its cached prefix holds.
pub(crate) fn tool_row_is_error(row: &Value) -> bool {
    row.get("ok").and_then(Value::as_bool) == Some(false)
}

/// A stored tool row's result length, as `chat_history` plans it.
fn result_len(content: &str) -> usize {
    serde_json::from_str::<Value>(content).ok().and_then(|v| v.get("result")?.as_str().map(str::len)).unwrap_or(0)
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

/// `text` as a `role` message, merged into the last one when it is a text
/// message of that role; `ask` is the user row it holds, when it has images.
fn push_text(out: &mut Vec<LlmMessage>, landing: &mut Vec<Vec<i64>>, role: LlmRole, text: String, ask: Option<i64>) {
    if text.is_empty() && ask.is_none() {
        return;
    }
    if let Some(LlmMessage { role: last, content: LlmContent::Text(t) }) = out.last_mut() {
        if *last == role {
            if !text.is_empty() {
                if !t.is_empty() {
                    t.push_str("\n\n");
                }
                t.push_str(&text);
            }
            if let (Some(id), Some(asks)) = (ask, landing.last_mut()) {
                asks.push(id);
            }
            return;
        }
    }
    out.push(LlmMessage { role, content: LlmContent::Text(text) });
    landing.push(ask.into_iter().collect());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_history::{build_history, HistoryRole, HistoryRow, TOOL_RESULT_FRESH, TOOL_RESULT_SETTLED};
    use crate::context::budget::{ContextBudget, ContextGuard, Learned, SOFT_PCT};
    use crate::db::Db;
    use crate::providers::{anthropic, openai_compat, Effort, LlmRequest};
    use serde_json::json;

    /// A stored row, owned, for tests that build many.
    #[derive(Default)]
    struct Owned {
        id: i64,
        role: &'static str,
        content: String,
        raw_json: Option<String>,
        tool_use_id: Option<String>,
        model_view: Option<String>,
    }

    impl Owned {
        fn row(&self) -> Row<'_> {
            Row {
                id: self.id,
                role: self.role,
                content: &self.content,
                context: None,
                raw_json: self.raw_json.as_deref(),
                tool_use_id: self.tool_use_id.as_deref(),
                model_view: self.model_view.as_deref(),
            }
        }
    }

    /// A finished v2 turn from id `base`: its ask, one round whose calls were
    /// given `views`, and its answer.
    fn v2_turn(base: i64, views: &[String]) -> Vec<Owned> {
        let calls: Vec<LlmToolUse> =
            (0..views.len()).map(|k| LlmToolUse { id: format!("tu_{base}_{k}"), name: "read_file".into(), input: json!({}) }).collect();
        let raw = calls.iter().map(|u| json!({ "type": "tool_use", "id": u.id, "name": u.name, "input": u.input })).collect();
        let record = RoundRecord { model: "m".into(), raw, text: String::new(), tool_uses: calls.clone() };
        let mut rows = vec![
            Owned { id: base, role: "user", content: format!("ask {base}"), ..Owned::default() },
            Owned { id: base + 1, role: "assistant_tool_use", content: "[tool_calls: []]".into(), raw_json: serde_json::to_string(&record).ok(), ..Owned::default() },
        ];
        for (k, (u, view)) in calls.iter().zip(views).enumerate() {
            let content = tool_record(&u.id, "read_file", view);
            rows.push(Owned { id: base + 2 + k as i64, role: "tool", content, tool_use_id: Some(u.id.clone()), model_view: Some(view.clone()), ..Owned::default() });
        }
        rows.push(Owned { id: base + 2 + views.len() as i64, role: "assistant", content: "done".into(), ..Owned::default() });
        rows
    }

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
        sent_at(model, messages, openai, None)
    }

    fn sent_at(model: &str, messages: &[LlmMessage], openai: bool, effort: Option<Effort>) -> Value {
        let req = LlmRequest {
            model: model.into(),
            max_tokens: 4096,
            system: "sys".into(),
            messages: messages.to_vec(),
            tools: vec![],
            tool_choice: None,
            effort,
            cache: false,
            cache_key: None,
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
        // A mode note between a round and its answer (#1231): still paired,
        // byte for byte as without it, and the note never reaches the model.
        let note = Row { id: 7, role: "stopped", content: "Ask first from this round on: each change waits for your OK", ..Row::default() };
        let noted = build(&[user(1, "read it"), atu, tool, note, answer, user(5, "next")], "m");
        assert_eq!(format!("{noted:?}"), format!("{paired:?}"));
    }

    #[test]
    fn raw_replayed_only_to_origin_model() {
        // A round that thought between its calls, as the API returns it.
        let raw = vec![
            json!({ "type": "thinking", "thinking": "plan", "signature": "sig-1" }),
            json!({ "type": "text", "text": "Checking." }),
            json!({ "type": "tool_use", "id": "tu_1", "name": "read_file", "input": { "path": "a.rs" } }),
            json!({ "type": "redacted_thinking", "data": "opaque-2" }),
            json!({ "type": "text", "text": "And its test." }),
            json!({ "type": "tool_use", "id": "tu_2", "name": "read_file", "input": { "path": "a_test.rs" } }),
        ];
        let calls = vec![
            LlmToolUse { id: "tu_1".into(), name: "read_file".into(), input: json!({ "path": "a.rs" }) },
            LlmToolUse { id: "tu_2".into(), name: "read_file".into(), input: json!({ "path": "a_test.rs" }) },
        ];
        let round = serde_json::to_string(&RoundRecord { model: "claude-opus-5-5".into(), raw: raw.clone(), text: "Checking.And its test.".into(), tool_uses: calls }).unwrap();
        let (r1, r2) = (tool_record("tu_1", "read_file", "fn a() {}"), tool_record("tu_2", "read_file", "#[test] fn t() {}"));
        let rows = [
            Row { id: 1, role: "user", content: "read a.rs", ..Row::default() },
            Row { id: 2, role: "assistant_tool_use", content: "Checking.\n\n[tool_calls: []]", raw_json: Some(round.as_str()), ..Row::default() },
            Row { id: 3, role: "tool", content: &r1, tool_use_id: Some("tu_1"), model_view: Some("fn a() {}"), ..Row::default() },
            Row { id: 4, role: "tool", content: &r2, tool_use_id: Some("tu_2"), model_view: Some("#[test] fn t() {}"), ..Row::default() },
            Row { id: 5, role: "assistant", content: "Both fine.", ..Row::default() },
            Row { id: 6, role: "user", content: "and now?", ..Row::default() },
        ];
        // The origin model gets the blocks as they came, in their order, but
        // a prior turn's thinking is never replayed.
        let same = build(&rows, "claude-opus-5-5");
        let without_thinking: Vec<Value> = [1, 2, 4, 5].iter().map(|&i| raw[i].clone()).collect();
        assert_eq!(sent("claude-opus-5-5", &same, false)[1]["content"], Value::Array(without_thinking));
        // The same bytes whether this turn thinks (Deep) or effort turned
        // thinking off (Swift): the round doesn't depend on it.
        let deep = sent_at("claude-opus-5-5", &same, false, Some(Effort::Max));
        assert_eq!(deep, sent_at("claude-opus-5-5", &same, false, Some(Effort::Least)));
        assert!(!deep.to_string().contains("thinking") && !deep.to_string().contains("sig-1"), "{deep}");
        // Another model: rebuilt from the text and tool calls, and every
        // tool_use keeps its result.
        let other = build(&rows, "claude-sonnet-5-5");
        let LlmContent::AssistantWithTools { raw: replayed, text: t, tool_uses } = &other[1].content else { panic!("{other:?}") };
        assert!(replayed.is_empty());
        assert_eq!((t.as_str(), tool_uses.len()), ("Checking.And its test.", 2));
        assert_eq!(sent("claude-sonnet-5-5", &other, false)[1]["content"][1]["id"], "tu_1");
        let openai = sent("gpt-6", &build(&rows, "gpt-6"), true);
        assert_eq!((openai[2]["tool_calls"][0]["id"].as_str(), openai[2]["tool_calls"][1]["id"].as_str()), (Some("tu_1"), Some("tu_2")));
        assert_eq!((openai[3]["role"].as_str(), openai[3]["tool_call_id"].as_str()), (Some("tool"), Some("tu_1")));
        assert!(!openai.to_string().contains("sig-1"));
        // A record that doesn't parse is no record: the turn renders as text.
        let broken = [rows[0], Row { raw_json: Some("{"), ..rows[1] }, rows[2], rows[3], rows[4], rows[5]];
        assert!(build(&broken, "claude-opus-5-5").iter().all(|m| matches!(m.content, LlmContent::Text(_))));
    }

    #[test]
    fn a_long_legacy_thread_keeps_legacys_bound() {
        // 100 legacy turns with three 5k outputs each: 300 tool rows.
        let record = tool_record("c", "run_command", &"o".repeat(5_000));
        let mut owned = Vec::new();
        for turn in 0..100 {
            let b = turn * 10;
            owned.push(Owned { id: b, role: "user", content: format!("ask {turn}"), ..Owned::default() });
            owned.push(Owned { id: b + 1, role: "assistant_tool_use", content: "[tool_calls: []]".into(), ..Owned::default() });
            owned.extend((2..5).map(|k| Owned { id: b + k, role: "tool", content: record.clone(), ..Owned::default() }));
            owned.push(Owned { id: b + 5, role: "assistant", content: "ok".into(), ..Owned::default() });
        }
        owned.push(Owned { id: 10_000, role: "user", content: "next".into(), ..Owned::default() });
        let rows: Vec<Row> = owned.iter().map(Owned::row).collect();
        let v2 = build(&rows, "m");
        let history: Vec<HistoryRow> = rows.iter().map(|r| HistoryRow { id: r.id, role: r.role, content: r.content, context: None }).collect();
        let legacy: Vec<LlmMessage> = build_history(&history)
            .into_iter()
            .map(|h| LlmMessage { role: if h.role == HistoryRole::User { LlmRole::User } else { LlmRole::Assistant }, content: LlmContent::Text(h.text) })
            .collect();
        // At 1.5k a row they would be 450k chars, past a 100k window. They
        // collapse as legacy's do, so v2 fits wherever legacy does.
        let chars = |m: &[LlmMessage]| m.iter().map(|m| text(m).len()).sum::<usize>();
        assert!(chars(&v2) <= chars(&legacy), "{} vs {}", chars(&v2), chars(&legacy));
        let guard = ContextGuard::new(ContextBudget::for_model(Some(100_000), 4_096, None), Learned::default());
        let soft = guard.budget().share(SOFT_PCT);
        assert!(guard.estimate(0, &legacy) < soft && guard.estimate(0, &v2) < soft, "{} {}", guard.estimate(0, &v2), soft);
        assert!(text(&v2[1]).contains(&format!("[Tool #2: run_command | Input: {{\"command\":\"npm test\"}} | Result: [untrusted output from run_command] {}\n…", "o".repeat(140))));
    }

    #[test]
    fn the_guard_stubs_a_v2_transcript_and_names_its_rows() {
        // Three finished v2 turns of two 10k results each, past the soft
        // threshold of a small window.
        let big = "x".repeat(10_000);
        let mut owned: Vec<Owned> = [10, 20, 30].iter().flat_map(|&b| v2_turn(b, &[big.clone(), big.clone()])).collect();
        owned.push(Owned { id: 40, role: "user", content: "next".into(), ..Owned::default() });
        let rows: Vec<Row> = owned.iter().map(Owned::row).collect();
        let mut messages = build(&rows, "m");
        let ids = tool_rows(&rows);
        let assistants = |m: &[LlmMessage]| format!("{:?}", m.iter().filter(|m| m.role == LlmRole::Assistant).collect::<Vec<_>>());
        let before = assistants(&messages);
        let guard = ContextGuard::new(ContextBudget::for_model(Some(20_000), 2_000, None), Learned::default());
        let s = guard.before_round(&mut messages, 0, &ids).expect("past the soft threshold");
        // The oldest turns' results, each naming its own row; the newest round
        // and every assistant turn as they were.
        assert_eq!(s.ids, ["tu_10_0", "tu_10_1", "tu_20_0", "tu_20_1"]);
        for m in &messages {
            let LlmContent::ToolResults(results) = &m.content else { continue };
            for r in results {
                if s.ids.contains(&r.tool_use_id) {
                    assert!(r.content.len() < 1_000 && r.content.contains(&recall_hint(ids[&r.tool_use_id])), "{}", r.content);
                } else {
                    assert_eq!(r.content, big);
                }
            }
        }
        assert_eq!(assistants(&messages), before);
    }

    #[test]
    fn a_failed_or_denied_call_replays_as_an_error() {
        // One round of three calls: one passed, one failed, one from before
        // the outcome stamp (no `ok`).
        let mut owned = v2_turn(10, &["a".to_string(), "b".to_string(), "c".to_string()]);
        let stamp = |row: &mut Owned, ok: bool| {
            let mut v: Value = serde_json::from_str(&row.content).unwrap();
            v["ok"] = json!(ok);
            row.content = v.to_string();
        };
        stamp(&mut owned[2], true);
        stamp(&mut owned[3], false);
        owned.push(Owned { id: 20, role: "user", content: "next".into(), ..Owned::default() });
        let rows: Vec<Row> = owned.iter().map(Owned::row).collect();
        let messages = build(&rows, "m");
        let flags: Vec<bool> = messages
            .iter()
            .flat_map(|m| match &m.content {
                LlmContent::ToolResults(results) => results.iter().map(|r| r.is_error).collect(),
                _ => Vec::new(),
            })
            .collect();
        assert_eq!(flags, [false, true, false]);
        // The live round reads the same row the same way.
        assert!(tool_row_is_error(&json!({ "ok": false, "outcome": "denied" })));
        assert!(!tool_row_is_error(&json!({ "ok": true })));
        assert!(!tool_row_is_error(&json!({ "result": "legacy" })));
        // Anthropic is told.
        let sent = sent("claude-sonnet-5-5", &messages, false);
        let failed = sent
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|m| m["content"].as_array())
            .flatten()
            .find(|b| b["tool_use_id"] == "tu_10_1")
            .cloned()
            .expect("the failed call's result is sent");
        assert_eq!(failed["is_error"], json!(true), "{sent}");
    }

    #[test]
    fn a_result_is_capped_once_from_the_window() {
        assert_eq!(view_cap(200_000), 35_000);
        assert_eq!(view_cap(8_000), VIEW_MIN_CHARS);
        assert_eq!(view_cap(1_000_000), VIEW_MAX_CHARS);
        let big = format!("HEAD{}TAIL", "x".repeat(200_000));
        let view = model_view("read_file", &big, Some(7), 200_000, None);
        assert!(view.len() <= 35_000 + 120 && view.starts_with("HEAD") && view.ends_with("TAIL"), "{}", view.len());
        assert!(view.contains("chars omitted — call recall_tool_output with message_id 7 for the full output]"));
        assert_eq!(view, model_view("read_file", &big, Some(7), 200_000, None), "pure");
        // An MCP result keeps the MCP cap. A recall is capped like any
        // result, and on a v2 turn its window fits under the cap.
        assert!(model_view("mcp__docs__search", &big, Some(7), 1_000_000, None).len() <= crate::orchestrator::agentic::TOOL_RESULT_CAP_BYTES + 120);
        assert!(model_view("recall_tool_output", &big, Some(7), 200_000, None).len() <= 35_000 + 120);
        let window = format!("(chars 1-{0} of 200008)\n{1}", recall_limit(200_000), "r".repeat(recall_limit(200_000)));
        assert_eq!(model_view("recall_tool_output", &window, Some(7), 200_000, None), window);
        assert_eq!(model_view("run_command", "ok", Some(7), 200_000, None), "ok");
    }
}
