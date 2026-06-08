//! CLI substrate: runs a stage via headless Claude Code (`claude -p`).
//!
//! All parsing/arg-building is pure and unit-tested; the live spawn lives in
//! `CliRunner::run` (added in a later task). The agent runs with
//! `--permission-mode bypassPermissions` inside the workspace's isolated git
//! worktree, bounded by `--max-turns`, with the post-stage checkpoint as the
//! human control point.

use crate::error::{AppError, AppResult};
use crate::orchestrator::runner::{artifact_kind_for, system_prompt_for, user_input_for, AgentRunner, StageContext};
use crate::orchestrator::types::{ArtifactKind, StageArtifact, StageOutcome, StageSpec, StageStatus};
use serde::Deserialize;
use std::process::Stdio;
use tokio::io::AsyncWriteExt;

const MAX_CLI_TURNS: u32 = 30;
const CLI_TIMEOUT_SECS: u64 = 900; // 15-minute wall-clock backstop for a hung CLI

#[derive(Deserialize, Debug, Default)]
struct CliResult {
    #[serde(default)]
    result: String,
    #[serde(default)]
    is_error: bool,
    #[serde(default)]
    total_cost_usd: f64,
    #[serde(default)]
    usage: CliUsage,
}

#[derive(Deserialize, Debug, Default)]
struct CliUsage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
}

/// Parse `claude -p --output-format json` stdout into a `StageOutcome`.
/// A non-zero exit OR `is_error: true` produces a Failed outcome. Returns
/// `Err` only when the output isn't parseable at all.
pub fn parse_cli_result(
    stdout: &str,
    exit_success: bool,
    role: &str,
) -> AppResult<StageOutcome> {
    let parsed: CliResult = serde_json::from_str(stdout.trim()).map_err(|e| {
        let preview: String = stdout.chars().take(300).collect();
        AppError::Other(format!("could not parse claude output: {e}; got: {preview}"))
    })?;

    if parsed.is_error || !exit_success {
        return Ok(StageOutcome {
            artifact: StageArtifact {
                kind: ArtifactKind::Note,
                text: String::new(),
                payload: None,
                refs_worktree: false,
            },
            input_tokens: parsed.usage.input_tokens,
            output_tokens: parsed.usage.output_tokens,
            cost_usd: parsed.total_cost_usd,
            status: StageStatus::Failed,
            tool_calls: vec![],
            error: Some(if parsed.result.is_empty() {
                "claude exited with an error".to_string()
            } else {
                parsed.result.clone()
            }),
        });
    }

    let kind = artifact_kind_for(role);
    let refs_worktree = matches!(kind, ArtifactKind::Diff | ArtifactKind::Tests);
    Ok(StageOutcome {
        artifact: StageArtifact {
            kind,
            text: parsed.result,
            payload: None,
            refs_worktree,
        },
        input_tokens: parsed.usage.input_tokens,
        output_tokens: parsed.usage.output_tokens,
        cost_usd: parsed.total_cost_usd,
        status: StageStatus::Done,
        tool_calls: vec![],
        error: None,
    })
}

/// Build the argv (after the program name) for a headless `claude -p` run.
/// The user prompt is supplied via stdin, not as an arg.
pub fn build_cli_args(model: &str, system_prompt: &str) -> Vec<String> {
    vec![
        "-p".to_string(),
        "--output-format".to_string(),
        "json".to_string(),
        "--model".to_string(),
        model.to_string(),
        "--append-system-prompt".to_string(),
        system_prompt.to_string(),
        "--permission-mode".to_string(),
        "bypassPermissions".to_string(),
        "--max-turns".to_string(),
        MAX_CLI_TURNS.to_string(),
    ]
}

/// The CLI substrate: runs a stage by shelling out to headless Claude Code.
pub struct CliRunner;

#[async_trait::async_trait]
impl AgentRunner for CliRunner {
    async fn run(
        &self,
        stage: &StageSpec,
        input: &StageArtifact,
        ctx: &StageContext,
    ) -> AppResult<StageOutcome> {
        let system = system_prompt_for(&stage.role);
        let user = user_input_for(&stage.role, &ctx.task, input, stage.feedback.as_deref());
        let args = build_cli_args(&stage.agent_model, &system);

        let mut child = match tokio::process::Command::new("claude")
            .args(&args)
            .current_dir(&ctx.workspace_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(failed_stage(
                    "Claude Code CLI (`claude`) was not found on PATH. Install it to use CLI stages.",
                ));
            }
            Err(e) => return Ok(failed_stage(&format!("failed to launch claude: {e}"))),
        };

        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(user.as_bytes()).await;
            // drop closes stdin
        }

        let output = match tokio::time::timeout(
            std::time::Duration::from_secs(CLI_TIMEOUT_SECS),
            child.wait_with_output(),
        )
        .await
        {
            Ok(Ok(o)) => o,
            Ok(Err(e)) => return Ok(failed_stage(&format!("claude process error: {e}"))),
            Err(_) => {
                return Ok(failed_stage(
                    "claude stage timed out (no result within 15 minutes)",
                ))
            }
        };

        let stdout = String::from_utf8_lossy(&output.stdout);
        match parse_cli_result(&stdout, output.status.success(), &stage.role) {
            Ok(outcome) => Ok(outcome),
            Err(_) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let detail = if !stderr.trim().is_empty() {
                    stderr.chars().take(400).collect::<String>()
                } else {
                    stdout.chars().take(400).collect::<String>()
                };
                Ok(failed_stage(&format!("claude produced no parseable result: {detail}")))
            }
        }
    }
}

fn failed_stage(msg: &str) -> StageOutcome {
    StageOutcome {
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
        error: Some(msg.to_string()),
    }
}
