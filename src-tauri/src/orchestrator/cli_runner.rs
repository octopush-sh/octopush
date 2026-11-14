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
/// Claude Code only: how long the process may stay open after its terminal
/// `result` event. Recent CLIs keep `-p` alive to wait for background work
/// the turn started (a dev server, a watch build); the stage's hand-off is the
/// `result`, so the runner stops the CLI once this grace runs out.
const SETTLE_AFTER_RESULT_SECS: u64 = 30;
/// Claude Code only: the CLI's own ceiling on waiting for subagents and
/// Monitor after its turn (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`). Below
/// [`SETTLE_AFTER_RESULT_SECS`], so the CLI's own clean exit comes first.
pub(crate) const BG_WAIT_CEILING_MS: u64 = 25_000;

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
    /// Why the run ended (Claude Code ≥ 2.1.319), e.g. [`TOOL_DEFERRED`] or
    /// [`DEFERRED_TOOL_UNAVAILABLE`]. Older CLIs leave it unset.
    #[serde(default)]
    terminal_reason: Option<String>,
    /// The tool call a PreToolUse hook deferred (`permissionDecision: "defer"`).
    #[serde(default)]
    deferred_tool_use: Option<CliDeferredToolUse>,
}

#[derive(Deserialize, Debug, Default)]
struct CliDeferredToolUse {
    #[serde(default)]
    name: String,
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
    /// `cache_creation.ephemeral_1h_input_tokens`: the part of
    /// `cache_creation_input_tokens` written with a 1-hour TTL (`0` without
    /// the breakdown).
    #[serde(default, rename = "cache_creation", deserialize_with = "one_hour_writes")]
    pub(crate) cache_creation_1h_input_tokens: u64,
    /// One streamed message ran in fast mode (`usage.speed: "fast"`). Only
    /// set per message by [`usage_from_stream_event`]; a sum doesn't carry it.
    #[serde(skip)]
    pub(crate) fast: bool,
}

fn one_hour_writes<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    let v = Value::deserialize(d)?;
    Ok(v.get("ephemeral_1h_input_tokens").and_then(Value::as_u64).unwrap_or(0))
}

impl CliUsage {
    fn add(&mut self, other: &CliUsage) {
        self.input_tokens += other.input_tokens;
        self.output_tokens += other.output_tokens;
        self.cache_read_input_tokens += other.cache_read_input_tokens;
        self.cache_creation_input_tokens += other.cache_creation_input_tokens;
        self.cache_creation_1h_input_tokens += other.cache_creation_1h_input_tokens;
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
            cache_creation_1h_input_tokens: crate::token_engine::one_hour_cache_writes(u),
            fast: crate::token_engine::is_fast(crate::token_engine::usage_speed(u).as_deref()),
        },
    ))
}

// ─── Claude plan windows (`rate_limit_event`) ────────────────────────────
//
// A subscription-authenticated (`claude login`, Pro/Max) CLI streams
// `rate_limit_event` lines whose `rate_limit_info` describes the plan's
// rolling windows. Every field is optional: older CLIs send no
// `unifiedWindows`, top-level `utilization` only appears once a threshold is
// crossed, and `rateLimitType` grows new values — an unknown one is kept
// verbatim, never dropped. `utilization` is a fraction (0.62 = 62%).

/// One plan window as a `rate_limit_event` reported it.
#[derive(serde::Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanWindow {
    /// `five_hour` · `seven_day` · `seven_day_opus` · `seven_day_sonnet` · …
    pub kind: String,
    /// Fraction of the window used, when the CLI said.
    pub utilization: Option<f64>,
    /// When the window resets, epoch seconds.
    pub resets_at: Option<i64>,
    /// `allowed` · `allowed_warning` · `rejected` · …; `None` when the event
    /// only described this window in passing (another window was the subject).
    pub status: Option<String>,
    pub overage_status: Option<String>,
    pub using_overage: bool,
}

/// Epoch seconds from a number that may be seconds or milliseconds.
fn epoch_secs(v: Option<&Value>) -> Option<i64> {
    let n = v?.as_f64()?;
    let secs = if n > 1e12 { n / 1000.0 } else { n };
    Some(secs as i64)
}

/// The plan windows a `rate_limit_event` carries — empty for any other
/// event, and for a rate-limit event without `rate_limit_info` (what an
/// API-key session and the recorded fixtures send). The event's subject
/// window (`rateLimitType`) comes first and carries the status; windows
/// listed only in `unifiedWindows` get the status too when it is `allowed`
/// (nothing is limited), otherwise none.
pub(crate) fn plan_windows_from_stream_event(v: &Value) -> Vec<PlanWindow> {
    if v.get("type").and_then(Value::as_str) != Some("rate_limit_event") {
        return vec![];
    }
    let Some(info) = v.get("rate_limit_info").filter(|i| i.is_object()) else {
        return vec![];
    };
    let s = |k: &str| info.get(k).and_then(Value::as_str).map(str::to_string);
    let status = s("status");
    let overage_status = s("overageStatus");
    let using_overage = info.get("isUsingOverage").and_then(Value::as_bool).unwrap_or(false);
    let unified = info.get("unifiedWindows").and_then(Value::as_object);
    let mut out: Vec<PlanWindow> = Vec::new();
    if let Some(kind) = s("rateLimitType") {
        let listed = unified.and_then(|u| u.get(&kind));
        out.push(PlanWindow {
            utilization: info
                .get("utilization")
                .and_then(Value::as_f64)
                .or_else(|| listed.and_then(|w| w.get("utilization")).and_then(Value::as_f64)),
            resets_at: epoch_secs(info.get("resetsAt"))
                .or_else(|| epoch_secs(listed.and_then(|w| w.get("resetsAt")))),
            status: status.clone(),
            overage_status: overage_status.clone(),
            using_overage,
            kind,
        });
    }
    for (kind, w) in unified.into_iter().flatten() {
        if out.iter().any(|p| p.kind == *kind) || !w.is_object() {
            continue;
        }
        out.push(PlanWindow {
            kind: kind.clone(),
            utilization: w.get("utilization").and_then(Value::as_f64),
            resets_at: epoch_secs(w.get("resetsAt")),
            status: status.clone().filter(|st| st == "allowed"),
            overage_status: overage_status.clone(),
            using_overage,
        });
    }
    out
}

/// How a Claude CLI session is authenticated, from its `system/init` event.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CliAuth {
    /// `claude login` with a Claude plan (`apiKeySource: "none"`).
    Subscription,
    /// An API key (`ANTHROPIC_API_KEY`, a helper, a proxy token…).
    ApiKey,
}

/// The session's auth from a `system/init` event; `None` for other events
/// and for an init that doesn't say (older CLIs).
pub(crate) fn cli_auth_from_init(v: &Value) -> Option<CliAuth> {
    if v.get("type").and_then(Value::as_str) != Some("system")
        || v.get("subtype").and_then(Value::as_str) != Some("init")
    {
        return None;
    }
    match v.get("apiKeySource").and_then(Value::as_str)? {
        "none" => Some(CliAuth::Subscription),
        _ => Some(CliAuth::ApiKey),
    }
}

/// Hand a Claude stream event's plan windows and sign-in end to
/// `PersistingSink`, which keeps them for Readiness, Usage and the notes.
/// `auth` is the session's, from its `system/init`. An API-key session's
/// rate limits are not plan windows and it reports no sign-in end, so its
/// init clears the stored end instead: no later stage would replace it.
pub(crate) fn forward_plan_and_login(
    auth: &mut Option<CliAuth>,
    value: &Value,
    emitter: &crate::orchestrator::live::LiveEmitter<'_>,
) {
    if let Some(a) = cli_auth_from_init(value) {
        *auth = Some(a);
        if a == CliAuth::ApiKey {
            emitter.login_cleared();
        }
    }
    if *auth == Some(CliAuth::ApiKey) {
        return;
    }
    let windows = plan_windows_from_stream_event(value);
    if !windows.is_empty() {
        emitter.plan_windows(&windows);
    }
    if let Some(expires_at) = credential_expiry_from_result(value) {
        emitter.login_expiry(expires_at);
    }
}

/// When the stored claude.ai sign-in ends, epoch seconds, from the `result`
/// event's `credential_expires_at` (Claude Code 2.1.318+). `None` for other
/// events, for older CLIs that don't send it and for a value it can't read.
/// The changelog doesn't give the format, so RFC 3339 text and epoch
/// seconds or milliseconds are all accepted.
pub(crate) fn credential_expiry_from_result(v: &Value) -> Option<i64> {
    if !is_result_event(v) {
        return None;
    }
    expiry_secs(v.get("credential_expires_at")?)
}

/// A sign-in end as epoch seconds: RFC 3339 text, or epoch seconds or
/// milliseconds. `None` for anything else (null, `0`, unreadable text).
pub(crate) fn expiry_secs(raw: &Value) -> Option<i64> {
    match raw.as_str() {
        Some(s) => chrono::DateTime::parse_from_rfc3339(s.trim()).ok().map(|d| d.timestamp()),
        None => epoch_secs(Some(raw)).filter(|s| *s > 0),
    }
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
pub(crate) fn login_shell_env() -> &'static [(String, String)] {
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
pub(crate) fn resolved_cli_path() -> String {
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

/// The `result` subtype Claude Code reports when `--max-budget-usd` stopped
/// the run. It still carries `total_cost_usd` and `session_id`.
pub const BUDGET_STOP_SUBTYPE: &str = "error_max_budget_usd";

/// True when a stage error is a Claude Code budget stop (see
/// [`parse_cli_result`]): the drive must not escalate it — a strong-tier
/// retry would spend past the budget that just stopped it.
pub fn is_budget_stop(error: &str) -> bool {
    error.contains(BUDGET_STOP_SUBTYPE)
}

/// The marker in the error of a stage whose `result` said `success` but whose
/// `claude -p` exited non-zero. Since Claude Code 2.1.317 that is how `-p`
/// reports a full disk or quota that lost the session transcript (or a
/// `~/.claude.json` write): the work is finished, the session is not saved.
pub const SESSION_NOT_SAVED: &str = "could not save its session";

/// True when a stage error is a finished-but-unsaved Claude Code stage (see
/// [`parse_cli_result`]): the drive must not escalate it — a stronger model
/// will not free a full disk — and its session must not be `--resume`d.
pub fn is_session_not_saved(error: &str) -> bool {
    error.contains(SESSION_NOT_SAVED)
}

/// The `terminal_reason` of a run that ended because a PreToolUse hook
/// deferred a tool call (`permissionDecision: "defer"`, Claude Code ≥ 2.1.319).
/// The CLI reports it as a clean `success` with no text and exits 0 — the tool
/// never ran, so the stage is not done.
pub const TOOL_DEFERRED: &str = "tool_deferred";

/// The `terminal_reason` of a `--resume` whose session ended on a deferred
/// tool call that is no longer available (an MCP server removed, a built-in
/// tool now disallowed). Claude Code ≥ 2.1.319 exits 1 with it.
pub const DEFERRED_TOOL_UNAVAILABLE: &str = "tool_deferred_unavailable";

/// The marker line [`parse_cli_result`] puts in a stage error for a
/// `terminal_reason` (the closing paren keeps [`TOOL_DEFERRED`] from matching
/// [`DEFERRED_TOOL_UNAVAILABLE`]).
fn terminal_reason_marker(reason: &str) -> String {
    format!("(terminal_reason: {reason})")
}

/// True when a stage error is a hook-deferred tool call (see
/// [`parse_cli_result`]): the drive must not escalate it — a stronger model
/// meets the same hook. Its session is kept, so Resume runs the call.
pub fn is_tool_deferred(error: &str) -> bool {
    error.contains(&terminal_reason_marker(TOOL_DEFERRED))
}

/// True when a stage error is a resumed session whose deferred tool is gone
/// (see [`parse_cli_result`]): the drive must not escalate it — a stronger
/// model won't bring the tool back. Its session is kept for a Resume once the
/// tool is reconnected.
pub fn is_deferred_tool_unavailable(error: &str) -> bool {
    error.contains(&terminal_reason_marker(DEFERRED_TOOL_UNAVAILABLE))
}

/// How a deferred tool is named in a halt: `mcp__‹server›__‹tool›` reads
/// `‹tool› (MCP server ‹server›)`. Any other name — a built-in tool, or one
/// whose server or tool part itself holds `__`, which can't be split safely —
/// is shown whole. No name at all reads `a tool`.
pub(crate) fn deferred_tool_label(name: &str) -> String {
    let name = name.trim();
    if name.is_empty() {
        return "a tool".to_string();
    }
    let mcp = name
        .strip_prefix("mcp__")
        .map(|rest| rest.split("__").collect::<Vec<_>>())
        .filter(|parts| parts.len() == 2 && parts.iter().all(|p| !p.is_empty()));
    match mcp.as_deref() {
        Some([server, tool]) => format!("{tool} (MCP server {server})"),
        _ => name.to_string(),
    }
}

/// Free space for an unprivileged user on the volume holding `path`.
#[allow(clippy::unnecessary_cast)] // statvfs field widths differ between macOS and Linux
pub(crate) fn free_bytes(path: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
        return None;
    }
    Some((st.f_bavail as u64).saturating_mul(st.f_frsize as u64))
}

/// `1.2 GB` / `340 MB` / `12 KB` — decimal units, as Finder shows them.
pub(crate) fn format_free_bytes(bytes: u64) -> String {
    const KB: f64 = 1e3;
    const MB: f64 = 1e6;
    const GB: f64 = 1e9;
    let b = bytes as f64;
    if b >= GB {
        format!("{:.1} GB", b / GB)
    } else if b >= MB {
        format!("{:.0} MB", b / MB)
    } else {
        format!("{:.0} KB", b / KB)
    }
}

/// Append the worktree volume's free space to a [`SESSION_NOT_SAVED`]
/// outcome's error; any other outcome is returned unchanged (and `free` is
/// not called).
pub(crate) fn with_free_space(mut outcome: StageOutcome, free: impl FnOnce() -> Option<u64>) -> StageOutcome {
    if let Some(err) = outcome.error.as_mut().filter(|e| is_session_not_saved(e)) {
        if let Some(bytes) = free() {
            err.push_str(&format!("\n{} free on the worktree's volume", format_free_bytes(bytes)));
        }
    }
    outcome
}

/// The `--max-budget-usd` cap for a Claude stage: the stage's share of the
/// run's remaining budget (`spend_limit`, absent when unmetered — no budget,
/// or the director's conscious override), plus, for a `--resume`d stage, the
/// session's prior reported total — a resumed run reports the conversation's
/// whole total, so the cap must sit on top of what was already spent.
/// Only the headroom is rounded DOWN to cents (never above it, at least one
/// cent) before the prior total is added, so a resumed cap always sits at
/// least a cent above what the session already reported — flooring the sum
/// could land under it and stop the resumed run straight away.
pub fn cli_budget_cap(spend_limit: Option<f64>, resumed_prior_cost_usd: f64) -> Option<f64> {
    spend_limit
        .filter(|l| *l > 0.0)
        .map(|l| ((l * 100.0).floor() / 100.0).max(0.01) + resumed_prior_cost_usd.max(0.0))
}

/// `--max-budget-usd <cap>` with the cap (already floored by
/// [`cli_budget_cap`]) printed to the nearest cent. Empty without a cap.
pub fn max_budget_args(cap: Option<f64>) -> Vec<String> {
    match cap {
        Some(c) => vec!["--max-budget-usd".to_string(), format!("{c:.2}")],
        None => Vec::new(),
    }
}

/// Parse the headless `claude` `type:"result"` NDJSON event into a `StageOutcome`.
/// A non-zero exit OR `is_error: true` produces a Failed outcome. `stderr_text`
/// is appended to the failure message when the result itself gives no detail.
/// A [`BUDGET_STOP_SUBTYPE`] result is a budget stop, not a crash: it keeps
/// its spend and session (Resume continues it) and its error says so —
/// [`is_budget_stop`] tells the drive not to escalate it.
/// A `success` result with text but a non-zero exit is a finished stage whose
/// session could not be saved: Failed with a [`SESSION_NOT_SAVED`] error, the
/// artifact kept and no session id ([`is_session_not_saved`]).
/// A [`TOOL_DEFERRED`] or [`DEFERRED_TOOL_UNAVAILABLE`] `terminal_reason` is
/// read first, whatever the exit code and `is_error` say: Failed, the session
/// kept for Resume ([`is_tool_deferred`], [`is_deferred_tool_unavailable`]).
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
    let kind = artifact_kind;
    let refs_worktree = matches!(kind, ArtifactKind::Diff | ArtifactKind::Tests);

    // A hook-deferred tool call (Claude Code ≥ 2.1.319). Matched on the
    // machine-readable reason, before the success-shaped branches below: a
    // deferring run looks like a clean success with no text, and a resume
    // whose deferred tool is gone looks like a success that exited 1.
    let deferred = parsed
        .terminal_reason
        .as_deref()
        .filter(|r| *r == TOOL_DEFERRED || *r == DEFERRED_TOOL_UNAVAILABLE);
    if let Some(reason) = deferred {
        let tool = deferred_tool_label(parsed.deferred_tool_use.as_ref().map_or("", |d| d.name.as_str()));
        let copy = if reason == TOOL_DEFERRED {
            format!("A hook paused {tool} before it ran. Resume once it may run, or re-run the stage.")
        } else {
            format!(
                "The resumed session was waiting to run {tool}, which isn't available anymore. \
                 Reconnect it and resume, or re-run the stage fresh."
            )
        };
        let error = format!("{copy}\n{}", terminal_reason_marker(reason));
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
            cache_read_tokens: parsed.usage.cache_read_input_tokens,
            cache_creation_tokens: parsed.usage.cache_creation_input_tokens,
            cost_usd: parsed.total_cost_usd,
            status: StageStatus::Failed,
            tool_calls: vec![],
            error: Some(error),
            verdict: None,
            session_id: parsed.session_id.clone(),
            blocked: None,
            blocked_transcript: None,
        });
    }

    // The CLI finished the work and reported success, then exited non-zero:
    // since 2.1.317 that means it could not save its session (full disk or
    // quota). Fail with that cause, not the agent's own summary, and keep the
    // artifact so the director can review and accept the finished work. The
    // session is dropped: its transcript was never written, so `--resume`
    // would fail.
    if !exit_success
        && !parsed.is_error
        && parsed.subtype.as_deref() == Some("success")
        && !parsed.result.trim().is_empty()
    {
        let error = format!(
            "Claude Code finished the work but exited with an error — it {SESSION_NOT_SAVED} \
             (disk full or quota?). The changes are in the worktree; free space, then accept or re-run."
        );
        let tail = stderr_tail(stderr_text, 10);
        let error = if tail.is_empty() { error } else { format!("{error}\n— stderr —\n{tail}") };
        return Ok(StageOutcome {
            artifact: StageArtifact {
                kind,
                text: parsed.result.clone(),
                payload: None,
                refs_worktree,
            },
            input_tokens: parsed.usage.input_tokens,
            output_tokens: parsed.usage.output_tokens,
            cache_read_tokens: parsed.usage.cache_read_input_tokens,
            cache_creation_tokens: parsed.usage.cache_creation_input_tokens,
            cost_usd: parsed.total_cost_usd,
            status: StageStatus::Failed,
            tool_calls: vec![],
            error: Some(error),
            verdict: None,
            session_id: None,
            blocked: None,
            blocked_transcript: None,
        });
    }

    if parsed.is_error || !exit_success || bad_subtype.is_some() {
        let error = match (bad_subtype, parsed.result.is_empty()) {
            (Some(BUDGET_STOP_SUBTYPE), _) => format!(
                "budget reached mid-stage — Claude Code stopped at the run's remaining budget \
                 ({BUDGET_STOP_SUBTYPE}, {} reported) — resume to continue within what is left of the budget, \
                 accept the partial work, or re-run",
                crate::token_engine::format_usd(parsed.total_cost_usd)
            ),
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
            cache_read_tokens: parsed.usage.cache_read_input_tokens,
            cache_creation_tokens: parsed.usage.cache_creation_input_tokens,
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

    Ok(StageOutcome {
        artifact: StageArtifact {
            kind,
            text: parsed.result.clone(),
            payload: None,
            refs_worktree,
        },
        input_tokens: parsed.usage.input_tokens,
        output_tokens: parsed.usage.output_tokens,
        cache_read_tokens: parsed.usage.cache_read_input_tokens,
        cache_creation_tokens: parsed.usage.cache_creation_input_tokens,
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

/// Inline `--settings` passed to EVERY Claude CLI stage (read-only ones too,
/// as defence in depth). Since Claude Code 2.1.314, Write/Edit/NotebookEdit
/// refuse paths outside the working directories in every permission mode,
/// `bypassPermissions` included — so a stage's file edits can't reach the main checkout,
/// a sibling workspace or `~/`. Needs Claude Code >= 2.1.314: older CLIs
/// ignore the unknown key, so the guard is off there. `Bash` is not covered
/// and stays unconfined unless the mission's `exec_isolation` is `sandbox`
/// (Seatbelt, see `sandbox.rs`). The argv goes
/// straight to `Command::args` with no shell, so the JSON needs no quoting.
pub const CLAUDE_STAGE_SETTINGS: &str = r#"{"permissions":{"blockWritesOutsideWorkingDirectories":true}}"#;

/// Build the argv (after the program name) for a headless `claude -p` run.
/// The user prompt is supplied via stdin, not as an arg. We stream NDJSON
/// (`stream-json` requires `--verbose`) so the stage emits live progress and a
/// chatty/debug stdout can't break result parsing — each line is parsed
/// independently and non-JSON log lines are simply skipped. Every stage
/// carries [`CLAUDE_STAGE_SETTINGS`]; `read_only` adds the review-stage tool
/// denial (see [`REVIEW_DISALLOWED_TOOLS`]).
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
        "--settings".to_string(),
        CLAUDE_STAGE_SETTINGS.to_string(),
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
        // The resume path needs the guard too (2.1.314 fixed it for --resume).
        "--settings".to_string(), CLAUDE_STAGE_SETTINGS.to_string(),
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

// ─── CLI dialects (B6) ────────────────────────────────────────────────────
//
// The `cli` substrate used to be hardcoded to Claude Code. A stage's MODEL now
// selects the CLI dialect: `claude-*` runs Claude Code exactly as before, and
// OpenAI-family ids (`gpt-*`, `o1/o3/o4*`, anything containing `codex`) run
// Codex CLI (`codex exec --json`). Deriving the dialect from the model —
// instead of the design note's `cli_dialect` column — needs no migration and
// no new builder control: the model picker the author already uses is the
// selector, and the builder's existing "CLI needs a matching model" warning
// covers the mismatch case. The enum keeps the seams (argv / resume /
// event-parse / result) in one place so an explicit per-stage override or a
// third dialect (Gemini CLI) can be added without touching the runner loop.

/// Which CLI runs a `cli`-substrate stage.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CliDialect {
    Claude,
    Codex,
}

/// What confines a Codex writer stage's own commands (read-only stages always
/// run in Codex's `read-only` sandbox; Claude stages ignore this).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CodexWriteScope {
    /// Codex's own `workspace-write` sandbox with the network on and no extra
    /// writable roots: the worktree and Codex's temp dirs only. A linked
    /// worktree's git dir is left out on purpose: Codex's writable roots can't
    /// deny a path inside a root, so granting `<common>/worktrees/<name>`
    /// would hand over its `commondir` and `config.worktree`, which repoint
    /// git at planted config and hooks. `git add`/`git commit` therefore fail
    /// there. The worktree's own `.git` entry is checked after the stage
    /// ([`guards_git_entry`]).
    Workspace,
    /// The mission runs sandboxed: Octopush's Seatbelt profile already
    /// confines the process, and nesting Codex's Seatbelt inside it is untested.
    MissionSandbox,
}

/// The scope a Codex writer stage gets for the mission's `exec_isolation`:
/// Octopush's Seatbelt profile under `sandbox`, else Codex's own sandbox. Pure.
pub fn codex_write_scope(exec_isolation: &str) -> CodexWriteScope {
    if exec_isolation == "sandbox" {
        CodexWriteScope::MissionSandbox
    } else {
        CodexWriteScope::Workspace
    }
}

/// Whether the runner checks the worktree's `.git` entry around this stage
/// (`sandbox::GitEntry`): only for a Codex writer in Codex's own sandbox,
/// which may not protect a `.git` *file* (a linked worktree's gitdir pointer)
/// the way the Seatbelt profile's `{ws}/.git` deny does. Pure.
pub fn guards_git_entry(dialect: CliDialect, read_only: bool, exec_isolation: &str) -> bool {
    dialect == CliDialect::Codex && !read_only && codex_write_scope(exec_isolation) == CodexWriteScope::Workspace
}

/// Derive the dialect from the stage's model id. Unknown ids fall back to
/// Claude (the historical behavior — and `claude` is the CLI most likely to
/// be configured for a proxy model).
pub fn dialect_for_model(model: &str) -> CliDialect {
    let m = model.to_ascii_lowercase();
    if m.starts_with("gpt-")
        || m.starts_with("o1")
        || m.starts_with("o3")
        || m.starts_with("o4")
        || m.contains("codex")
    {
        CliDialect::Codex
    } else {
        CliDialect::Claude
    }
}

/// True when a stage's reasoning effort actually reaches the agent: always on
/// the API substrate; on the CLI for a dialect that takes an effort (Claude
/// Code's `--effort`, Codex's `-c model_reasoning_effort`, selected by
/// `model`). Escalation and the pre-run estimate key on this.
pub fn effort_applies(substrate: &str, model: &str) -> bool {
    match substrate {
        "api" => true,
        "cli" => match dialect_for_model(model) {
            // Codex gets an effort only on a model whose levels we know.
            CliDialect::Codex => codex_effort_levels(model).is_some_and(|l| !l.is_empty()),
            d => d.takes_effort(),
        },
        _ => false,
    }
}

/// The reasoning levels Codex advertises per model, from its bundled catalog
/// (`supported_reasoning_levels` in openai/codex
/// `codex-rs/models-manager/models.json`; the commit is in the file's
/// `source`). One table for both sides: `src/lib/codexEffortLevels.json`,
/// which `lib/claudeCli.ts` imports too. Codex sends the effort to the API
/// unchanged (`codex-rs/core/src/client.rs` `build_reasoning`), so a level the
/// model doesn't list can fail the stage.
const CODEX_EFFORT_LEVELS_JSON: &str = include_str!("../../../src/lib/codexEffortLevels.json");

fn codex_effort_table() -> &'static std::collections::HashMap<String, Vec<String>> {
    static TABLE: std::sync::OnceLock<std::collections::HashMap<String, Vec<String>>> = std::sync::OnceLock::new();
    TABLE.get_or_init(|| {
        #[derive(serde::Deserialize)]
        struct Catalog {
            models: std::collections::HashMap<String, Vec<String>>,
        }
        // Pinned by `codex_effort_table_parses_and_lists_only_codex_tokens`.
        serde_json::from_str::<Catalog>(CODEX_EFFORT_LEVELS_JSON)
            .map(|c| c.models)
            .unwrap_or_default()
    })
}

/// The levels Codex lists for `model` (case-insensitive slug match), or `None`
/// for a model missing from its catalog. An empty list = a non-reasoning model.
pub fn codex_effort_levels(model: &str) -> Option<&'static [String]> {
    codex_effort_table().get(&model.trim().to_ascii_lowercase()).map(Vec::as_slice)
}

/// The level Codex gets for `effort` on `model`: the effort itself when the
/// model lists it, else the highest listed level below it (the lowest listed
/// one if none is below). `None` — pass no override, Codex keeps its default —
/// for an unknown or non-reasoning model.
pub fn codex_effort_level(model: &str, effort: crate::providers::Effort) -> Option<&'static str> {
    clamp_to_listed_levels(codex_effort_levels(model)?, effort)
}

/// [`codex_effort_level`]'s clamp on an explicit level list: `None` when the
/// list holds none of Octopush's levels (a non-reasoning model).
pub fn clamp_to_listed_levels(listed: &[String], effort: crate::providers::Effort) -> Option<&'static str> {
    use crate::providers::Effort;
    const ORDER: [Effort; 5] = [Effort::Low, Effort::Medium, Effort::High, Effort::Xhigh, Effort::Max];
    let supported: Vec<Effort> = ORDER.into_iter().filter(|e| listed.iter().any(|l| l == e.as_str())).collect();
    let rank = |e: Effort| ORDER.iter().position(|o| *o == e).unwrap_or(0);
    supported
        .iter()
        .rev()
        .find(|e| rank(**e) <= rank(effort))
        .or_else(|| supported.first())
        .map(|e| e.as_str())
}

impl CliDialect {
    pub fn binary(&self) -> &'static str {
        match self {
            CliDialect::Claude => "claude",
            CliDialect::Codex => "codex",
        }
    }

    /// Fresh-run argv. Codex has no `--append-system-prompt` or `--max-turns`
    /// equivalent: the system prompt rides stdin (see [`CliDialect::stdin_payload`])
    /// and the turn budget is bounded by the runner's idle/absolute timeouts.
    /// `read_only` maps to each CLI's native mechanism: Claude denies the edit
    /// tools; Codex runs in its own `read-only` sandbox. A Codex writer runs in
    /// its `workspace-write` sandbox, or bypasses it inside a sandboxed mission
    /// (see [`CodexWriteScope`]); either way it never stops for approval,
    /// which would hang a headless stage. The writer's settings are `-c`
    /// config overrides, the mechanism the effort already uses, not flags
    /// `codex exec` may not take: approval `never` and network on (Octopush's
    /// Seatbelt profile confines writes only, too). No extra writable roots.
    pub fn argv(
        &self,
        model: &str,
        system_prompt: &str,
        max_turns: i64,
        read_only: bool,
        scope: CodexWriteScope,
    ) -> Vec<String> {
        match self {
            CliDialect::Claude => build_cli_args(model, system_prompt, max_turns, read_only),
            CliDialect::Codex => {
                let mut a = vec![
                    "exec".to_string(),
                    "--json".to_string(),
                    "--skip-git-repo-check".to_string(),
                    "-m".to_string(),
                    model.to_string(),
                ];
                match (read_only, scope) {
                    (true, _) => a.extend(["--sandbox".to_string(), "read-only".to_string()]),
                    (false, CodexWriteScope::Workspace) => a.extend([
                        "--sandbox".to_string(),
                        "workspace-write".to_string(),
                        "-c".to_string(),
                        "approval_policy=\"never\"".to_string(),
                        "-c".to_string(),
                        "sandbox_workspace_write.network_access=true".to_string(),
                    ]),
                    (false, CodexWriteScope::MissionSandbox) => {
                        a.push("--dangerously-bypass-approvals-and-sandbox".to_string())
                    }
                }
                // `-` = read the prompt from stdin.
                a.push("-".to_string());
                a
            }
        }
    }

    /// The launch line's sandbox label: Codex's own sandbox when it confines
    /// a writer stage; `None` otherwise.
    pub fn sandbox_label(&self, read_only: bool, scope: CodexWriteScope) -> Option<&'static str> {
        match (self, read_only, scope) {
            (CliDialect::Codex, false, CodexWriteScope::Workspace) => Some("workspace-write sandbox"),
            _ => None,
        }
    }

    /// Resume argv, for dialects with a confirmed session-continuation
    /// contract. `None` ⇒ the runner falls back to a fresh run (worktree
    /// preserved, feedback in the prompt) — the already-graceful path.
    pub fn resume_argv(
        &self,
        model: &str,
        session_id: &str,
        max_turns: i64,
        read_only: bool,
    ) -> Option<Vec<String>> {
        match self {
            CliDialect::Claude => Some(build_cli_args_resume(model, session_id, max_turns, read_only)),
            // Codex has a `codex exec resume` in newer builds, but the contract
            // isn't stable enough to bet a stage on — fresh re-run instead.
            CliDialect::Codex => None,
        }
    }

    /// What is written to the child's stdin. Claude gets the user prompt (the
    /// system prompt rides `--append-system-prompt`); Codex gets both, joined —
    /// it has no separate system-prompt channel.
    pub fn stdin_payload(&self, system: &str, user: &str) -> String {
        match self {
            CliDialect::Claude => user.to_string(),
            CliDialect::Codex => format!("{system}\n\n---\n\n{user}"),
        }
    }

    /// Extra environment for the stage's CLI process. Claude: bound its own
    /// waits on subagents and Monitor to [`BG_WAIT_CEILING_MS`], below the
    /// settle grace after its `result` ([`SETTLE_AFTER_RESULT_SECS`]), so the
    /// CLI's own clean exit (EOF) comes before the runner stops it. Fast mode
    /// is off for stages (`CLAUDE_CODE_DISABLE_FAST_MODE`): a stage runs at the
    /// rate its model was routed for, not the doubled fast-mode rate. MCP tasks
    /// run inside their tool call (`CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND`):
    /// since 2.1.319, "when an MCP server runs a tool call as a task, Claude
    /// Code moves it to the background right away", and a stage settled on its
    /// `result` could otherwise hand on work that is still running. The
    /// changelog scopes that to the terminal, so this is a defensive pin; an
    /// older CLI ignores the unknown variable. Set on fresh and `--resume` runs
    /// alike; Run-mode terminals never get it — backgrounding is theirs to keep.
    pub fn stage_env(&self) -> Vec<(&'static str, String)> {
        match self {
            CliDialect::Claude => vec![
                ("CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS", BG_WAIT_CEILING_MS.to_string()),
                ("CLAUDE_CODE_DISABLE_FAST_MODE", "1".to_string()),
                ("CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND", "1".to_string()),
            ],
            CliDialect::Codex => Vec::new(),
        }
    }

    /// True when the stage's reasoning effort reaches this CLI. Claude Code
    /// takes `--effort <level>` (low/medium/high/xhigh/max, the same tokens as
    /// [`crate::providers::Effort`]); Codex takes the one-off config override
    /// `-c model_reasoning_effort="<level>"`, which beats its config file.
    pub fn takes_effort(&self) -> bool {
        matches!(self, CliDialect::Claude | CliDialect::Codex)
    }

    /// The level token this CLI gets for `effort` on `model`; `None` without
    /// an effort. Codex's levels vary by model, so it gets the level clamped
    /// to what the model lists in Codex's catalog ([`codex_effort_level`]),
    /// and nothing on a model missing from it or without reasoning. Claude
    /// Code clamps per model itself and gets the token unchanged.
    pub fn effort_level(&self, model: &str, effort: Option<crate::providers::Effort>) -> Option<&'static str> {
        let e = effort.filter(|_| self.takes_effort())?;
        match self {
            CliDialect::Codex => codex_effort_level(model, e),
            CliDialect::Claude => Some(e.as_str()),
        }
    }

    /// The journal line for a Codex stage whose effort is not passed because
    /// Codex's catalog doesn't list the model's levels (or lists none);
    /// `None` when the effort reaches the CLI, or there is none.
    pub fn unpassed_effort_notice(&self, model: &str, effort: Option<crate::providers::Effort>) -> Option<String> {
        let e = effort?;
        (*self == CliDialect::Codex && self.effort_level(model, Some(e)).is_none()).then(|| {
            format!(
                "This stage's {} effort is not passed to Codex: its model catalog lists no reasoning levels for {model}, so it runs at Codex's default effort.",
                e.as_str()
            )
        })
    }

    /// The effort flags for a stage with an effort — Claude Code's
    /// `--effort <level>`, Codex's `-c model_reasoning_effort="<level>"` —
    /// empty otherwise (the CLI keeps its per-model default). See
    /// [`CliDialect::push_effort_args`] for where they go.
    pub fn effort_args(&self, model: &str, effort: Option<crate::providers::Effort>) -> Vec<String> {
        match (self, self.effort_level(model, effort)) {
            (CliDialect::Claude, Some(l)) => vec!["--effort".to_string(), l.to_string()],
            (CliDialect::Codex, Some(l)) => vec!["-c".to_string(), format!("model_reasoning_effort=\"{l}\"")],
            (_, None) => Vec::new(),
        }
    }

    /// Adds [`CliDialect::effort_args`] to a built argv: appended on Claude
    /// Code (fresh and resumed runs alike), and on Codex placed before the
    /// trailing `-` so the stdin-prompt marker stays the last argument.
    pub fn push_effort_args(&self, args: &mut Vec<String>, model: &str, effort: Option<crate::providers::Effort>) {
        let flags = self.effort_args(model, effort);
        let at = match self {
            CliDialect::Codex if args.last().is_some_and(|a| a == "-") => args.len() - 1,
            _ => args.len(),
        };
        let tail = args.split_off(at);
        args.extend(flags);
        args.extend(tail);
    }

    /// Inherited variables removed from the stage's CLI process. Claude Code
    /// lets `CLAUDE_CODE_EFFORT_LEVEL` beat `--effort`, so a value exported in
    /// the user's shell would silently override the stage's own setting — it
    /// is dropped when the stage passes an effort, and left alone otherwise.
    /// Codex has no such variable (its `-c` override already wins).
    pub fn stage_env_remove(&self, effort: Option<crate::providers::Effort>) -> Vec<&'static str> {
        if effort.is_some() && *self == CliDialect::Claude {
            vec!["CLAUDE_CODE_EFFORT_LEVEL"]
        } else {
            Vec::new()
        }
    }

    /// Effort environment for the stage's CLI process. Claude Code (2.1.317+)
    /// no longer carries `--effort` to subagents on another model, so the
    /// stage's level also rides `CLAUDE_CODE_SUBAGENT_EFFORT` (2.1.316+; an
    /// older CLI ignores the unknown variable). A subagent's own `effort`
    /// frontmatter still wins. Set over any inherited export, and only when
    /// the stage passes an effort — otherwise the CLI keeps its defaults.
    /// Codex has no environment equivalent.
    pub fn stage_effort_env(&self, effort: Option<crate::providers::Effort>) -> Vec<(&'static str, String)> {
        match effort {
            Some(e) if *self == CliDialect::Claude => vec![("CLAUDE_CODE_SUBAGENT_EFFORT", e.as_str().to_string())],
            _ => Vec::new(),
        }
    }

    fn not_found_message(&self) -> String {
        match self {
            CliDialect::Claude => "Claude Code CLI (`claude`) was not found. Octopush searched your PATH, \
                 login-shell PATH, and common install dirs (e.g. ~/.local/bin, /opt/homebrew/bin). \
                 Ensure `claude` is installed and on your shell's PATH."
                .to_string(),
            CliDialect::Codex => "Codex CLI (`codex`) was not found. Octopush searched your PATH, \
                 login-shell PATH, and common install dirs (e.g. ~/.local/bin, /opt/homebrew/bin). \
                 Install it (`npm i -g @openai/codex`) or switch this stage to a Claude model / the API substrate."
                .to_string(),
        }
    }
}

/// What a Codex stream has told us so far. Codex has no single terminal
/// `result` event — the outcome is assembled from the accumulated stream:
/// the LAST assistant message is the artifact, `turn.failed`/`error` mark
/// failure, and `thread.started` carries the session id.
#[derive(Clone, Debug, Default)]
pub(crate) struct CodexAccum {
    pub final_message: Option<String>,
    pub error: Option<String>,
    pub session_id: Option<String>,
}

/// A string field that may be a plain string or an array of strings (codex
/// renders commands both ways across versions).
fn string_or_join(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) => Some(s.clone()),
        Value::Array(a) => Some(
            a.iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(" "),
        ),
        _ => None,
    }
}

/// Fold one Codex NDJSON event into the accumulator and return any journal
/// entries it implies. Tolerant of BOTH Codex stream schemas — the modern
/// `{"type":"item.completed","item":{…}}` thread events and the older
/// `{"msg":{"type":"agent_message",…}}` experimental shape — because the CLI's
/// JSON contract has drifted across versions; unknown events are skipped, so a
/// schema surprise degrades to "no result" (an honest, recoverable failure),
/// never a crash.
pub(crate) fn codex_fold_event(accum: &mut CodexAccum, v: &Value) -> Vec<Value> {
    use serde_json::json;
    let mut entries = Vec::new();
    // ── Modern thread-event schema ──
    if let Some(t) = v.get("type").and_then(Value::as_str) {
        match t {
            "thread.started" => {
                if let Some(id) = v.get("thread_id").and_then(Value::as_str) {
                    accum.session_id = Some(id.to_string());
                }
            }
            "turn.failed" | "error" => {
                let msg = v
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .or_else(|| v.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("codex reported an error");
                accum.error = Some(msg.to_string());
                entries.push(json!({ "kind": "notice", "text": format!("codex error — {msg}") }));
            }
            "item.started" | "item.updated" | "item.completed" => {
                if let Some(item) = v.get("item") {
                    let itype = item
                        .get("item_type")
                        .or_else(|| item.get("type"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let completed = t == "item.completed";
                    match itype {
                        "assistant_message" | "agent_message" => {
                            if completed {
                                if let Some(text) = item.get("text").and_then(Value::as_str) {
                                    if !text.trim().is_empty() {
                                        accum.final_message = Some(text.to_string());
                                        // A message AFTER an error means the CLI
                                        // recovered (retried the turn) — a stale
                                        // sticky error must not outrank the
                                        // eventual real answer.
                                        accum.error = None;
                                        entries.push(json!({ "kind": "text", "text": text.trim() }));
                                    }
                                }
                            }
                        }
                        "command_execution" => {
                            let cmd = string_or_join(item.get("command")).unwrap_or_default();
                            if t == "item.started" {
                                entries.push(json!({ "kind": "tool", "tool": "run_command",
                                    "hint": crate::orchestrator::live::summarize(&cmd) }));
                            } else if completed {
                                let ok = item
                                    .get("exit_code")
                                    .and_then(Value::as_i64)
                                    .map(|c| c == 0)
                                    .unwrap_or(true);
                                let out = item
                                    .get("aggregated_output")
                                    .and_then(Value::as_str)
                                    .unwrap_or("");
                                entries.push(json!({ "kind": "tool_result", "ok": ok,
                                    "detail": crate::orchestrator::live::summarize(out) }));
                            }
                        }
                        "file_change" => {
                            if completed {
                                let paths = item
                                    .get("changes")
                                    .and_then(Value::as_array)
                                    .map(|a| {
                                        a.iter()
                                            .filter_map(|c| c.get("path").and_then(Value::as_str))
                                            .collect::<Vec<_>>()
                                            .join(", ")
                                    })
                                    .unwrap_or_default();
                                entries.push(json!({ "kind": "tool", "tool": "edit_file",
                                    "hint": crate::orchestrator::live::summarize(&paths) }));
                            }
                        }
                        "mcp_tool_call" | "web_search" => {
                            if completed {
                                entries.push(json!({ "kind": "tool", "tool": itype, "hint": "" }));
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
        return entries;
    }
    // ── Legacy experimental schema ──
    if let Some(msg) = v.get("msg") {
        match msg.get("type").and_then(Value::as_str).unwrap_or("") {
            "agent_message" => {
                if let Some(text) = msg.get("message").and_then(Value::as_str) {
                    if !text.trim().is_empty() {
                        accum.final_message = Some(text.to_string());
                        accum.error = None; // recovered — see the modern arm
                        entries.push(json!({ "kind": "text", "text": text.trim() }));
                    }
                }
            }
            "task_complete" => {
                if let Some(text) = msg.get("last_agent_message").and_then(Value::as_str) {
                    if !text.trim().is_empty() {
                        accum.final_message = Some(text.to_string());
                        accum.error = None; // recovered — see the modern arm
                    }
                }
            }
            "exec_command_begin" => {
                let cmd = string_or_join(msg.get("command")).unwrap_or_default();
                entries.push(json!({ "kind": "tool", "tool": "run_command",
                    "hint": crate::orchestrator::live::summarize(&cmd) }));
            }
            "exec_command_end" => {
                let ok = msg.get("exit_code").and_then(Value::as_i64).map(|c| c == 0).unwrap_or(true);
                entries.push(json!({ "kind": "tool_result", "ok": ok, "detail": "" }));
            }
            "session_configured" => {
                if let Some(id) = msg.get("session_id").and_then(Value::as_str) {
                    accum.session_id = Some(id.to_string());
                }
            }
            "error" => {
                let m = msg.get("message").and_then(Value::as_str).unwrap_or("codex reported an error");
                accum.error = Some(m.to_string());
                entries.push(json!({ "kind": "notice", "text": format!("codex error — {m}") }));
            }
            _ => {}
        }
    }
    entries
}

/// Usage from a Codex stream event. Modern: `turn.completed` carries per-turn
/// usage (each event is a distinct key — `None` id ⇒ caller keys it uniquely).
/// Legacy: `token_count` events are cumulative, so they share the fixed key
/// `"token_count"` and latest-wins. Codex reports the FULL input including
/// cached and cache-written tokens (OpenAI-style), so both slices are split
/// out for pricing: `cached_input_tokens` at the cache-read rate and
/// `cache_write_input_tokens` (openai/codex `exec_events.rs` `Usage`,
/// `#[serde(default)]`, so older CLIs omit it) at the cache-write rate.
pub(crate) fn codex_usage_from_event(v: &Value) -> Option<(Option<String>, CliUsage)> {
    let (usage, key) = if v.get("type").and_then(Value::as_str) == Some("turn.completed") {
        (v.get("usage")?, None)
    } else if v.get("msg").and_then(|m| m.get("type")).and_then(Value::as_str) == Some("token_count")
    {
        (
            v.get("msg")?.get("info").and_then(|i| i.get("total_token_usage")).or_else(|| v.get("msg"))?,
            Some("token_count".to_string()),
        )
    } else {
        return None;
    };
    let g = |k: &str| usage.get(k).and_then(Value::as_u64).unwrap_or(0);
    let input = g("input_tokens");
    let cached = g("cached_input_tokens").min(input);
    let written = g("cache_write_input_tokens").min(input - cached);
    Some((
        key,
        CliUsage {
            input_tokens: input - cached - written,
            output_tokens: g("output_tokens"),
            cache_read_input_tokens: cached,
            cache_creation_input_tokens: written,
            cache_creation_1h_input_tokens: 0,
            fast: false,
        },
    ))
}

/// Assemble a Codex stage outcome from the accumulated stream: the last
/// assistant message is the artifact; `turn.failed`/`error` (or a bad exit
/// with no message) is a failure. Usage is the deduped stream sum, priced
/// through the catalog (codex reports no USD).
pub(crate) fn build_codex_outcome(
    accum: &CodexAccum,
    usage: CliUsage,
    exit_success: bool,
    artifact_kind: ArtifactKind,
    model: &str,
    stderr_text: &str,
) -> StageOutcome {
    let cost = crate::orchestrator::cost::stage_cost(
        model,
        usage.input_tokens,
        usage.output_tokens,
        usage.cache_read_input_tokens,
        usage.cache_creation_input_tokens,
    );
    let failed = accum.error.is_some() || (!exit_success && accum.final_message.is_none());
    if failed {
        let mut error = accum
            .error
            .clone()
            .unwrap_or_else(|| "codex exited with an error".to_string());
        if let Some(m) = accum.final_message.as_deref().filter(|m| !m.trim().is_empty()) {
            error.push_str(&format!("\n— last message —\n{m}"));
        }
        let tail = stderr_tail(stderr_text, 10);
        if !tail.is_empty() {
            error.push_str(&format!("\n— stderr —\n{tail}"));
        }
        let mut out = failed_stage(&error);
        out.input_tokens = usage.input_tokens;
        out.output_tokens = usage.output_tokens;
        out.cache_read_tokens = usage.cache_read_input_tokens;
        out.cache_creation_tokens = usage.cache_creation_input_tokens;
        out.cost_usd = cost;
        out.session_id = accum.session_id.clone();
        return out;
    }
    match accum.final_message.as_deref().filter(|m| !m.trim().is_empty()) {
        Some(text) => {
            let refs_worktree = matches!(artifact_kind, ArtifactKind::Diff | ArtifactKind::Tests);
            StageOutcome {
                artifact: StageArtifact {
                    kind: artifact_kind,
                    text: text.to_string(),
                    payload: None,
                    refs_worktree,
                },
                input_tokens: usage.input_tokens,
                output_tokens: usage.output_tokens,
                cache_read_tokens: usage.cache_read_input_tokens,
                cache_creation_tokens: usage.cache_creation_input_tokens,
                cost_usd: cost,
                status: StageStatus::Done,
                tool_calls: vec![],
                error: None,
                verdict: parse_verdict(text),
                session_id: accum.session_id.clone(),
                blocked: None,
                blocked_transcript: None,
            }
        }
        None => {
            let mut out = failed_stage(&format!(
                "codex produced no final message: {}",
                failure_detail(stderr_text, "the stream ended without an assistant message")
            ));
            out.input_tokens = usage.input_tokens;
            out.output_tokens = usage.output_tokens;
            out.cache_read_tokens = usage.cache_read_input_tokens;
            out.cache_creation_tokens = usage.cache_creation_input_tokens;
            out.cost_usd = cost;
            out.session_id = accum.session_id.clone();
            out
        }
    }
}

/// How the stdout read loop ended — drives the post-loop handling.
#[derive(Debug)]
pub(crate) enum ReadEnd {
    Eof(Option<String>, std::collections::VecDeque<String>),
    Idle(Option<String>, std::collections::VecDeque<String>),
    AbsCap(Option<String>, std::collections::VecDeque<String>),
    /// Claude emitted its `result` line and the process was still open
    /// [`ReadLimits::settle`] later (waiting on background work).
    Settled(String, std::collections::VecDeque<String>),
}

/// Timing limits for [`read_stream`]: the consts above for a stage, short
/// ones in tests.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ReadLimits {
    pub idle: std::time::Duration,
    pub cap: std::time::Duration,
    pub settle: std::time::Duration,
}

impl ReadLimits {
    pub(crate) const STAGE: ReadLimits = ReadLimits {
        idle: std::time::Duration::from_secs(IDLE_TIMEOUT_SECS),
        cap: std::time::Duration::from_secs(ABS_CAP_SECS),
        settle: std::time::Duration::from_secs(SETTLE_AFTER_RESULT_SECS),
    };
}

/// Read the CLI's stdout line by line until EOF, an idle stall, the absolute
/// cap, or (Claude) the settle grace after the `result` event. `on_event`
/// gets every JSON line (journal, usage, plan windows). We read RAW BYTES and
/// decode lossily — a chatty proxy can emit non-UTF-8 on stdout, and a
/// UTF-8-only line reader would abort the whole stream on the first bad byte
/// (losing the result event). Non-JSON lines (debug logs) are skipped, and a
/// bounded tail of recent lines is kept for diagnostics when no result event
/// ever arrives.
pub(crate) async fn read_stream<R: tokio::io::AsyncRead + Unpin>(
    stdout: R,
    dialect: CliDialect,
    limits: ReadLimits,
    mut on_event: impl FnMut(&Value),
) -> ReadEnd {
    let mut reader = tokio::io::BufReader::new(stdout);
    let mut result_line: Option<String> = None;
    // When the `result` line arrived — starts the settle grace. Not reset by
    // later lines: a background server that keeps logging must not hold the
    // stage open.
    let mut result_at: Option<std::time::Instant> = None;
    let mut tail: std::collections::VecDeque<String> = std::collections::VecDeque::new();
    let mut raw: Vec<u8> = Vec::new();
    let started = std::time::Instant::now();
    let settled = |at: Option<std::time::Instant>| at.is_some_and(|t| t.elapsed() >= limits.settle);
    loop {
        if settled(result_at) {
            if let Some(line) = result_line.take() {
                return ReadEnd::Settled(line, tail);
            }
        }
        let elapsed = started.elapsed();
        if elapsed >= limits.cap {
            return ReadEnd::AbsCap(result_line, tail);
        }
        raw.clear();
        let mut wait = limits.idle.min(limits.cap - elapsed);
        if let Some(at) = result_at {
            wait = wait.min(limits.settle.saturating_sub(at.elapsed()));
        }
        let read = tokio::time::timeout(wait, reader.read_until(b'\n', &mut raw)).await;
        match read {
            Err(_) => {
                // Timed out after `wait`: the settle grace ran out, the
                // absolute cap was reached, or it's a genuine idle stall.
                if settled(result_at) {
                    continue;
                }
                if started.elapsed() >= limits.cap {
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
        if dialect == CliDialect::Claude && is_result_event(&value) {
            result_line = Some(trimmed.to_string());
            result_at.get_or_insert_with(std::time::Instant::now);
        }
        on_event(&value);
    }
    ReadEnd::Eof(result_line, tail)
}

/// How long each polite signal in `stop_cli_child` gets before it escalates.
pub(crate) const STOP_GRACE: std::time::Duration = std::time::Duration::from_secs(5);

/// Stop a CLI stage's child and everything it started (it runs in its own
/// process group, see the spawn). SIGINT first — Claude Code ends the turn
/// cleanly; then SIGTERM — it terminates the process trees of its running Bash
/// commands and runs SessionEnd hooks; each gets `grace` to exit. Last, the
/// whole group gets SIGKILL: the escalation when the CLI ignored both, and a
/// sweep of any dev server, watch build or test runner left behind when it
/// did exit. Returns the child's exit status when it could be reaped.
pub(crate) async fn stop_cli_child(
    child: &mut tokio::process::Child,
    grace: std::time::Duration,
) -> Option<std::process::ExitStatus> {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        let pid = pid as libc::pid_t;
        let mut status = None;
        for sig in [libc::SIGINT, libc::SIGTERM] {
            // SAFETY: plain syscall on a pid that is still ours — `id()` is
            // Some only while the child is unreaped, so it can't be reused.
            unsafe {
                libc::kill(pid, sig);
            }
            if let Ok(Ok(s)) = tokio::time::timeout(grace, child.wait()).await {
                status = Some(s);
                break;
            }
        }
        // SAFETY: kill(-pid, SIGKILL) signals the group `process_group(0)`
        // created for this child. Once the leader is reaped the id stays
        // reserved while any member of its group lives; with none left the
        // call is a harmless ESRCH.
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
        if status.is_none() {
            status = child.wait().await.ok();
        }
        return status;
    }
    let _ = child.kill().await;
    child.wait().await.ok()
}

/// The CLI substrate: runs a stage by shelling out to headless Claude Code.
pub struct CliRunner;

/// Whether a stage runs read-only: a worktree review stage's whole contract
/// is to judge the diff, not to change it (Action-environment roles keep
/// their write access — committing/pushing IS their job). Pure.
fn stage_is_read_only(stage: &StageSpec) -> bool {
    matches!(stage.artifact_kind, ArtifactKind::Review)
        && matches!(stage.role_environment, crate::orchestrator::types::RoleEnvironment::Worktree)
}

/// `outcome` turned into a failure with `msg`, keeping the spend it burned so
/// the run meter stays truthful. Pure.
pub fn fail_keeping_usage(outcome: StageOutcome, msg: &str) -> StageOutcome {
    StageOutcome {
        input_tokens: outcome.input_tokens,
        output_tokens: outcome.output_tokens,
        cache_read_tokens: outcome.cache_read_tokens,
        cache_creation_tokens: outcome.cache_creation_tokens,
        cost_usd: outcome.cost_usd,
        ..failed_stage(msg)
    }
}

#[async_trait::async_trait]
impl AgentRunner for CliRunner {
    async fn run(
        &self,
        stage: &StageSpec,
        input: &StageInput,
        ctx: &StageContext,
    ) -> AppResult<StageOutcome> {
        // A Codex writer in Codex's own sandbox: record the worktree's `.git`
        // entry, and after the stage put a changed gitdir pointer back before
        // anything runs git there (`sandbox::restore_git_entry`).
        let dialect = dialect_for_model(&stage.agent_model);
        if !guards_git_entry(dialect, stage_is_read_only(stage), &ctx.exec_isolation) {
            return self.run_stage(stage, input, ctx).await;
        }
        let ws = ctx.workspace_path.clone();
        let read_ws = ws.clone();
        let before = tokio::task::spawn_blocking(move || crate::orchestrator::sandbox::GitEntry::read(&read_ws))
            .await
            .map_err(|e| AppError::Other(format!("could not check the worktree's .git: {e}")))?;
        let result = self.run_stage(stage, input, ctx).await;
        let changed = tokio::task::spawn_blocking(move || crate::orchestrator::sandbox::restore_git_entry(&ws, &before))
            .await
            .unwrap_or_else(|e| Some(format!("Octopush could not check the worktree's .git after the stage ({e}). Don't run git in it until you have checked it.")));
        match (changed, result) {
            (None, result) => result,
            (Some(msg), Ok(outcome)) => Ok(fail_keeping_usage(outcome, &msg)),
            (Some(msg), Err(_)) => Ok(failed_stage(&msg)),
        }
    }
}

impl CliRunner {
    async fn run_stage(
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
        let read_only = stage_is_read_only(stage);
        // The MODEL selects the CLI dialect (B6): claude-* → Claude Code,
        // OpenAI-family ids → Codex CLI. See `dialect_for_model`.
        let dialect = dialect_for_model(&stage.agent_model);
        // Version preflight (Claude Code only), cached per app session. An old
        // CLI is a journal warning, never a reason to stop the stage — but it
        // gets no `--effort`, which the tested floor is known to accept.
        let cli_version = if dialect == CliDialect::Claude {
            tokio::task::spawn_blocking(crate::agent_adapter::claude_cli_version).await.ok()
        } else {
            None
        };
        let old_cli = cli_version.as_ref().is_some_and(|v| v.below_floor);
        let effort = stage.effort.filter(|_| !old_cli);
        // Resume only on dialects with a confirmed continuation contract; a
        // dialect without one falls back to a fresh run (worktree preserved,
        // feedback in the prompt) even when a session id is on the row.
        let resume_args = stage
            .resume_session
            .as_deref()
            .and_then(|sid| dialect.resume_argv(&stage.agent_model, sid, stage.max_iterations, read_only));
        let resuming = resume_args.is_some();
        // A Codex writer outside a sandboxed mission runs in Codex's own
        // `workspace-write` sandbox, never the bypass flag.
        let write_scope = codex_write_scope(&ctx.exec_isolation);
        let (mut args, user) = match resume_args {
            Some(argv) => (
                argv,
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
                dialect.argv(&stage.agent_model, &system, stage.max_iterations, read_only, write_scope),
                dialect.stdin_payload(
                    &system,
                    &user_input_for(&stage.role, &ctx.task, input, stage.feedback.as_deref()),
                ),
            ),
        };
        // Claude Code meters its own spend: cap the stage at its share of the
        // run's remaining budget so one long stage can't run far past it (the
        // API substrate stops at the same headroom in `run_agentic_loop`).
        // Codex has no such flag and keeps the between-stage gate.
        let budget_cap = match dialect {
            CliDialect::Claude => cli_budget_cap(
                ctx.spend_limit,
                if resuming { stage.resume_prior_cost_usd } else { 0.0 },
            ),
            CliDialect::Codex => None,
        };
        args.extend(max_budget_args(budget_cap));
        dialect.push_effort_args(&mut args, &stage.agent_model, effort);

        let path_env = resolved_cli_path();
        let real_program: std::ffi::OsString = resolve_executable(dialect.binary(), &path_env)
            .map(Into::into)
            .unwrap_or_else(|| dialect.binary().into());

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
        for (k, v) in dialect.stage_env() {
            command.env(k, v);
        }
        // After the login-shell env, which may carry the user's own export.
        for k in dialect.stage_env_remove(effort) {
            command.env_remove(k);
        }
        for (k, v) in dialect.stage_effort_env(effort) {
            command.env(k, v);
        }
        command
            .env("PATH", &path_env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        // Own process group, so a stop reaches the dev servers, watch builds
        // and test runners the stage started (`sandbox-exec` execs into the
        // CLI, so the group covers the sandboxed case too).
        #[cfg(unix)]
        command.process_group(0);
        // Created before the spawn so the journal can name the substrate the
        // moment it launches — the model id silently selects the dialect (B6),
        // and a stage quietly running `codex` instead of `claude` is exactly
        // the kind of surprise the journal exists to surface.
        let emitter = crate::orchestrator::live::LiveEmitter::new(
            ctx.events.as_ref(), &ctx.run_id, &ctx.stage_id,
        );
        for note in cli_version.as_ref().map(|v| v.stage_notices()).unwrap_or_default() {
            emitter.notice(&note);
        }
        if let (Some(e), true) = (stage.effort, old_cli) {
            emitter.notice(&format!(
                "This stage's {} effort is not passed to the older Claude Code; it runs at the CLI's default effort.",
                e.as_str()
            ));
        }
        if let Some(note) = dialect.unpassed_effort_notice(&stage.agent_model, effort) {
            emitter.notice(&note);
        }
        let mut child = match command.spawn() {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(failed_stage(&dialect.not_found_message()));
            }
            Err(e) => return Ok(failed_stage(&format!("failed to launch {}: {e}", dialect.binary()))),
        };
        emitter.notice(&format!(
            "launching {} · {}{}{}{}",
            dialect.binary(),
            stage.agent_model,
            dialect.effort_level(&stage.agent_model, effort).map(|e| format!(" · {e} effort")).unwrap_or_default(),
            dialect.sandbox_label(read_only, write_scope).map(|s| format!(" · {s}")).unwrap_or_default(),
            if resuming { " · resuming session" } else { "" },
        ));
        if let Some(cap) = max_budget_args(budget_cap).get(1) {
            emitter.notice(&format!(
                "budget cap · ${cap} for this stage — Claude Code stops at it, measured by its own \
                 estimated API-equivalent cost, which can differ from your actual bill"
            ));
        }

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

        // Stream stdout line-by-line (`read_stream`): emit live progress per
        // NDJSON event and keep the final `result` event.
        // Running usage estimate from streamed assistant events, readable from
        // the cancel branch too — a stop/timeout used to record ZERO usage
        // ("unknowable mid-flight"), silently understating real spend against
        // the budget. Keyed by message id (latest usage per message wins) so
        // the CLI's one-event-per-content-block stream never double-counts a
        // multi-block turn; id-less events get a unique synthetic key.
        let streamed_usage: std::sync::Arc<parking_lot::Mutex<std::collections::HashMap<String, CliUsage>>> =
            std::sync::Arc::new(parking_lot::Mutex::new(std::collections::HashMap::new()));
        let usage_in_loop = std::sync::Arc::clone(&streamed_usage);
        // Codex terminal state accumulates across the stream (there is no
        // single `result` event); shared so the timeout/salvage paths below
        // can read it too.
        let codex_accum: std::sync::Arc<parking_lot::Mutex<CodexAccum>> =
            std::sync::Arc::new(parking_lot::Mutex::new(CodexAccum::default()));
        let codex_in_loop = std::sync::Arc::clone(&codex_accum);
        // Codex stream-schema tripwire: the codex CLI's JSON contract has
        // drifted across versions and `codex_fold_event` skips unknown
        // events — parsing many JSON lines while journaling NONE of them
        // means the installed CLI speaks a schema we don't, and the live
        // pane would sit silently empty until the stage settles. Say so
        // once instead.
        let mut codex_json_lines: u32 = 0;
        let mut codex_journaled = false;
        let mut codex_schema_warned = false;
        // From `system/init`: an API-key session's rate-limit events are
        // not plan windows and never reach the plan snapshot.
        let mut auth: Option<CliAuth> = None;
        // A retry storm journals one line per cause per 10 s, not one per attempt.
        let mut retry_throttle = crate::orchestrator::live::RetryThrottle::default();
        let on_event = |value: &Value| match dialect {
            CliDialect::Claude => {
                if let Some((id, u)) = usage_from_stream_event(value) {
                    let mut map = usage_in_loop.lock();
                    let key = id.unwrap_or_else(|| format!("anon-{}", map.len()));
                    map.insert(key, u);
                }
                if retry_throttle.allow(value, std::time::Instant::now()) {
                    for entry in crate::orchestrator::live::entries_from_stream_event(value) {
                        emitter.emit_raw_entry(entry);
                    }
                }
                forward_plan_and_login(&mut auth, value, &emitter);
            }
            CliDialect::Codex => {
                codex_json_lines += 1;
                let entries = codex_fold_event(&mut codex_in_loop.lock(), value);
                codex_journaled |= !entries.is_empty();
                for entry in entries {
                    emitter.emit_raw_entry(entry);
                }
                if let Some((id, u)) = codex_usage_from_event(value) {
                    let mut map = usage_in_loop.lock();
                    let key = id.unwrap_or_else(|| format!("anon-{}", map.len()));
                    map.insert(key, u);
                }
                if !codex_journaled && !codex_schema_warned && codex_json_lines >= 10 {
                    codex_schema_warned = true;
                    emitter.notice(
                        "codex is streaming events this version of Octopush doesn't \
                         recognize — the live journal may stay quiet until the stage \
                         finishes (the work itself is unaffected)",
                    );
                }
            }
        };
        let read_loop = read_stream(stdout, dialect, ReadLimits::STAGE, on_event);

        // Race the child's output against the director's stop signal: poll the
        // cancel flag every ~500ms and, when set, stop the child's process
        // group (`stop_cli_child`) and fail the stage with the director message
        // and the usage streamed so far. An idle timeout fires when NO output arrives
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
                stop_cli_child(&mut child, STOP_GRACE).await;
                // Estimated spend from the streamed assistant events — a stop
                // used to record zero and silently understate the budget.
                return Ok(failed_stage_with_usage(
                    &crate::orchestrator::runner::unfinished_stage_error(true, 0),
                    &stage.agent_model,
                    &streamed_usage.lock(),
                ));
            }
        };
        let bin = dialect.binary();
        let (result_line, tail, timeout_kind, settled) = match read_end {
            ReadEnd::Eof(r, t) => (r, t, None, false),
            ReadEnd::Idle(r, t) => (r, t, Some("timed out — no output for 5 minutes"), false),
            ReadEnd::AbsCap(r, t) => (r, t, Some("exceeded the 60-minute cap"), false),
            ReadEnd::Settled(r, t) => (Some(r), t, None, true),
        };
        // Is there a salvageable terminal state? Claude: a captured `result`
        // line (authoritative — the CLI declared itself finished). Codex has
        // NO terminal event: an accumulated assistant message on a TIMEOUT is
        // just the last narration of a stalled run, not proof of completion —
        // promoting it to a Done artifact would hand half-finished work
        // downstream unmarked. A stalled codex stage therefore fails honestly
        // (the journal keeps its messages; Accept-partial salvages them).
        let has_terminal = match dialect {
            CliDialect::Claude => result_line.is_some(),
            CliDialect::Codex => false,
        };
        if let (Some(kind), false) = (timeout_kind, has_terminal) {
            stop_cli_child(&mut child, STOP_GRACE).await;
            stderr_task.abort();
            return Ok(failed_stage_with_usage(
                &format!("{bin} {kind}"),
                &stage.agent_model,
                &streamed_usage.lock(),
            ));
        }
        // Settled: the CLI declared itself finished and then stayed open on
        // background work it started — the `result` is the hand-off.
        let salvaged = timeout_kind.is_some() || settled;

        // When we salvaged a result from a slow-EOF idle/cap or a settle, the
        // child may still be lingering — stop its whole process group (so the
        // dev servers it started go too) instead of blocking on wait(), and
        // trust the result event's own is_error (same rationale as the
        // existing wait-hiccup comment). Otherwise (clean EOF) wait normally.
        let exit_success = if salvaged {
            stop_cli_child(&mut child, STOP_GRACE).await;
            if settled {
                emitter.notice("stage finished · stopped background work it left running");
            }
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

        // Question-as-result guard (both dialects): a Done outcome whose text
        // is a person-addressed question becomes a director block — the
        // question must reach the human, not the next stage's prompt disguised
        // as a result. Verdict-bearing reviews are exempt (they finished; the
        // verdict drives the loop).
        let apply_question_guard = |mut outcome: StageOutcome| -> StageOutcome {
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
            outcome
        };

        match dialect {
            CliDialect::Codex => {
                let accum = codex_accum.lock().clone();
                let u = sum_usage(&streamed_usage.lock());
                let outcome = build_codex_outcome(
                    &accum,
                    u,
                    exit_success,
                    stage.artifact_kind.clone(),
                    &stage.agent_model,
                    &stderr_out,
                );
                Ok(apply_question_guard(outcome))
            }
            CliDialect::Claude => match result_line {
                Some(line) => match parse_cli_result(&line, exit_success, stage.artifact_kind.clone(), &stderr_out) {
                    Ok(outcome) => Ok(apply_question_guard(with_free_space(
                        outcome,
                        || free_bytes(&ctx.workspace_path),
                    ))),
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
            },
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

/// The estimated cost of the streamed per-message usage: standard-speed
/// messages at the model's price, fast-mode ones at the fast rate
/// (`token_engine::fast_prices`). A fast message on a model without a fast
/// rate adds nothing — unpriced, never billed at the standard rate.
pub(crate) fn streamed_cost(model: &str, map: &std::collections::HashMap<String, CliUsage>) -> f64 {
    let mut standard = CliUsage::default();
    let mut fast = CliUsage::default();
    for u in map.values() {
        if u.fast {
            fast.add(u);
        } else {
            standard.add(u);
        }
    }
    let mut cost = crate::orchestrator::cost::stage_cost_split(
        model,
        standard.input_tokens,
        standard.output_tokens,
        standard.cache_read_input_tokens,
        standard.cache_creation_input_tokens,
        standard.cache_creation_1h_input_tokens,
    );
    if fast != CliUsage::default() {
        let prices = crate::token_engine::prices_at_speed(
            model,
            crate::token_engine::prices_for(model),
            Some(crate::token_engine::SPEED_FAST),
        );
        if let Some(p) = prices {
            cost += p.cost_split(
                fast.input_tokens,
                fast.output_tokens,
                fast.cache_read_input_tokens,
                fast.cache_creation_input_tokens,
                fast.cache_creation_1h_input_tokens,
            );
        }
    }
    cost
}

/// A failed outcome carrying the ESTIMATED usage summed from the streamed
/// assistant events (no terminal `result` event arrived to be authoritative).
/// Cost is priced through the normal catalog ([`streamed_cost`]) so the run
/// meter and budget see the burned spend instead of zero.
fn failed_stage_with_usage(msg: &str, model: &str, map: &std::collections::HashMap<String, CliUsage>) -> StageOutcome {
    let u = sum_usage(map);
    let mut out = failed_stage(msg);
    out.input_tokens = u.input_tokens;
    out.output_tokens = u.output_tokens;
    out.cache_read_tokens = u.cache_read_input_tokens;
    out.cache_creation_tokens = u.cache_creation_input_tokens;
    out.cost_usd = streamed_cost(model, map);
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
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
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
