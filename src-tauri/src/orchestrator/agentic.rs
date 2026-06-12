//! Headless agentic tool-loop. Reuses the chat-engine leaf helpers
//! (`build_llm_tools`, `execute_tool`) but, unlike `chat_engine::send_agentic`,
//! it persists nothing and emits no events — it just runs and returns a result.

use crate::chat_engine::{build_llm_tools, execute_tool};
use crate::error::AppResult;
use crate::orchestrator::types::ToolCallLog;
use crate::providers::{
    LlmContent, LlmMessage, LlmProvider, LlmRequest, LlmRole, LlmStopReason, LlmToolResult,
};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

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
) -> AppResult<AgenticResult> {
    let tools = build_llm_tools();
    let mut messages: Vec<LlmMessage> = vec![LlmMessage {
        role: LlmRole::User,
        content: LlmContent::Text(initial_user.to_string()),
    }];
    let mut out = AgenticResult::default();

    for _ in 0..max_iterations {
        if cancel.load(Ordering::Relaxed) {
            emitter.notice("stopped by the director");
            out.text = "(stopped by the director)".to_string();
            return Ok(out);
        }
        let req = LlmRequest {
            model: model.to_string(),
            max_tokens: 32768,
            system: system.to_string(),
            messages: messages.clone(),
            tools: tools.clone(),
            tool_choice: None,
        };
        let resp = provider.complete(api_base, api_key, &req, client).await?;
        out.input_tokens += resp.input_tokens;
        out.output_tokens += resp.output_tokens;
        out.cache_read_tokens += resp.cache_read_tokens;
        out.cache_creation_tokens += resp.cache_creation_tokens;

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
            let result = execute_tool(workspace_path, &u.name, &u.input);
            emitter.tool_result(!crate::orchestrator::live::looks_like_error(&result), &crate::orchestrator::live::summarize(&result));
            out.tool_calls.push(ToolCallLog {
                name: u.name.clone(),
                input: u.input.clone(),
                result: result.clone(),
            });
            results.push(LlmToolResult {
                tool_use_id: u.id.clone(),
                content: result,
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
