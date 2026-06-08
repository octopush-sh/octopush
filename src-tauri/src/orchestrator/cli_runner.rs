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
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};

const MAX_CLI_TURNS: u32 = 30;
const CLI_TIMEOUT_SECS: u64 = 900; // 15-minute wall-clock backstop for a hung CLI

/// Frontend event for live per-stage progress lines (mirrors `RUN_EVENTS.log`).
pub(crate) const RUN_LOG_EVENT: &str = "run://log";

/// Preferred tool-input keys to surface as the one-line progress hint, in
/// priority order — JSON object iteration order is not meaningful, so we pick
/// the most descriptive argument explicitly before falling back to any string.
const TOOL_HINT_KEYS: &[&str] = &["command", "file_path", "path", "pattern", "query", "url", "prompt"];

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

/// Merge PATH-like dir lists into one, de-duplicating while preserving
/// first-seen order and dropping empty segments.
pub fn merge_path_dirs(parts: &[&str]) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<String> = Vec::new();
    for part in parts {
        for dir in part.split(':') {
            if dir.is_empty() {
                continue;
            }
            if seen.insert(dir.to_string()) {
                out.push(dir.to_string());
            }
        }
    }
    out.join(":")
}

/// Find an executable named `name` in the first dir of `path_env` (colon-list)
/// that contains a regular file with an exec bit. Returns its absolute path.
pub fn resolve_executable(name: &str, path_env: &str) -> Option<PathBuf> {
    for dir in path_env.split(':') {
        if dir.is_empty() {
            continue;
        }
        let candidate = Path::new(dir).join(name);
        if let Ok(meta) = std::fs::metadata(&candidate) {
            let is_exec = meta.is_file()
                && std::os::unix::fs::PermissionsExt::mode(&meta.permissions()) & 0o111 != 0;
            if is_exec {
                return Some(candidate);
            }
        }
    }
    None
}

/// Common dirs where user CLIs land, beyond a GUI app's minimal launchd PATH.
fn default_bin_dirs() -> Vec<String> {
    let mut v = Vec::new();
    if let Ok(home) = std::env::var("HOME") {
        for sub in [".local/bin", "bin", ".claude/local", ".bun/bin", ".npm-global/bin", ".deno/bin"] {
            v.push(format!("{home}/{sub}"));
        }
    }
    for d in ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/bin", "/bin"] {
        v.push(d.to_string());
    }
    v
}

/// Parse `env -0` (null-delimited KEY=VALUE) output into pairs. Skips cwd/shell
/// bookkeeping vars (`current_dir` governs the working directory) and malformed
/// entries. Multi-line values survive because records are null-delimited.
pub fn parse_env0(stdout: &[u8]) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    for chunk in stdout.split(|b| *b == 0) {
        if chunk.is_empty() {
            continue;
        }
        let s = String::from_utf8_lossy(chunk);
        if let Some((k, v)) = s.split_once('=') {
            if matches!(k, "PWD" | "OLDPWD" | "SHLVL" | "_") {
                continue;
            }
            pairs.push((k.to_string(), v.to_string()));
        }
    }
    pairs
}

/// The user's full login+interactive shell environment, captured once. A GUI app
/// (Finder/Dock) starts from launchd's minimal env and never sources ~/.zshrc, so
/// it lacks both the user's PATH AND their exported config — e.g.
/// ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN for a LiteLLM/Bedrock proxy. RUN-mode
/// terminals work because the PTY runs a login shell that sources the rc files;
/// the CLI stage must inherit the same environment.
fn login_shell_env() -> &'static [(String, String)] {
    static CACHE: OnceLock<Vec<(String, String)>> = OnceLock::new();
    CACHE.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        std::process::Command::new(&shell)
            .args(["-lic", "env -0"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| parse_env0(&o.stdout))
            .unwrap_or_default()
    })
}

/// The effective PATH for spawning user CLIs: login-shell PATH ∪ inherited ∪ common dirs.
fn resolved_cli_path() -> String {
    let login_path = login_shell_env()
        .iter()
        .find(|(k, _)| k == "PATH")
        .map(|(_, v)| v.as_str())
        .unwrap_or("");
    let inherited = std::env::var("PATH").unwrap_or_default();
    let defaults = default_bin_dirs().join(":");
    merge_path_dirs(&[login_path, &inherited, &defaults])
}

/// Parse the headless `claude` `type:"result"` NDJSON event into a `StageOutcome`.
/// A non-zero exit OR `is_error: true` produces a Failed outcome. Returns
/// `Err` only when the line isn't parseable at all.
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
/// The user prompt is supplied via stdin, not as an arg. We stream NDJSON
/// (`stream-json` requires `--verbose`) so the stage emits live progress and a
/// chatty/debug stdout can't break result parsing — each line is parsed
/// independently and non-JSON log lines are simply skipped.
pub fn build_cli_args(model: &str, system_prompt: &str) -> Vec<String> {
    vec![
        "-p".to_string(),
        "--output-format".to_string(),
        "stream-json".to_string(),
        "--verbose".to_string(),
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

/// True if `v` is the terminal `type:"result"` NDJSON event (carries the final
/// text, cost, usage, and `is_error`). Parsed via [`parse_cli_result`].
pub fn is_result_event(v: &Value) -> bool {
    v.get("type").and_then(Value::as_str) == Some("result")
}

/// Render a streaming NDJSON event into a concise human-readable progress line,
/// or `None` for events that carry no user-facing progress (system init, tool
/// results, the final result). `assistant` events surface the model's text and
/// each tool call as `§ TOOL_NAME <hint>`.
pub fn render_stream_event(v: &Value) -> Option<String> {
    if v.get("type").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let content = v.get("message")?.get("content")?.as_array()?;
    let mut parts: Vec<String> = Vec::new();
    for block in content {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(t) = block.get("text").and_then(Value::as_str) {
                    let t = t.trim();
                    if !t.is_empty() {
                        parts.push(t.to_string());
                    }
                }
            }
            Some("tool_use") => {
                let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
                // A descriptive argument (path/command/pattern) as a one-line hint.
                let hint = block
                    .get("input")
                    .and_then(Value::as_object)
                    .and_then(|o| {
                        TOOL_HINT_KEYS
                            .iter()
                            .find_map(|k| o.get(*k).and_then(Value::as_str))
                            .or_else(|| o.values().find_map(Value::as_str))
                    })
                    .map(|s| {
                        let first = s.lines().next().unwrap_or(s);
                        let clipped: String = first.chars().take(80).collect();
                        if first.chars().count() > 80 {
                            format!("{clipped}…")
                        } else {
                            clipped
                        }
                    })
                    .unwrap_or_default();
                parts.push(format!("§ {name} {hint}").trim_end().to_string());
            }
            _ => {}
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
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

        let path_env = resolved_cli_path();
        let program: std::ffi::OsString = resolve_executable("claude", &path_env)
            .map(Into::into)
            .unwrap_or_else(|| "claude".into());
        let mut command = tokio::process::Command::new(&program);
        command
            .args(&args)
            .current_dir(&ctx.workspace_path);
        for (k, v) in login_shell_env() {
            command.env(k, v);
        }
        command
            .env("PATH", &path_env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = match command.spawn() {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(failed_stage(
                    "Claude Code CLI (`claude`) was not found. Octopush searched your PATH, \
                     login-shell PATH, and common install dirs (e.g. ~/.local/bin, /opt/homebrew/bin). \
                     Ensure `claude` is installed and on your shell's PATH.",
                ));
            }
            Err(e) => return Ok(failed_stage(&format!("failed to launch claude: {e}"))),
        };

        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(user.as_bytes()).await;
            // drop closes stdin
        }

        let stdout = child.stdout.take().expect("stdout was piped");
        let stderr = child.stderr.take().expect("stderr was piped");

        // Drain stderr concurrently: a chatty proxy/debug log can fill the pipe
        // buffer and block the child if we only ever read stdout.
        let stderr_task = tokio::spawn(async move {
            let mut buf = String::new();
            let _ = tokio::io::BufReader::new(stderr).read_to_string(&mut buf).await;
            buf
        });

        // Stream stdout line-by-line: emit live progress per NDJSON event and
        // keep the final `result` event. Non-JSON lines (debug logs) are skipped,
        // so a noisy stdout can't break result parsing. We read RAW BYTES and
        // decode lossily — a chatty proxy can emit non-UTF-8 on stdout, and a
        // UTF-8-only line reader would abort the whole stream on the first bad
        // byte (losing the result event). A bounded tail of recent lines is kept
        // for diagnostics when no result event ever arrives.
        let read_loop = async {
            let mut reader = tokio::io::BufReader::new(stdout);
            let mut result_line: Option<String> = None;
            let mut tail: std::collections::VecDeque<String> = std::collections::VecDeque::new();
            let mut raw: Vec<u8> = Vec::new();
            loop {
                raw.clear();
                match reader.read_until(b'\n', &mut raw).await {
                    Ok(0) => break,  // EOF
                    Ok(_) => {}
                    Err(_) => break, // read error → stop streaming, use what we have
                }
                let line = String::from_utf8_lossy(&raw);
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if tail.len() >= 20 {
                    tail.pop_front();
                }
                tail.push_back(trimmed.to_string());
                let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
                    continue;
                };
                if is_result_event(&value) {
                    result_line = Some(trimmed.to_string());
                }
                if let Some(rendered) = render_stream_event(&value) {
                    ctx.events.emit(
                        RUN_LOG_EVENT,
                        serde_json::json!({
                            "runId": ctx.run_id,
                            "stageId": ctx.stage_id,
                            "line": rendered,
                        }),
                    );
                }
            }
            (result_line, tail)
        };

        let (result_line, tail) = match tokio::time::timeout(
            std::time::Duration::from_secs(CLI_TIMEOUT_SECS),
            read_loop,
        )
        .await
        {
            Ok(out) => out,
            // child is dropped on return → kill_on_drop terminates the process.
            Err(_) => {
                return Ok(failed_stage(
                    "claude stage timed out (no result within 15 minutes)",
                ))
            }
        };

        // We got a result event from claude (it ran to completion); trust its
        // own `is_error` over a rare `wait()` hiccup, so default a wait error to
        // success rather than failing a stage that actually succeeded.
        let exit_success = child.wait().await.map(|s| s.success()).unwrap_or(true);
        let stderr_out = stderr_task.await.unwrap_or_default();

        match result_line {
            Some(line) => match parse_cli_result(&line, exit_success, &stage.role) {
                Ok(outcome) => Ok(outcome),
                Err(_) => Ok(failed_stage(&format!(
                    "claude produced no parseable result: {}",
                    failure_detail(&stderr_out, &line)
                ))),
            },
            None => {
                let recent = tail.into_iter().collect::<Vec<_>>().join("\n");
                let fallback = if recent.trim().is_empty() {
                    "claude emitted no result event"
                } else {
                    &recent
                };
                Ok(failed_stage(&format!(
                    "claude produced no result: {}",
                    failure_detail(&stderr_out, fallback)
                )))
            }
        }
    }
}

/// Preview (≤400 chars) of stderr if it has content, else of `fallback`
/// (the unparseable result line or recent stdout tail) — for failure messages.
fn failure_detail(stderr: &str, fallback: &str) -> String {
    let src = if stderr.trim().is_empty() { fallback } else { stderr };
    src.chars().take(400).collect()
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
