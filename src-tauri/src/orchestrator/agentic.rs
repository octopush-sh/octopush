//! Headless agentic tool-loop. Reuses the chat-engine leaf helpers
//! (`build_llm_tools`, `execute_tool`) but, unlike `chat_engine::send_agentic`,
//! it persists nothing and emits no events — it just runs and returns a result.

use crate::chat_engine::{build_llm_tools, execute_tool};
use crate::error::{AppResult, ProviderErrorKind};
use crate::orchestrator::types::{BlockedAsk, BlockedQuestion, ToolCallLog};
use crate::providers::{
    complete_with_retry, interruptible_sleep, Effort, LlmContent, LlmMessage, LlmProvider,
    LlmRequest, LlmResponse, LlmRole, LlmStopReason, LlmTool, LlmToolResult, LlmToolUse,
    DEFAULT_MAX_RETRIES,
};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

/// Upper bound on a single proactive rate-limit pause. A window reset is at most
/// ~60s out; the small margin absorbs clock skew without parking a run.
const MAX_THROTTLE_SECS: u64 = 65;

/// Cap (bytes) on a tool result fed back to the model. A single huge read can
/// otherwise inflate every later turn's input tokens for the rest of the stage.
const TOOL_RESULT_CAP_BYTES: usize = 24_000;

/// The `max_tokens` floor for a stage given its effort. High-effort thinking
/// spends its own tokens before the answer, so the output cap must clear that
/// or a deep-thinking stage truncates mid-answer. (The `output-128k` beta is
/// already sent, so 64k is safe.) `None`/low/medium keep the historical 32768.
pub fn max_tokens_for(effort: Option<Effort>) -> u32 {
    match effort {
        None | Some(Effort::Low) | Some(Effort::Medium) => 32768,
        Some(Effort::High) => 48000,
        Some(Effort::Xhigh) | Some(Effort::Max) => 64000,
    }
}

/// Decide how long, if at all, to pause before the NEXT model call given the
/// rate-limit headroom the provider just reported. Returns `Some(secs)` only
/// when the remaining input-token budget is below what this turn consumed — the
/// context only grows, so the next call would almost certainly 429 — and the
/// window's reset delay is known. Bounded by [`MAX_THROTTLE_SECS`].
fn compute_throttle(resp: &LlmResponse) -> Option<u64> {
    let rl = resp.rate_limit.as_ref()?;
    let remaining = rl.input_tokens_remaining?;
    let reset = rl.reset_after_secs?;
    if resp.input_tokens > 0 && remaining < resp.input_tokens && reset > 0.0 {
        Some((reset.ceil() as u64).clamp(1, MAX_THROTTLE_SECS))
    } else {
        None
    }
}

/// Cap an oversized tool result before it's fed back to the model. The FULL
/// result is still kept in the work journal as evidence — only the copy sent
/// back to the model is trimmed (head + tail), with a marker telling the model
/// how to retrieve the omitted middle if it needs it.
fn cap_tool_result(s: &str) -> String {
    if s.len() <= TOOL_RESULT_CAP_BYTES {
        return s.to_string();
    }
    let head_budget = TOOL_RESULT_CAP_BYTES * 3 / 4;
    let tail_budget = TOOL_RESULT_CAP_BYTES - head_budget;
    let mut head_end = head_budget.min(s.len());
    while !s.is_char_boundary(head_end) {
        head_end -= 1;
    }
    let mut tail_start = s.len() - tail_budget;
    while !s.is_char_boundary(tail_start) {
        tail_start += 1;
    }
    let shown = head_end + (s.len() - tail_start);
    format!(
        "{}\n… [tool output truncated — {shown} of {} bytes shown; re-run with a narrower range or query if you need the omitted middle] …\n{}",
        &s[..head_end],
        s.len(),
        &s[tail_start..],
    )
}

/// Aggregate result of a headless agentic run.
#[derive(Clone, Debug, Default)]
pub struct AgenticResult {
    pub text: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub tool_calls: Vec<ToolCallLog>,
    /// False when the loop exhausted `max_iterations` without a final answer.
    /// Callers must not treat an unfinished result as a successful stage.
    pub finished: bool,
    /// Set when the loop stopped because the model called `ask_director`: the
    /// stage is blocked on a director decision. The caller parks it as a
    /// checkpoint and re-runs it once answered. `finished` stays false.
    pub blocked: Option<BlockedAsk>,
}

/// The DIRECT-only escape-valve tool. Appended to every DIRECT stage's toolset
/// AFTER the per-stage allowlist filter — so it survives a review stage's
/// read-only allowlist — and never added to TALK (which shares
/// `build_llm_tools` but has a human present, making the tool meaningless).
pub const ASK_DIRECTOR_TOOL: &str = "ask_director";

fn ask_director_tool() -> LlmTool {
    LlmTool {
        name: ASK_DIRECTOR_TOOL.to_string(),
        description: "Stop and ask the director a blocking question ONLY when you cannot proceed \
            without a decision that only they can make — a genuine ambiguity, a missing spec or \
            credential, or contradictory requirements. Give your recommended default for each \
            question so they can accept quickly. Do NOT use it for choices you can reasonably make \
            yourself. Calling this ends your work on this stage until the director answers; prefer \
            to ask before making expensive or irreversible changes."
            .to_string(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "summary": {
                    "type": "string",
                    "description": "One sentence: what you are blocked on."
                },
                "questions": {
                    "type": "array",
                    "description": "The specific decisions you need from the director.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "question": { "type": "string", "description": "The decision you need." },
                            "whyBlocked": { "type": "string", "description": "Why you cannot proceed without it." },
                            "recommendedDefault": { "type": "string", "description": "Your best answer if the director does not specify." }
                        },
                        "required": ["question", "recommendedDefault"]
                    }
                }
            },
            "required": ["summary", "questions"]
        }),
    }
}

/// The last-resort question text when a block carries no usable summary either.
const BLOCK_FALLBACK_QUESTION: &str = "The stage needs a decision to proceed.";

/// Normalize a parsed/salvaged [`BlockedAsk`] so the director ALWAYS sees usable
/// context — never a blank question label. For each question: an empty/whitespace
/// `question` is backfilled (from its `why_blocked`, else the ask's `summary`,
/// else the fallback); a question with NO text at all (no question/why/default)
/// is dropped. If that leaves no questions, one is synthesized from the summary.
/// The summary itself is backfilled to the fallback when blank so the UI header
/// is never empty either.
fn normalize_blocked_ask(ask: BlockedAsk) -> BlockedAsk {
    let summary_text = |s: &str| -> String {
        if s.trim().is_empty() {
            BLOCK_FALLBACK_QUESTION.to_string()
        } else {
            s.trim().to_string()
        }
    };
    let mut out: Vec<BlockedQuestion> = Vec::new();
    for mut q in ask.questions {
        let has_q = !q.question.trim().is_empty();
        let has_why = !q.why_blocked.trim().is_empty();
        let has_def = !q.recommended_default.trim().is_empty();
        if !has_q && !has_why && !has_def {
            continue; // entirely empty — nothing to show; drop it.
        }
        if !has_q {
            q.question = if has_why {
                q.why_blocked.trim().to_string()
            } else {
                summary_text(&ask.summary)
            };
        }
        out.push(q);
    }
    if out.is_empty() {
        out.push(BlockedQuestion {
            question: summary_text(&ask.summary),
            why_blocked: String::new(),
            recommended_default: String::new(),
        });
    }
    BlockedAsk { summary: summary_text(&ask.summary), questions: out }
}

/// Parse an `ask_director` tool call's input into a [`BlockedAsk`]. With
/// [`BlockedAsk`]/[`BlockedQuestion`] tolerant of missing/aliased fields, the
/// strict parse succeeds for ANY array-of-objects payload — so a well-formed
/// multi-question ask keeps every question. The result is [`normalize_blocked_ask`]d
/// so no question ever renders blank; a strict parse is accepted only if that
/// leaves at least one question with real text, otherwise (or on a hard parse
/// failure) we salvage from the raw JSON — mapping over ALL elements (bare-string
/// or object, either field casing), then normalizing the same way. Never crashes.
pub(crate) fn parse_ask_director(u: &LlmToolUse) -> BlockedAsk {
    if let Ok(ask) = serde_json::from_value::<BlockedAsk>(u.input.clone()) {
        let normalized = normalize_blocked_ask(ask);
        if normalized.questions.iter().any(|q| !q.question.trim().is_empty()) {
            return normalized;
        }
    }
    // Salvage path: pull whatever is present out of the raw JSON, tolerating a
    // bare-string question, either field casing, and any number of questions.
    let summary = u
        .input
        .get("summary")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_default();
    let field = |q: &serde_json::Value, camel: &str, snake: &str| -> String {
        q.get(camel)
            .or_else(|| q.get(snake))
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_default()
    };
    let questions: Vec<BlockedQuestion> = u
        .input
        .get("questions")
        .and_then(|q| q.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|q| {
                    if let Some(s) = q.as_str() {
                        return Some(BlockedQuestion {
                            question: s.to_string(),
                            why_blocked: String::new(),
                            recommended_default: String::new(),
                        });
                    }
                    if q.is_object() {
                        return Some(BlockedQuestion {
                            question: field(q, "question", "question"),
                            why_blocked: field(q, "whyBlocked", "why_blocked"),
                            recommended_default: field(q, "recommendedDefault", "recommended_default"),
                        });
                    }
                    None
                })
                .collect()
        })
        .unwrap_or_default();
    // Normalization backfills blank question text and synthesizes one from the
    // summary when the array yields nothing usable — so both paths guarantee it.
    normalize_blocked_ask(BlockedAsk { summary, questions })
}

/// Run the tool-use loop against `provider` until it returns a final answer
/// (or `max_iterations` is hit, or `cancel` is set). Tools execute in
/// `workspace_path`. The cancel flag is checked at the top of each iteration:
/// when set, the loop stops before the next model turn, closes the journal
/// with a notice, and returns an UNFINISHED result (the caller maps it to a
/// failed stage that lands in the normal halt-recovery flow).
#[allow(clippy::too_many_arguments)]
pub async fn run_agentic_loop(
    provider: &dyn LlmProvider,
    api_base: &str,
    api_key: Option<&str>,
    client: &reqwest::Client,
    model: &str,
    system: &str,
    initial_user: &str,
    workspace_path: &Path,
    max_iterations: usize,
    cancel: &AtomicBool,
    emitter: &crate::orchestrator::live::LiveEmitter<'_>,
    // Per-stage tool allowlist. `None` grants the full workspace tool set;
    // `Some(list)` restricts the agent to exactly those tools (a review stage
    // runs read-only, an implementer gets write/run, etc.).
    allowed_tools: Option<&[String]>,
    // How hard the model thinks per turn. `None` ⇒ no thinking (today's
    // behavior). Also raises the `max_tokens` floor so deep thinking doesn't
    // truncate the answer.
    effort: Option<Effort>,
) -> AppResult<AgenticResult> {
    let mut tools = build_llm_tools();
    if let Some(allowed) = allowed_tools {
        tools.retain(|t| allowed.iter().any(|a| a == &t.name));
    }
    // The escape valve is appended AFTER the allowlist filter so it is always
    // available to a DIRECT stage — even a review stage whose allowlist is
    // read-only. It is deliberately NOT part of `build_llm_tools` (shared with
    // TALK), which has a human present and no use for a director-ask tool.
    tools.push(ask_director_tool());
    let mut messages: Vec<LlmMessage> = vec![LlmMessage {
        role: LlmRole::User,
        content: LlmContent::Text(initial_user.to_string()),
    }];
    let mut out = AgenticResult::default();
    // How long to pace before the next call, set from the previous response's
    // reported rate-limit headroom (see `compute_throttle`). Applied at the top
    // of the loop so it covers every path that issues another call.
    let mut pending_throttle: Option<u64> = None;

    for _ in 0..max_iterations {
        if cancel.load(Ordering::Relaxed) {
            emitter.notice("stopped by the director");
            out.text = "(stopped by the director)".to_string();
            return Ok(out);
        }

        // Proactive throttle: ride out a nearly-spent input-token window instead
        // of charging into a guaranteed 429. Interruptible by a director stop.
        if let Some(wait) = pending_throttle.take() {
            emitter.notice(&format!(
                "input-token budget low — pausing {wait}s for the rate-limit window to reset"
            ));
            if !interruptible_sleep(wait, cancel).await {
                emitter.notice("stopped by the director");
                out.text = "(stopped by the director)".to_string();
                return Ok(out);
            }
        }

        let req = LlmRequest {
            model: model.to_string(),
            max_tokens: max_tokens_for(effort),
            system: system.to_string(),
            messages: messages.clone(),
            tools: tools.clone(),
            tool_choice: None,
            effort,
        };
        // Transient failures (rate limit, overload, 5xx, dropped connection) are
        // retried in place with backoff — the accumulated message history is
        // preserved, so a momentary blip never costs the stage its work or forces
        // a halt. Each wait is narrated into the journal.
        let mut on_retry = |attempt: u32, delay: u64, kind: ProviderErrorKind| {
            emitter.notice(&format!(
                "{} — retrying in {delay}s (attempt {attempt} of {DEFAULT_MAX_RETRIES})",
                kind.label()
            ));
        };
        let resp = complete_with_retry(
            provider,
            api_base,
            api_key,
            &req,
            client,
            cancel,
            DEFAULT_MAX_RETRIES,
            &mut on_retry,
        )
        .await?;
        out.input_tokens += resp.input_tokens;
        out.output_tokens += resp.output_tokens;
        out.cache_read_tokens += resp.cache_read_tokens;
        out.cache_creation_tokens += resp.cache_creation_tokens;
        // Pace the next call if this response says the window is nearly spent.
        pending_throttle = compute_throttle(&resp);

        // Escape valve: if the model called `ask_director`, asking supersedes
        // acting. Stop the loop immediately — do NOT execute this turn's tools
        // (including any other tool_uses, which are discarded), do NOT push more
        // messages, and do NOT continue. The result is unfinished (it's a block,
        // not a completed answer); the caller parks the stage and re-runs it
        // once the director answers.
        if let Some(u) = resp.tool_uses.iter().find(|u| u.name == ASK_DIRECTOR_TOOL) {
            let ask = parse_ask_director(u);
            emitter.notice(&format!("paused to ask the director: {}", ask.summary));
            out.blocked = Some(ask);
            return Ok(out);
        }

        let is_final =
            resp.stop_reason != LlmStopReason::ToolUse || resp.tool_uses.is_empty();

        // Truncation during tool use: feed back errors and retry (mirrors send_agentic).
        if matches!(resp.stop_reason, LlmStopReason::MaxTokens) && !resp.tool_uses.is_empty() {
            // Truncation path: do NOT replay raw_content verbatim. A turn cut off
            // at max_tokens can carry an unsigned/partial trailing thinking block,
            // and replaying it 400s the next request. Empty raw makes the
            // serializer rebuild from text + tool_uses instead (per the design).
            messages.push(LlmMessage {
                role: LlmRole::Assistant,
                content: LlmContent::AssistantWithTools {
                    raw: vec![],
                    text: resp.text.clone(),
                    tool_uses: resp.tool_uses.clone(),
                },
            });
            let errs: Vec<LlmToolResult> = resp
                .tool_uses
                .iter()
                .map(|u| LlmToolResult {
                    tool_use_id: u.id.clone(),
                    content: "ERROR: response truncated at max_tokens; retry with smaller output."
                        .into(),
                    is_error: true,
                })
                .collect();
            messages.push(LlmMessage {
                role: LlmRole::User,
                content: LlmContent::ToolResults(errs),
            });
            continue;
        }

        if is_final {
            out.text = resp.text.trim().to_string();
            out.finished = true;
            return Ok(out);
        }

        // Emit narration text before processing tool calls.
        emitter.text(&resp.text);

        // Record the assistant tool-use turn — the full content array verbatim,
        // so the next turn's replay preserves signed thinking and the exact
        // block order (required when thinking is on).
        messages.push(LlmMessage {
            role: LlmRole::Assistant,
            content: LlmContent::AssistantWithTools {
                raw: resp.raw_content.clone(),
                text: resp.text.clone(),
                tool_uses: resp.tool_uses.clone(),
            },
        });

        // Execute each tool, collect results + log.
        let mut results: Vec<LlmToolResult> = Vec::new();
        for u in &resp.tool_uses {
            emitter.tool(&u.name, &crate::orchestrator::live::tool_hint(&u.input));
            // The chat engine consumes execute_tool's structural `ok`; the
            // orchestrator keeps its own text-based classifier for journal
            // continuity, so it deliberately ignores the bool here.
            let (result, _) = execute_tool(workspace_path, &u.name, &u.input);
            emitter.tool_result(!crate::orchestrator::live::looks_like_error(&result), &crate::orchestrator::live::summarize(&result));
            // The journal keeps the FULL result as evidence; only the copy fed
            // back to the model is capped, to bound input-token growth.
            out.tool_calls.push(ToolCallLog {
                name: u.name.clone(),
                input: u.input.clone(),
                result: result.clone(),
            });
            results.push(LlmToolResult {
                tool_use_id: u.id.clone(),
                content: cap_tool_result(&result),
                is_error: false,
            });
        }
        messages.push(LlmMessage {
            role: LlmRole::User,
            content: LlmContent::ToolResults(results),
        });
    }

    // Exhaustion: close the journal with a terminal notice so the stage's end
    // explains itself instead of just stopping mid-stream.
    emitter.notice(&format!(
        "iteration cap reached — {max_iterations} of {max_iterations} tool turns used"
    ));
    out.text = format!("(agentic loop hit {max_iterations} iterations without finishing)");
    Ok(out)
}
