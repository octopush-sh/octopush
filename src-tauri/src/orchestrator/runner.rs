//! The `AgentRunner` abstraction and its API-substrate implementation.

use crate::chat_engine::resolve_provider;
use crate::error::AppResult;
use crate::orchestrator::agentic::run_agentic_loop;
use crate::orchestrator::events::EventSink;
use crate::orchestrator::types::{
    ArtifactKind, StageArtifact, StageInput, StageOutcome, StageSpec, StageStatus,
};
use std::path::PathBuf;
use std::sync::Arc;

/// Re-export compose_system_prompt from roles so callers can use it without
/// importing the roles module directly.
pub use crate::orchestrator::roles::compose_system_prompt;

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
    /// Director stop signal: set by `stop_current_stage`/`abort_run` while the
    /// stage is in flight. Substrates must check it and halt promptly.
    pub cancel: Arc<std::sync::atomic::AtomicBool>,
}

/// The error message for a stage whose agentic work ended without a final
/// answer: a director stop, or iteration exhaustion.
pub fn unfinished_stage_error(cancelled: bool, max_iterations: usize) -> String {
    if cancelled {
        "stopped by the director — review the work journal, then accept, re-run, or abort".to_string()
    } else {
        format!(
            "agentic loop hit {max_iterations} iterations without finishing — review the work journal, then re-run or abort"
        )
    }
}

/// Uniform execution contract — both API and (future) CLI substrates implement it.
#[async_trait::async_trait]
pub trait AgentRunner: Send + Sync {
    async fn run(
        &self,
        stage: &StageSpec,
        input: &StageInput,
        ctx: &StageContext,
    ) -> AppResult<StageOutcome>;
}


/// Cap (chars) on a single dossier section fed to a stage. Generous enough for
/// a full plan or review (~4k tokens), tight enough that a runaway artifact
/// can't blow up every later stage's prompt. Truncation keeps head + tail —
/// intent and conclusions survive; boilerplate middles are what get dropped.
const SECTION_CAP_CHARS: usize = 16_000;

/// Middle-truncate `s` to [`SECTION_CAP_CHARS`] on char boundaries.
pub(crate) fn cap_section(s: &str) -> String {
    if s.len() <= SECTION_CAP_CHARS {
        return s.to_string();
    }
    let head_budget = SECTION_CAP_CHARS * 3 / 4;
    let tail_budget = SECTION_CAP_CHARS - head_budget;
    let mut head_end = head_budget.min(s.len());
    while !s.is_char_boundary(head_end) {
        head_end -= 1;
    }
    let mut tail_start = s.len() - tail_budget;
    while !s.is_char_boundary(tail_start) {
        tail_start += 1;
    }
    format!(
        "{}\n… [section truncated for length — the beginning and end are preserved] …\n{}",
        &s[..head_end],
        &s[tail_start..],
    )
}

/// Human-readable role for prompt attribution ("plan_review" → "plan review").
fn role_words(role: &str) -> String {
    role.replace('_', " ")
}

/// The dossier label for a section of the given kind.
fn section_label(kind: &ArtifactKind) -> &'static str {
    match kind {
        ArtifactKind::Plan => "The plan to follow",
        ArtifactKind::Review => "Review findings",
        ArtifactKind::Tests => "Tests from an earlier stage",
        ArtifactKind::Diff => "Summary of code changes so far",
        ArtifactKind::Note => "Context",
    }
}

/// Build the user message that seeds a stage: the task, a one-line pipeline
/// map, then the freshest artifact of each kind from earlier stages — each
/// attributed to its producing stage and capped — and finally any reviewer
/// feedback for a re-run. This is the stage's full working context; nothing
/// the pipeline has refined gets shadowed by whatever ran last.
pub fn user_input_for(
    role: &str,
    task: &str,
    input: &StageInput,
    feedback: Option<&str>,
) -> String {
    let mut s = format!("Task: {task}\n\n");
    if !input.breadcrumb.trim().is_empty() {
        s.push_str(&format!("Pipeline: {}\n\n", input.breadcrumb));
    }
    for sec in &input.sections {
        if sec.text.trim().is_empty() {
            continue;
        }
        s.push_str(&format!(
            "{} (from the {} stage):\n{}\n\n",
            section_label(&sec.kind),
            role_words(&sec.role),
            cap_section(&sec.text),
        ));
    }
    // A reviewer/tester must judge the ACTUAL code: include the live worktree
    // diff when it was captured; otherwise fall back to the tools hint.
    if let Some(diff) = input.worktree_diff.as_deref().filter(|d| !d.trim().is_empty()) {
        s.push_str("The actual code changes in the workspace (git diff):\n```diff\n");
        s.push_str(&cap_section(diff));
        s.push_str("\n```\n\nRead any changed file with your tools when you need more context than the diff shows.\n\n");
    } else if input.refs_worktree {
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
        input: &StageInput,
        ctx: &StageContext,
    ) -> AppResult<StageOutcome> {
        let (provider, api_base, api_key) = resolve_provider(&stage.agent_model)?;
        let system = compose_system_prompt(&stage.role_prompt, stage.role_environment, stage.loop_mode.clone(), stage.instructions.as_deref());
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
            ctx.cancel.as_ref(),
            &emitter,
            stage.tools.as_deref(),
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
                // An unfinished loop is a failure, not a thin success: the
                // stage never produced a final answer, so don't hand its
                // placeholder text to the next stage. Usage is preserved for
                // cost accounting; the live journal stays as the evidence.
                // A director stop reads differently from iteration exhaustion.
                if !r.finished {
                    let cancelled = ctx.cancel.load(std::sync::atomic::Ordering::Relaxed);
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
                        error: Some(unfinished_stage_error(cancelled, max_iterations)),
                        verdict: None,
                        session_id: None,
                    });
                }
                let kind = stage.artifact_kind.clone();
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
                    session_id: None,
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
                session_id: None,
            }),
        }
    }
}
