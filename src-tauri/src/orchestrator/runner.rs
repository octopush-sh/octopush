//! The `AgentRunner` abstraction and its API-substrate implementation.

use crate::chat_engine::resolve_provider;
use crate::error::{AppError, AppResult};
use crate::orchestrator::agentic::run_agentic_loop;
use crate::orchestrator::types::{ArtifactKind, StageArtifact, StageOutcome, StageSpec, StageStatus};
use std::path::PathBuf;

const MAX_STAGE_ITERATIONS: usize = 25;

/// Everything a runner needs to execute one stage, beyond the `StageSpec`.
pub struct StageContext {
    pub workspace_path: PathBuf,
    /// The original run task (seed for stage 1, context for later stages).
    pub task: String,
    pub client: reqwest::Client,
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

/// Role-specific system prompt.
pub fn system_prompt_for(role: &str) -> String {
    match role {
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
    }
    .to_string()
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
    }
    let _ = role; // role currently only affects system prompt; reserved for future shaping
    s
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
        let system = system_prompt_for(&stage.role);
        let user = user_input_for(&stage.role, &ctx.task, input, stage.feedback.as_deref());

        let result = run_agentic_loop(
            provider.as_ref(),
            &api_base,
            api_key.as_deref(),
            &ctx.client,
            &stage.agent_model,
            &system,
            &user,
            &ctx.workspace_path,
            MAX_STAGE_ITERATIONS,
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
                let kind = artifact_kind_for(&stage.role);
                let refs_worktree = matches!(kind, ArtifactKind::Diff | ArtifactKind::Tests);
                Ok(StageOutcome {
                    artifact: StageArtifact {
                        kind,
                        text: r.text,
                        payload: None,
                        refs_worktree,
                    },
                    input_tokens: r.input_tokens,
                    output_tokens: r.output_tokens,
                    cost_usd: cost,
                    status: StageStatus::Done,
                    tool_calls: r.tool_calls,
                    error: None,
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
            }),
        }
    }
}

/// Placeholder for the CLI substrate — implemented in Plan 2 (Phase C).
pub struct CliRunnerUnavailable;

#[async_trait::async_trait]
impl AgentRunner for CliRunnerUnavailable {
    async fn run(
        &self,
        _stage: &StageSpec,
        _input: &StageArtifact,
        _ctx: &StageContext,
    ) -> AppResult<StageOutcome> {
        Err(AppError::Other(
            "CLI substrate is not available yet (coming in a later phase)".into(),
        ))
    }
}
