//! TALK conversation history → provider context.
//!
//! On every turn `chat_engine::send_agentic` rebuilds the model's context from
//! the thread's persisted rows. This module owns the shape of that rebuild —
//! how much of each earlier tool output survives, how the model's own
//! pre-tool narration is kept, how turns merge — as pure functions over plain
//! rows, so the exact context a follow-up turn sees is unit-tested without a
//! provider or a database.
//!
//! Tool outputs are the expensive part. Instead of one flat cut for every
//! tool row (the old 500-char truncation that lost every diff, log tail and
//! stack trace the moment a turn ended), each row gets a **settle-once
//! allowance**: the turn the user is most likely following up on keeps the
//! most, every older turn keeps one final size for good, and a thread-wide
//! budget bounds the total by collapsing the oldest rows in blocks. Stable
//! old rows matter as much as generous fresh ones: the rendered history is
//! the prompt prefix the provider caches, and every rewrite of an old row
//! throws that cache away from the row to the end of the thread. What a
//! row shows is a **head + tail excerpt** (the tail is where exit codes and
//! errors live) that names its message id, so the model can pull the full
//! stored output back on demand with the `recall_tool_output` tool.

/// Tool-call rounds a single TALK turn may run when no preference is saved.
pub const DEFAULT_TALK_MAX_ITERATIONS: usize = 25;
/// Lowest value the "Tool turns per message" preference may take.
pub const TALK_MAX_ITERATIONS_MIN: usize = 5;
/// Highest value the "Tool turns per message" preference may take.
pub const TALK_MAX_ITERATIONS_MAX: usize = 200;

/// Resolve the saved "Tool turns per message" preference into the loop bound
/// `send_agentic` runs with: unset → the default, set → clamped to the
/// supported range (a hand-edited settings.json can't produce a zero-turn or
/// runaway loop).
pub fn effective_talk_max_iterations(setting: Option<u32>) -> usize {
    match setting {
        Some(n) => (n as usize).clamp(TALK_MAX_ITERATIONS_MIN, TALK_MAX_ITERATIONS_MAX),
        None => DEFAULT_TALK_MAX_ITERATIONS,
    }
}

/// The saved "Sub-agent tool turns" preference as the bound a sub-agent runs
/// with: unset (the default) is **no limit** — a sub-agent runs until it
/// finishes or is stopped, so the director never builds on a report cut
/// mid-work; a set value is clamped like the Talk turns. A definition's own
/// `max-turns` is applied on top, never above a set preference.
pub fn effective_subagent_max_iterations(setting: Option<u32>) -> Option<usize> {
    setting.map(|n| (n as usize).clamp(TALK_MAX_ITERATIONS_MIN, TALK_MAX_ITERATIONS_MAX))
}

/// The turn bound one sub-agent runs with, `None` = unlimited: its
/// definition's `max-turns` when it has one (capped by a set preference),
/// else the preference — which, unset, is no limit at all.
pub fn subagent_iterations(definition_max_turns: Option<u32>, subagent_cap: Option<usize>) -> Option<usize> {
    match (definition_max_turns, subagent_cap) {
        (Some(n), Some(cap)) => Some((n as usize).max(1).min(cap)),
        (Some(n), None) => Some((n as usize).max(1)),
        (None, cap) => cap,
    }
}

/// Chars of one tool result kept in context, by how many turns ago it ran
/// (0 = the turn just before the message being sent). A follow-up almost
/// always refers to the previous turn, so that one stays close to verbatim;
/// every older result settles to ONE final size and then never changes
/// again. Two sizes, not a fade: a row's rendered text is part of the prompt
/// prefix every later turn re-sends, and each rewrite of an old row
/// invalidates the provider's prompt cache from that row to the end of the
/// thread. With a settle-once schedule a row is rewritten exactly once (the
/// turn after it ran, when it sits near the tail and the cache loss is
/// small) instead of on every age boundary.
pub fn tool_result_allowance(turns_ago: usize) -> usize {
    if turns_ago == 0 {
        TOOL_RESULT_FRESH
    } else {
        TOOL_RESULT_SETTLED
    }
}

/// Allowance for a result from the turn just before the message being sent.
pub const TOOL_RESULT_FRESH: usize = 6_000;
/// Final allowance for every older result — the size it keeps for the rest
/// of the thread (until the thread-wide budget collapses it to a stub).
pub const TOOL_RESULT_SETTLED: usize = 1_500;

/// Thread-wide cap on the SETTLED tool-output chars re-sent per turn. A
/// long-lived thread with hundreds of tool rows can't grow past this no
/// matter how many rows it holds; rows beyond it collapse to
/// [`TOOL_HISTORY_STUB`]. Counted over every row's settled size — never the
/// fresh size — so the figure only ever grows as rows are appended, and the
/// collapse boundary it drives only ever moves forward.
pub const TOOL_HISTORY_TOTAL_BUDGET: usize = 80_000;
/// Extra chars the fresh (age 0) rows may add on top of their settled size,
/// funded newest-first. Bounds a tool-heavy turn without touching any
/// older row's rendering.
pub const TOOL_HISTORY_FRESH_EXTRA: usize = 40_000;
/// Excerpt size for a tool row once the thread-wide budget is spent.
pub const TOOL_HISTORY_STUB: usize = 200;
/// Granularity of the budget collapse. When the thread outgrows the budget,
/// the oldest rows are stubbed in blocks of this many chars — not one row at
/// a time — so the collapse point moves only every ~block of new tool output
/// (one cache rewrite of the old rows every few turns, not every turn).
pub const TOOL_HISTORY_COLLAPSE_BLOCK: usize = 20_000;
/// Longest tool INPUT echoed into a summary (a heredoc'd `run_command` or a
/// large `edit_file` old/new pair would otherwise dwarf the result).
const TOOL_INPUT_MAX: usize = 600;

/// Plan how many chars each tool row keeps. `rows` is `(turns_ago, len)` in
/// chronological order; the result is one allowance per row in the same
/// order.
///
/// The plan is monotone across turns, which is what keeps the provider's
/// prompt cache warm:
/// 1. Every row's baseline is its settled size. The sum of baselines only
///    grows as rows are appended, so the block-quantized collapse of the
///    OLDEST rows to the stub (see [`TOOL_HISTORY_COLLAPSE_BLOCK`]) only ever
///    moves forward — a row that was stubbed stays stubbed, and a settled
///    row is never rewritten until the boundary reaches it.
/// 2. Fresh rows (age 0) are then raised to their fresh size, newest-first,
///    within [`TOOL_HISTORY_FRESH_EXTRA`]; when they settle next turn they
///    shrink once, at the tail of the prefix, where the cache loss is small.
///
/// A pure function of the rows, so the same thread state always renders the
/// same prefix.
pub fn plan_tool_history(rows: &[(usize, usize)]) -> Vec<usize> {
    let mut plan: Vec<usize> = rows
        .iter()
        .map(|&(_, len)| len.min(TOOL_RESULT_SETTLED))
        .collect();
    let settled_total: usize = plan.iter().sum();
    if settled_total > TOOL_HISTORY_TOTAL_BUDGET {
        let overflow = settled_total - TOOL_HISTORY_TOTAL_BUDGET;
        let target = overflow.div_ceil(TOOL_HISTORY_COLLAPSE_BLOCK) * TOOL_HISTORY_COLLAPSE_BLOCK;
        let mut shed = 0usize;
        for (i, &(_, len)) in rows.iter().enumerate() {
            if shed >= target {
                break;
            }
            let stub = len.min(TOOL_HISTORY_STUB);
            shed += plan[i].saturating_sub(stub);
            plan[i] = stub;
        }
    }
    let mut extra = TOOL_HISTORY_FRESH_EXTRA;
    for (i, &(turns_ago, len)) in rows.iter().enumerate().rev() {
        if turns_ago != 0 {
            continue;
        }
        let want = len.min(TOOL_RESULT_FRESH);
        let raise = want.saturating_sub(plan[i]);
        if raise <= extra {
            extra -= raise;
            plan[i] = want;
        }
    }
    plan
}

/// Longest prefix of `s` that fits in `max` bytes, cut on a char boundary.
fn head_bytes(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Longest suffix of `s` that fits in `max` bytes, cut on a char boundary.
fn tail_bytes(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut start = s.len() - max;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    &s[start..]
}

/// Keep the head and the tail of `s` within `budget` bytes, marking the gap.
/// 70/30 head/tail: the head says what a command printed first, the tail is
/// where its exit status, the failing assertion or the last error line sits.
/// `recall_hint` is appended inside the gap marker so a truncated excerpt
/// tells the model how to get the rest.
pub fn excerpt_head_tail(s: &str, budget: usize, recall_hint: &str) -> String {
    if s.len() <= budget {
        return s.to_string();
    }
    let head_max = budget * 7 / 10;
    let tail_max = budget - head_max;
    let head = head_bytes(s, head_max);
    let tail = tail_bytes(s, tail_max);
    let omitted = s.len().saturating_sub(head.len() + tail.len());
    format!("{head}\n… [{omitted} chars omitted{recall_hint}]\n{tail}")
}

/// Char-window over `s` for `recall_tool_output`: `offset` bytes in (snapped
/// forward to a char boundary), at most `limit` bytes (snapped back). Prefixes
/// a `(chars a-b of total)` line when the window doesn't cover everything so
/// the model knows to page.
pub fn window_text(s: &str, offset: usize, limit: usize) -> String {
    let total = s.len();
    if offset == 0 && limit >= total {
        return s.to_string();
    }
    let mut start = offset.min(total);
    while start < total && !s.is_char_boundary(start) {
        start += 1;
    }
    let body = head_bytes(&s[start..], limit);
    let end = start + body.len();
    format!("(chars {}-{} of {total})\n{body}", start + 1, end)
}

/// A persisted chat row as the history builder sees it.
#[derive(Debug, Clone, Copy)]
pub struct HistoryRow<'a> {
    pub id: i64,
    pub role: &'a str,
    pub content: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryRole {
    User,
    Assistant,
}

/// One provider-facing turn: `chat_engine` maps this 1:1 onto an
/// `LlmMessage` with text content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryTurn {
    pub role: HistoryRole,
    pub text: String,
}

/// The bookkeeping suffix `send_agentic` appends to `assistant_tool_use`
/// rows; everything before it is the model's own lead-in prose.
const TOOL_CALLS_MARKER: &str = "[tool_calls:";

fn strip_tool_calls_suffix(content: &str) -> &str {
    match content.find(TOOL_CALLS_MARKER) {
        Some(idx) => content[..idx].trim(),
        None => content.trim(),
    }
}

/// Format one persisted `role="tool"` row for the model. `budget` is the
/// result allowance from [`plan_tool_history`]; a truncated result names the
/// row id so `recall_tool_output` can fetch the rest.
fn summarize_tool_row(id: i64, content: &str, budget: usize) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(content).ok()?;
    let name = parsed.get("toolName").and_then(|n| n.as_str()).unwrap_or("tool");
    let empty_obj = serde_json::json!({});
    let input = parsed.get("toolInput").unwrap_or(&empty_obj);
    let result = parsed.get("result").and_then(|r| r.as_str()).unwrap_or("");
    let input_json = serde_json::to_string(input).unwrap_or_default();
    let input_shown = if input_json.len() > TOOL_INPUT_MAX {
        format!("{}…", head_bytes(&input_json, TOOL_INPUT_MAX))
    } else {
        input_json
    };
    let hint = format!(" — call recall_tool_output with message_id {id} for the full output");
    let result_shown = excerpt_head_tail(result, budget, &hint);
    Some(format!("[Tool #{id}: {name} | Input: {input_shown} | Result: {result_shown}]"))
}

/// Rebuild a thread's rows into alternating provider turns.
///
/// - `assistant_tool_use` rows contribute the model's lead-in prose ("Now I
///   have the full picture…"), in order with the tool summaries that
///   followed, so a continued turn reads as one narrative.
/// - `tool` rows become `[Tool #id: …]` summaries under the recency plan.
/// - `assistant` rows close a turn: pending narration + summaries + the final
///   text become one Assistant turn.
/// - `user` rows absorb any orphaned narration/summaries (a `$`-direct
///   command's output, a turn that errored before answering) so the model
///   still sees what happened, then merge into a preceding user turn rather
///   than producing two in a row (strict providers reject that).
/// - `error`, `stopped` and unknown roles are never replayed.
///
/// Consecutive same-role turns are merged, so the output alternates.
pub fn build_history(rows: &[HistoryRow<'_>]) -> Vec<HistoryTurn> {
    // Pass 1 — how many turns ago each tool row ran. The row being sent is
    // already persisted as the trailing user row, so "user rows after this
    // one, minus that one" counts completed turns since the tool ran.
    let mut users_after = 0usize;
    let mut tool_plan_input: Vec<(usize, usize)> = Vec::new();
    let tool_len = |content: &str| -> usize {
        serde_json::from_str::<serde_json::Value>(content)
            .ok()
            .and_then(|v| v.get("result").and_then(|r| r.as_str()).map(|r| r.len()))
            .unwrap_or(0)
    };
    let mut ages: Vec<usize> = vec![0; rows.len()];
    for (i, row) in rows.iter().enumerate().rev() {
        match row.role {
            "user" => users_after += 1,
            "tool" => ages[i] = users_after.saturating_sub(1),
            _ => {}
        }
    }
    for (i, row) in rows.iter().enumerate() {
        if row.role == "tool" {
            tool_plan_input.push((ages[i], tool_len(row.content)));
        }
    }
    let plan = plan_tool_history(&tool_plan_input);
    let mut plan_iter = plan.into_iter();

    // Pass 2 — assemble.
    let mut turns: Vec<HistoryTurn> = Vec::new();
    let mut pending: Vec<String> = Vec::new();
    let push_turn = |turns: &mut Vec<HistoryTurn>, role: HistoryRole, text: String| {
        if text.is_empty() {
            return;
        }
        match turns.last_mut() {
            Some(last) if last.role == role => {
                last.text.push_str("\n\n");
                last.text.push_str(&text);
            }
            _ => turns.push(HistoryTurn { role, text }),
        }
    };
    let flush = |pending: &mut Vec<String>, tail: &str| -> String {
        let mut content = String::new();
        if !pending.is_empty() {
            content.push_str(&pending.join("\n"));
            pending.clear();
            if !tail.is_empty() {
                content.push_str("\n\n");
            }
        }
        content.push_str(tail);
        content
    };

    for row in rows {
        match row.role {
            "tool" => {
                let budget = plan_iter.next().unwrap_or(TOOL_HISTORY_STUB);
                if let Some(summary) = summarize_tool_row(row.id, row.content, budget) {
                    pending.push(summary);
                }
            }
            "assistant_tool_use" => {
                let lead = strip_tool_calls_suffix(row.content);
                if !lead.is_empty() {
                    pending.push(lead.to_string());
                }
            }
            "assistant" => {
                let text = flush(&mut pending, row.content.trim());
                push_turn(&mut turns, HistoryRole::Assistant, text);
            }
            "user" => {
                let text = flush(&mut pending, row.content);
                push_turn(&mut turns, HistoryRole::User, text);
            }
            _ => {}
        }
    }
    turns
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subagent_turns_come_from_the_preference_with_the_definition_cap_under_it() {
        // Unset = no limit; a set value is clamped like the Talk turns.
        assert_eq!(effective_subagent_max_iterations(None), None);
        assert_eq!(effective_subagent_max_iterations(Some(60)), Some(60));
        assert_eq!(effective_subagent_max_iterations(Some(1)), Some(TALK_MAX_ITERATIONS_MIN));
        assert_eq!(effective_subagent_max_iterations(Some(9_999)), Some(TALK_MAX_ITERATIONS_MAX));
        // A definition's max-turns applies under a set preference, never
        // above — and stands on its own when nothing is configured.
        assert_eq!(subagent_iterations(Some(15), Some(60)), Some(15));
        assert_eq!(subagent_iterations(Some(80), Some(60)), Some(60));
        assert_eq!(subagent_iterations(Some(15), None), Some(15));
        assert_eq!(subagent_iterations(None, None), None);
        assert_eq!(subagent_iterations(None, Some(60)), Some(60));
        assert_eq!(subagent_iterations(Some(0), Some(60)), Some(1));
    }

    fn tool_row(id: i64, name: &str, result: &str) -> String {
        serde_json::json!({
            "callId": format!("c{id}"),
            "toolName": name,
            "toolInput": {"command": "x"},
            "result": result,
        })
        .to_string()
    }

    #[test]
    fn max_iterations_defaults_and_clamps() {
        assert_eq!(effective_talk_max_iterations(None), DEFAULT_TALK_MAX_ITERATIONS);
        assert_eq!(effective_talk_max_iterations(Some(60)), 60);
        assert_eq!(effective_talk_max_iterations(Some(0)), TALK_MAX_ITERATIONS_MIN);
        assert_eq!(effective_talk_max_iterations(Some(10_000)), TALK_MAX_ITERATIONS_MAX);
    }

    #[test]
    fn allowance_settles_once_and_then_holds() {
        // Fresh (age 0) keeps more; every older age is ONE size, so a row is
        // rewritten exactly once after it first appears — the prompt-cache
        // prefix stops churning at every age boundary.
        assert!(tool_result_allowance(0) > tool_result_allowance(1));
        assert_eq!(tool_result_allowance(1), tool_result_allowance(2));
        assert_eq!(tool_result_allowance(2), tool_result_allowance(3));
        assert_eq!(tool_result_allowance(3), tool_result_allowance(99));
    }

    #[test]
    fn plan_settles_by_age_and_never_pads() {
        let plan = plan_tool_history(&[(3, 6_000), (1, 6_000), (0, 6_000)]);
        assert_eq!(plan, vec![TOOL_RESULT_SETTLED, TOOL_RESULT_SETTLED, TOOL_RESULT_FRESH]);
        // A short result is never padded past its own length.
        assert_eq!(plan_tool_history(&[(0, 12)]), vec![12]);
    }

    #[test]
    fn plan_is_stable_while_a_thread_grows_within_the_budget() {
        // Turn N: 10 settled rows + 3 fresh. Turn N+1: the same rows one turn
        // older, plus 3 new fresh rows. Every row that was already settled
        // renders identically — the only rewrite is the 3 rows that just
        // settled, at the tail, and the appended rows.
        let mut rows: Vec<(usize, usize)> = vec![(4, 8_000); 10];
        rows.extend([(0, 8_000); 3]);
        let before = plan_tool_history(&rows);
        let mut later: Vec<(usize, usize)> = rows.iter().map(|&(a, l)| (a + 1, l)).collect();
        later.extend([(0, 8_000); 3]);
        let after = plan_tool_history(&later);
        assert_eq!(&after[..10], &before[..10]);
        assert_eq!(&before[10..], &[TOOL_RESULT_FRESH; 3]);
        assert_eq!(&after[10..13], &[TOOL_RESULT_SETTLED; 3]);
        assert_eq!(&after[13..], &[TOOL_RESULT_FRESH; 3]);
    }

    #[test]
    fn plan_never_unstubs_when_a_tool_heavy_turn_settles() {
        // 50 settled rows + a turn of 8 big tools. Next turn those 8 settle
        // (+1 fresh). The collapse boundary is driven by settled sizes only,
        // so it cannot move backwards: every old row renders exactly as it
        // did — the prompt-cache prefix survives the turn.
        let mut rows: Vec<(usize, usize)> = vec![(5, 5_000); 50];
        rows.extend([(0, 8_000); 8]);
        let before = plan_tool_history(&rows);
        let mut later: Vec<(usize, usize)> = rows.iter().map(|&(a, l)| (a + 1, l)).collect();
        later.push((0, 8_000));
        let after = plan_tool_history(&later);
        assert_eq!(&after[..50], &before[..50]);
        // The settled turn shrank once, in place; the new row is fresh.
        assert_eq!(&before[50..], &[TOOL_RESULT_FRESH; 8]);
        assert_eq!(&after[50..58], &[TOOL_RESULT_SETTLED; 8]);
        assert_eq!(after[58], TOOL_RESULT_FRESH);
        // And with a boundary already past the budget, the same holds.
        let mut big: Vec<(usize, usize)> = vec![(5, 5_000); 70];
        big.extend([(0, 8_000); 8]);
        let b1 = plan_tool_history(&big);
        let mut big2: Vec<(usize, usize)> = big.iter().map(|&(a, l)| (a + 1, l)).collect();
        big2.push((0, 8_000));
        let b2 = plan_tool_history(&big2);
        assert_eq!(&b2[..70], &b1[..70]);
        let stubbed = b1.iter().take_while(|&&g| g == TOOL_HISTORY_STUB).count();
        assert!(stubbed > 0);
    }

    #[test]
    fn plan_collapses_the_oldest_rows_in_blocks() {
        // 70 settled rows × 1.5k = 105k wants 25k over the 80k budget. The
        // collapse rounds up to two 20k blocks: the oldest rows are stubbed
        // until ~40k has been shed, and nothing newer is touched.
        let rows: Vec<(usize, usize)> = vec![(5, 5_000); 70];
        let plan = plan_tool_history(&rows);
        let stubbed = plan.iter().take_while(|&&g| g == TOOL_HISTORY_STUB).count();
        let shed_per_row = TOOL_RESULT_SETTLED - TOOL_HISTORY_STUB;
        assert_eq!(stubbed, (2 * TOOL_HISTORY_COLLAPSE_BLOCK).div_ceil(shed_per_row), "{plan:?}");
        assert!(plan[stubbed..].iter().all(|&g| g == TOOL_RESULT_SETTLED));
        assert!(plan.iter().sum::<usize>() <= TOOL_HISTORY_TOTAL_BUDGET);
        // Adding a few more rows stays inside the same block: the boundary
        // does not move, so the old rows' rendering (and the cache) hold.
        let mut more = rows.clone();
        more.extend([(0, 5_000); 2]);
        let plan2 = plan_tool_history(&more);
        assert_eq!(&plan2[..70], &plan[..]);
    }

    #[test]
    fn plan_funds_fresh_rows_newest_first_within_their_extra() {
        // One turn that ran 20 big tools. Their settled sizes (20 × 1.5k)
        // fit the thread budget, so nothing is stubbed; the fresh raise
        // (4.5k each) is funded newest-first within the fresh allowance,
        // and the older rows of the same turn stay at their settled size.
        let rows: Vec<(usize, usize)> = vec![(0, 6_000); 20];
        let plan = plan_tool_history(&rows);
        assert_eq!(plan.len(), 20);
        assert_eq!(*plan.last().unwrap(), TOOL_RESULT_FRESH);
        let full = plan.iter().filter(|&&g| g == TOOL_RESULT_FRESH).count();
        assert_eq!(full, TOOL_HISTORY_FRESH_EXTRA / (TOOL_RESULT_FRESH - TOOL_RESULT_SETTLED), "{plan:?}");
        assert!(plan[..20 - full].iter().all(|&g| g == TOOL_RESULT_SETTLED), "{plan:?}");
        let total: usize = plan.iter().sum();
        assert!(total <= TOOL_HISTORY_TOTAL_BUDGET + TOOL_HISTORY_FRESH_EXTRA, "{total}");
        // Funding is monotone: once a row is fresh, every newer row is too.
        let first_full = plan.iter().position(|&g| g == TOOL_RESULT_FRESH).unwrap();
        assert!(plan[first_full..].iter().all(|&g| g == TOOL_RESULT_FRESH));
    }

    #[test]
    fn excerpt_keeps_both_ends_and_marks_the_gap() {
        let s = format!("{}MIDDLE{}", "a".repeat(1000), "z".repeat(1000));
        let out = excerpt_head_tail(&s, 100, " — recall #7");
        assert!(out.starts_with(&"a".repeat(70)), "head kept");
        assert!(out.ends_with(&"z".repeat(30)), "tail kept");
        assert!(out.contains("chars omitted — recall #7]"), "{out}");
        assert!(!out.contains("MIDDLE"));
        // Under budget → untouched.
        assert_eq!(excerpt_head_tail("short", 100, ""), "short");
    }

    #[test]
    fn excerpt_never_splits_a_multibyte_char() {
        // 'é' is 2 bytes; odd budgets land mid-codepoint without the snap.
        let s = "é".repeat(500);
        let out = excerpt_head_tail(&s, 101, "");
        assert!(out.contains("chars omitted"));
        assert!(out.chars().all(|c| c == 'é' || !c.is_alphabetic() || c.is_ascii()));
    }

    #[test]
    fn window_pages_with_a_position_line() {
        let s = "0123456789";
        assert_eq!(window_text(s, 0, 100), s);
        assert_eq!(window_text(s, 3, 4), "(chars 4-7 of 10)\n3456");
        assert_eq!(window_text(s, 8, 100), "(chars 9-10 of 10)\n89");
        assert_eq!(window_text(s, 50, 10), "(chars 11-10 of 10)\n");
    }

    #[test]
    fn history_glues_narration_and_tools_into_the_assistant_turn() {
        let t1 = tool_row(2, "run_command", "ok");
        let rows = [
            HistoryRow { id: 1, role: "user", content: "run it" },
            HistoryRow { id: 2, role: "assistant_tool_use", content: "I'll run it.\n\n[tool_calls: [{}]]" },
            HistoryRow { id: 3, role: "tool", content: &t1 },
            HistoryRow { id: 4, role: "assistant", content: "Done." },
            HistoryRow { id: 5, role: "user", content: "thanks" },
        ];
        let turns = build_history(&rows);
        assert_eq!(turns.len(), 3);
        assert_eq!(turns[0], HistoryTurn { role: HistoryRole::User, text: "run it".into() });
        assert_eq!(turns[1].role, HistoryRole::Assistant);
        assert_eq!(
            turns[1].text,
            "I'll run it.\n[Tool #3: run_command | Input: {\"command\":\"x\"} | Result: ok]\n\nDone."
        );
        assert_eq!(turns[2], HistoryTurn { role: HistoryRole::User, text: "thanks".into() });
    }

    #[test]
    fn history_recent_turn_keeps_more_than_old_turns() {
        let big = "x".repeat(10_000);
        let old_tool = tool_row(2, "run_command", &big);
        let new_tool = tool_row(6, "run_command", &big);
        let rows = [
            HistoryRow { id: 1, role: "user", content: "a" },
            HistoryRow { id: 2, role: "tool", content: &old_tool },
            HistoryRow { id: 3, role: "assistant", content: "A" },
            HistoryRow { id: 4, role: "user", content: "b" },
            HistoryRow { id: 5, role: "tool", content: &new_tool },
            HistoryRow { id: 6, role: "assistant", content: "B" },
            HistoryRow { id: 7, role: "user", content: "c" },
        ];
        let turns = build_history(&rows);
        let old_len = turns[1].text.len();
        let new_len = turns[3].text.len();
        assert!(new_len > old_len, "new {new_len} vs old {old_len}");
        assert!(new_len > 6_000 && new_len < 7_000, "{new_len}");
        assert!(old_len > 1_500 && old_len < 2_500, "{old_len}");
        // Both name the row to recall.
        assert!(turns[1].text.contains("recall_tool_output with message_id 2"));
        assert!(turns[3].text.contains("recall_tool_output with message_id 5"));
    }

    #[test]
    fn history_orphans_ride_on_the_next_user_turn_and_users_merge() {
        // A capped/errored turn: tools ran, no assistant answer, then the
        // user says "continue". The error row is dropped, the tool output
        // survives on the user turn, and the two user rows merge into one.
        let t = tool_row(3, "read_file", "contents");
        let rows = [
            HistoryRow { id: 1, role: "user", content: "review" },
            HistoryRow { id: 2, role: "assistant_tool_use", content: "[tool_calls: []]" },
            HistoryRow { id: 3, role: "tool", content: &t },
            HistoryRow { id: 4, role: "error", content: "boom" },
            HistoryRow { id: 5, role: "stopped", content: "stopped" },
            HistoryRow { id: 6, role: "user", content: "continue" },
        ];
        let turns = build_history(&rows);
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].role, HistoryRole::User);
        assert!(!turns[0].text.contains("boom"));
        assert!(!turns[0].text.contains("stopped"));
        assert!(turns[0].text.starts_with("review\n\n[Tool #3: read_file"));
        assert!(turns[0].text.ends_with("\n\ncontinue"), "{}", turns[0].text);
    }

    #[test]
    fn history_caps_a_huge_tool_input() {
        let content = serde_json::json!({
            "toolName": "run_command",
            "toolInput": {"command": "y".repeat(5_000)},
            "result": "ok",
        })
        .to_string();
        let rows = [
            HistoryRow { id: 1, role: "user", content: "a" },
            HistoryRow { id: 2, role: "tool", content: &content },
            HistoryRow { id: 3, role: "assistant", content: "A" },
        ];
        let turns = build_history(&rows);
        assert!(turns[1].text.len() < 1_000, "{}", turns[1].text.len());
        assert!(turns[1].text.contains("…"));
    }
}
