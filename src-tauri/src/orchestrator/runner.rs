//! The `AgentRunner` abstraction and its API-substrate implementation.

use crate::chat_engine::resolve_provider;
use crate::error::AppResult;
use crate::orchestrator::agentic::run_agentic_loop;
use crate::orchestrator::events::EventSink;
use crate::orchestrator::types::{ArtifactKind, StageArtifact, StageOutcome, StageSpec, StageStatus};
use std::path::PathBuf;
use std::sync::Arc;

/// Everything a runner needs to execute one stage, beyond the `StageSpec`.
pub struct StageContext {
    pub workspace_path: PathBuf,
    /// The original run task (seed for stage 1, context for later stages).
    pub task: String,
    pub client: reqwest::Client,
    /// Sink for live progress events (e.g. the CLI substrate streams its output).
    pub events: Arc<dyn EventSink>,
    pub run_id: String,
    pub stage_id: String,
}

/// Uniform execution contract — both API and (future) CLI substrates implement it.
#[async_trait::async_trait]
pub trait AgentRunner: Send + Sync {
    async fn run(
        &self,
        stage: &StageSpec,
        input: &StageArtifact,
        ctx: &StageContext,
    ) -> AppResult<StageOutcome>;
}

/// Map a stage role to the kind of artifact it produces.
pub fn artifact_kind_for(role: &str) -> ArtifactKind {
    match role {
        "plan" => ArtifactKind::Plan,
        "plan_review" | "code_review" | "critique" | "verify" => ArtifactKind::Review,
        "implement" | "fix" | "repro" | "refine" => ArtifactKind::Diff,
        "test" => ArtifactKind::Tests,
        _ => ArtifactKind::Note,
    }
}

/// Prepended to every stage prompt: the agent is one step in an automated,
/// headless pipeline — there is no human to answer it mid-stage, so it must act
/// autonomously and never block on input. The worktree is the shared blackboard
/// between stages, so the agent leaves its changes uncommitted (later stages
/// read them from the working tree) and must not touch git itself.
const PIPELINE_PREAMBLE: &str = "You are one stage in an automated, headless build pipeline. \
    There is NO human watching this stage and no way to answer you — never ask questions, never \
    present options or menus, and never wait for input, confirmation, or approval. Work \
    autonomously to completion using your tools, then end with a brief summary of what you did \
    and anything still outstanding. Do not commit, push, or otherwise manage git: leave any code \
    changes uncommitted in the working tree — the next stage reads them from there, and that is \
    expected and correct.";

/// Role-specific system prompt, with the shared [`PIPELINE_PREAMBLE`] prepended.
pub fn system_prompt_for(role: &str) -> String {
    let role_body = match role {
        "plan" => "You are a senior engineer. Produce a concise, concrete implementation plan \
            for the task. Do not write code; describe the steps, files, and approach.",
        "plan_review" | "critique" => "You are a critical reviewer. Review the proposed plan for \
            gaps, risks, and better approaches. Be specific and concise.",
        "implement" | "fix" => "You are a skilled engineer. Implement the plan by editing files in \
            the workspace using your tools. Make the changes; do not just describe them.",
        "code_review" | "verify" => "You are a code reviewer. Inspect the current changes in the \
            workspace and report concrete issues. Do not modify files.",
        "test" => "You are a test engineer. Write unit tests for the recent changes using your \
            tools to create the test files. Run them if a test command is obvious.",
        "repro" => "You are a debugger. Reproduce the reported issue and describe the root cause.",
        "refine" => "You are an editor. Refine and finalize the plan based on the prior review.",
        _ => "You are a helpful engineering assistant working in the project workspace.",
    };
    format!("{PIPELINE_PREAMBLE}\n\n{role_body}")
}

/// Build the user message that seeds a stage from the task + the prior artifact.
pub fn user_input_for(
    role: &str,
    task: &str,
    prior: &StageArtifact,
    feedback: Option<&str>,
) -> String {
    let mut s = format!("Task: {task}\n\n");
    if !prior.text.trim().is_empty() {
        let label = match prior.kind {
            ArtifactKind::Plan => "Plan from the previous stage",
            ArtifactKind::Review => "Review findings from the previous stage",
            ArtifactKind::Tests => "Tests from the previous stage",
            ArtifactKind::Diff => "Summary of changes from the previous stage",
            ArtifactKind::Note => "Context",
        };
        s.push_str(&format!("{label}:\n{}\n\n", prior.text));
    }
    if prior.refs_worktree {
        s.push_str("The current code changes are present in the workspace; inspect them with your tools.\n\n");
    }
    if let Some(fb) = feedback {
        s.push_str(&format!("Reviewer feedback to address this time:\n{fb}\n\n"));
        s.push_str(
            "Your previous attempt's changes may still be present in the workspace — revise them rather than starting over.\n\n",
        );
    }
    let _ = role; // role currently only affects system prompt; reserved for future shaping
    s
}

const VERDICT_INSTRUCTION: &str = "\n\nThis is an automated review. After your findings, end your \
    response with EXACTLY ONE line, on its own line: `VERDICT: PASS` if the changes are acceptable, \
    or `VERDICT: CHANGES_REQUESTED` if they must be revised. Emit nothing after that line.";

/// `system_prompt_for(role)` plus the auto-mode verdict instruction when this is
/// an auto-loop stage.
pub fn system_prompt_with_loop(role: &str, loop_mode: Option<crate::orchestrator::types::LoopMode>) -> String {
    let base = system_prompt_for(role);
    if matches!(loop_mode, Some(crate::orchestrator::types::LoopMode::Auto)) {
        format!("{base}{VERDICT_INSTRUCTION}")
    } else {
        base
    }
}

/// Parse the LAST `VERDICT: PASS|CHANGES_REQUESTED` line from a review stage's
/// output (case/space tolerant). `None` when absent or malformed — the caller
/// then falls back to a gated checkpoint rather than looping blindly.
pub fn parse_verdict(text: &str) -> Option<crate::orchestrator::types::ReviewVerdict> {
    use crate::orchestrator::types::ReviewVerdict;
    let mut found = None;
    for line in text.lines() {
        let upper = line.trim().to_ascii_uppercase();
        // Tolerate "VERDICT:" and "VERDICT :" (optional space before the colon).
        let Some(after_kw) = upper.strip_prefix("VERDICT") else { continue };
        let Some(rest) = after_kw.trim_start().strip_prefix(':') else { continue };
        let rest = rest.trim();
        // Match the leading token; trailing prose (e.g. "PASS (lgtm)") is tolerated.
        // Check CHANGES_REQUESTED first (distinct token).
        if rest.starts_with("CHANGES_REQUESTED") {
            found = Some(ReviewVerdict::ChangesRequested);
        } else if rest.starts_with("PASS") {
            found = Some(ReviewVerdict::Pass);
        }
    }
    found
}

/// The API substrate: runs a stage through the in-app LLM tool-loop.
pub struct ApiRunner;

#[async_trait::async_trait]
impl AgentRunner for ApiRunner {
    async fn run(
        &self,
        stage: &StageSpec,
        input: &StageArtifact,
        ctx: &StageContext,
    ) -> AppResult<StageOutcome> {
        let (provider, api_base, api_key) = resolve_provider(&stage.agent_model)?;
        let system = system_prompt_with_loop(&stage.role, stage.loop_mode.clone());
        let user = user_input_for(&stage.role, &ctx.task, input, stage.feedback.as_deref());

        let emitter = crate::orchestrator::live::LiveEmitter::new(
            ctx.events.as_ref(), &ctx.run_id, &ctx.stage_id);
        // The per-stage tool-turn budget (validated 1..=100 at save time);
        // clamp defensively so a corrupt row can never yield a zero-turn loop.
        let max_iterations = stage.max_iterations.max(1) as usize;
        let result = run_agentic_loop(
            provider.as_ref(),
            &api_base,
            api_key.as_deref(),
            &ctx.client,
            &stage.agent_model,
            &system,
            &user,
            &ctx.workspace_path,
            max_iterations,
            &emitter,
        )
        .await;

        match result {
            Ok(r) => {
                let cost = crate::orchestrator::cost::stage_cost(
                    &stage.agent_model,
                    r.input_tokens,
                    r.output_tokens,
                    r.cache_read_tokens,
                    r.cache_creation_tokens,
                );
                // Iteration exhaustion is a failure, not a thin success: the
                // stage never produced a final answer, so don't hand its
                // placeholder text to the next stage. Usage is preserved for
                // cost accounting; the live journal stays as the evidence.
                if !r.finished {
                    return Ok(StageOutcome {
                        artifact: StageArtifact {
                            kind: ArtifactKind::Note,
                            text: String::new(),
                            payload: None,
                            refs_worktree: false,
                        },
                        input_tokens: r.input_tokens,
                        output_tokens: r.output_tokens,
                        cost_usd: cost,
                        status: StageStatus::Failed,
                        tool_calls: r.tool_calls,
                        error: Some(format!(
                            "agentic loop hit {max_iterations} iterations without finishing — review the work journal, then re-run or abort"
                        )),
                        verdict: None,
                    });
                }
                let kind = artifact_kind_for(&stage.role);
                let refs_worktree = matches!(kind, ArtifactKind::Diff | ArtifactKind::Tests);
                let verdict = parse_verdict(&r.text);
                if let Some(v) = &verdict {
                    emitter.notice(match v {
                        crate::orchestrator::types::ReviewVerdict::Pass => "Verdict: passed",
                        crate::orchestrator::types::ReviewVerdict::ChangesRequested => "Verdict: changes requested",
                    });
                }
                Ok(StageOutcome {
                    artifact: StageArtifact {
                        kind,
                        text: r.text.clone(),
                        payload: None,
                        refs_worktree,
                    },
                    input_tokens: r.input_tokens,
                    output_tokens: r.output_tokens,
                    cost_usd: cost,
                    status: StageStatus::Done,
                    tool_calls: r.tool_calls,
                    error: None,
                    verdict,
                })
            }
            Err(e) => Ok(StageOutcome {
                artifact: StageArtifact {
                    kind: ArtifactKind::Note,
                    text: String::new(),
                    payload: None,
                    refs_worktree: false,
                },
                input_tokens: 0,
                output_tokens: 0,
                cost_usd: 0.0,
                status: StageStatus::Failed,
                tool_calls: vec![],
                error: Some(e.to_string()),
                verdict: None,
            }),
        }
    }
}
