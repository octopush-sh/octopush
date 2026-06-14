//! Headless agentic tool-loop. Reuses the chat-engine leaf helpers
//! (`build_llm_tools`, `execute_tool`) but, unlike `chat_engine::send_agentic`,
//! it persists nothing and emits no events — it just runs and returns a result.

use crate::chat_engine::{build_llm_tools, execute_tool};
use crate::error::{AppResult, ProviderErrorKind};
use crate::orchestrator::types::ToolCallLog;
use crate::providers::{
    complete_with_retry, interruptible_sleep, LlmContent, LlmMessage, LlmProvider, LlmRequest,
    LlmResponse, LlmRole, LlmStopReason, LlmToolResult, DEFAULT_MAX_RETRIES,
};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

/// Upper bound on a single proactive rate-limit pause. A window reset is at most
/// ~60s out; the small margin absorbs clock skew without parking a run.
const MAX_THROTTLE_SECS: u64 = 65;

/// Cap (bytes) on a tool result fed back to the model. A single huge read can
/// otherwise inflate every later turn's input tokens for the rest of the stage.
const TOOL_RESULT_CAP_BYTES: usize = 24_000;

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
) -> AppResult<AgenticResult> {
    let mut tools = build_llm_tools();
    if let Some(allowed) = allowed_tools {
        tools.retain(|t| allowed.iter().any(|a| a == &t.name));
    }
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
            max_tokens: 32768,
            system: system.to_string(),
            messages: messages.clone(),
            tools: tools.clone(),
            tool_choice: None,
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

        let is_final =
            resp.stop_reason != LlmStopReason::ToolUse || resp.tool_uses.is_empty();

        // Truncation during tool use: feed back errors and retry (mirrors send_agentic).
        if matches!(resp.stop_reason, LlmStopReason::MaxTokens) && !resp.tool_uses.is_empty() {
            messages.push(LlmMessage {
                role: LlmRole::Assistant,
                content: LlmContent::AssistantWithTools {
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

        // Record the assistant tool-use turn.
        messages.push(LlmMessage {
            role: LlmRole::Assistant,
            content: LlmContent::AssistantWithTools {
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
