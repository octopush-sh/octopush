//! CLI substrate: runs a stage via headless Claude Code (`claude -p`).
//!
//! All parsing/arg-building is pure and unit-tested; the live spawn lives in
//! `CliRunner::run` (added in a later task). The agent runs with
//! `--permission-mode bypassPermissions` inside the workspace's isolated git
//! worktree, bounded by `--max-turns`, with the post-stage checkpoint as the
//! human control point.

use crate::error::{AppError, AppResult};
use crate::orchestrator::runner::{parse_verdict, user_input_for, AgentRunner, StageContext};
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
/// Claude Code's default ceiling on one foreground Bash/PowerShell command
/// (`BASH_MAX_TIMEOUT_MS`, 10 minutes). While such a call is open the CLI is
/// silent by design, so the idle window stretches to it ([`command_idle_window`]).
const BASH_MAX_TIMEOUT_DEFAULT_MS: u64 = 600_000;
/// Slack on top of the command ceiling for the CLI to report the result.
const COMMAND_RESULT_SLACK_SECS: u64 = 60;
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
    /// Start-up errors (Claude Code ≥ 2.1.323), e.g. the settings that failed
    /// validation ([`refused_setting`]). Kept untyped: only strings are read.
    #[serde(default)]
    errors: Option<serde_json::Value>,
    /// Why the CLI never started the session (Claude Code ≥ 2.1.323), e.g.
    /// [`SANDBOX_REQUIRED_UNAVAILABLE`]. Older CLIs leave it unset.
    #[serde(default)]
    startup_failure_reason: Option<String>,
    /// Turns the session ran; a start-up stop reports 0.
    #[serde(default)]
    num_turns: Option<u64>,
    /// The tool calls Claude Code refused with nobody to ask (`bypassPermissions`
    /// asks or denies some calls since 2.1.326). Kept untyped: a missing or
    /// malformed list reads as none ([`refused_calls`]).
    #[serde(default)]
    permission_denials: Option<serde_json::Value>,
}

#[derive(Deserialize, Debug, Default)]
struct CliDeferredToolUse {
    #[serde(default)]
    name: String,
}

#[derive(Deserialize, Debug, Default, Clone, PartialEq)]
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
    /// The model that answered one streamed message (`message.model`) — a
    /// subagent's can differ from the stage's. Only set per message by
    /// [`usage_from_stream_event`]; `None` means the stage's model.
    #[serde(skip)]
    pub(crate) model: Option<String>,
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

    /// Every token the usage counts (input, output, cache reads and writes).
    fn total(&self) -> u64 {
        self.input_tokens + self.output_tokens + self.cache_read_input_tokens + self.cache_creation_input_tokens
    }
}

/// Per-message usage from an `assistant` NDJSON stream event: the message id
/// (the CLI emits ONE assistant event per content block, each repeating the
/// same message's usage — summing raw events double/triple-counts multi-block
/// turns) plus the usage tuple. Callers keep the LATEST usage per id and sum
/// across ids, so a stop/timeout that never sees the terminal `result` event
/// still reports an honest ESTIMATE of the burned spend instead of zero.
/// A missing id yields `None` for the id — the caller keys it uniquely.
/// The usage carries the message's own `message.model` (a subagent may run
/// on another model than the stage; `None` when the event names none).
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
            model: msg.get("model").and_then(Value::as_str).filter(|m| !m.is_empty()).map(str::to_string),
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

/// The model a Claude session runs on, from its `system/init` event's
/// `model`; `None` for any other event or an init without one.
pub(crate) fn init_model(v: &Value) -> Option<&str> {
    if v.get("type").and_then(Value::as_str) != Some("system")
        || v.get("subtype").and_then(Value::as_str) != Some("init")
    {
        return None;
    }
    v.get("model").and_then(Value::as_str).map(str::trim).filter(|m| !m.is_empty())
}

/// Claude Code's own aliases cover any id of their family: `sonnet` (or
/// `sonnet[1m]`, already stripped) runs as some `claude-sonnet-*`;
/// `opusplan` as Opus or Sonnet; `default`/`best` as whatever the account
/// resolves them to.
fn alias_covers(alias: &str, id: &str) -> bool {
    match alias {
        "default" | "best" => true,
        "opusplan" => id.starts_with("claude-opus") || id.starts_with("claude-sonnet"),
        "sonnet" | "opus" | "haiku" | "fable" | "mythos" => id.starts_with(&format!("claude-{alias}")),
        _ => false,
    }
}

/// True when a stage that asked for `requested` and ran on `ran` ran on the
/// model it asked for: equal after `token_engine::normalize_model_id`
/// (gateway prefixes, Bedrock/Vertex suffixes, dated snapshots, dotted
/// gateway versions, `[1m]`), or one is a Claude Code alias covering the
/// other (`sonnet` vs `claude-sonnet-5-5`). Pure.
pub fn same_model(requested: &str, ran: &str) -> bool {
    let norm = |m: &str| crate::token_engine::normalize_model_id(&m.trim().to_ascii_lowercase());
    let (a, b) = (norm(requested), norm(ran));
    a == b || alias_covers(&a, &b) || alias_covers(&b, &a)
}

/// True when `id`, normalised, names a Claude family: a `claude-*` id or a
/// Claude Code alias (`sonnet`, `opusplan`, `default`…).
fn has_claude_family(id: &str) -> bool {
    let m = crate::token_engine::normalize_model_id(&id.trim().to_ascii_lowercase());
    m.starts_with("claude-")
        || matches!(m.as_str(), "default" | "best" | "opusplan" | "sonnet" | "opus" | "haiku" | "fable" | "mythos")
}

/// The model a Claude stage ran on when it isn't the one it asked for: the
/// `system/init` event's `model` that [`same_model`] says differs. A missing
/// or empty `model` changes nothing. Nor does a provider-native id with no
/// Claude family (a Bedrock application-inference-profile ARN, a Foundry
/// deployment name) for a stage that asked for a Claude model: it is most
/// likely the requested model under another name, so the stage keeps its
/// requested model (no note, cost priced as asked). Pure.
pub fn substituted_model(requested: &str, init: &Value) -> Option<String> {
    init_model(init)
        .filter(|ran| !same_model(requested, ran))
        .filter(|ran| has_claude_family(ran) || !has_claude_family(requested))
        .map(str::to_string)
}

/// A model's short display name for the journal: the catalog's name
/// without "Claude " ("Sonnet 5.5"), else the id as given.
fn model_display(model: &str, router: Option<&crate::provider_router::ProviderRouter>) -> String {
    router
        .and_then(|r| r.find_model(model))
        .map(|(_, m)| m.display_name.trim_start_matches("Claude ").to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| model.to_string())
}

/// The journal line when a Claude stage runs on another model than it
/// asked for: "ran on Sonnet 5.5, not Opus 5.5 — Claude Code's model
/// settings picked another model". Since 2.1.323 `claude -p` "now warns on
/// stderr" when settings block the requested model in text output only;
/// a stream-json stage says nothing, so this is the only notice.
pub fn ran_on_notice(requested: &str, ran: &str, router: Option<&crate::provider_router::ProviderRouter>) -> String {
    format!(
        "ran on {}, not {} — Claude Code's model settings picked another model",
        model_display(ran, router),
        model_display(requested, router)
    )
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

// ─── Claude plan limit (a stage stopped at the plan's wall) ───────────────
//
// When a subscription session hits a plan window, Claude Code streams a
// `rate_limit_event` whose `rate_limit_info.status` is `rejected` (with the
// window's `resetsAt`), then a synthetic assistant message (`model:
// "<synthetic>"`, `error: "rate_limit"`, text like "You've hit your 5-hour
// limit · resets 7:40pm") and ends the turn. A `rejected` event with
// `isUsingOverage: true` is not a stop: extra usage covers the request.

/// The marker in the error of a stage that a Claude plan limit stopped.
/// The drive parks such a stage until the window resets ([`is_plan_limit`]).
pub const PLAN_LIMIT_MARKER: &str = "(plan_limit)";

/// True when a stage error is a Claude plan limit (see [`apply_plan_limit`]):
/// never escalated (a stronger model meets the same wall), and resumable.
pub fn is_plan_limit(error: &str) -> bool {
    error.contains(PLAN_LIMIT_MARKER)
}

/// The plan window that stopped a stage, and when it resets (epoch seconds).
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanLimit {
    pub window: String,
    pub resets_at: i64,
}

/// Watches one Claude stage's stream for a plan limit. Fed only for a session
/// that is not API-key authenticated, so API-key users see no change.
#[derive(Default, Debug)]
pub(crate) struct PlanLimitWatch {
    rejected: Option<PlanLimit>,
    /// The CLI wrote its own limit notice (`error: "rate_limit"`).
    limit_notice: bool,
    /// The last rate-limit event seen was that rejection: nothing allowed a
    /// request after it, so it is what ended the turn.
    rejection_last: bool,
}

impl PlanLimitWatch {
    /// Feed one stream message. Only the stage's own top-level messages
    /// count: a sub-agent's (`parent_tool_use_id` set) is not the stage's
    /// stop.
    pub(crate) fn observe(&mut self, v: &Value) {
        if v.get("parent_tool_use_id").is_some_and(|p| !p.is_null()) {
            return;
        }
        let windows = plan_windows_from_stream_event(v);
        if !windows.is_empty() {
            // A rate-limit event: the rejection is the last one only if this
            // event rejects too (other windows it lists may be allowed).
            self.rejection_last = false;
        }
        for w in windows {
            match w.status.as_deref() {
                Some("rejected") if !w.using_overage => {
                    if let Some(resets_at) = w.resets_at {
                        self.rejected = Some(PlanLimit { window: w.kind, resets_at });
                        self.rejection_last = true;
                    }
                }
                // The same window allowed again: the wall is gone.
                Some("allowed") | Some("allowed_warning")
                    if self.rejected.as_ref().is_some_and(|r| r.window == w.kind) =>
                {
                    self.rejected = None;
                }
                _ => {}
            }
        }
        if v.get("type").and_then(Value::as_str) == Some("assistant") {
            let err = v
                .get("error")
                .or_else(|| v.get("message").and_then(|m| m.get("error")))
                .and_then(Value::as_str);
            if err == Some("rate_limit") {
                self.limit_notice = true;
            }
        }
    }

    pub(crate) fn limit(&self) -> Option<&PlanLimit> {
        self.rejected.as_ref()
    }
}

/// The full name of a plan window, for the halt copy.
pub fn plan_window_name(kind: &str) -> String {
    match kind {
        "five_hour" => "5-hour window".into(),
        "seven_day" => "weekly window".into(),
        k if k.starts_with("seven_day_") => {
            let model = k["seven_day_".len()..].replace('_', " ");
            let mut c = model.chars();
            let cap = c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default();
            format!("weekly {cap} window")
        }
        k => format!("{} window", k.replace('_', " ")),
    }
}

/// Mark `outcome` as stopped by a Claude plan limit when the stream showed a
/// `rejected` window and the stage didn't finish: Failed, with the plan copy
/// and [`PLAN_LIMIT_MARKER`], its spend and session kept for Resume, and
/// `cli.plan_limit` set so the drive parks it. A result that only *looks*
/// finished (the CLI's own limit notice as the reply) is a stop too. A
/// budget stop, a deferred tool and an unsaved session keep their own cause.
pub(crate) fn apply_plan_limit(mut outcome: StageOutcome, watch: &PlanLimitWatch) -> StageOutcome {
    let Some(limit) = watch.limit().cloned() else {
        return outcome;
    };
    let own_cause = outcome.error.as_deref().is_some_and(|e| {
        is_budget_stop(e) || is_tool_deferred(e) || is_deferred_tool_unavailable(e) || is_session_not_saved(e)
    });
    if own_cause {
        return outcome;
    }
    let stopped = match outcome.status {
        // A failure is the plan's only with the CLI's own limit notice, or
        // when the rejection was the last rate-limit event before the result
        // (a failure after a later allowed request has another cause).
        StageStatus::Failed => watch.limit_notice || watch.rejection_last,
        // The reply is the CLI's own limit notice, not the agent's work.
        StageStatus::Done | StageStatus::AwaitingCheckpoint => watch.limit_notice,
        _ => false,
    };
    if !stopped {
        return outcome;
    }
    let detail = outcome
        .error
        .take()
        .filter(|e| !e.trim().is_empty())
        .or_else(|| Some(outcome.artifact.text.trim().to_string()).filter(|t| !t.is_empty()));
    let mut error = format!(
        "Paused by your Claude plan — the {} is used up until it resets.\n{PLAN_LIMIT_MARKER}",
        plan_window_name(&limit.window)
    );
    if let Some(d) = detail {
        error.push('\n');
        error.push_str(&d);
    }
    outcome.status = StageStatus::Failed;
    outcome.error = Some(error);
    outcome.verdict = None;
    outcome.blocked = None;
    outcome.artifact = StageArtifact {
        kind: ArtifactKind::Note,
        text: String::new(),
        payload: None,
        refs_worktree: false,
    };
    outcome.cli.plan_limit = Some(limit);
    outcome
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

/// The start of the error of a Claude stage that Claude Code refused to start
/// because the stage's settings failed validation. Since 2.1.323 `claude -p`
/// "stops at start-up and names the invalid setting" when `--settings` that
/// turn the sandbox on fail validation, instead of running Bash unsandboxed.
pub const SETTINGS_REFUSED: &str = "Claude Code refused the stage's settings";

/// True when a stage error is a refused-settings start-up stop (see
/// [`parse_cli_result`]): the drive must not escalate it — a stronger model
/// starts with the same settings.
pub fn is_settings_refused(error: &str) -> bool {
    error.starts_with(SETTINGS_REFUSED)
}

/// The `startup_failure_reason` of a result whose `--settings` turn the
/// sandbox on but failed validation (Claude Code ≥ 2.1.323).
pub const SANDBOX_REQUIRED_UNAVAILABLE: &str = "sandbox_required_unavailable";

/// The prefix of the line Claude Code prints for that start-up stop.
const SANDBOX_REQUIRED_PREFIX: &str = "sandbox required but unavailable";

/// A line, without a leading `Error: `, that is Claude Code's own
/// refused-settings message: the "Sandbox required but unavailable" prefix
/// together with "failed validation". Any other "failed validation" line
/// (a gateway probe, a hook) is not one.
fn refused_settings_line(line: &str) -> Option<&str> {
    let l = line.trim();
    let l = l.strip_prefix("Error:").map(str::trim_start).unwrap_or(l);
    let lower = l.to_ascii_lowercase();
    (lower.starts_with(SANDBOX_REQUIRED_PREFIX) && lower.contains("failed validation")).then_some(l)
}

/// The line naming the setting Claude Code refused, from the result's
/// `errors` (first) or stderr, at most 400 chars. Anchored on the real
/// signal: `startup_failure_reason` is [`SANDBOX_REQUIRED_UNAVAILABLE`], or
/// a line is the "Sandbox required but unavailable … failed validation"
/// message ([`refused_settings_line`]). With the reason but no such line, the
/// first `errors` string stands in. `None` for any other failure. Pure.
pub(crate) fn refused_setting(
    errors: Option<&serde_json::Value>,
    stderr: &str,
    startup_failure_reason: Option<&str>,
) -> Option<String> {
    let error_lines = || {
        errors
            .and_then(|e| e.as_array())
            .into_iter()
            .flatten()
            .filter_map(|e| e.as_str())
            .flat_map(str::lines)
    };
    let clip = |l: &str| -> String { l.chars().take(400).collect() };
    if let Some(l) = error_lines().chain(stderr.lines()).find_map(refused_settings_line) {
        return Some(clip(l));
    }
    if startup_failure_reason != Some(SANDBOX_REQUIRED_UNAVAILABLE) {
        return None;
    }
    let first = error_lines().map(str::trim).find(|l| !l.is_empty());
    let first = first.map(|l| l.strip_prefix("Error:").map(str::trim_start).unwrap_or(l));
    Some(clip(first.unwrap_or("Sandbox required but unavailable: the settings failed validation")))
}

/// The error for a refused-settings stop ([`SETTINGS_REFUSED`]), with the
/// stderr tail when there is one.
fn settings_refused_error(line: &str, stderr: &str) -> String {
    let error = format!("{SETTINGS_REFUSED}: {line}");
    let tail = stderr_tail(stderr, 10);
    if tail.is_empty() { error } else { format!("{error}\n— stderr —\n{tail}") }
}

/// The marker line in the error of a Codex stage that ended (director stop,
/// stall, 60-minute cap, `turn.failed`, a crash) with its last turn missing
/// its `turn.completed` / `token_count` event: Codex reports usage only there,
/// so (that part of) the stage's spend is unknown, not $0.
/// Also the journal line the drive writes for it.
pub const USAGE_UNREPORTED: &str = "codex stopped before reporting usage, so this stage's cost is unknown";

/// The marker line in the error of a stopped Claude Code stage whose streamed
/// usage includes a message Octopush can't price: a subagent on a model with
/// no price, or a fast-mode message on a model with no fast rate. That part of
/// the spend is unknown, not $0 — it reads "usage not reported" like
/// [`USAGE_UNREPORTED`]. The unpriced models follow it on the same line.
pub const USAGE_UNPRICED: &str = "part of this stage's streamed usage has no price, so that part of its cost is unknown";

/// The line of a stage error that carries [`USAGE_UNREPORTED`] or
/// [`USAGE_UNPRICED`] — the sentence the drive journals for it.
pub fn usage_unreported_line(error: &str) -> Option<&str> {
    error.lines().find(|l| l.contains(USAGE_UNREPORTED) || l.contains(USAGE_UNPRICED))
}

/// True when a stage error carries [`USAGE_UNREPORTED`] or [`USAGE_UNPRICED`]:
/// the drive flags the stage `usage_unreported` so the ledger reads "usage
/// not reported".
pub fn is_usage_unreported(error: &str) -> bool {
    usage_unreported_line(error).is_some()
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

/// One kind of tool call Claude Code refused in a stage (the result event's
/// `permission_denials`): the tool, a redacted one-line hint (its command or
/// path) and how many times that same call was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RefusedCall {
    pub tool: String,
    pub hint: String,
    pub count: u32,
}

/// Every journal notice about refused calls starts with this (the done
/// card's verdict line skips them: `lastNotice` in `src/lib/liveLine.ts`).
pub const REFUSED_NOTICE_PREFIX: &str = "refused · ";

/// The most of a refused call's hint the journal shows.
const REFUSED_HINT_CHARS: usize = 80;

/// The hint for one refused call: `tool_input.command`, else `file_path`,
/// else `path`, on one line, redacted by the secret guard, then cut to
/// [`REFUSED_HINT_CHARS`]. Empty when the input names none of them.
fn refused_hint(input: Option<&Value>, known: &[crate::secret_scan::KnownSecret]) -> String {
    let raw = ["command", "file_path", "path"]
        .iter()
        .find_map(|k| input.and_then(|i| i.get(*k)).and_then(Value::as_str).filter(|s| !s.trim().is_empty()))
        .unwrap_or_default();
    let one_line = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let redacted = crate::secret_scan::redact_line(&one_line, known);
    if redacted.chars().count() > REFUSED_HINT_CHARS {
        let cut: String = redacted.chars().take(REFUSED_HINT_CHARS - 1).collect();
        format!("{}…", cut.trim_end())
    } else {
        redacted
    }
}

/// The calls in a result event's `permission_denials`, repeats of the same
/// tool and hint collapsed, in first-seen order. Anything but a list, and
/// any entry without a `tool_name`, reads as nothing. Pure.
pub fn refused_calls(denials: Option<&Value>, known: &[crate::secret_scan::KnownSecret]) -> Vec<RefusedCall> {
    let mut out: Vec<RefusedCall> = Vec::new();
    for d in denials.and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default() {
        let Some(tool) = d.get("tool_name").and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty()) else {
            continue;
        };
        let hint = refused_hint(d.get("tool_input"), known);
        match out.iter_mut().find(|c| c.tool == tool && c.hint == hint) {
            Some(c) => c.count += 1,
            None => out.push(RefusedCall { tool: tool.to_string(), hint, count: 1 }),
        }
    }
    out
}

/// How many calls were refused in all (repeats counted).
pub fn refused_total(calls: &[RefusedCall]) -> u32 {
    calls.iter().map(|c| c.count).sum()
}

/// The journal notice for one refused call: `refused · Bash · git push ×2`.
pub fn refused_notice(call: &RefusedCall) -> String {
    let mut s = format!("{REFUSED_NOTICE_PREFIX}{}", call.tool);
    if !call.hint.is_empty() {
        s.push_str(&format!(" · {}", call.hint));
    }
    if call.count > 1 {
        s.push_str(&format!(" ×{}", call.count));
    }
    s
}

/// What a finished writer stage hands the next stage about its refused
/// calls, appended to its artifact, so a review stage can check them.
/// Empty when nothing was refused.
pub fn refused_handoff(calls: &[RefusedCall]) -> String {
    if calls.is_empty() {
        return String::new();
    }
    let mut s = String::from(
        "\n\nClaude Code refused these tool calls during this stage, so they never ran — check whether the work still needs them:",
    );
    for c in calls {
        s.push_str(&format!("\n- {}", c.tool));
        if !c.hint.is_empty() {
            s.push_str(&format!(": {}", c.hint));
        }
        if c.count > 1 {
            s.push_str(&format!(" (×{})", c.count));
        }
    }
    s
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
/// The calls Claude Code refused (`permission_denials`) go on
/// `outcome.cli.refused_calls` whatever the outcome; a `Done` writer stage
/// (diff or tests) also names them at the end of its artifact
/// ([`refused_handoff`]), so the next stage sees them.
/// Returns `Err` only when the line isn't parseable at all.
pub fn parse_cli_result(
    stdout: &str,
    exit_success: bool,
    artifact_kind: ArtifactKind,
    stderr_text: &str,
) -> AppResult<StageOutcome> {
    parse_cli_result_redacting(stdout, exit_success, artifact_kind, stderr_text, &[])
}

/// [`parse_cli_result`], with the refused calls' hints also redacted for
/// `known` (the credentials Octopush holds).
pub fn parse_cli_result_redacting(
    stdout: &str,
    exit_success: bool,
    artifact_kind: ArtifactKind,
    stderr_text: &str,
    known: &[crate::secret_scan::KnownSecret],
) -> AppResult<StageOutcome> {
    let parsed: CliResult = serde_json::from_str(stdout.trim()).map_err(|e| {
        let preview: String = stdout.chars().take(300).collect();
        AppError::Other(format!("could not parse claude output: {e}; got: {preview}"))
    })?;
    let refused = refused_calls(parsed.permission_denials.as_ref(), known);
    let mut outcome = outcome_of_result(&parsed, exit_success, artifact_kind, stderr_text);
    if matches!(outcome.status, StageStatus::Done) && outcome.artifact.refs_worktree {
        outcome.artifact.text.push_str(&refused_handoff(&refused));
    }
    outcome.cli.refused_calls = refused;
    Ok(outcome)
}

/// The outcome of a parsed `result` event (see [`parse_cli_result`]).
fn outcome_of_result(
    parsed: &CliResult,
    exit_success: bool,
    artifact_kind: ArtifactKind,
    stderr_text: &str,
) -> StageOutcome {
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
        return StageOutcome {
            cli: Default::default(),
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
        };
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
        return StageOutcome {
            cli: Default::default(),
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
        };
    }

    // Claude Code refused to start because the stage's settings failed
    // validation (≥ 2.1.323): name the refused setting, not "stopped early
    // (error_during_execution)". The session never ran, so there is nothing
    // to resume. Never a budget stop or a max-turns stop, nor a session that
    // ran turns: those keep their own handling below.
    let ran_turns = parsed.num_turns.is_some_and(|n| n > 0);
    let own_stop = matches!(bad_subtype, Some(BUDGET_STOP_SUBTYPE) | Some("error_max_turns"));
    if (parsed.is_error || !exit_success) && !ran_turns && !own_stop {
        if let Some(line) =
            refused_setting(parsed.errors.as_ref(), stderr_text, parsed.startup_failure_reason.as_deref())
        {
            return StageOutcome {
                cli: Default::default(),
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
                error: Some(settings_refused_error(&line, stderr_text)),
                verdict: None,
                session_id: None,
                blocked: None,
                blocked_transcript: None,
            };
        }
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
        return StageOutcome {
            cli: Default::default(),
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
        };
    }

    StageOutcome {
        cli: Default::default(),
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
    }
}

/// File-mutating Claude Code tools denied to a read-only (review) CLI stage.
/// The API substrate enforces read-only reviewers through its tool allowlist;
/// the CLI ran with `bypassPermissions` and nothing but a "Do not modify
/// files" prompt — a reviewer that "fixes" what it reviews corrupts the very
/// diff the gate then approves. `Bash` stays allowed (reviewers must run
/// builds/tests), so this is a guardrail, not a sandbox; the git writes are
/// denied separately ([`review_disallowed_tools`]).
pub const REVIEW_DISALLOWED_TOOLS: &str = "Write,Edit,MultiEdit,NotebookEdit";

/// Everything a read-only (review-kind worktree) Claude stage is denied:
/// [`REVIEW_DISALLOWED_TOOLS`] plus one `Bash(git <sub>:*)` rule per
/// [`GIT_WRITE_SUBCOMMANDS`](crate::orchestrator::read_only::GIT_WRITE_SUBCOMMANDS)
/// (#847: a Reproduce and a Verify stage each applied the change and
/// committed it), except `stash`, which gets
/// [`CLI_STASH_DENY_RULES`](crate::orchestrator::read_only::CLI_STASH_DENY_RULES)
/// so `git stash list`/`show` stay allowed. Deny rules hold under `bypassPermissions`. A command that
/// hides git behind `sh -c` or a script still gets through — the commit
/// notice is the backstop. Pure.
pub fn review_disallowed_tools() -> String {
    let mut s = String::from(REVIEW_DISALLOWED_TOOLS);
    for sub in crate::orchestrator::read_only::GIT_WRITE_SUBCOMMANDS {
        // Prefix rules: `Bash(git stash:*)` would deny `stash list`/`show`
        // too, so stash's write forms are listed one by one.
        if *sub == "stash" {
            for rule in crate::orchestrator::read_only::CLI_STASH_DENY_RULES {
                s.push(',');
                s.push_str(rule);
            }
            continue;
        }
        s.push_str(&format!(",Bash(git {sub}:*)"));
    }
    s
}

/// Claude Code's interactive question tool, denied to EVERY Claude CLI stage.
/// A headless `claude -p` stage has nobody to answer it (since 2.1.321 the CLI
/// refuses it there and the model guesses). With the tool gone, a question can
/// only come out in the final message, where [`detect_trailing_question`]
/// parks it for the director.
pub const ASK_USER_QUESTION_TOOL: &str = "AskUserQuestion";

/// The one `--disallowedTools` value for a Claude CLI stage: the question
/// tool, plus the review denial on a read-only stage.
pub fn cli_disallowed_tools(read_only: bool) -> String {
    if read_only {
        format!("{ASK_USER_QUESTION_TOOL},{}", review_disallowed_tools())
    } else {
        ASK_USER_QUESTION_TOOL.to_string()
    }
}

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

/// [`CLAUDE_STAGE_SETTINGS`] plus the read guard, for a Claude stage in a
/// mission whose own `exec_isolation` is `sandbox`: Read/Grep/Glob refuse
/// paths outside the working directories too, so an agent can't pull
/// `~/.ssh`, `~/.aws` or a sibling repo into its context. Claude Code also
/// asks before a Bash command it sees reading outside them, which a headless
/// stage refuses; reads it can't see still go through (the Seatbelt profile
/// only denies writes). The stage's build-cache root and its own temp dir
/// (`TMPDIR`, see `sandbox::prepare_with`) are added as working dirs
/// (`--add-dir`, [`sandbox_read_dir_args`]), so it can still read what it
/// writes there. The user-wide `$TMPDIR` is not: every app and stage writes
/// there, and Claude Code loads `.claude/skills`, agents and commands from an
/// `--add-dir` dir, so it would let anything plant skills into the stage.
/// Every other mission keeps the write guard only — a `readonly`
/// (review/probe) mission with `exec_isolation = "none"` too, though its
/// sandbox is forced on: its agents read dependency sources outside the
/// worktree.
pub const CLAUDE_SANDBOXED_STAGE_SETTINGS: &str =
    r#"{"permissions":{"blockWritesOutsideWorkingDirectories":true,"blockReadsOutsideWorkingDirectories":true}}"#;

/// The oldest Claude Code that honours `blockReadsOutsideWorkingDirectories`;
/// older CLIs ignore the key.
pub const CLAUDE_READ_GUARD_FLOOR: &str = "2.1.257";

/// When the mission's own `exec_choice` is `sandbox` (not the effective tier a
/// `readonly` mission forces on), swap a Claude stage's `--settings` value
/// (fresh or resumed argv) for [`CLAUDE_SANDBOXED_STAGE_SETTINGS`]. Returns
/// whether it did; Codex stages and other missions are left as they are. Pure.
pub fn confine_reads_in_sandbox(dialect: CliDialect, exec_choice: &str, args: &mut [String]) -> bool {
    if dialect != CliDialect::Claude || exec_choice != "sandbox" {
        return false;
    }
    match args.iter().position(|a| a == "--settings") {
        Some(i) if i + 1 < args.len() => {
            args[i + 1] = CLAUDE_SANDBOXED_STAGE_SETTINGS.to_string();
            true
        }
        _ => false,
    }
}

/// The [`CacheTenant`](crate::orchestrator::sandbox::CacheTenant) a sandboxed
/// CLI stage's cache root and temp dir are keyed by: the mission's own exec
/// choice and whether the stage is read-confined (the `bool`
/// [`confine_reads_in_sandbox`] returned). Pure.
pub fn cli_cache_tenant(exec_choice: &str, reads_confined: bool) -> crate::orchestrator::sandbox::CacheTenant<'_> {
    crate::orchestrator::sandbox::CacheTenant::Cli { exec_choice, reads_confined }
}

/// `--add-dir` flags for a read-confined Claude stage (`reads_confined`, see
/// [`confine_reads_in_sandbox`]): its build-cache root and own temp dir
/// (`dirs`, from `sandbox::prepare_with`), which `sandbox_cache_env` /
/// `TMPDIR` point npm, cargo & co. at. Both are keyed by workspace, write
/// roots, exec choice and read guard ([`cli_cache_tenant`]), which no
/// sandboxed launch of another kind can write: of those, only read-confined
/// Claude stages of the same workspace, access mode and exec choice can —
/// no Codex stage, no exec-`none` readonly stage, no TALK or API-substrate
/// `run_command`, and no Codex writer in Codex's own sandbox. That matters
/// most for a readonly mission, whose stages can't write the worktree: these
/// dirs would otherwise be the one place another sandboxed launch could plant `.claude/skills`, agents or commands
/// that Claude Code loads from an `--add-dir` dir. Without them the read
/// guard would refuse the stage's own temp files and redirected caches. One
/// flag per dir, blanks and repeats (trailing `/` ignored) dropped; nothing
/// when reads aren't confined. Pure.
pub fn sandbox_read_dir_args(reads_confined: bool, dirs: &[String]) -> Vec<String> {
    let mut seen: Vec<&str> = Vec::new();
    let mut out = Vec::new();
    if !reads_confined {
        return out;
    }
    for d in dirs {
        let t = d.trim();
        let t = if t.len() > 1 { t.trim_end_matches('/') } else { t };
        if t.is_empty() || seen.contains(&t) {
            continue;
        }
        seen.push(t);
        out.push("--add-dir".to_string());
        out.push(t.to_string());
    }
    out
}

/// The launch line's note when the read guard was asked for but the known
/// CLI is too old to honour it; `None` otherwise (an unknown version never
/// warns). Pure.
pub fn read_guard_label(reads_confined: bool, cli_version: Option<&str>) -> Option<String> {
    let v = cli_version.filter(|_| reads_confined)?;
    crate::agent_adapter::version_below(v, CLAUDE_READ_GUARD_FLOOR)
        .then(|| format!("file reads not confined (Claude Code {CLAUDE_READ_GUARD_FLOOR}+ needed)"))
}

/// Build the argv (after the program name) for a headless `claude -p` run.
/// The user prompt is supplied via stdin, not as an arg. We stream NDJSON
/// (`stream-json` requires `--verbose`) so the stage emits live progress and a
/// chatty/debug stdout can't break result parsing — each line is parsed
/// independently and non-JSON log lines are simply skipped. Every stage
/// carries [`CLAUDE_STAGE_SETTINGS`] and denies [`ASK_USER_QUESTION_TOOL`];
/// `read_only` adds the review-stage tool denial (see [`cli_disallowed_tools`]).
pub fn build_cli_args(model: &str, system_prompt: &str, max_turns: i64, read_only: bool) -> Vec<String> {
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
        "--settings".to_string(),
        CLAUDE_STAGE_SETTINGS.to_string(),
        "--disallowedTools".to_string(),
        cli_disallowed_tools(read_only),
    ]
}

/// Argv for resuming an existing headless session: continue the same
/// conversation (`--resume <id>`) with a fresh turn budget. The continuation
/// nudge is supplied via stdin by the caller.
pub fn build_cli_args_resume(model: &str, session_id: &str, max_turns: i64, read_only: bool) -> Vec<String> {
    vec![
        "-p".to_string(),
        "--output-format".to_string(), "stream-json".to_string(),
        "--verbose".to_string(),
        "--model".to_string(), model.to_string(),
        "--resume".to_string(), session_id.to_string(),
        "--permission-mode".to_string(), "bypassPermissions".to_string(),
        "--max-turns".to_string(), max_turns.max(1).to_string(),
        // The resume path needs the guard too (2.1.314 fixed it for --resume).
        "--settings".to_string(), CLAUDE_STAGE_SETTINGS.to_string(),
        "--disallowedTools".to_string(), cli_disallowed_tools(read_only),
    ]
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

/// What confines a Codex stage's own commands (Claude stages ignore this).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum CodexWriteScope {
    /// Codex's own `workspace-write` sandbox with the network on: the
    /// worktree, Codex's temp dirs and the stage's own build-cache root
    /// ([`codex_writable_root_args`]). Codex keeps `<worktree>/.git` and the
    /// gitdir it resolves to read-only, and a linked worktree's objects and
    /// refs live in the common dir outside the worktree, so `git add`,
    /// `commit`, `stash`, `fetch` and `checkout -b` fail in every such stage.
    /// The git dirs are left out on purpose: Codex's writable roots can't deny
    /// a path inside a root, so granting `<common>/worktrees/<name>` would hand
    /// over its `commondir` and `config.worktree`, which repoint git at
    /// planted config and hooks. The worktree's own `.git` entry is also
    /// checked after the stage ([`guards_git_entry`]).
    Workspace,
    /// The mission runs sandboxed: Octopush's Seatbelt profile confines a
    /// writer, which bypasses Codex's own sandbox and has its own
    /// `CODEX_HOME` (`sandbox::prepare_codex_home`). Codex's sandbox can't
    /// run inside the profile: a nested `sandbox-exec` fails with
    /// `sandbox_apply: Operation not permitted` (pinned by
    /// `sandbox::tests::seatbelt_refuses_a_nested_sandbox`), so every command
    /// of a `--sandbox read-only` stage would fail. A read-only stage is
    /// refused here for now ([`codex_read_only_refusal`]).
    MissionSandbox,
}

/// The scope a Codex stage gets for the mission's `exec_isolation`:
/// Octopush's Seatbelt profile under `sandbox`, else Codex's own sandbox. Pure.
pub fn codex_write_scope(exec_isolation: &str) -> CodexWriteScope {
    if exec_isolation == "sandbox" {
        CodexWriteScope::MissionSandbox
    } else {
        CodexWriteScope::Workspace
    }
}

/// The stage failure, and the launcher's warning, for a read-only Codex
/// stage in a sandboxed mission (a readonly mission included).
pub const CODEX_READ_ONLY_SANDBOX_REFUSAL: &str =
    "A read-only Codex stage can't run in a sandboxed mission yet. Give this stage a Claude model.";

/// Why this stage is refused before anything is set up: a read-only Codex
/// stage in a sandboxed mission, where Codex's own `read-only` sandbox can't
/// nest inside Octopush's profile ([`CodexWriteScope::MissionSandbox`]).
/// Mirrors `lib/claudeCli.ts::codexReadOnlySandboxNote`. Pure.
pub fn codex_read_only_refusal(dialect: CliDialect, read_only: bool, scope: CodexWriteScope) -> Option<&'static str> {
    (dialect == CliDialect::Codex && read_only && scope == CodexWriteScope::MissionSandbox)
        .then_some(CODEX_READ_ONLY_SANDBOX_REFUSAL)
}

/// The `-c` override that adds `root` (the stage's build-cache root,
/// `sandbox::codex_build_cache`) to Codex's `workspace-write` writable roots.
/// The value is a TOML array; a JSON string array is one. Pure.
pub fn codex_writable_root_args(root: &str) -> Vec<String> {
    let list = serde_json::to_string(&[root]).unwrap_or_else(|_| "[]".to_string());
    vec!["-c".to_string(), format!("sandbox_workspace_write.writable_roots={list}")]
}

/// Whether the runner checks the worktree's `.git` entry around this stage
/// (`sandbox::GitEntry`): only for a Codex writer in Codex's own sandbox.
/// Codex already keeps `<worktree>/.git` and the gitdir it points to
/// read-only; the check is a second guard, so a changed pointer never
/// reaches the git commands Octopush runs after the stage. Pure.
pub fn guards_git_entry(dialect: CliDialect, read_only: bool, exec_isolation: &str) -> bool {
    dialect == CliDialect::Codex && !read_only && codex_write_scope(exec_isolation) == CodexWriteScope::Workspace
}

/// The journal notice for an Action role (one that may commit and push) on a
/// Codex writer in Codex's own sandbox, where git can't write `.git`. Pure.
pub fn codex_git_notice(
    dialect: CliDialect,
    read_only: bool,
    scope: CodexWriteScope,
    environment: crate::orchestrator::types::RoleEnvironment,
) -> Option<&'static str> {
    let action = environment == crate::orchestrator::types::RoleEnvironment::Action;
    (dialect == CliDialect::Codex && !read_only && scope == CodexWriteScope::Workspace && action).then_some(
        "Codex's sandbox keeps .git read-only, so this stage can't commit, stash or push. \
         Give this stage a Claude model.",
    )
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

/// The levels Codex lists for `model`, or `None` for a model missing from its
/// catalog. An empty list = a non-reasoning model. Matched the way Codex finds
/// a model's info: case-insensitively, the longest catalog slug that prefixes
/// the id (so `gpt-5.5-2026-03-01` gets `gpt-5.5`'s levels), then once more
/// with one leading `namespace/` stripped (`openai/gpt-5.5`).
pub fn codex_effort_levels(model: &str) -> Option<&'static [String]> {
    let id = model.trim().to_ascii_lowercase();
    let longest_prefix = |id: &str| {
        codex_effort_table()
            .iter()
            .filter(|(slug, _)| id.starts_with(slug.as_str()))
            .max_by_key(|(slug, _)| slug.len())
            .map(|(_, levels)| levels.as_slice())
    };
    longest_prefix(&id).or_else(|| longest_prefix(id.split_once('/')?.1))
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
    /// tools; Codex runs in its own `read-only` sandbox (a read-only Codex
    /// stage in a sandboxed mission is refused before it gets here,
    /// [`codex_read_only_refusal`]). A Codex writer runs in its
    /// `workspace-write` sandbox, or bypasses it inside a sandboxed mission
    /// (see [`CodexWriteScope`]); either way it never stops for approval,
    /// which would hang a headless stage. The writer's settings are `-c`
    /// config overrides, the mechanism the effort already uses, not flags
    /// `codex exec` may not take: approval `never` and network on (Octopush's
    /// Seatbelt profile confines writes only, too). The runner adds the
    /// build-cache root to the writable roots ([`codex_writable_root_args`]).
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

    /// The launch line's version label: `codex 0.169.0` on Codex when its
    /// version is known; `None` otherwise (Claude Code's version shows in
    /// its own notices).
    pub fn version_label(&self, codex_version: Option<&str>) -> Option<String> {
        match self {
            CliDialect::Codex => codex_version.map(|v| format!("codex {v}")),
            CliDialect::Claude => None,
        }
    }

    /// Resume argv, for dialects with a confirmed session-continuation
    /// contract. `None` ⇒ the runner falls back to a fresh run (worktree
    /// preserved, feedback in the prompt) — the already-graceful path.
    ///
    /// Codex: `codex exec <the fresh run's flags> resume <session_id> -`,
    /// pinned by the recorded `codex exec resume --help`
    /// (`tests/fixtures/codex/<version>/`). `resume` takes `SESSION_ID`,
    /// `PROMPT` (`-` = stdin), `-c`, `-m`, `--json` and
    /// `--skip-git-repo-check`, but not `-s/--sandbox`, so every flag of the
    /// fresh argv stays in front of the subcommand, where `codex exec` reads
    /// them. A resumed thread takes this invocation's sandbox, approval policy
    /// and model (openai/codex `exec/src/lib.rs`
    /// `thread_resume_params_from_config`), so a read-only review stays
    /// read-only and a writer keeps its `workspace-write` settings. The
    /// effort and writable-root `-c` overrides go in before the trailing `-`
    /// ([`CliDialect::push_flags`]), which `resume` accepts too.
    pub fn resume_argv(
        &self,
        model: &str,
        session_id: &str,
        max_turns: i64,
        read_only: bool,
        scope: CodexWriteScope,
    ) -> Option<Vec<String>> {
        match self {
            CliDialect::Claude => Some(build_cli_args_resume(model, session_id, max_turns, read_only)),
            CliDialect::Codex => {
                let mut a = self.argv(model, "", max_turns, read_only, scope);
                // The fresh argv ends with `-` (prompt on stdin); the resumed
                // one ends `resume <id> -`.
                if a.last().is_some_and(|x| x == "-") {
                    a.pop();
                }
                a.extend(["resume".to_string(), session_id.to_string(), "-".to_string()]);
                Some(a)
            }
        }
    }

    /// The prompt a resumed session gets. Claude: the director's answers (or
    /// a plain continue) with a fresh turn budget. Codex has no turn budget,
    /// and its resume also carries a reviewer's loop-back findings, so its
    /// nudge names the feedback as being about the session's own earlier work.
    pub fn resume_prompt(&self, feedback: Option<&str>) -> String {
        let fb = feedback.filter(|f| !f.trim().is_empty());
        match (self, fb) {
            (CliDialect::Claude, Some(fb)) => format!(
                "{fb}\n\nContinue the task from where you left off with these decisions. \
                 You have a fresh turn budget; finish the remaining work, then stop."
            ),
            (CliDialect::Claude, None) => "Continue the task from where you left off. You have a fresh turn budget; \
                     finish the remaining work, then stop."
                .to_string(),
            // Answered questions (an answered block's feedback, see
            // `format_blocker_feedback`) are decisions, not a critique of
            // the earlier work: they get their own wording.
            (CliDialect::Codex, Some(fb)) => match fb.strip_prefix(crate::orchestrator::BLOCKER_FEEDBACK_HEADER) {
                Some(answers) => format!(
                    "Your director answered your questions:\n{}\n\nProceed with these decisions and do not ask again \
                     unless a new blocking ambiguity arises. Pick up from where you left off, finish the remaining \
                     work, then end with your final message as before.",
                    answers.trim_end()
                ),
                None => format!(
                    "A reviewer sent your earlier work in this session back with these findings:\n\n{fb}\n\n\
                     Pick up from where you left off, act on the findings, then end with your final message as before."
                ),
            },
            (CliDialect::Codex, None) => "Continue the task from where you left off: finish the remaining work, \
                     then end with your final message as before."
                .to_string(),
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
    /// older CLI ignores the unknown variable. Skills stay as the stage found
    /// them (`CLAUDE_CODE_PLUGIN_DIR_WATCH=0`): 2.1.321 "changed headless
    /// sessions to reload mods in `.claude/skills` when their files change",
    /// so a stage that writes (or is tricked into planting) a skill in the
    /// worktree it edits would change its own instructions mid-stage, and a
    /// reviewer would certify work done under other rules than it started
    /// with; an older CLI ignores this one too. Subagent progress summaries
    /// are off (`CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES=1`): 2.1.323
    /// "Added `CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES` (available since
    /// 2.1.318): set it to `1` to turn off subagent progress summaries and the
    /// requests that write them". Those requests are billed, and a stage reads
    /// none of them: the journal leaves `task_summary`-style system events
    /// out, and the pane shows tool calls and the result. An older CLI ignores
    /// the unknown variable. All are set on fresh and `--resume` runs alike,
    /// over any inherited value; Run-mode terminals never get them —
    /// backgrounding, skill reloads and progress summaries are theirs to keep,
    /// since a human is directing there.
    pub fn stage_env(&self) -> Vec<(&'static str, String)> {
        match self {
            CliDialect::Claude => vec![
                ("CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS", BG_WAIT_CEILING_MS.to_string()),
                ("CLAUDE_CODE_DISABLE_FAST_MODE", "1".to_string()),
                ("CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND", "1".to_string()),
                ("CLAUDE_CODE_PLUGIN_DIR_WATCH", "0".to_string()),
                ("CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES", "1".to_string()),
            ],
            CliDialect::Codex => Vec::new(),
        }
    }

    /// Settings › Privacy › "Quiet Claude Code in crews and Routines" (#703).
    /// With it on, a Claude Code stage gets
    /// `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. Claude Code's env-var
    /// reference: "Set to any non-empty value, such as `1`, to disable
    /// nonessential network traffic: auto-updates, telemetry, error
    /// reporting, … release notes, … and availability checks such as the fast
    /// mode check. … Also disables feature-flag fetching, which makes Remote
    /// Control and the other features that need feature-flag fetching
    /// unavailable." **Off ⇒ nothing is set or removed**: the docs say even
    /// `0` still disables the traffic, so an off toggle never writes a value,
    /// and a user's own export is left as they set it. Like [`Self::stage_env`]
    /// it takes no resume flag — fresh and `--resume` runs, in-process or in
    /// the detached worker, get the same. Codex has no equivalent; Run-mode
    /// terminals and Talk never get it.
    pub fn stage_quiet_env(&self, quiet: bool) -> Vec<(&'static str, String)> {
        match self {
            CliDialect::Claude if quiet => vec![(QUIET_TRAFFIC_ENV, "1".to_string())],
            _ => Vec::new(),
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
                "This stage's {} effort is not passed to Codex: {model} {}, so it runs at Codex's default effort.",
                e.as_str(),
                if codex_effort_levels(model).is_some() {
                    "lists no reasoning levels in Codex's model catalog"
                } else {
                    "isn't in Octopush's copy of Codex's model catalog"
                }
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
        self.push_flags(args, self.effort_args(model, effort));
    }

    /// Append `flags` to the argv, before Codex's trailing `-` (the prompt on
    /// stdin) so they stay flags.
    pub fn push_flags(&self, args: &mut Vec<String>, flags: Vec<String>) {
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
    /// A `turn.started` with no `turn.completed` after it: Codex reports a
    /// turn's usage only on `turn.completed`, so this turn's tokens are unknown.
    pub turn_open: bool,
    /// The model did work: a `turn.started`, an `item.*` event, or a legacy
    /// agent `msg` (the legacy schema has no `turn.started`). A failure before
    /// any of these (a bad flag, no login at launch, an `error` before
    /// `turn.started`) provably spent nothing. A turn that started and then
    /// failed (a 401 or an unknown model) is flagged: the stream can't show
    /// whether it spent anything.
    pub activity: bool,
}

impl CodexAccum {
    /// True when the stage's spend can't be known from the stream: the last
    /// turn never completed, or the model did work and no usage event arrived.
    /// A stage that failed before any turn or model activity is not flagged.
    pub fn usage_unreported(&self, reported: &CliUsage) -> bool {
        self.turn_open || (self.activity && *reported == CliUsage::default())
    }
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
            "turn.started" => {
                accum.turn_open = true;
                accum.activity = true;
            }
            "turn.completed" => accum.turn_open = false,
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
                accum.activity = true;
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
        let mtype = msg.get("type").and_then(Value::as_str).unwrap_or("");
        if !matches!(mtype, "" | "session_configured" | "error") {
            accum.activity = true;
        }
        match mtype {
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
            model: None,
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
        if accum.usage_unreported(&usage) {
            error.push_str(&format!("\n{USAGE_UNREPORTED}"));
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
                cli: Default::default(),
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
            let mut error = format!(
                "codex produced no final message: {}",
                failure_detail(stderr_text, "the stream ended without an assistant message")
            );
            if accum.usage_unreported(&usage) {
                error.push_str(&format!("\n{USAGE_UNREPORTED}"));
            }
            let mut out = failed_stage(&error);
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

/// A tool call a Claude stream started and hasn't reported a result for yet.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct OpenTool {
    pub id: String,
    pub name: String,
    /// A Bash/PowerShell call's command: its first line, shortened.
    pub command: Option<String>,
}

impl OpenTool {
    /// A foreground command Claude Code may wait on for up to `BASH_MAX_TIMEOUT_MS`.
    fn is_command(&self) -> bool {
        matches!(self.name.as_str(), "Bash" | "PowerShell")
    }

    /// `Bash `npm test`` for a command, the bare tool name otherwise.
    pub(crate) fn label(&self) -> String {
        match &self.command {
            Some(c) => format!("{} `{c}`", self.name),
            None => self.name.clone(),
        }
    }
}

/// The tool calls still open in a Claude stream: each `tool_use` block of an
/// `assistant` event opens one, the `tool_result` with its id in a `user`
/// event closes it. A result for an id that never opened changes nothing.
#[derive(Debug, Default)]
pub(crate) struct OpenTools(Vec<OpenTool>);

impl OpenTools {
    pub(crate) fn observe(&mut self, v: &Value) {
        let kind = v.get("type").and_then(Value::as_str);
        let Some(blocks) = v.pointer("/message/content").and_then(Value::as_array) else {
            return;
        };
        for b in blocks {
            match (kind, b.get("type").and_then(Value::as_str)) {
                (Some("assistant"), Some("tool_use")) => {
                    let Some(id) = b.get("id").and_then(Value::as_str) else { continue };
                    if self.0.iter().any(|t| t.id == id) {
                        continue;
                    }
                    let name = b.get("name").and_then(Value::as_str).unwrap_or("a tool").to_string();
                    let mut tool = OpenTool { id: id.to_string(), name, command: None };
                    if tool.is_command() {
                        tool.command = b.pointer("/input/command").and_then(Value::as_str).map(short_command);
                    }
                    self.0.push(tool);
                }
                (Some("user"), Some("tool_result")) => {
                    if let Some(id) = b.get("tool_use_id").and_then(Value::as_str) {
                        self.0.retain(|t| t.id != id);
                    }
                }
                _ => {}
            }
        }
    }

    /// True while a Bash/PowerShell call is open.
    pub(crate) fn command_open(&self) -> bool {
        self.0.iter().any(OpenTool::is_command)
    }

    /// The call a stall is blamed on: the latest open command, else the latest open tool.
    pub(crate) fn latest(&self) -> Option<&OpenTool> {
        self.0.iter().rev().find(|t| t.is_command()).or_else(|| self.0.last())
    }
}

/// A command's first non-empty line, at most 60 characters.
fn short_command(cmd: &str) -> String {
    let line = cmd.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let multi = cmd.trim().lines().count() > 1;
    if line.chars().count() > 60 {
        format!("{}…", line.chars().take(59).collect::<String>())
    } else if multi {
        format!("{line} …")
    } else {
        line.to_string()
    }
}

/// How long a Claude stage may stay silent while a Bash/PowerShell call is
/// open: the CLI's own command ceiling (`BASH_MAX_TIMEOUT_MS` from the stage
/// env, default 10 minutes; never below the plain idle window) plus a minute
/// for the result. An unreadable value counts as unset.
pub(crate) fn command_idle_window(bash_max_timeout_ms: Option<&str>) -> std::time::Duration {
    let ms = bash_max_timeout_ms
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|ms| *ms > 0)
        .unwrap_or(BASH_MAX_TIMEOUT_DEFAULT_MS);
    std::time::Duration::from_millis(ms).max(std::time::Duration::from_secs(IDLE_TIMEOUT_SECS))
        + std::time::Duration::from_secs(COMMAND_RESULT_SLACK_SECS)
}

/// The env a sandboxed stage gets on top of the login shell's: the
/// prepared cache and temp-dir env and, for a Claude stage only,
/// `sandbox::claude_stage_env` (auto memory off, since the profile denies
/// it). An unsandboxed stage never goes through here. Pure.
pub(crate) fn sandboxed_stage_env(dialect: CliDialect, prepared: Vec<(String, String)>) -> Vec<(String, String)> {
    let mut env = prepared;
    if dialect == CliDialect::Claude {
        env.extend(crate::orchestrator::sandbox::claude_stage_env());
    }
    env
}

/// Prepare a sandboxed Codex stage's own `CODEX_HOME`
/// (`sandbox::prepare_codex_home`), off the async runtime: the user's Codex
/// home is `CODEX_HOME` as the stage would see it (login shell, then the
/// app's env), else `~/.codex`, and `CODEX_API_KEY` counts when the stage
/// would inherit it. The error is the stage's failure message
/// ([`codex_home_failure`]).
async fn prepare_codex_stage_home(
    scope: &str,
    write_roots: &[String],
    exec_choice: &str,
    reads_confined: bool,
) -> Result<crate::orchestrator::sandbox::CodexHome, String> {
    use crate::orchestrator::sandbox::{prepare_codex_home, CodexHomeError};
    let (scope, roots, choice) = (scope.to_string(), write_roots.to_vec(), exec_choice.to_string());
    let joined = tokio::task::spawn_blocking(move || {
        let user_home = crate::codex_trust::codex_home()
            .ok_or_else(|| CodexHomeError::Setup("no home directory to find your Codex config in".into()))?;
        let env_key = stage_env_value("CODEX_API_KEY").is_some_and(|v| !v.trim().is_empty());
        prepare_codex_home(&scope, &roots, cli_cache_tenant(&choice, reads_confined), &user_home, env_key)
    })
    .await;
    match joined {
        Ok(Ok(home)) => Ok(home),
        Ok(Err(e)) => Err(codex_home_failure(&e)),
        Err(e) => Err(codex_home_failure(&CodexHomeError::Setup(e.to_string()))),
    }
}

/// The stage failure for a Codex home that couldn't be prepared: the
/// sign-in preflight's own message (e.g. "Open Codex once to refresh
/// sign-in"), or the sandbox's fail-closed line. Pure.
pub fn codex_home_failure(e: &crate::orchestrator::sandbox::CodexHomeError) -> String {
    use crate::orchestrator::sandbox::CodexHomeError;
    match e {
        CodexHomeError::SignIn(msg) => (*msg).to_string(),
        CodexHomeError::Setup(why) => {
            format!("Sandbox setup failed — refusing to run the stage without the requested isolation: {why}")
        }
    }
}

/// The variable "Quiet Claude Code in crews and Routines" sets (#703). Shared
/// with the Routines runner, which exports it to a Routine's own commands.
pub const QUIET_TRAFFIC_ENV: &str = "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC";

/// Claude Code's knob for a model's context window. 2.1.325: "Changed
/// `CLAUDE_CODE_MAX_CONTEXT_TOKENS` to also set the context window of
/// unrecognized model IDs that start with `claude-`, such as a gateway's
/// `claude-sonnet-latest`".
pub const MAX_CONTEXT_TOKENS_ENV: &str = "CLAUDE_CODE_MAX_CONTEXT_TOKENS";
/// Claude Code's switch back to a 200K window. 2.1.323: "Changed the context
/// window assumed for a model ID that Claude Code doesn't recognize from 200K
/// to 1M; use `/autocompact` to compact earlier, or
/// `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` to keep 200K".
pub const DISABLE_1M_CONTEXT_ENV: &str = "CLAUDE_CODE_DISABLE_1M_CONTEXT";
/// The window Claude Code (2.1.323+) assumes for a model id it doesn't know.
const UNRECOGNIZED_MODEL_CONTEXT: u64 = 1_000_000;
/// The window [`DISABLE_1M_CONTEXT_ENV`] keeps.
const KEPT_CONTEXT_WITHOUT_1M: u64 = 200_000;
/// The first Claude Code that applies [`MAX_CONTEXT_TOKENS_ENV`] to an
/// unrecognized id starting with `claude-` (2.1.325). That entry says the
/// variable "also" covers those ids, so ids that don't start with `claude-`
/// already honoured it before 2.1.325.
pub const CLAUDE_PREFIXED_MAX_CONTEXT_FLOOR: &str = "2.1.325";

/// The context-window variables a Claude stage on `model` gets, so Claude
/// Code compacts before a smaller gateway window fills instead of assuming
/// 1M. 2.1.323: "sessions on other vendors' models with a smaller window:
/// once full, they can fail every turn until `/clear`, so set
/// `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` before they fill" — and a headless
/// stage can't `/clear`. Pure:
/// - a built-in Anthropic catalog id (`builtin`, decided on the normalized
///   id, [`is_builtin_claude_model`]), or a model whose window is unknown
///   (`max_context` `None`/0) or at least 1M, gets nothing;
/// - any other model gets [`MAX_CONTEXT_TOKENS_ENV`] set to its window.
///   [`DISABLE_1M_CONTEXT_ENV`] is never used for an id that doesn't start
///   with `claude-`: it is process-wide, so it would also cap a subagent on
///   a builtin 1M model, and such ids honour the max-tokens variable anyway;
/// - an id starting with `claude-` on a Claude Code below
///   [`CLAUDE_PREFIXED_MAX_CONTEXT_FLOOR`] (or an unknown version,
///   `cli_version` `None`) ignores that variable, so at a window ≤ 200K it
///   also gets [`DISABLE_1M_CONTEXT_ENV`]`=1`, which keeps 200K. A window
///   below 200K can't be expressed there (2.1.323–324);
/// - a variable `user_set` reports (the user's own export) is never
///   overridden.
pub(crate) fn context_window_env(
    model: &str,
    builtin: bool,
    max_context: Option<u64>,
    cli_version: Option<&str>,
    user_set: impl Fn(&str) -> bool,
) -> Vec<(&'static str, String)> {
    let Some(window) = max_context.filter(|w| *w > 0 && *w < UNRECOGNIZED_MODEL_CONTEXT) else {
        return Vec::new();
    };
    if builtin {
        return Vec::new();
    }
    let mut picks = vec![(MAX_CONTEXT_TOKENS_ENV, window.to_string())];
    let claude_prefixed = model.trim().to_ascii_lowercase().starts_with("claude-");
    let old_cli = cli_version.is_none_or(|v| crate::agent_adapter::version_below(v, CLAUDE_PREFIXED_MAX_CONTEXT_FLOOR));
    if claude_prefixed && old_cli && window <= KEPT_CONTEXT_WITHOUT_1M {
        picks.push((DISABLE_1M_CONTEXT_ENV, "1".to_string()));
    }
    picks.into_iter().filter(|(k, _)| !user_set(k)).collect()
}

/// Whether Claude Code knows `model` and its window: its normalized id
/// ([`crate::token_engine::normalize_model_id`], so `bedrock/claude-haiku-4-5`
/// and `us.anthropic.claude-sonnet-5-v1:0` count) is a builtin Anthropic
/// catalog id.
pub(crate) fn is_builtin_claude_model(model: &str) -> bool {
    let id = crate::token_engine::normalize_model_id(model);
    crate::provider_router::builtin_providers()
        .get("anthropic")
        .is_some_and(|p| p.models.iter().any(|m| m.id == id))
}

/// [`context_window_env`] for a stage's model: built-in per
/// [`is_builtin_claude_model`]; the window comes from the provider catalog,
/// the user's custom model entries included (`ProviderRouter::find_model`);
/// `cli_version` is the version the stage probed before spawning
/// (`run_attempt`'s preflight; `None` when unknown); a user's export is read the way the CLI process will see it
/// ([`stage_env_value`]). Codex: nothing.
fn stage_context_env(dialect: CliDialect, model: &str, cli_version: Option<&str>) -> Vec<(&'static str, String)> {
    if dialect != CliDialect::Claude || is_builtin_claude_model(model) {
        return Vec::new();
    }
    let max_context = crate::provider_router::ProviderRouter::load()
        .ok()
        .and_then(|r| r.find_model(model).map(|(_, m)| m.max_context));
    context_window_env(model, false, max_context, cli_version, |k| stage_env_value(k).is_some())
}

/// The stage's own environment, applied to its CLI process after the
/// login-shell and sandbox variables: the dialect's pins
/// ([`CliDialect::stage_env`]), the inherited effort override dropped
/// ([`CliDialect::stage_env_remove`]), the subagent effort
/// ([`CliDialect::stage_effort_env`]), the quiet-traffic opt-in
/// ([`CliDialect::stage_quiet_env`]) and a gateway model's context window
/// ([`stage_context_env`]). The ONE place a stage's env is set — fresh and
/// `--resume` runs, in-process and detached, all spawn through it.
pub(crate) fn apply_stage_env(
    command: &mut tokio::process::Command,
    dialect: CliDialect,
    model: &str,
    effort: Option<crate::providers::Effort>,
    quiet: bool,
    cli_version: Option<&str>,
) {
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
    for (k, v) in dialect.stage_quiet_env(quiet) {
        command.env(k, v);
    }
    for (k, v) in stage_context_env(dialect, model, cli_version) {
        command.env(k, v);
    }
}

/// A variable as the stage's CLI process sees it: the login-shell env, which
/// the spawn sets over the app's own, else the app's.
fn stage_env_value(key: &str) -> Option<String> {
    login_shell_env()
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.clone())
        .or_else(|| std::env::var(key).ok())
}

/// Whole minutes, rounded up: `5 minutes`, `11 minutes`, `1 minute`.
fn minutes(d: std::time::Duration) -> u64 {
    d.as_secs().div_ceil(60).max(1)
}

/// What an idle stall found: the tool call still open when it tripped (if
/// any), the silence it waited, and — when the last line was a Claude
/// `system/api_retry` — that retry's cause ("" when it named none).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct IdleStall {
    pub tool: Option<OpenTool>,
    pub window: std::time::Duration,
    pub after_retry: Option<String>,
}

/// The longest retry delay [`retry_idle_window`] waits out: 300s, the
/// ceiling Claude Code 2.1.323 set for `CLAUDE_CODE_OVERLOADED_RETRY_MAX_DELAY_MS`
/// (529 overload backoff). A 429 `Retry-After` or a wait under
/// `CLAUDE_CODE_RETRY_WATCHDOG` can be longer; it is capped here too, so the
/// window after a retry stays about 10 minutes at most.
pub(crate) const MAX_RETRY_DELAY: std::time::Duration = std::time::Duration::from_secs(300);

/// How long a Claude stage may stay silent after a `system/api_retry` that
/// says it waits `retry_delay` before the next attempt: that delay (capped at
/// [`MAX_RETRY_DELAY`]) plus the plain window for the attempt itself, never
/// below `idle`.
pub(crate) fn retry_idle_window(idle: std::time::Duration, retry_delay: std::time::Duration) -> std::time::Duration {
    retry_delay.min(MAX_RETRY_DELAY).saturating_add(idle).max(idle)
}

/// The stage error for an idle stall, after the CLI's name: "timed out — no
/// output for 5 minutes", naming the open call ("timed out — Bash `npm
/// test` gave no result for 11 minutes"), or the API retry it was waiting
/// out ("timed out — no output for 10 minutes after an API retry
/// (overloaded)").
pub(crate) fn idle_timeout_message(stall: &IdleStall) -> String {
    let m = minutes(stall.window);
    let unit = if m == 1 { "minute" } else { "minutes" };
    match (&stall.tool, stall.after_retry.as_deref()) {
        (Some(t), _) => format!("timed out — {} gave no result for {m} {unit}", t.label()),
        (None, Some("")) => format!("timed out — no output for {m} {unit} after an API retry"),
        (None, Some(cause)) => format!("timed out — no output for {m} {unit} after an API retry ({cause})"),
        (None, None) => format!("timed out — no output for {m} {unit}"),
    }
}

/// The journal line when a stage stays silent past the plain idle window
/// because a command is still running.
pub(crate) fn long_command_notice(window: std::time::Duration) -> String {
    format!("waiting on a long command (up to {} min)", minutes(window))
}

/// How the stdout read loop ended — drives the post-loop handling.
#[derive(Debug)]
pub(crate) enum ReadEnd {
    Eof(Option<String>, std::collections::VecDeque<String>),
    Idle(Option<String>, std::collections::VecDeque<String>, IdleStall),
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
    /// The idle window while a Bash/PowerShell call is open (Claude only;
    /// never shorter than `idle`).
    pub command_idle: std::time::Duration,
    pub cap: std::time::Duration,
    pub settle: std::time::Duration,
}

impl ReadLimits {
    pub(crate) const STAGE: ReadLimits = ReadLimits {
        idle: std::time::Duration::from_secs(IDLE_TIMEOUT_SECS),
        command_idle: std::time::Duration::from_secs(BASH_MAX_TIMEOUT_DEFAULT_MS / 1000 + COMMAND_RESULT_SLACK_SECS),
        cap: std::time::Duration::from_secs(ABS_CAP_SECS),
        settle: std::time::Duration::from_secs(SETTLE_AFTER_RESULT_SECS),
    };

    /// [`ReadLimits::STAGE`] with the command window from the stage env's
    /// `BASH_MAX_TIMEOUT_MS` ([`command_idle_window`]).
    pub(crate) fn for_stage(bash_max_timeout_ms: Option<&str>) -> ReadLimits {
        ReadLimits { command_idle: command_idle_window(bash_max_timeout_ms), ..ReadLimits::STAGE }
    }
}

/// Read the CLI's stdout line by line until EOF, an idle stall, the absolute
/// cap, or (Claude) the settle grace after the `result` event. `on_event`
/// gets every JSON line (journal, usage, plan windows). We read RAW BYTES and
/// decode lossily — a chatty proxy can emit non-UTF-8 on stdout, and a
/// UTF-8-only line reader would abort the whole stream on the first bad byte
/// (losing the result event). Non-JSON lines (debug logs) are skipped, and a
/// bounded tail of recent lines is kept for diagnostics when no result event
/// ever arrives.
///
/// Claude: while a Bash/PowerShell call is open ([`OpenTools`]) the idle
/// window is [`ReadLimits::command_idle`] — Claude Code itself waits that
/// long on a foreground command that prints nothing to the stream. The first
/// time a stage stays silent past `idle` on that account, `on_long_wait` gets
/// the window (the journal line). After a `system/api_retry` with a numeric
/// `retry_delay_ms` the next silence may last that delay plus `idle`
/// ([`retry_idle_window`]) — the CLI is waiting out its own backoff; the
/// next line of any other kind goes back to the plain window. Codex keeps
/// the plain idle window.
pub(crate) async fn read_stream<R: tokio::io::AsyncRead + Unpin>(
    stdout: R,
    dialect: CliDialect,
    limits: ReadLimits,
    mut on_event: impl FnMut(&Value),
    mut on_long_wait: impl FnMut(std::time::Duration),
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
    let mut open = OpenTools::default();
    let mut long_wait_noted = false;
    // The last line was a Claude `system/api_retry`: its cause and the
    // silence it allows ([`retry_idle_window`]).
    let mut retry_wait: Option<(String, std::time::Duration)> = None;
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
        let command = open.command_open();
        let mut window = if command { limits.command_idle.max(limits.idle) } else { limits.idle };
        if let Some((_, w)) = &retry_wait {
            window = window.max(*w);
        }
        let mut wait = window.min(limits.cap - elapsed);
        if let Some(at) = result_at {
            wait = wait.min(limits.settle.saturating_sub(at.elapsed()));
        }
        let read = if command && wait > limits.idle {
            // Only an open command waits past `idle`: say so once when it
            // does, then wait out the rest. `raw` keeps a partial line.
            let first = tokio::time::timeout(limits.idle, reader.read_until(b'\n', &mut raw)).await;
            match first {
                Err(_) => {
                    if !long_wait_noted {
                        long_wait_noted = true;
                        on_long_wait(window);
                    }
                    tokio::time::timeout(wait - limits.idle, reader.read_until(b'\n', &mut raw)).await
                }
                done => done,
            }
        } else {
            tokio::time::timeout(wait, reader.read_until(b'\n', &mut raw)).await
        };
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
                let after_retry = retry_wait.map(|(cause, _)| cause);
                return ReadEnd::Idle(result_line, tail, IdleStall { tool: open.latest().cloned(), window, after_retry });
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
        if dialect == CliDialect::Claude {
            retry_wait = crate::orchestrator::live::api_retry_cause(&value).zip(
                crate::orchestrator::live::api_retry_delay(&value).map(|d| retry_idle_window(limits.idle, d)),
            );
            open.observe(&value);
            if is_result_event(&value) {
                result_line = Some(trimmed.to_string());
                result_at.get_or_insert_with(std::time::Instant::now);
            }
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
    crate::orchestrator::read_only::role_is_read_only(&stage.artifact_kind, stage.role_environment)
}

/// `outcome` turned into a failure with `msg`, keeping the spend it burned so
/// the run meter stays truthful. Pure.
pub fn fail_keeping_usage(outcome: StageOutcome, msg: &str) -> StageOutcome {
    StageOutcome {
        cli: Default::default(),
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
    /// One stage, with the Codex resume fallback: a Codex stage with a
    /// session to resume runs `codex exec resume` when the installed CLI has
    /// it ([`crate::agent_adapter::codex_exec_resume_supported`]) and the
    /// session's reported total is known (the cost baseline). When the resume
    /// fails before any assistant message, or Codex answers with another
    /// session, the stage runs fresh ONCE with the feedback in the prompt, and
    /// the journal says why. Both attempts' spend is kept.
    async fn run_stage(
        &self,
        stage: &StageSpec,
        input: &StageInput,
        ctx: &StageContext,
    ) -> AppResult<StageOutcome> {
        let dialect = dialect_for_model(&stage.agent_model);
        if dialect != CliDialect::Codex || stage.resume_session.is_none() {
            return self.run_attempt(stage, input, ctx, true, &mut AttemptReport::default()).await;
        }
        let emitter = crate::orchestrator::live::LiveEmitter::new(ctx.events.as_ref(), &ctx.run_id, &ctx.stage_id);
        let supported = tokio::task::spawn_blocking(crate::agent_adapter::codex_exec_resume_supported)
            .await
            .unwrap_or(false);
        if let Some(why) = codex_resume_skip_reason(supported, stage.resume_baseline.is_some()) {
            emitter.notice(&format!("Not resuming this stage's Codex session: {why}. It runs fresh, with the feedback in the prompt."));
            return self.run_attempt(stage, input, ctx, false, &mut AttemptReport::default()).await;
        }
        let mut report = AttemptReport::default();
        let resumed = self.run_attempt(stage, input, ctx, true, &mut report).await?;
        let Some(why) = report.resume_failure else {
            return Ok(resumed);
        };
        emitter.notice(&codex_resume_failure_notice(&why));
        let fresh = self.run_attempt(stage, input, ctx, false, &mut AttemptReport::default()).await?;
        Ok(merge_resume_fallback(resumed, fresh))
    }

    async fn run_attempt(
        &self,
        stage: &StageSpec,
        input: &StageInput,
        ctx: &StageContext,
        allow_resume: bool,
        report: &mut AttemptReport,
    ) -> AppResult<StageOutcome> {
        // The CLI substrate (Claude Code) owns its own tool surface, so the
        // per-stage tool allowlist does not apply here; the author's free-form
        // instructions still shape the stage via the system prompt.
        // CLI substrate has no `ask_director` tool — keep the strict never-ask
        // preamble by NOT appending the carve-out (`can_ask_director = false`).
        let mut system = crate::orchestrator::roles::compose_stage_system_prompt(&stage.role_prompt, stage.role_environment, stage_is_read_only(stage), stage.loop_mode.clone(), stage.instructions.as_deref(), false);
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
        // Codex: only named on the launch line (`codex --version`, cached the
        // same way); the Readiness card says when it lacks a sandbox fix.
        let codex_version = if dialect == CliDialect::Codex {
            tokio::task::spawn_blocking(crate::agent_adapter::codex_cli_version).await.ok().flatten()
        } else {
            None
        };
        let effort = stage.effort.filter(|_| !old_cli);
        // Resume only on dialects with a confirmed continuation contract; a
        // dialect without one falls back to a fresh run (worktree preserved,
        // feedback in the prompt) even when a session id is on the row.
        // A Codex writer outside a sandboxed mission runs in Codex's own
        // `workspace-write` sandbox, never the bypass flag — resumed or not.
        let write_scope = codex_write_scope(&ctx.exec_isolation);
        let resume_args = stage
            .resume_session
            .as_deref()
            .filter(|_| allow_resume)
            .and_then(|sid| dialect.resume_argv(&stage.agent_model, sid, stage.max_iterations, read_only, write_scope));
        let resuming = resume_args.is_some();
        // A resumed Codex session reports the thread's running total: the
        // tokens it had already reported are subtracted (see `usage_since`).
        let baseline = if resuming && dialect == CliDialect::Codex { stage.resume_baseline } else { None };
        let (mut args, user) = match resume_args {
            Some(argv) => (
                argv,
                // An answered question-block resumes with the director's
                // decisions in the nudge — the CLI counterpart of the API
                // substrate's transcript continuation; a Codex loop-back with
                // the reviewer's findings. A plain halt-recovery resume has no
                // feedback and keeps the generic nudge.
                dialect.resume_prompt(stage.feedback.as_deref()),
            ),
            None => (
                dialect.argv(&stage.agent_model, &system, stage.max_iterations, read_only, write_scope),
                dialect.stdin_payload(
                    &system,
                    &user_input_for(&stage.role, &ctx.task, input, stage.feedback.as_deref()),
                ),
            ),
        };
        // A mission the user chose to sandbox also confines the file tools'
        // reads (fresh and resumed). Keyed on the choice, not the effective
        // tier: a readonly mission's forced sandbox keeps the write guard only.
        let reads_confined = confine_reads_in_sandbox(dialect, &ctx.exec_choice, &mut args);
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
        // A Codex writer in Codex's own sandbox can't write `~/.npm` or
        // `~/.cargo`: its build caches go to its own root, made writable.
        let mut cache_env: Vec<(String, String)> = Vec::new();
        let mut cache_note: Option<String> = None;
        if dialect == CliDialect::Codex && !read_only && write_scope == CodexWriteScope::Workspace {
            let scope = ctx.workspace_path.to_string_lossy().into_owned();
            match tokio::task::spawn_blocking(move || crate::orchestrator::sandbox::codex_build_cache(&scope)).await {
                Ok(Ok((root, env))) => {
                    dialect.push_flags(&mut args, codex_writable_root_args(&root));
                    cache_env = env;
                }
                Ok(Err(e)) => cache_note = Some(e.to_string()),
                Err(e) => cache_note = Some(e.to_string()),
            }
        }

        let path_env = resolved_cli_path();
        let real_program: std::ffi::OsString = resolve_executable(dialect.binary(), &path_env)
            .map(Into::into)
            .unwrap_or_else(|| dialect.binary().into());

        // Seatbelt sandbox (macOS): when the mission asks for it, wrap the spawn
        // in `sandbox-exec -p <profile> claude …`. NO silent fallback — if the
        // sandbox can't be set up the stage fails rather than running unconfined.
        let mut sandbox_env: Vec<(String, String)> = cache_env;
        let mut left_out: Vec<String> = Vec::new();
        let (program, exec_args): (std::ffi::OsString, Vec<std::ffi::OsString>) =
            match ctx.exec_isolation.as_str() {
                "none" => (real_program, args.iter().map(Into::into).collect()),
                "sandbox" => {
                    let scope = ctx.workspace_path.to_string_lossy();
                    // A Claude stage keeps its state in `CLAUDE_CONFIG_DIR`
                    // when the user set one, so the profile grants that
                    // dir's state instead of `~/.claude`'s. A relative value
                    // isn't followed, and the launch line says so.
                    let (claude_config, config_note) = match dialect {
                        CliDialect::Claude => crate::orchestrator::sandbox::claude_config_dir(
                            stage_env_value("CLAUDE_CONFIG_DIR").as_deref(),
                        ),
                        _ => (None, None),
                    };
                    // A Claude stage gets its own temp dir (`TMPDIR`) beside
                    // its cache root; a read-confined one names both as
                    // working dirs, or the read guard refuses them. Both are
                    // keyed by the exec choice and the read guard too, so no
                    // stage with open reads (a Codex stage, an exec-`none`
                    // review) shares a read-confined stage's dirs.
                    // Codex's read-only sandbox can't nest in the profile:
                    // refused before anything is set up (#784).
                    if let Some(msg) = codex_read_only_refusal(dialect, read_only, write_scope) {
                        return Ok(failed_stage(msg));
                    }
                    let write_roots = &ctx.allowed_write_roots;
                    let tenant = cli_cache_tenant(&ctx.exec_choice, reads_confined);
                    // A Codex stage gets its own CODEX_HOME, made outside the
                    // sandbox after an unsandboxed sign-in preflight; it never
                    // writes the user's ~/.codex (#784).
                    let codex_home = match dialect {
                        CliDialect::Codex => match prepare_codex_stage_home(&scope, write_roots, &ctx.exec_choice, reads_confined).await {
                            Ok(home) => Some(home),
                            Err(msg) => return Ok(failed_stage(&msg)),
                        },
                        CliDialect::Claude => None,
                    };
                    // Its state DB and logs stay in that home whatever the
                    // user's config.toml says (fresh and resumed).
                    if let Some(home) = &codex_home {
                        dialect.push_flags(&mut args, home.args.clone());
                    }
                    match crate::orchestrator::sandbox::prepare_with(
                        write_roots,
                        Some(&*scope),
                        tenant,
                        &real_program,
                        &args,
                        dialect == CliDialect::Claude,
                        claude_config.as_deref(),
                        codex_home.as_ref(),
                        |own_dirs| sandbox_read_dir_args(reads_confined, own_dirs),
                    ) {
                        Ok(prepared) => {
                            sandbox_env = sandboxed_stage_env(dialect, prepared.env);
                            left_out = prepared.left_out;
                            left_out.extend(config_note);
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
        // Sandboxed, or a Codex writer in its own sandbox: redirect build-tool
        // caches into the stage's own cache root (per workspace and access
        // mode) so builds work without exposing the real ~/.cargo etc.
        // Overrides any cache vars the login shell set.
        for (k, v) in sandbox_env {
            command.env(k, v);
        }
        apply_stage_env(
            &mut command,
            dialect,
            &stage.agent_model,
            effort,
            ctx.quiet_claude_code,
            cli_version.as_ref().and_then(|v| v.version.as_deref()),
        );
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
        if let Some(e) = cache_note {
            emitter.notice(&format!(
                "Octopush could not set up this stage's build cache ({e}). In Codex's sandbox, npm, cargo and \
                 other package managers may fail to write their caches."
            ));
        }
        if let Some(note) = codex_git_notice(dialect, read_only, write_scope, stage.role_environment) {
            emitter.notice(note);
        }
        if dialect == CliDialect::Codex {
            if let Some(note) = crate::codex_trust::untrusted_note(&ctx.workspace_path) {
                emitter.notice(&format!("{} {}", note.line, note.how));
            }
        }
        let mut child = match command.spawn() {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(failed_stage(&dialect.not_found_message()));
            }
            Err(e) => return Ok(failed_stage(&format!("failed to launch {}: {e}", dialect.binary()))),
        };
        emitter.notice(&format!(
            "launching {} · {}{}{}{}{}{}{}",
            dialect.binary(),
            stage.agent_model,
            dialect.effort_level(&stage.agent_model, effort).map(|e| format!(" · {e} effort")).unwrap_or_default(),
            dialect.sandbox_label(read_only, write_scope).map(|s| format!(" · {s}")).unwrap_or_default(),
            read_guard_label(reads_confined, cli_version.as_ref().and_then(|v| v.version.as_deref()))
                .map(|s| format!(" · {s}"))
                .unwrap_or_default(),
            if resuming { " · resuming session" } else { "" },
            crate::orchestrator::sandbox::left_out_label(&left_out).map(|s| format!(" · {s}")).unwrap_or_default(),
            dialect.version_label(codex_version.as_deref()).map(|s| format!(" · {s}")).unwrap_or_default(),
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
        // A Claude plan wall in the stream (never for an API-key session).
        let plan_watch = std::sync::Arc::new(parking_lot::Mutex::new(PlanLimitWatch::default()));
        let plan_watch_in_loop = std::sync::Arc::clone(&plan_watch);
        // A retry storm journals one line per cause per 10 s, not one per attempt.
        let mut retry_throttle = crate::orchestrator::live::RetryThrottle::default();
        // From `system/init`: the model the session runs on, when it isn't
        // the one the stage asked for (settings such as `availableModels`
        // can make Claude Code pick another). Prices a stop's estimate and
        // goes on the outcome (`CliOutcomeMeta::ran_model`).
        let ran_model: std::sync::Arc<parking_lot::Mutex<Option<String>>> =
            std::sync::Arc::new(parking_lot::Mutex::new(None));
        let ran_in_loop = std::sync::Arc::clone(&ran_model);
        let on_event = |value: &Value| match dialect {
            CliDialect::Claude => {
                if let Some(ran) = substituted_model(&stage.agent_model, value) {
                    let catalog = crate::token_engine::catalog();
                    emitter.notice(&ran_on_notice(&stage.agent_model, &ran, catalog.as_deref()));
                    *ran_in_loop.lock() = Some(ran);
                }
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
                if auth != Some(CliAuth::ApiKey) {
                    plan_watch_in_loop.lock().observe(value);
                }
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
        // This attempt's own usage (a resume's baseline taken off), and why
        // the baseline couldn't be trusted, if it couldn't (see `usage_since`).
        let counted_usage = || {
            usage_since(
                &streamed_usage.lock(),
                baseline,
                stage.resume_session.as_deref(),
                codex_accum.lock().session_id.as_deref(),
            )
        };
        let limits = ReadLimits::for_stage(stage_env_value("BASH_MAX_TIMEOUT_MS").as_deref());
        let on_long_wait = |window: std::time::Duration| emitter.notice(&long_command_notice(window));
        let read_loop = read_stream(stdout, dialect, limits, on_event, on_long_wait);

        // Race the child's output against the director's stop signal: poll the
        // cancel flag every ~500ms and, when set, stop the child's process
        // group (`stop_cli_child`) and fail the stage with the director message
        // and the usage streamed so far. An idle timeout fires when NO output arrives
        // for IDLE_TIMEOUT_SECS (longer while a Claude Bash/PowerShell call is
        // open, see `read_stream`); an absolute cap fires after ABS_CAP_SECS total.
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
                let (counted, drift) = counted_usage();
                let ran = ran_model.lock().clone();
                let mut out = stopped_stage(
                    dialect,
                    &crate::orchestrator::runner::unfinished_stage_error(true, 0),
                    ran.as_deref().unwrap_or(&stage.agent_model),
                    &counted,
                    codex_accum.lock().turn_open,
                );
                flag_usage_drift(&mut out, drift.as_deref(), &emitter);
                out.cli.ran_model = ran;
                return Ok(out);
            }
        };
        let bin = dialect.binary();
        let (result_line, tail, timeout_kind, settled) = match read_end {
            ReadEnd::Eof(r, t) => (r, t, None, false),
            ReadEnd::Idle(r, t, stall) => (r, t, Some(idle_timeout_message(&stall)), false),
            ReadEnd::AbsCap(r, t) => (r, t, Some("exceeded the 60-minute cap".to_string()), false),
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
        if let (Some(kind), false) = (timeout_kind.as_deref(), has_terminal) {
            stop_cli_child(&mut child, STOP_GRACE).await;
            stderr_task.abort();
            let (counted, drift) = counted_usage();
            let ran = ran_model.lock().clone();
            let mut out = stopped_stage(
                dialect,
                &format!("{bin} {kind}"),
                ran.as_deref().unwrap_or(&stage.agent_model),
                &counted,
                codex_accum.lock().turn_open,
            );
            flag_usage_drift(&mut out, drift.as_deref(), &emitter);
            out.cli.ran_model = ran;
            return Ok(out);
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
                let total = sum_usage(&streamed_usage.lock());
                let (counted, drift) = counted_usage();
                let u = sum_usage(&counted);
                let mut outcome = build_codex_outcome(
                    &accum,
                    u,
                    exit_success,
                    stage.artifact_kind.clone(),
                    &stage.agent_model,
                    &stderr_out,
                );
                outcome.cli.session_usage = codex_session_usage(&accum, &total);
                flag_usage_drift(&mut outcome, drift.as_deref(), &emitter);
                if resuming {
                    report.resume_failure = codex_resume_failure(
                        stage.resume_session.as_deref().unwrap_or_default(),
                        &accum,
                        matches!(outcome.status, StageStatus::Failed),
                        &stderr_out,
                    );
                }
                Ok(apply_question_guard(outcome))
            }
            CliDialect::Claude => match result_line {
                Some(line) => match parse_cli_result_redacting(
                    &line,
                    exit_success,
                    stage.artifact_kind.clone(),
                    &stderr_out,
                    &crate::secret_scan::known_secrets_from(&crate::settings::load_settings().unwrap_or_default()),
                ) {
                    Ok(mut outcome) => {
                        outcome.cli.ran_model = ran_model.lock().clone();
                        for call in &outcome.cli.refused_calls {
                            emitter.notice(&refused_notice(call));
                        }
                        Ok(apply_question_guard(apply_plan_limit(
                            with_free_space(outcome, || free_bytes(&ctx.workspace_path)),
                            &plan_watch.lock(),
                        )))
                    }
                    Err(_) => Ok(failed_stage(&format!(
                        "claude produced no parseable result: {}",
                        failure_detail(&stderr_out, &line)
                    ))),
                },
                // No result event, but stderr carries Claude Code's own
                // "Sandbox required but unavailable … failed validation" line.
                None if !exit_success && refused_setting(None, &stderr_out, None).is_some() => {
                    let line = refused_setting(None, &stderr_out, None).unwrap_or_default();
                    Ok(failed_stage(&settings_refused_error(&line, &stderr_out)))
                }
                None => {
                    let recent = tail.into_iter().collect::<Vec<_>>().join("\n");
                    let fallback = if recent.trim().is_empty() {
                        "claude emitted no result event"
                    } else {
                        &recent
                    };
                    // A crashed or killed CLI still burned what it streamed.
                    let (counted, drift) = counted_usage();
                    let ran = ran_model.lock().clone();
                    let mut out = claude_no_result_stage(
                        &failure_detail(&stderr_out, fallback),
                        ran.as_deref().unwrap_or(&stage.agent_model),
                        &counted,
                    );
                    flag_usage_drift(&mut out, drift.as_deref(), &emitter);
                    out.cli.ran_model = ran;
                    Ok(apply_plan_limit(out, &plan_watch.lock()))
                }
            },
        }
    }
}

/// What [`CliRunner::run_attempt`] tells [`CliRunner::run_stage`] beyond
/// the outcome.
#[derive(Debug, Default)]
pub(crate) struct AttemptReport {
    /// Why a `codex exec resume` attempt counts as failed to resume (see
    /// [`codex_resume_failure`]); `None` on a fresh run, a resume that
    /// worked, or a stop/timeout (never retried).
    pub resume_failure: Option<String>,
}

/// Why a Codex stage with a session to resume runs fresh without trying:
/// the installed `codex` has no `exec resume` (the help probe), or the
/// session's reported total is unknown, so the resumed run's thread-wide
/// usage couldn't be told apart from what was already counted. Pure.
pub fn codex_resume_skip_reason(exec_resume_supported: bool, baseline_known: bool) -> Option<&'static str> {
    if !exec_resume_supported {
        Some("the installed Codex CLI has no `codex exec resume`")
    } else if !baseline_known {
        Some("its earlier run never reported usage, so the resumed run's cost couldn't be counted")
    } else {
        None
    }
}

/// Why a finished `codex exec resume` attempt didn't resume, so the stage
/// should run fresh once; `None` when it did. Two cases:
/// - Codex streamed a different session id than the one asked for (a
///   UUID is resumed as is in 0.169.0, so this is a guard, not an expected path);
/// - the attempt failed before any assistant message: an unknown session
///   (exit 1, no JSONL, `thread/resume failed: no rollout found …` on
///   stderr), an argument error, or a `turn.failed` on the first request
///   (e.g. the resumed history no longer fits the context window).
/// A failure after an assistant message is the stage's own outcome. Pure.
pub(crate) fn codex_resume_failure(requested: &str, accum: &CodexAccum, failed: bool, stderr: &str) -> Option<String> {
    if let Some(got) = accum.session_id.as_deref().filter(|got| *got != requested) {
        return Some(format!("Codex answered with session {got}, not {requested}"));
    }
    if !failed || accum.final_message.is_some() {
        return None;
    }
    let stderr_error = stderr
        .lines()
        .map(str::trim)
        .find(|l| l.starts_with("Error:") || l.starts_with("error:"))
        .map(|l| l.trim_start_matches("Error:").trim_start_matches("error:").trim().to_string());
    Some(
        accum
            .error
            .clone()
            .or(stderr_error)
            .unwrap_or_else(|| "it failed before any assistant message".to_string()),
    )
}

/// True when a [`codex_resume_failure`] reason is clearly about resuming the
/// session itself: another session id, an unknown session (`no rollout
/// found`, `thread/resume`), an argument error on `codex exec resume`, or a
/// resumed history that no longer fits the context window. Anything else
/// (quota, auth, network…) is a failure that happened to hit the resumed
/// run, not proof the session can't be continued. Pure.
pub(crate) fn is_resume_problem(why: &str) -> bool {
    let w = why.to_ascii_lowercase();
    w.starts_with("codex answered with session")
        || w.contains("no rollout found")
        || w.contains("thread/resume")
        || w.contains("unexpected argument")
        || w.contains("context window")
}

/// The journal line before a failed resume's fresh run: "could not resume"
/// only when the reason is a resume problem ([`is_resume_problem`]),
/// otherwise a neutral "failed before answering on the resumed session". Pure.
pub(crate) fn codex_resume_failure_notice(why: &str) -> String {
    if is_resume_problem(why) {
        format!(
            "Codex could not resume this stage's session ({why}). Running the stage fresh once, with the feedback in the prompt."
        )
    } else {
        format!(
            "Codex failed before answering on the resumed session ({why}); running fresh once, with the feedback in the prompt."
        )
    }
}

/// `map`'s usage with `baseline` (the session's earlier reported total)
/// taken off, as one entry; `map` unchanged without a baseline. A resumed
/// Codex run's `turn.completed` reports the thread's running total (openai/codex
/// `exec/src/event_processor_with_jsonl_output.rs` `usage_from_last_total`,
/// seeded from the rollout on resume), so without this the earlier runs'
/// tokens, already retired onto the run, would be counted again.
///
/// The subtraction is only trusted when the stream is the requested
/// session's continuation. When Codex answered with another session id
/// (`got` ≠ `requested`), or any field of the reported total is below the
/// baseline (usage drift), nothing is subtracted: `map` comes back unchanged
/// with `Some(why)`, and the caller flags the stage `usage_unreported` and
/// journals `why` — the raw usage may double-count, but the stage never
/// records ~0 for work it really did. Pure.
pub(crate) fn usage_since(
    map: &std::collections::HashMap<String, CliUsage>,
    baseline: Option<crate::orchestrator::types::SessionUsage>,
    requested: Option<&str>,
    got: Option<&str>,
) -> (std::collections::HashMap<String, CliUsage>, Option<String>) {
    let Some(b) = baseline else { return (map.clone(), None) };
    if map.is_empty() {
        return (map.clone(), None);
    }
    if let (Some(req), Some(got)) = (requested, got) {
        if req != got {
            return (
                map.clone(),
                Some(format!(
                    "Codex reported usage for session {got}, not the resumed {req}, so its earlier total wasn't subtracted"
                )),
            );
        }
    }
    let t = sum_usage(map);
    let Some(d) = session_usage_of(&t).since(&b) else {
        return (
            map.clone(),
            Some(
                "the resumed session's reported total is below what it had reported before, so the earlier total wasn't subtracted"
                    .to_string(),
            ),
        );
    };
    (
        std::collections::HashMap::from([(
            "resumed".to_string(),
            CliUsage {
                input_tokens: d.input_tokens,
                output_tokens: d.output_tokens,
                cache_read_input_tokens: d.cache_read_tokens,
                cache_creation_input_tokens: d.cache_creation_tokens,
                ..t
            },
        )]),
        None,
    )
}

/// The journal line for a resumed Codex run whose usage couldn't be taken
/// off its earlier total (see [`usage_since`]).
pub(crate) fn usage_drift_notice(why: &str) -> String {
    format!("Usage not reported exactly: {why}. This attempt counts the session's raw usage, which may include earlier runs.")
}

fn session_usage_of(u: &CliUsage) -> crate::orchestrator::types::SessionUsage {
    crate::orchestrator::types::SessionUsage {
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        cache_read_tokens: u.cache_read_input_tokens,
        cache_creation_tokens: u.cache_creation_input_tokens,
    }
}

/// The running total a Codex session reported by the end of an attempt
/// (`total` = the raw stream sum, before any baseline is taken off), kept as
/// the next resume's baseline. `None` when it's unknown: no session id, no
/// usage, or a last turn that never completed. Pure.
pub(crate) fn codex_session_usage(accum: &CodexAccum, total: &CliUsage) -> Option<crate::orchestrator::types::SessionUsage> {
    (accum.session_id.is_some() && !accum.turn_open && *total != CliUsage::default()).then(|| session_usage_of(total))
}

/// Flag `outcome`'s spend as not exactly reported and journal why, when
/// [`usage_since`] couldn't subtract the resume baseline.
fn flag_usage_drift(
    outcome: &mut StageOutcome,
    drift: Option<&str>,
    emitter: &crate::orchestrator::live::LiveEmitter<'_>,
) {
    if let Some(why) = drift {
        outcome.cli.usage_unreported = true;
        outcome.cli.usage_unreported_journaled = true;
        emitter.notice(&usage_drift_notice(why));
    }
}

/// The outcome of a failed resume followed by its fresh run: the fresh run's
/// result, with the failed attempt's spend added (it was really burned) and
/// its unknown spend, if any, still flagged. Pure.
pub(crate) fn merge_resume_fallback(resumed: StageOutcome, mut fresh: StageOutcome) -> StageOutcome {
    fresh.input_tokens += resumed.input_tokens;
    fresh.output_tokens += resumed.output_tokens;
    fresh.cache_read_tokens += resumed.cache_read_tokens;
    fresh.cache_creation_tokens += resumed.cache_creation_tokens;
    fresh.cost_usd += resumed.cost_usd;
    // A stop marker in the resumed error was never journaled (its error is
    // dropped), so only drift-only unknowns on both sides skip the generic line.
    let resumed_stopped = resumed.error.as_deref().is_some_and(is_usage_unreported);
    let unjournaled = |cli: &crate::orchestrator::types::CliOutcomeMeta|cli.usage_unreported && !cli.usage_unreported_journaled;
    let journaled = !resumed_stopped && !unjournaled(&resumed.cli) && !unjournaled(&fresh.cli);
    fresh.cli.usage_unreported |= resumed.cli.usage_unreported || resumed_stopped;
    fresh.cli.usage_unreported_journaled = fresh.cli.usage_unreported && journaled;
    fresh
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
pub(crate) fn sum_usage(map: &std::collections::HashMap<String, CliUsage>) -> CliUsage {
    let mut total = CliUsage::default();
    for u in map.values() {
        total.add(u);
    }
    total
}

/// The streamed per-message usage priced as an estimate ([`streamed_estimate`]).
#[derive(Debug, Default, Clone, PartialEq)]
pub(crate) struct StreamedEstimate {
    /// The tokens to record: every message's when none could be priced,
    /// otherwise only the priced messages' (so the baseline never re-prices
    /// tokens whose cost is unknown and reports them as saved).
    pub(crate) usage: CliUsage,
    pub(crate) cost_usd: f64,
    /// The (model, speed) groups that have tokens but no price, as `model`
    /// or `model (fast)`, sorted and deduplicated. Empty when the estimate is
    /// complete, and also when every token is the stage's own unpriced model
    /// at standard speed (the ledger already reads that stage "unpriced" from
    /// its model). Token-less groups and CLI placeholder models such as
    /// `<synthetic>` are never listed.
    pub(crate) unpriced: Vec<String>,
}

/// The estimated cost of the streamed per-message usage. Messages are
/// grouped by (model, speed) — each message's own `message.model` (a
/// subagent may run on another model), falling back to the stage's `model` —
/// and each group is priced for its own model through the normal catalog:
/// standard speed at the model's price, fast mode at its fast rate
/// (`token_engine::prices_at_speed`). A group with no price (an unknown
/// model, or fast mode on a model with no fast rate) is never billed at
/// another rate and never read as free: it lands in `unpriced`, except a
/// stage whose usage is all its own unpriced model at standard speed — the
/// ledger already reads that stage "unpriced" from its model. A group with
/// no tokens, or on a CLI placeholder model (`<synthetic>`, which Claude Code
/// stamps on its own error messages), billed nothing and is never unpriced.
pub(crate) fn streamed_estimate(model: &str, map: &std::collections::HashMap<String, CliUsage>) -> StreamedEstimate {
    use crate::token_engine::{normalize_model_id, prices_at_speed, prices_for, SPEED_FAST};
    let stage = normalize_model_id(model);
    let mut groups: std::collections::BTreeMap<(String, bool), (String, CliUsage)> = std::collections::BTreeMap::new();
    for u in map.values() {
        let m = u.model.as_deref().unwrap_or(model);
        let entry = groups
            .entry((normalize_model_id(m), u.fast))
            .or_insert_with(|| (m.to_string(), CliUsage::default()));
        entry.1.add(u);
    }
    let mut all = CliUsage::default();
    let mut priced = CliUsage::default();
    let mut any_priced = false;
    let mut cost = 0.0;
    let mut unpriced = Vec::new();
    let mut only_stage_model_unpriced = true;
    for ((key, fast), (m, u)) in &groups {
        all.add(u);
        let speed = if *fast { Some(SPEED_FAST) } else { None };
        match prices_at_speed(m, prices_for(m), speed) {
            Some(p) => {
                any_priced = true;
                priced.add(u);
                cost += p.cost_split(
                    u.input_tokens,
                    u.output_tokens,
                    u.cache_read_input_tokens,
                    u.cache_creation_input_tokens,
                    u.cache_creation_1h_input_tokens,
                );
            }
            None if u.total() == 0 || m.starts_with('<') => {}
            None => {
                only_stage_model_unpriced &= !*fast && *key == stage;
                unpriced.push(if *fast { format!("{m} (fast)") } else { m.clone() });
            }
        }
    }
    if only_stage_model_unpriced && !any_priced {
        unpriced.clear();
    }
    unpriced.sort();
    unpriced.dedup();
    StreamedEstimate { usage: if any_priced { priced } else { all }, cost_usd: cost, unpriced }
}

/// [`streamed_estimate`]'s cost alone.
#[cfg(test)]
pub(crate) fn streamed_cost(model: &str, map: &std::collections::HashMap<String, CliUsage>) -> f64 {
    streamed_estimate(model, map).cost_usd
}

/// A failed outcome carrying the ESTIMATED usage summed from the streamed
/// assistant events (no terminal `result` event arrived to be authoritative).
/// Cost is priced through the normal catalog ([`streamed_estimate`]) so the
/// run meter and budget see the burned spend instead of zero; a part it
/// can't price appends [`USAGE_UNPRICED`] (with the models) to the error, so
/// the stage reads "+ usage not reported" instead of a smaller total.
fn failed_stage_with_usage(msg: &str, model: &str, map: &std::collections::HashMap<String, CliUsage>) -> StageOutcome {
    let est = streamed_estimate(model, map);
    let msg = if est.unpriced.is_empty() {
        msg.to_string()
    } else {
        format!("{msg}\n{USAGE_UNPRICED} ({})", est.unpriced.join(", "))
    };
    let u = est.usage;
    let mut out = failed_stage(&msg);
    out.input_tokens = u.input_tokens;
    out.output_tokens = u.output_tokens;
    out.cache_read_tokens = u.cache_read_input_tokens;
    out.cache_creation_tokens = u.cache_creation_input_tokens;
    out.cost_usd = est.cost_usd;
    out
}

/// The outcome of a stage stopped before it finished (director stop, stall,
/// 60-minute cap): the streamed usage priced as an estimate. A Codex stage
/// whose last turn never completed (`turn_open`) or that streamed no usage
/// event never reported those tokens — its error carries [`USAGE_UNREPORTED`]
/// so its cost reads unknown (or "+ usage not reported") instead of a total.
pub(crate) fn stopped_stage(
    dialect: CliDialect,
    msg: &str,
    model: &str,
    map: &std::collections::HashMap<String, CliUsage>,
    turn_open: bool,
) -> StageOutcome {
    if dialect == CliDialect::Codex && (turn_open || map.is_empty()) {
        return failed_stage_with_usage(&format!("{msg}\n{USAGE_UNREPORTED}"), model, map);
    }
    failed_stage_with_usage(msg, model, map)
}

/// The outcome of a Claude stage whose stream reached EOF with no `result`
/// line (a crashed or killed CLI, not a stop): "claude produced no result:
/// `detail`", with the streamed usage priced as an estimate
/// ([`failed_stage_with_usage`]) instead of $0.
pub(crate) fn claude_no_result_stage(
    detail: &str,
    model: &str,
    map: &std::collections::HashMap<String, CliUsage>,
) -> StageOutcome {
    failed_stage_with_usage(&format!("claude produced no result: {detail}"), model, map)
}

fn failed_stage(msg: &str) -> StageOutcome {
    StageOutcome {
        cli: Default::default(),
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
