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

#[derive(Deserialize, Debug, Default, Clone, Copy, PartialEq)]
pub(crate) struct CliUsage {
    #[serde(default)]
    pub(crate) input_tokens: u64,
    #[serde(default)]
    pub(crate) output_tokens: u64,
    #[serde(default)]
    pub(crate) cache_read_input_tokens: u64,
    #[serde(default)]
    pub(crate) cache_creation_input_tokens: u64,
}

impl CliUsage {
    fn add(&mut self, other: &CliUsage) {
        self.input_tokens += other.input_tokens;
        self.output_tokens += other.output_tokens;
        self.cache_read_input_tokens += other.cache_read_input_tokens;
        self.cache_creation_input_tokens += other.cache_creation_input_tokens;
    }
}

/// Per-message usage from an `assistant` NDJSON stream event: the message id
/// (the CLI emits ONE assistant event per content block, each repeating the
/// same message's usage — summing raw events double/triple-counts multi-block
/// turns) plus the usage tuple. Callers keep the LATEST usage per id and sum
/// across ids, so a stop/timeout that never sees the terminal `result` event
/// still reports an honest ESTIMATE of the burned spend instead of zero.
/// A missing id yields `None` for the id — the caller keys it uniquely.
pub(crate) fn usage_from_stream_event(v: &Value) -> Option<(Option<String>, CliUsage)> {
    if v.get("type").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let msg = v.get("message")?;
    let u = msg.get("usage")?;
    let g = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
    let id = msg.get("id").and_then(Value::as_str).map(str::to_string);
    Some((
        id,
        CliUsage {
            input_tokens: g("input_tokens"),
            output_tokens: g("output_tokens"),
            cache_read_input_tokens: g("cache_read_input_tokens"),
            cache_creation_input_tokens: g("cache_creation_input_tokens"),
        },
    ))
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

/// Markers that make a trailing question read as ADDRESSED TO A PERSON (the
/// conservative half of the question-as-result detector below).
const QUESTION_MARKERS: &[&str] = &[
    "should i",
    "shall i",
    "do you want",
    "would you like",
    "do you prefer",
    "which of",
    "which one",
    "let me know",
    "please confirm",
    "can you confirm",
    "could you clarify",
];

/// Detect a CLI stage that finished by ASKING A QUESTION instead of doing the
/// work. The CLI has no `ask_director` tool and its preamble forbids asking —
/// but a genuinely blocked model asks anyway, in prose, and that question then
/// flowed downstream as if it were a result ("¿Postgres or SQLite?" handed to
/// the reviewer as a plan). Deliberately conservative — BOTH must hold:
/// the final non-empty line ends with '?', AND that line (or the one before
/// it) carries a person-addressed marker. Returns the synthesized ask;
/// `None` for ordinary results (including rhetorical trailing questions).
pub fn detect_trailing_question(text: &str) -> Option<crate::orchestrator::types::BlockedAsk> {
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let last = *lines.last()?;
    if !last.ends_with('?') {
        return None;
    }
    let window = lines[lines.len().saturating_sub(2)..].join(" ").to_lowercase();
    if !QUESTION_MARKERS.iter().any(|m| window.contains(m)) {
        return None;
    }
    Some(crate::orchestrator::types::BlockedAsk {
        summary: "The stage stopped to ask a question instead of finishing.".to_string(),
        questions: vec![crate::orchestrator::types::BlockedQuestion {
            question: last.to_string(),
            why_blocked: "The agent ended its work with this question — it needs an answer to proceed."
                .to_string(),
            recommended_default: String::new(),
        }],
    })
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
                blocked_transcript: None,
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
                blocked_transcript: None,
    })
}

/// File-mutating Claude Code tools denied to a read-only (review) CLI stage.
/// The API substrate enforces read-only reviewers through its tool allowlist;
/// the CLI ran with `bypassPermissions` and nothing but a "Do not modify
/// files" prompt — a reviewer that "fixes" what it reviews corrupts the very
/// diff the gate then approves. `Bash` stays allowed (reviewers must run
/// builds/tests), so this is a guardrail, not a sandbox.
pub const REVIEW_DISALLOWED_TOOLS: &str = "Write,Edit,MultiEdit,NotebookEdit";

/// Build the argv (after the program name) for a headless `claude -p` run.
/// The user prompt is supplied via stdin, not as an arg. We stream NDJSON
/// (`stream-json` requires `--verbose`) so the stage emits live progress and a
/// chatty/debug stdout can't break result parsing — each line is parsed
/// independently and non-JSON log lines are simply skipped. `read_only` adds
/// the review-stage tool denial (see [`REVIEW_DISALLOWED_TOOLS`]).
pub fn build_cli_args(model: &str, system_prompt: &str, max_turns: i64, read_only: bool) -> Vec<String> {
    let mut args = vec![
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
    ];
    if read_only {
        args.push("--disallowedTools".to_string());
        args.push(REVIEW_DISALLOWED_TOOLS.to_string());
    }
    args
}

/// Argv for resuming an existing headless session: continue the same
/// conversation (`--resume <id>`) with a fresh turn budget. The continuation
/// nudge is supplied via stdin by the caller.
pub fn build_cli_args_resume(model: &str, session_id: &str, max_turns: i64, read_only: bool) -> Vec<String> {
    let mut args = vec![
        "-p".to_string(),
        "--output-format".to_string(), "stream-json".to_string(),
        "--verbose".to_string(),
        "--model".to_string(), model.to_string(),
        "--resume".to_string(), session_id.to_string(),
        "--permission-mode".to_string(), "bypassPermissions".to_string(),
        "--max-turns".to_string(), max_turns.max(1).to_string(),
    ];
    if read_only {
        args.push("--disallowedTools".to_string());
        args.push(REVIEW_DISALLOWED_TOOLS.to_string());
    }
    args
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
        let mut system = compose_system_prompt(&stage.role_prompt, stage.role_environment, stage.loop_mode.clone(), stage.instructions.as_deref(), false);
        // Same skill instructions the API substrate gets. The CLI resolves
        // `/slug` itself only for its own interactive input; a stage prompt is
        // not that, so the body is inlined here rather than hoping the CLI
        // reads the token out of the brief.
        system.push_str(&crate::skills::skill_prompt_section(&ctx.skills));
        // A worktree review stage runs read-only: its whole contract is to
        // judge the diff, not to change it (Action-environment roles keep
        // their write access — committing/pushing IS their job).
        let read_only = matches!(stage.artifact_kind, ArtifactKind::Review)
            && matches!(stage.role_environment, crate::orchestrator::types::RoleEnvironment::Worktree);
        let (args, user) = match stage.resume_session.as_deref() {
            Some(sid) => (
                build_cli_args_resume(&stage.agent_model, sid, stage.max_iterations, read_only),
                // An answered question-block resumes with the director's
                // decisions in the nudge — the CLI counterpart of the API
                // substrate's transcript continuation. A plain halt-recovery
                // resume has no feedback and keeps the generic nudge.
                match stage.feedback.as_deref().filter(|f| !f.trim().is_empty()) {
                    Some(fb) => format!(
                        "{fb}\n\nContinue the task from where you left off with these decisions. \
                         You have a fresh turn budget; finish the remaining work, then stop."
                    ),
                    None => "Continue the task from where you left off. You have a fresh turn budget; \
                             finish the remaining work, then stop.".to_string(),
                },
            ),
            None => (
                build_cli_args(&stage.agent_model, &system, stage.max_iterations, read_only),
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
        // Running usage estimate from streamed assistant events, readable from
        // the cancel branch too — a stop/timeout used to record ZERO usage
        // ("unknowable mid-flight"), silently understating real spend against
        // the budget. Keyed by message id (latest usage per message wins) so
        // the CLI's one-event-per-content-block stream never double-counts a
        // multi-block turn; id-less events get a unique synthetic key.
        let streamed_usage: std::sync::Arc<parking_lot::Mutex<std::collections::HashMap<String, CliUsage>>> =
            std::sync::Arc::new(parking_lot::Mutex::new(std::collections::HashMap::new()));
        let usage_in_loop = std::sync::Arc::clone(&streamed_usage);
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
                if let Some((id, u)) = usage_from_stream_event(&value) {
                    let mut map = usage_in_loop.lock();
                    let key = id.unwrap_or_else(|| format!("anon-{}", map.len()));
                    map.insert(key, u);
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
                // Estimated spend from the streamed assistant events — a stop
                // used to record zero and silently understate the budget.
                let u = sum_usage(&streamed_usage.lock());
                return Ok(failed_stage_with_usage(
                    &crate::orchestrator::runner::unfinished_stage_error(true, 0),
                    &stage.agent_model,
                    u,
                ));
            }
        };
        let (result_line, tail, salvaged) = match read_end {
            ReadEnd::Eof(r, t) => (r, t, false),
            ReadEnd::Idle(Some(line), t) | ReadEnd::AbsCap(Some(line), t) => (Some(line), t, true),
            ReadEnd::Idle(None, _) => {
                stderr_task.abort();
                let u = sum_usage(&streamed_usage.lock());
                return Ok(failed_stage_with_usage(
                    "claude timed out — no output for 5 minutes",
                    &stage.agent_model,
                    u,
                ));
            }
            ReadEnd::AbsCap(None, _) => {
                stderr_task.abort();
                let u = sum_usage(&streamed_usage.lock());
                return Ok(failed_stage_with_usage(
                    "claude exceeded the 60-minute cap",
                    &stage.agent_model,
                    u,
                ));
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
                Ok(mut outcome) => {
                    // Question-as-result guard: a Done outcome whose text is
                    // a person-addressed question becomes a director block —
                    // the question must reach the human, not the next stage's
                    // prompt disguised as a result. Verdict-bearing reviews
                    // are exempt (they finished; the verdict drives the loop).
                    if matches!(outcome.status, StageStatus::Done) && outcome.verdict.is_none() {
                        if let Some(ask) = detect_trailing_question(&outcome.artifact.text) {
                            emitter.notice(&format!(
                                "the agent ended with a question — pausing for the director: {}",
                                ask.questions[0].question
                            ));
                            outcome.status = StageStatus::AwaitingCheckpoint;
                            outcome.blocked = Some(ask);
                        }
                    }
                    Ok(outcome)
                }
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

/// Sum the per-message usage map into one total (see `usage_from_stream_event`).
fn sum_usage(map: &std::collections::HashMap<String, CliUsage>) -> CliUsage {
    let mut total = CliUsage::default();
    for u in map.values() {
        total.add(u);
    }
    total
}

/// A failed outcome carrying the ESTIMATED usage summed from the streamed
/// assistant events (no terminal `result` event arrived to be authoritative).
/// Cost is priced through the normal catalog so the run meter and budget see
/// the burned spend instead of zero.
fn failed_stage_with_usage(msg: &str, model: &str, u: CliUsage) -> StageOutcome {
    let mut out = failed_stage(msg);
    out.input_tokens = u.input_tokens;
    out.output_tokens = u.output_tokens;
    out.cost_usd = crate::orchestrator::cost::stage_cost(
        model,
        u.input_tokens,
        u.output_tokens,
        u.cache_read_input_tokens,
        u.cache_creation_input_tokens,
    );
    out
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
                blocked_transcript: None,
    }
}
