//! CLI substrate: runs a stage via headless Claude Code (`claude -p`).
//!
//! All parsing/arg-building is pure and unit-tested; the live spawn lives in
//! `CliRunner::run` (added in a later task). The agent runs with
//! `--permission-mode bypassPermissions` inside the workspace's isolated git
//! worktree, bounded by `--max-turns`, with the post-stage checkpoint as the
//! human control point.

use crate::error::{AppError, AppResult};
use crate::orchestrator::runner::{compose_system_prompt, parse_verdict, user_input_for, AgentRunner, StageContext};
use crate::orchestrator::types::{ArtifactKind, StageArtifact, StageInput, StageOutcome, StageSpec, StageStatus};
use serde::Deserialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};

/// Fail a CLI stage if it emits NO output for this long — a hung CLI, not a
/// busy one. A stage that keeps streaming (a long build/release) stays alive.
const IDLE_TIMEOUT_SECS: u64 = 300; // 5 minutes of silence
/// Absolute backstop: even a trickle of output can't run forever.
const ABS_CAP_SECS: u64 = 3600; // 60 minutes total

#[derive(Deserialize, Debug, Default)]
struct CliResult {
    #[serde(default)]
    result: String,
    #[serde(default)]
    is_error: bool,
    /// "success" on a clean finish; "error_max_turns"/"error_during_execution"
    /// otherwise — sometimes with `is_error: false` (a success-shaped failure).
    #[serde(default)]
    subtype: Option<String>,
    #[serde(default)]
    total_cost_usd: f64,
    #[serde(default)]
    usage: CliUsage,
    /// The CLI session ID from the result event — carries forward for resume.
    #[serde(default)]
    session_id: Option<String>,
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
/// A non-zero exit OR `is_error: true` produces a Failed outcome. `stderr_text`
/// is appended to the failure message when the result itself gives no detail.
/// Returns `Err` only when the line isn't parseable at all.
pub fn parse_cli_result(
    stdout: &str,
    exit_success: bool,
    artifact_kind: ArtifactKind,
    stderr_text: &str,
) -> AppResult<StageOutcome> {
    let parsed: CliResult = serde_json::from_str(stdout.trim()).map_err(|e| {
        let preview: String = stdout.chars().take(300).collect();
        AppError::Other(format!("could not parse claude output: {e}; got: {preview}"))
    })?;

    let bad_subtype = parsed.subtype.as_deref().filter(|st| *st != "success");
    if parsed.is_error || !exit_success || bad_subtype.is_some() {
        let error = match (bad_subtype, parsed.result.is_empty()) {
            (Some(st), true) => format!(
                "claude stopped early ({st}) — review the work journal, then resume or re-run"
            ),
            (Some(st), false) => format!("claude stopped early ({st}): {}", parsed.result),
            (None, true) => "claude exited with an error".to_string(),
            (None, false) => parsed.result.clone(),
        };
        let tail = stderr_tail(stderr_text, 10);
        let error = if tail.is_empty() { error } else { format!("{error}\n— stderr —\n{tail}") };
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
            error: Some(error),
            verdict: None,
            session_id: parsed.session_id.clone(),
            // `ask_director` is an API-substrate tool only; a CLI stage never blocks.
            blocked: None,
        });
    }

    let kind = artifact_kind;
    let refs_worktree = matches!(kind, ArtifactKind::Diff | ArtifactKind::Tests);
    Ok(StageOutcome {
        artifact: StageArtifact {
            kind,
            text: parsed.result.clone(),
            payload: None,
            refs_worktree,
        },
        input_tokens: parsed.usage.input_tokens,
        output_tokens: parsed.usage.output_tokens,
        cost_usd: parsed.total_cost_usd,
        status: StageStatus::Done,
        tool_calls: vec![],
        error: None,
        verdict: parse_verdict(&parsed.result),
        session_id: parsed.session_id.clone(),
        blocked: None,
    })
}

/// Build the argv (after the program name) for a headless `claude -p` run.
/// The user prompt is supplied via stdin, not as an arg. We stream NDJSON
/// (`stream-json` requires `--verbose`) so the stage emits live progress and a
/// chatty/debug stdout can't break result parsing — each line is parsed
/// independently and non-JSON log lines are simply skipped.
pub fn build_cli_args(model: &str, system_prompt: &str, max_turns: i64) -> Vec<String> {
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
        max_turns.max(1).to_string(),
    ]
}

/// Argv for resuming an existing headless session: continue the same
/// conversation (`--resume <id>`) with a fresh turn budget. The continuation
/// nudge is supplied via stdin by the caller.
pub fn build_cli_args_resume(model: &str, session_id: &str, max_turns: i64) -> Vec<String> {
    vec![
        "-p".to_string(),
        "--output-format".to_string(), "stream-json".to_string(),
        "--verbose".to_string(),
        "--model".to_string(), model.to_string(),
        "--resume".to_string(), session_id.to_string(),
        "--permission-mode".to_string(), "bypassPermissions".to_string(),
        "--max-turns".to_string(), max_turns.max(1).to_string(),
    ]
}

/// True if `v` is the terminal `type:"result"` NDJSON event (carries the final
/// text, cost, usage, and `is_error`). Parsed via [`parse_cli_result`].
pub fn is_result_event(v: &Value) -> bool {
    v.get("type").and_then(Value::as_str) == Some("result")
}

/// How the stdout read loop ended — drives the post-loop handling.
enum ReadEnd {
    Eof(Option<String>, std::collections::VecDeque<String>),
    Idle(Option<String>, std::collections::VecDeque<String>),
    AbsCap(Option<String>, std::collections::VecDeque<String>),
}

/// The CLI substrate: runs a stage by shelling out to headless Claude Code.
pub struct CliRunner;

#[async_trait::async_trait]
impl AgentRunner for CliRunner {
    async fn run(
        &self,
        stage: &StageSpec,
        input: &StageInput,
        ctx: &StageContext,
    ) -> AppResult<StageOutcome> {
        // The CLI substrate (Claude Code) owns its own tool surface, so the
        // per-stage tool allowlist does not apply here; the author's free-form
        // instructions still shape the stage via the system prompt.
        // CLI substrate has no `ask_director` tool — keep the strict never-ask
        // preamble by NOT appending the carve-out (`can_ask_director = false`).
        let system = compose_system_prompt(&stage.role_prompt, stage.role_environment, stage.loop_mode.clone(), stage.instructions.as_deref(), false);
        let (args, user) = match stage.resume_session.as_deref() {
            Some(sid) => (
                build_cli_args_resume(&stage.agent_model, sid, stage.max_iterations),
                "Continue the task from where you left off. You have a fresh turn budget; \
                 finish the remaining work, then stop.".to_string(),
            ),
            None => (
                build_cli_args(&stage.agent_model, &system, stage.max_iterations),
                user_input_for(&stage.role, &ctx.task, input, stage.feedback.as_deref()),
            ),
        };

        let path_env = resolved_cli_path();
        let real_program: std::ffi::OsString = resolve_executable("claude", &path_env)
            .map(Into::into)
            .unwrap_or_else(|| "claude".into());

        // Seatbelt sandbox (macOS): when the mission asks for it, wrap the spawn
        // in `sandbox-exec -f <profile> claude …`. NO silent fallback — if the
        // sandbox can't be set up the stage fails rather than running unconfined.
        // The profile guard lives to the end of this fn (past `child.wait`).
        let mut _profile_guard: Option<crate::orchestrator::sandbox::ProfileGuard> = None;
        let (program, exec_args): (std::ffi::OsString, Vec<std::ffi::OsString>) =
            match ctx.exec_isolation.as_str() {
                "none" => (real_program, args.iter().map(Into::into).collect()),
                "sandbox" => {
                    match crate::orchestrator::sandbox::prepare(
                        &ctx.allowed_write_roots,
                        &real_program,
                        &args,
                    ) {
                        Ok(prepared) => {
                            _profile_guard = Some(prepared.guard);
                            (prepared.program, prepared.args)
                        }
                        Err(e) => {
                            return Ok(failed_stage(&format!(
                                "Sandbox setup failed — refusing to run the stage without the \
                                 requested isolation: {e}"
                            )));
                        }
                    }
                }
                // Fail CLOSED on any recognized-but-unimplemented tier (container /
                // cloud) rather than silently running unconfined — the whole point
                // of the axis is that isolation never degrades quietly.
                other => {
                    return Ok(failed_stage(&format!(
                        "Execution isolation '{other}' is not available yet — refusing to run \
                         the stage without the requested isolation."
                    )));
                }
            };

        let mut command = tokio::process::Command::new(&program);
        command
            .args(&exec_args)
            .current_dir(&ctx.workspace_path);
        for (k, v) in login_shell_env() {
            command.env(k, v);
        }
        // Sandboxed (guard is Some): redirect build-tool caches into the confined
        // temp so builds work without exposing the real ~/.cargo etc. Overrides
        // any cache vars the login shell set.
        if _profile_guard.is_some() {
            if let Ok(tmp) = std::env::var("TMPDIR") {
                let scope = ctx.workspace_path.to_string_lossy();
                for (k, v) in crate::orchestrator::sandbox::sandbox_cache_env(&tmp, &scope) {
                    command.env(k, v);
                }
            }
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
        let emitter = crate::orchestrator::live::LiveEmitter::new(
            ctx.events.as_ref(), &ctx.run_id, &ctx.stage_id,
        );
        let read_loop = async {
            let mut reader = tokio::io::BufReader::new(stdout);
            let mut result_line: Option<String> = None;
            let mut tail: std::collections::VecDeque<String> = std::collections::VecDeque::new();
            let mut raw: Vec<u8> = Vec::new();
            let started = std::time::Instant::now();
            loop {
                let elapsed = started.elapsed().as_secs();
                if elapsed >= ABS_CAP_SECS {
                    return ReadEnd::AbsCap(result_line, tail);
                }
                raw.clear();
                let wait = IDLE_TIMEOUT_SECS.min(ABS_CAP_SECS - elapsed);
                let read = tokio::time::timeout(
                    std::time::Duration::from_secs(wait),
                    reader.read_until(b'\n', &mut raw),
                )
                .await;
                match read {
                    Err(_) => {
                        // Timed out after `wait`. If we reached the absolute cap,
                        // report that; otherwise it's a genuine idle stall.
                        if started.elapsed().as_secs() >= ABS_CAP_SECS {
                            return ReadEnd::AbsCap(result_line, tail);
                        }
                        return ReadEnd::Idle(result_line, tail);
                    }
                    Ok(Ok(0)) => break,  // EOF
                    Ok(Ok(_)) => {}
                    Ok(Err(_)) => break, // read error
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
                for entry in crate::orchestrator::live::entries_from_stream_event(&value) {
                    emitter.emit_raw_entry(entry);
                }
            }
            ReadEnd::Eof(result_line, tail)
        };

        // Race the child's output against the director's stop signal: poll the
        // cancel flag every ~500ms and, when set, kill the child and fail the
        // stage with the director message (zero usage — the burned spend is
        // unknowable mid-flight). An idle timeout fires when NO output arrives
        // for IDLE_TIMEOUT_SECS; an absolute cap fires after ABS_CAP_SECS total.
        let cancel = std::sync::Arc::clone(&ctx.cancel);
        let cancel_watch = async move {
            loop {
                if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            }
        };
        let read_end = tokio::select! {
            end = read_loop => end,
            _ = cancel_watch => {
                let _ = child.kill().await;
                return Ok(failed_stage(
                    &crate::orchestrator::runner::unfinished_stage_error(true, 0),
                ));
            }
        };
        let (result_line, tail, salvaged) = match read_end {
            ReadEnd::Eof(r, t) => (r, t, false),
            ReadEnd::Idle(Some(line), t) | ReadEnd::AbsCap(Some(line), t) => (Some(line), t, true),
            ReadEnd::Idle(None, _) => {
                stderr_task.abort();
                return Ok(failed_stage("claude timed out — no output for 5 minutes"));
            }
            ReadEnd::AbsCap(None, _) => {
                stderr_task.abort();
                return Ok(failed_stage("claude exceeded the 60-minute cap"));
            }
        };

        // When we salvaged a result from a slow-EOF idle/cap, the child may still
        // be lingering — kill it instead of blocking on wait(), and trust the
        // result event's own is_error (same rationale as the existing wait-hiccup
        // comment). Otherwise (clean EOF) wait normally.
        let exit_success = if salvaged {
            let _ = child.kill().await;
            true
        } else {
            child.wait().await.map(|s| s.success()).unwrap_or(true)
        };
        let stderr_out = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            stderr_task,
        )
        .await
        .ok()
        .and_then(|r| r.ok())
        .unwrap_or_default();

        match result_line {
            Some(line) => match parse_cli_result(&line, exit_success, stage.artifact_kind.clone(), &stderr_out) {
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

/// Last `n` non-empty lines of stderr, joined — appended to a failure message
/// when claude itself gave no detail. Empty string when stderr is blank.
fn stderr_tail(stderr: &str, n: usize) -> String {
    let lines: Vec<&str> = stderr.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
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
        verdict: None,
        session_id: None,
        blocked: None,
    }
}
