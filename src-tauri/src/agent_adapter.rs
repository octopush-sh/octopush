//! Agent adapters — abstraction over different CLI-based coding agents.
//!
//! Each adapter knows how to:
//! - Build the shell command to launch the agent
//! - Parse token usage from the agent's output
//! - Report whether it supports mid-session model swapping

use crate::token_engine::TokenEvent;
use portable_pty::CommandBuilder;
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

/// Trait for pluggable agent adapters.
pub trait AgentAdapter: Send + Sync {
    fn name(&self) -> &str;
    fn display_name(&self) -> &str;
    fn build_command(&self, model: &str, cwd: &str) -> CommandBuilder;
    fn parse_token_usage(&self, session_id: &str, output: &str) -> Option<TokenEvent>;
    fn supports_hot_swap(&self) -> bool;
}

/// Adapter metadata for the frontend.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AdapterInfo {
    pub name: String,
    pub display_name: String,
    pub supports_hot_swap: bool,
}

// ─── Claude Code ──────────────────────────────────────────────────

pub struct ClaudeCodeAdapter;

impl AgentAdapter for ClaudeCodeAdapter {
    fn name(&self) -> &str {
        "claude-code"
    }
    fn display_name(&self) -> &str {
        "Claude Code"
    }
    fn build_command(&self, model: &str, cwd: &str) -> CommandBuilder {
        let mut cmd = CommandBuilder::new("claude");
        cmd.arg("--model");
        cmd.arg(model);
        cmd.cwd(cwd);
        cmd
    }
    fn parse_token_usage(&self, session_id: &str, output: &str) -> Option<TokenEvent> {
        // Delegate to the shared scanner which already handles Claude Code format.
        crate::token_engine::scan_pty_output(session_id, output.as_bytes())
    }
    fn supports_hot_swap(&self) -> bool {
        // Claude Code sessions can be restarted with a different --model.
        false
    }
}

// ─── Aider ────────────────────────────────────────────────────────

pub struct AiderAdapter;

impl AgentAdapter for AiderAdapter {
    fn name(&self) -> &str {
        "aider"
    }
    fn display_name(&self) -> &str {
        "Aider"
    }
    fn build_command(&self, model: &str, cwd: &str) -> CommandBuilder {
        let mut cmd = CommandBuilder::new("aider");
        cmd.arg("--model");
        cmd.arg(model);
        cmd.cwd(cwd);
        cmd
    }
    fn parse_token_usage(&self, session_id: &str, output: &str) -> Option<TokenEvent> {
        // Aider prints "Tokens: NNN sent, NNN received" — parse if present.
        parse_aider_tokens(session_id, output)
    }
    fn supports_hot_swap(&self) -> bool {
        // Aider supports /model command mid-session.
        true
    }
}

fn parse_aider_tokens(session_id: &str, output: &str) -> Option<TokenEvent> {
    // Pattern: "Tokens: 1,234 sent, 567 received"
    let idx = output.find("Tokens:")?;
    let line = output[idx..].lines().next()?;
    let sent = extract_number_before(line, "sent")?;
    let recv = extract_number_before(line, "received")?;
    Some(TokenEvent {
        id: None,
        session_id: session_id.to_string(),
        timestamp: chrono::Utc::now().to_rfc3339(),
        input_tokens: sent,
        output_tokens: recv,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        model: "unknown".to_string(),
        cost_usd: 0.0,
    })
}

fn extract_number_before(s: &str, keyword: &str) -> Option<u64> {
    let idx = s.find(keyword)?;
    let before = s[..idx].trim_end().trim_end_matches(',');
    // Walk backwards to find the number.
    let num_str: String = before
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit() || *c == ',')
        .collect::<String>()
        .chars()
        .rev()
        .filter(|c| *c != ',')
        .collect();
    num_str.parse().ok()
}

// ─── Custom Agent ─────────────────────────────────────────────────

pub struct CustomAgentAdapter {
    pub agent_name: String,
    pub command: String,
    pub args: Vec<String>,
}

impl AgentAdapter for CustomAgentAdapter {
    fn name(&self) -> &str {
        &self.agent_name
    }
    fn display_name(&self) -> &str {
        &self.agent_name
    }
    fn build_command(&self, _model: &str, cwd: &str) -> CommandBuilder {
        let mut cmd = CommandBuilder::new(&self.command);
        for arg in &self.args {
            cmd.arg(arg);
        }
        cmd.cwd(cwd);
        cmd
    }
    fn parse_token_usage(&self, _session_id: &str, _output: &str) -> Option<TokenEvent> {
        // Custom agents: rely on JSON usage block interception.
        None
    }
    fn supports_hot_swap(&self) -> bool {
        false
    }
}

// ─── Registry ─────────────────────────────────────────────────────

pub fn builtin_adapters() -> Vec<Box<dyn AgentAdapter>> {
    vec![
        Box::new(ClaudeCodeAdapter),
        Box::new(AiderAdapter),
    ]
}

pub fn adapter_info_list() -> Vec<AdapterInfo> {
    builtin_adapters()
        .iter()
        .map(|a| AdapterInfo {
            name: a.name().to_string(),
            display_name: a.display_name().to_string(),
            supports_hot_swap: a.supports_hot_swap(),
        })
        .collect()
}

// ─── Claude Code CLI version ──────────────────────────────────────

/// The oldest Claude Code release Octopush is tested against: the version of
/// the contract fixtures (`tests/fixtures/claude-code/<version>/`). The
/// release-watch routine bumps it when it refreshes them; a contract test
/// keeps it naming a recorded version.
pub const TESTED_CLAUDE_FLOOR: &str = "2.1.314";

/// Claude Code releases that fix a sandbox or permission escape, oldest
/// first: (version, why it matters in one line). Separate from
/// [`TESTED_CLAUDE_FLOOR`] so adding a row never forces a fixture re-record.
/// The release-watch routine adds a row when a changelog entry fixes one.
pub const CLAUDE_SECURITY_FIXES: &[(&str, &str)] = &[
    ("2.1.319", "fixes a sandbox escape when creating a worktree"),
    ("2.1.321", "fixes a read-only Bash command running outside the sandbox without a prompt"),
    ("2.1.323", "fixes the Bash sandbox switching off mid-session"),
    ("2.1.325", "fixes the Bash sandbox not fully protecting a worktree's settings, hooks and shared git folder"),
];

/// Who a [`CLAUDE_KNOWN_BAD_RELEASES`] row hurts, which decides where it
/// warns beyond the Readiness card.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum KnownBadScope {
    /// Claude Code CLI stages on a gateway model (any model that isn't a
    /// built-in Anthropic catalog id).
    GatewayStages,
}

/// Single Claude Code releases to skip because they broke something a crew
/// relies on and the next release put it back: (version, why in one line,
/// scope). Matched exactly, never as a floor: the release after it is fine.
/// The release-watch routine adds a row the way it adds
/// [`CLAUDE_SECURITY_FIXES`] rows, when a changelog entry reverts a
/// regression of the one before.
pub const CLAUDE_KNOWN_BAD_RELEASES: &[(&str, &str, KnownBadScope)] = &[(
    "2.1.329",
    "drops the retry gateway models need when a max_tokens error names a lower limit; 2.1.330 restores it",
    KnownBadScope::GatewayStages,
)];

/// The [`CLAUDE_KNOWN_BAD_RELEASES`]-shaped row of `table` that `version`
/// is exactly (a pre-release suffix ignored); `None` for any other version
/// or one that doesn't parse.
pub fn known_bad_release<'a>(
    version: &str,
    table: &[(&'a str, &'a str, KnownBadScope)],
) -> Option<(&'a str, &'a str, KnownBadScope)> {
    let key = version_key(version)?;
    table.iter().find(|(v, _, _)| version_key(v) == Some(key)).copied()
}

/// "Claude Code 2.1.329 drops … ; 2.1.330 restores it" for a known bad row.
fn known_bad_line(version: &str, reason: &str) -> String {
    format!("Claude Code {version} {reason}")
}

/// The Direct launcher's line for a crew whose Claude Code CLI stages
/// launch `models` (escalations included) on the `installed` CLI: only when
/// that version is a [`KnownBadScope::GatewayStages`] row of `table` and one
/// of `models` is a gateway model (`is_gateway`). Never blocks a run.
pub fn known_bad_launch_note(
    models: &[String],
    installed: Option<&str>,
    table: &[(&str, &str, KnownBadScope)],
    is_gateway: impl Fn(&str) -> bool,
) -> Option<String> {
    let (v, reason, scope) = known_bad_release(installed?, table)?;
    let hits = match scope {
        KnownBadScope::GatewayStages => models.iter().any(|m| is_gateway(m.as_str())),
    };
    hits.then(|| format!("{}. A stage on a gateway model may fail every turn; update Claude Code.", known_bad_line(v, reason)))
}

/// The stage error for a failed Claude Code CLI stage on a gateway model
/// (`gateway`) whose `error` is a `max_tokens` one, on a CLI that is a
/// [`KnownBadScope::GatewayStages`] row of `table`: the release named and
/// the update asked for on the first line, the CLI's own error after it.
/// `None` otherwise, so the error stays as it was. Pure.
pub fn known_bad_stage_error(
    error: &str,
    installed: Option<&str>,
    gateway: bool,
    table: &[(&str, &str, KnownBadScope)],
) -> Option<String> {
    let (v, reason, scope) = known_bad_release(installed?, table)?;
    let applies = match scope {
        KnownBadScope::GatewayStages => gateway && error.to_ascii_lowercase().contains("max_tokens"),
    };
    applies.then(|| format!("{KNOWN_BAD_STAGE_PREFIX}{v} on a gateway model: it {reason}. Update Claude Code, then resume or re-run.\n{error}"))
}

/// How [`known_bad_stage_error`]'s first line starts; `stageHalt.ts` reads it.
pub const KNOWN_BAD_STAGE_PREFIX: &str = "Skip Claude Code ";

/// Claude Code releases worth updating to that fix no sandbox or permission
/// escape, oldest first: (version, why it matters in one line). They never
/// warn a stage or the launcher; the Readiness card's Claude Code row shows
/// the newest one missing as a recommended note while a Run-mode session runs
/// Claude Code (`ReadinessCard.tsx`).
pub const CLAUDE_RECOMMENDED_FIXES: &[(&str, &str)] = &[
    ("2.1.330", "fixes ExitWorktree removing a worktree another session is using"),
];

/// "Recommended: Claude Code 2.1.330 fixes …" when the known `version` lacks
/// a [`CLAUDE_RECOMMENDED_FIXES`] row; `None` otherwise.
pub fn claude_recommended_notice(version: &str) -> Option<String> {
    let (fix, reason) = missing_security_fix(version, CLAUDE_RECOMMENDED_FIXES)?;
    Some(format!("Recommended: Claude Code {fix} {reason}."))
}

/// Codex CLI releases that fix a sandbox or permission escape, oldest first:
/// (version, why it matters in one line). Codex writer stages run in Codex's
/// own `workspace-write` sandbox, so the Readiness card's Codex row warns
/// below the newest. Codex has no tested floor; this list is all it gets.
pub const CODEX_SECURITY_FIXES: &[(&str, &str)] = &[
    ("0.170.0", "fixes permission updates and child threads losing sandbox restrictions"),
];

/// Models a Claude Code CLI stage can only launch on a new enough CLI:
/// (normalized model id, display name, oldest Claude Code that runs it). From
/// the upstream model docs; matched on [`crate::token_engine::normalize_model_id`].
pub const CLAUDE_MODEL_FLOORS: &[(&str, &str, &str)] = &[
    ("claude-fable-5-2", "Fable 5.2", "2.1.321"),
    ("claude-fable-5-1", "Fable 5.1", "2.1.257"),
];

/// A crew model the installed CLI is too old for — the Direct launcher's
/// amber line. Never blocks a run.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeModelFloorNote {
    /// Display name, e.g. "Fable 5.2".
    pub label: String,
    /// The oldest Claude Code that runs it.
    pub needs: String,
    /// The installed version.
    pub installed: String,
}

/// The [`CLAUDE_MODEL_FLOORS`] row for `model`, if any: (label, version).
pub fn claude_model_floor(model: &str) -> Option<(&'static str, &'static str)> {
    let id = crate::token_engine::normalize_model_id(model);
    CLAUDE_MODEL_FLOORS.iter().find(|(m, _, _)| *m == id).map(|(_, label, v)| (*label, *v))
}

/// The one model among `models` that needs the newest CLI the known
/// `installed` version is below; `None` when every model runs on it, or the
/// version is unknown (an unknown version never warns).
pub fn model_floor_note(models: &[String], installed: Option<&str>) -> Option<ClaudeModelFloorNote> {
    let installed = installed?;
    models
        .iter()
        .filter_map(|m| claude_model_floor(m.as_str()))
        .filter(|(_, needs)| version_below(installed, needs))
        .max_by_key(|(_, needs)| version_key(needs))
        .map(|(label, needs)| ClaudeModelFloorNote {
            label: label.to_string(),
            needs: needs.to_string(),
            installed: installed.to_string(),
        })
}

/// How long `claude --version` may take before the version counts as unknown.
const VERSION_TIMEOUT: Duration = Duration::from_secs(10);

/// The installed Claude Code CLI's version against the tested floor — drives
/// the Settings row and the run preflight warning. Never blocks a run.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCliVersion {
    /// `x.y.z` from `claude --version`; `None` when the CLI isn't found or
    /// didn't print a version.
    pub version: Option<String>,
    pub floor: String,
    /// True only when the version is known AND older than the floor.
    pub below_floor: bool,
    /// The newest [`CLAUDE_SECURITY_FIXES`] row the known version is below;
    /// `None` when it has them all or the version is unknown.
    pub security_fix: Option<ClaudeSecurityFix>,
    /// The version to update to: the higher of the floor and `security_fix`.
    pub recommended: String,
    /// The [`CLAUDE_KNOWN_BAD_RELEASES`] row the known version is exactly;
    /// `None` for any other version or an unknown one.
    pub known_bad: Option<ClaudeKnownBadRelease>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSecurityFix {
    pub version: String,
    pub reason: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeKnownBadRelease {
    pub version: String,
    pub reason: String,
    pub scope: KnownBadScope,
}

impl ClaudeCliVersion {
    pub fn new(version: Option<String>, floor: &str) -> Self {
        Self::with_fixes(version, floor, CLAUDE_SECURITY_FIXES)
    }

    /// [`ClaudeCliVersion::new`] against an explicit fix table (tests).
    pub fn with_fixes(version: Option<String>, floor: &str, fixes: &[(&str, &str)]) -> Self {
        let below_floor = version.as_deref().is_some_and(|v| version_below(v, floor));
        let security_fix = version.as_deref().and_then(|v| {
            fixes
                .iter()
                .filter(|(fix, _)| version_below(v, fix))
                .max_by_key(|(fix, _)| version_key(fix))
                .map(|(fix, reason)| ClaudeSecurityFix { version: fix.to_string(), reason: reason.to_string() })
        });
        let recommended = match &security_fix {
            Some(fix) if version_below(floor, &fix.version) => fix.version.clone(),
            _ => floor.to_string(),
        };
        let known_bad = version.as_deref().and_then(|v| known_bad_release(v, CLAUDE_KNOWN_BAD_RELEASES)).map(
            |(v, reason, scope)| ClaudeKnownBadRelease { version: v.to_string(), reason: reason.to_string(), scope },
        );
        Self { version, floor: floor.to_string(), below_floor, security_fix, recommended, known_bad }
    }

    /// "Claude Code 2.1.329 drops …; 2.1.330 restores it" when the known
    /// version is a [`CLAUDE_KNOWN_BAD_RELEASES`] row, whatever its scope (the
    /// Readiness card); `None` otherwise. Never blocks a run.
    pub fn known_bad_notice(&self) -> Option<String> {
        let bad = self.known_bad.as_ref()?;
        Some(known_bad_line(&bad.version, &bad.reason))
    }

    /// "Update Claude Code: 2.1.319 fixes …" when the known version lacks a
    /// security fix; `None` otherwise. Never blocks a run.
    pub fn security_notice(&self) -> Option<String> {
        let fix = self.security_fix.as_ref()?;
        Some(format!("Update Claude Code: {} {}", fix.version, fix.reason))
    }

    /// Whether Run-mode attention may come from Claude Code's hooks: only a
    /// KNOWN version at or above the floor. An unknown version keeps the
    /// terminal heuristic (#287).
    pub fn supports_hooks(&self) -> bool {
        self.version.is_some() && !self.below_floor
    }

    /// The journal notice for a CLI stage on an old CLI; `None` otherwise.
    pub fn update_notice(&self) -> Option<String> {
        let v = self.version.as_deref().filter(|_| self.below_floor)?;
        Some(format!(
            "Claude Code {v} is older than {floor}, the version Octopush is tested with. \
             Older releases can record wrong token usage and skip sandbox rules on resumed \
             sessions. Update Claude Code ({recommended} or newer recommended); the run continues.",
            floor = self.floor,
            recommended = self.recommended
        ))
    }

    /// What a Claude Code CLI stage journals before it starts, once each: the
    /// tested-floor notice, then the security one.
    pub fn stage_notices(&self) -> Vec<String> {
        let security = self.security_notice().zip(self.version.as_deref()).map(|(note, v)| {
            format!("{note} (installed: {v}); the run continues.")
        });
        self.update_notice().into_iter().chain(security).collect()
    }
}

/// `x.y.z` as numbers; a pre-release/build suffix (`-beta.1`, `+abc`) is
/// ignored, so `2.1.319-beta.1` counts as 2.1.319: at the floor, and with
/// that release's security fix.
fn version_key(v: &str) -> Option<(u64, u64, u64)> {
    let core = v.split(['-', '+']).next()?;
    let mut parts = core.split('.').map(|p| p.parse::<u64>().ok());
    let key = (parts.next()??, parts.next()??, parts.next()??);
    parts.next().is_none().then_some(key)
}

/// The first `x.y.z` token in `claude --version`'s output, e.g.
/// `2.1.316 (Claude Code)` → `2.1.316`. A leading `v` is accepted.
pub fn parse_claude_version(output: &str) -> Option<String> {
    output.split_whitespace().find_map(|tok| {
        let t = tok.trim_matches(|c: char| !c.is_ascii_alphanumeric());
        let t = t.strip_prefix('v').unwrap_or(t);
        version_key(t)?;
        Some(t.split(['-', '+']).next().unwrap_or(t).to_string())
    })
}

/// The version on `codex --version`'s `codex-cli 0.169.0` line (pinned by
/// `tests/fixtures/codex/<version>/version.txt`); `None` for anything else.
pub fn parse_codex_version(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let v = line.trim().strip_prefix("codex-cli ")?.trim();
        version_key(v)?;
        Some(v.split(['-', '+']).next().unwrap_or(v).to_string())
    })
}

/// The newest of `fixes` the known `version` is below: (version, reason).
/// `None` when it has them all, or the version doesn't parse.
pub fn missing_security_fix<'a>(version: &str, fixes: &[(&'a str, &'a str)]) -> Option<(&'a str, &'a str)> {
    fixes.iter().filter(|(fix, _)| version_below(version, fix)).max_by_key(|(fix, _)| version_key(fix)).copied()
}

/// "Update Codex: 0.170.0 fixes …" when the known Codex `version` lacks a
/// [`CODEX_SECURITY_FIXES`] row; `None` otherwise. Never blocks a run.
pub fn codex_security_notice(version: &str) -> Option<String> {
    let (fix, reason) = missing_security_fix(version, CODEX_SECURITY_FIXES)?;
    Some(format!("Update Codex: {fix} {reason}"))
}

/// True when `version` is strictly older than `floor`. Unparseable input on
/// either side is never "below" — an unknown version must not warn.
pub fn version_below(version: &str, floor: &str) -> bool {
    match (version_key(version), version_key(floor)) {
        (Some(v), Some(f)) => v < f,
        _ => false,
    }
}

/// The installed CLI's version, probed with the same login-shell PATH and
/// environment the CLI stages run with, then cached until the Readiness card
/// re-probes ([`forget_claude_cli_version`]).
pub fn claude_cli_version() -> ClaudeCliVersion {
    ClaudeCliVersion::new(CLAUDE_VERSION_CACHE.get_or_probe(probe_claude_version), TESTED_CLAUDE_FLOOR)
}

/// The last probe result without probing and without waiting; `None` until a
/// CLI stage, the preflight or Settings has run [`claude_cli_version`]. A
/// Readiness check doesn't clear it: until the next probe answers, the
/// version it had is still the best guess.
pub fn claude_cli_version_cached() -> Option<ClaudeCliVersion> {
    CLAUDE_VERSION_CACHE.peek().map(|v| ClaudeCliVersion::new(v, TESTED_CLAUDE_FLOOR))
}

/// Drop the cached version so the next [`claude_cli_version`] probes again:
/// the Readiness card re-probes, and after an update the launcher and stage
/// journals must stop warning without a restart.
pub fn forget_claude_cli_version() {
    CLAUDE_VERSION_CACHE.forget();
}

static CLAUDE_VERSION_CACHE: VersionCache = VersionCache::new();

/// The lock is only ever held to read or write these fields, never across a
/// probe, so the run loop's [`VersionCache::peek`] can't wait on one. The
/// condvar wakes callers waiting for another caller's probe.
struct VersionCache(Mutex<VersionState>, Condvar);

/// `None` = not probed; `Some(None)` = probed, no version found.
struct VersionState {
    current: Option<Option<String>>,
    /// The last answer, kept through [`VersionCache::forget`].
    last: Option<Option<String>>,
    /// The generation `last`'s probe started in, so an overtaken probe that
    /// finishes late never replaces a newer answer.
    last_generation: u64,
    /// Bumped by each forget, so a probe that started before one doesn't
    /// store a possibly stale answer as current.
    generation: u64,
    /// The generation a probe is running in right now, if any.
    probing: Option<u64>,
}

impl VersionCache {
    const fn new() -> Self {
        let state = VersionState { current: None, last: None, last_generation: 0, generation: 0, probing: None };
        Self(Mutex::new(state), Condvar::new())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, VersionState> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Probes outside the lock, one probe per generation: a caller that
    /// arrives while one runs waits for its answer (letting go of the lock
    /// meanwhile). After a forget, the next caller probes afresh.
    fn get_or_probe(&self, probe: impl FnOnce() -> Option<String>) -> Option<String> {
        let generation = {
            let mut state = self.lock();
            loop {
                if let Some(v) = &state.current {
                    return v.clone();
                }
                if state.probing != Some(state.generation) {
                    break;
                }
                state = self.1.wait(state).unwrap_or_else(|e| e.into_inner());
            }
            state.probing = Some(state.generation);
            state.generation
        };
        // Clears `probing` and wakes the waiters even if the probe panics.
        let _probing = ProbingGuard { cache: self, generation };
        let found = probe();
        let mut state = self.lock();
        if state.generation == generation {
            state.current = Some(found.clone());
        }
        if generation >= state.last_generation {
            state.last = Some(found.clone());
            state.last_generation = generation;
        }
        found
    }

    /// The last answer, even one forgotten since; `None` before any, or in
    /// the instant another thread holds the lock (never waits).
    fn peek(&self) -> Option<Option<String>> {
        match self.0.try_lock() {
            Ok(state) => state.last.clone(),
            Err(std::sync::TryLockError::Poisoned(e)) => e.into_inner().last.clone(),
            Err(std::sync::TryLockError::WouldBlock) => None,
        }
    }

    fn forget(&self) {
        let mut state = self.lock();
        state.current = None;
        state.generation += 1;
    }
}

/// Held across a [`VersionCache::get_or_probe`] probe; dropped after the
/// answer is stored.
struct ProbingGuard<'a> {
    cache: &'a VersionCache,
    generation: u64,
}

impl Drop for ProbingGuard<'_> {
    fn drop(&mut self) {
        let mut state = self.cache.lock();
        if state.probing == Some(self.generation) {
            state.probing = None;
        }
        drop(state);
        self.cache.1.notify_all();
    }
}

fn probe_claude_version() -> Option<String> {
    probe_version("claude", parse_claude_version)
}

/// The installed Codex CLI's version (`codex --version`, local), probed like
/// [`claude_cli_version`] and cached until the Readiness card re-probes
/// ([`forget_codex_cli_version`]). `None` when not found or unparseable.
pub fn codex_cli_version() -> Option<String> {
    CODEX_VERSION_CACHE.get_or_probe(|| probe_version("codex", parse_codex_version))
}

/// Drop the cached Codex version so the next stage probes again.
pub fn forget_codex_cli_version() {
    CODEX_VERSION_CACHE.forget();
}

static CODEX_VERSION_CACHE: VersionCache = VersionCache::new();

/// `<name> --version` with the login-shell PATH and environment the CLI
/// stages run with, read by `parse`.
fn probe_version(name: &str, parse: fn(&str) -> Option<String>) -> Option<String> {
    use crate::orchestrator::cli_runner::{login_shell_env, resolve_executable, resolved_cli_path};
    let path_env = resolved_cli_path();
    let bin = resolve_executable(name, &path_env)?;
    let mut cmd = Command::new(bin);
    cmd.arg("--version");
    for (k, v) in login_shell_env() {
        cmd.env(k, v);
    }
    cmd.env("PATH", &path_env);
    parse(&run_bounded(cmd, VERSION_TIMEOUT)?)
}

// ─── `codex exec resume` probe ─────────────────────────────────────

/// True when the installed `codex` has `codex exec resume` in the shape
/// Octopush calls it (`… resume <SESSION_ID> -`, the prompt on stdin, with
/// `--json` in effect): read from `codex exec resume --help`, probed once per
/// app session with the same login-shell PATH the stages use. A missing CLI,
/// a non-zero exit or a timeout reads as unsupported, so the stage runs
/// fresh. A stale answer is safe: an `exec resume` that is gone fails at
/// once with an argument error, and the runner then runs the stage fresh.
pub fn codex_exec_resume_supported() -> bool {
    static PROBE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *PROBE.get_or_init(|| probe_codex_exec_resume_help().is_some_and(|h| codex_help_lists_exec_resume(&h)))
}

/// `codex exec resume --help` lists what the resumed argv relies on: the
/// subcommand's usage line, the `SESSION_ID` and `PROMPT` positionals, `-`
/// reading the prompt from stdin, and `--json`. Pinned by the recorded help
/// in `tests/fixtures/codex/<version>/exec-resume-help.txt`. Pure.
pub fn codex_help_lists_exec_resume(help: &str) -> bool {
    help.contains("Usage: codex exec resume")
        && help.contains("[SESSION_ID]")
        && help.contains("[PROMPT]")
        && help.contains("If `-` is used, read from stdin")
        && help.contains("--json")
}

fn probe_codex_exec_resume_help() -> Option<String> {
    use crate::orchestrator::cli_runner::{login_shell_env, resolve_executable, resolved_cli_path};
    let path_env = resolved_cli_path();
    let bin = resolve_executable("codex", &path_env)?;
    let mut cmd = Command::new(bin);
    cmd.args(["exec", "resume", "--help"]);
    for (k, v) in login_shell_env() {
        cmd.env(k, v);
    }
    cmd.env("PATH", &path_env);
    run_bounded(cmd, VERSION_TIMEOUT)
}

// ─── `claude auth status` → claude.ai sign-in end (2.1.318+) ──────

/// `--json` is asked for explicitly (it is the default today, see
/// `claude auth status --help`), so a future default change can't turn the
/// answer into text.
pub const CLAUDE_AUTH_STATUS_ARGS: [&str; 3] = ["auth", "status", "--json"];

/// The Claude Code release whose `claude auth status` reports
/// `loginExpiresAt` (changelog 2.1.318). Older CLIs never say when the
/// sign-in ends, so Check again can't read a new date from them.
pub const CLAUDE_LOGIN_END_SINCE: &str = "2.1.318";

/// How long `claude auth status` may run. It may refresh the OAuth token,
/// and interrupting that can sign the user out (Claude Code changelog
/// 2.1.301 and 2.1.317), so it gets far longer than a Readiness check, a
/// SIGTERM before the SIGKILL, and is left running at quit.
pub const CLAUDE_AUTH_STATUS_TIMEOUT: Duration = Duration::from_secs(15);

/// What quitting does to a running `claude auth status`: nothing. It runs in
/// its own group, so it finishes the refresh on its own after the app exits.
pub const CLAUDE_AUTH_STATUS_ON_QUIT: crate::readiness::OnQuit = crate::readiness::OnQuit::Leave;

/// How long a timed-out `claude auth status` has after SIGTERM to save what
/// it was writing before its group is SIGKILLed.
pub const CLAUDE_AUTH_STATUS_TERM_GRACE: Duration = Duration::from_secs(2);

/// What `claude auth status` said about the claude.ai sign-in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaudeLoginProbe {
    /// Signed in; the stored sign-in ends at this epoch second
    /// (`loginExpiresAt`, Claude Code 2.1.318+).
    SignedIn(i64),
    /// `loggedIn: false`: there is no sign-in, so no stored end applies.
    SignedOut,
    /// Not asked, missing, timed out, an older CLI without the field, or
    /// output that isn't the JSON object: nothing is known.
    Unknown,
}

impl ClaudeLoginProbe {
    /// The sign-in end, when signed in with one.
    pub fn expires_at(self) -> Option<i64> {
        match self {
            ClaudeLoginProbe::SignedIn(e) => Some(e),
            _ => None,
        }
    }
}

/// Read `claude auth status --json`. `loggedIn: false` is
/// [`ClaudeLoginProbe::SignedOut`] whatever else it prints;
/// `loginExpiresAt` (Claude Code 2.1.318+) gives
/// [`ClaudeLoginProbe::SignedIn`]; anything else is
/// [`ClaudeLoginProbe::Unknown`]. The date format isn't documented, so
/// RFC 3339 text and epoch seconds or milliseconds are all accepted. Text
/// around the object (a stderr warning) is skipped.
pub fn parse_claude_auth_status(output: &str) -> ClaudeLoginProbe {
    let object = || -> Option<serde_json::Value> {
        let start = output.find('{')?;
        let end = output.rfind('}')?;
        serde_json::from_str(output.get(start..=end)?).ok()
    };
    let Some(v) = object() else { return ClaudeLoginProbe::Unknown };
    if v.get("loggedIn").and_then(serde_json::Value::as_bool) == Some(false) {
        return ClaudeLoginProbe::SignedOut;
    }
    match v.get("loginExpiresAt").and_then(crate::orchestrator::cli_runner::expiry_secs) {
        Some(e) => ClaudeLoginProbe::SignedIn(e),
        None => ClaudeLoginProbe::Unknown,
    }
}

/// `claude auth status --json` with the login-shell PATH and environment the
/// CLI stages use, through the Readiness probe runner (output capped, its
/// process group SIGTERMed then SIGKILLed after
/// [`CLAUDE_AUTH_STATUS_TIMEOUT`], left running at quit). What it prints (the
/// account too) stays in memory: only the date and whether it is signed in
/// are kept.
pub fn probe_claude_login() -> ClaudeLoginProbe {
    use crate::readiness::{local_command, run_probe_terminating, Probe};
    let cmd = local_command("claude", &CLAUDE_AUTH_STATUS_ARGS);
    match run_probe_terminating(cmd, CLAUDE_AUTH_STATUS_TIMEOUT, CLAUDE_AUTH_STATUS_TERM_GRACE, CLAUDE_AUTH_STATUS_ON_QUIT) {
        Probe::Exited { output, .. } => parse_claude_auth_status(&output),
        Probe::Missing | Probe::TimedOut => ClaudeLoginProbe::Unknown,
    }
}

// ─── Claude Code hooks (Run-mode attention, #287) ─────────────────
//
// In a worktree Octopush created, `Notification` (`permission_prompt`,
// `idle_prompt`, `elicitation_dialog`, `elicitation_url_dialog`) and `Stop`
// hooks go into `.claude/settings.local.json`,
// merged with whatever the user keeps there. Each runs `octopush-mcp hook`,
// which reads the payload below from stdin. A `Notification` hook also passes
// `--kind <signal>` for the matcher it is registered under, so the matcher
// Claude Code fired on decides the signal, not a payload field name.

/// The worktree-local Claude Code settings file the hooks live in.
pub const LOCAL_SETTINGS_FILE: &str = ".claude/settings.local.json";

/// Ends every hook command Octopush installs, so re-installing or removing
/// touches only ours. A marker in the command rather than an extra JSON key:
/// Claude Code drops a settings file whose keys it doesn't know.
pub const HOOK_MARKER: &str = "--octopush-hook";

/// Precedes the signal a `Notification` hook was registered for.
pub const HOOK_KIND_FLAG: &str = "--kind";

/// An MCP server's elicitation (a form or a URL) waits on the human too (#594).
const NOTIFICATION_MATCHERS: [(&str, HookSignal); 4] = [
    ("permission_prompt", HookSignal::NeedsPermission),
    ("idle_prompt", HookSignal::NeedsInput),
    ("elicitation_dialog", HookSignal::NeedsInput),
    ("elicitation_url_dialog", HookSignal::NeedsInput),
];

/// What a hook payload means: for the attention beacon, or for which Claude
/// Code session a terminal runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookSignal {
    /// `Notification` / `permission_prompt` — waiting on permission.
    NeedsPermission,
    /// `Notification` / `idle_prompt`, `elicitation_dialog`,
    /// `elicitation_url_dialog` — waiting on your input.
    NeedsInput,
    /// `Stop` — Claude finished its turn.
    Settled,
    /// `SessionStart` — a session began in the terminal: `claude` started, or
    /// `/clear`, `/resume`, `--resume`, `--continue`, a fork or a compaction
    /// gave the process the session the payload names.
    SessionStarted,
    /// `SessionEnd` — the session the payload names is over: `/exit`,
    /// `/clear`, `/resume` to another, logout, or the process was signalled.
    SessionEnded,
}

impl HookSignal {
    pub fn as_str(self) -> &'static str {
        match self {
            HookSignal::NeedsPermission => "permission",
            HookSignal::NeedsInput => "input",
            HookSignal::Settled => "settled",
            HookSignal::SessionStarted => "session-start",
            HookSignal::SessionEnded => "session-end",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "permission" => Some(HookSignal::NeedsPermission),
            "input" => Some(HookSignal::NeedsInput),
            "settled" => Some(HookSignal::Settled),
            "session-start" => Some(HookSignal::SessionStarted),
            "session-end" => Some(HookSignal::SessionEnded),
            _ => None,
        }
    }

    /// The two signals that say which session a terminal runs, not that it
    /// wants the user. Their hooks are installed silent ([`hook_command`]).
    pub fn is_session(self) -> bool {
        matches!(self, HookSignal::SessionStarted | HookSignal::SessionEnded)
    }
}

/// The variable Claude Code sets in a hook's environment to say how the
/// session was started: `cli` for the interactive terminal UI, `sdk-cli` for
/// print mode (`claude -p`), other `sdk-…` values for the Agent SDKs (seen
/// live on 2.1.327; fixtures `claude-code/2.1.327`).
pub const ENTRYPOINT_ENV: &str = "CLAUDE_CODE_ENTRYPOINT";

/// Whether a hook's session is the one a person drives in the terminal.
/// Print mode and the SDKs are not: a `claude -p` the agent itself runs
/// inherits the terminal's id, and must never be taken for the terminal's
/// session. An unset or unknown value counts as interactive, which is what a
/// CLI that doesn't set the variable was before.
pub fn interactive_entrypoint(entrypoint: Option<&str>) -> bool {
    !entrypoint.map(str::trim).is_some_and(|e| e.starts_with("sdk"))
}

/// A hook payload reduced to what Octopush keeps: never the message text or
/// the transcript path.
#[derive(Debug, Clone, PartialEq)]
pub struct HookEvent {
    pub signal: HookSignal,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
}

/// Read a hook's stdin payload. Keyed on `hook_event_name`; for a
/// `Notification`, the `--kind` the hook was registered with (`kind`) wins,
/// and only without one is `notification_type` read. Anything else is `None`.
pub fn parse_hook_event(payload: &serde_json::Value, kind: Option<&str>) -> Option<HookEvent> {
    let signal = match payload.get("hook_event_name")?.as_str()? {
        "Notification" => match kind.and_then(HookSignal::parse) {
            Some(s @ (HookSignal::NeedsPermission | HookSignal::NeedsInput)) => s,
            _ => {
                let kind = payload.get("notification_type")?.as_str()?;
                NOTIFICATION_MATCHERS.iter().find(|(m, _)| *m == kind)?.1
            }
        },
        "Stop" => HookSignal::Settled,
        "SessionStart" => HookSignal::SessionStarted,
        "SessionEnd" => HookSignal::SessionEnded,
        _ => return None,
    };
    let text = |key: &str| payload.get(key).and_then(serde_json::Value::as_str).map(str::to_string);
    Some(HookEvent { signal, session_id: text("session_id"), cwd: text("cwd") })
}

/// The command each hook runs: the quoted `octopush-mcp` path, `--kind` for a
/// `Notification` matcher, then the marker.
pub fn hook_command(hook_bin: &Path, kind: Option<HookSignal>) -> String {
    let bin = hook_bin.to_string_lossy().replace('\'', r"'\''");
    match kind {
        Some(k) => format!("'{bin}' hook {HOOK_KIND_FLAG} {} {HOOK_MARKER}", k.as_str()),
        None => format!("'{bin}' hook {HOOK_MARKER}"),
    }
}

/// Sends a hook command's output nowhere. A redirection may stand anywhere
/// in a simple command, so the marker still ends it.
const SILENCE: &str = ">/dev/null 2>&1";

/// The command the `SessionStart` and `SessionEnd` hooks run: the same
/// binary, with stdout and stderr discarded by the shell itself. Claude Code
/// adds a `SessionStart` hook's stdout to the conversation, so this command
/// must not be able to print whatever the binary does; `octopush-mcp hook`
/// prints nothing anyway.
pub fn session_hook_command(hook_bin: &Path) -> String {
    let bin = hook_bin.to_string_lossy().replace('\'', r"'\''");
    format!("'{bin}' hook {SILENCE} {HOOK_MARKER}")
}

fn is_octopush_hook(hook: &serde_json::Value) -> bool {
    hook.get("command")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|c| c.trim_end().ends_with(HOOK_MARKER))
}

/// `settings` without any Octopush hook. Everything else is kept; a matcher
/// group, event list or `hooks` object is dropped only when removing ours
/// emptied it.
pub fn strip_claude_hooks(mut settings: serde_json::Value) -> serde_json::Value {
    let mut drop_hooks = false;
    if let Some(hooks) = settings.get_mut("hooks").and_then(serde_json::Value::as_object_mut) {
        let mut emptied = false;
        hooks.retain(|_, groups| {
            let Some(list) = groups.as_array_mut() else { return true };
            let before = list.len();
            list.retain_mut(|group| {
                let Some(inner) = group.get_mut("hooks").and_then(serde_json::Value::as_array_mut) else {
                    return true;
                };
                let had = inner.len();
                inner.retain(|h| !is_octopush_hook(h));
                inner.len() == had || !inner.is_empty()
            });
            let keep = list.len() == before || !list.is_empty();
            emptied |= !keep;
            keep
        });
        drop_hooks = emptied && hooks.is_empty();
    }
    if drop_hooks {
        if let Some(obj) = settings.as_object_mut() {
            obj.remove("hooks");
        }
    }
    settings
}

/// `settings` with Octopush's hooks (re)installed for `hook_bin`, or `None`
/// when its shape isn't one we can merge into (then the file is left alone).
/// Ours are stripped first, so re-installing brings a worktree hooked by an
/// earlier version up to the current set (the launch sweep does this for
/// every worktree it keeps hooked).
pub fn merge_claude_hooks(settings: serde_json::Value, hook_bin: &Path) -> Option<serde_json::Value> {
    use serde_json::json;
    let mut settings = strip_claude_hooks(settings);
    let hooks = settings.as_object_mut()?.entry("hooks").or_insert_with(|| json!({}));
    let hooks = hooks.as_object_mut()?;
    let ours = |kind: Option<HookSignal>| {
        json!({ "type": "command", "command": hook_command(hook_bin, kind), "async": true })
    };
    let mut add = |event: &str, group: serde_json::Value| -> Option<()> {
        hooks.entry(event).or_insert_with(|| json!([])).as_array_mut()?.push(group);
        Some(())
    };
    for (matcher, kind) in NOTIFICATION_MATCHERS {
        add("Notification", json!({ "matcher": matcher, "hooks": [ours(Some(kind))] }))?;
    }
    add("Stop", json!({ "hooks": [ours(None)] }))?;
    // Which session the terminal runs. No matcher: every source (startup,
    // resume, clear, compact, fork) and every reason counts. `SessionStart`
    // is async like the rest, so it never delays the prompt. `SessionEnd` is
    // not: an async hook can be dropped as the process exits, and this one
    // must land (it takes a few milliseconds, inside Claude Code's 1.5 s
    // budget for `SessionEnd` hooks).
    let session = session_hook_command(hook_bin);
    add("SessionStart", json!({ "hooks": [{ "type": "command", "command": session, "async": true }] }))?;
    add("SessionEnd", json!({ "hooks": [{ "type": "command", "command": session }] }))?;
    Some(settings)
}

/// Whether `path` (or what's there) is a symlink. A missing path is not.
fn is_symlink(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink())
}

/// Whether the hooks file can be written without leaving the worktree:
/// neither `<worktree>/.claude` nor the settings file may be a symlink. A repo
/// that commits `.claude` as a link (to `~/.claude`, say) would otherwise have
/// the install write — and the removal delete — a file outside the worktree.
/// The temp sibling is created fresh (see [`write_settings`]), never through a
/// link.
fn local_settings_in_worktree(worktree: &Path) -> bool {
    let path = worktree.join(LOCAL_SETTINGS_FILE);
    let dir_ok = path.parent().is_none_or(|d| !is_symlink(d));
    dir_ok && !is_symlink(&path)
}

/// Install the hooks into `<worktree>/.claude/settings.local.json`. A missing
/// file counts as `{}`; one that isn't valid JSON (or isn't an object) is
/// never overwritten — `Ok(false)`, the install is skipped.
pub fn install_claude_hooks(worktree: &Path, hook_bin: &Path) -> std::io::Result<bool> {
    if !local_settings_in_worktree(worktree) {
        return Ok(false);
    }
    let path = worktree.join(LOCAL_SETTINGS_FILE);
    let current = match std::fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(v) => v,
            Err(_) => return Ok(false),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
        Err(e) => return Err(e),
    };
    let Some(next) = merge_claude_hooks(current.clone(), hook_bin) else {
        return Ok(false);
    };
    if next != current {
        write_settings(&path, &next)?;
    }
    Ok(true)
}

/// Remove Octopush's hooks from `<worktree>/.claude/settings.local.json`. The
/// file is deleted only when nothing but ours was in it; a missing or
/// unreadable file is left as it is.
pub fn remove_claude_hooks(worktree: &Path) -> std::io::Result<()> {
    if !local_settings_in_worktree(worktree) {
        return Ok(());
    }
    let path = worktree.join(LOCAL_SETTINGS_FILE);
    let Ok(text) = std::fs::read_to_string(&path) else { return Ok(()) };
    let Ok(current) = serde_json::from_str::<serde_json::Value>(&text) else { return Ok(()) };
    let next = strip_claude_hooks(current.clone());
    if next == current {
        return Ok(());
    }
    if next.as_object().is_some_and(|o| o.is_empty()) {
        std::fs::remove_file(&path)?;
        // `.claude/` too, but only if that left it empty.
        if let Some(dir) = path.parent() {
            let _ = std::fs::remove_dir(dir);
        }
        return Ok(());
    }
    write_settings(&path, &next)
}

/// Write via a sibling temp file + rename, so Claude Code never reads half a file.
/// Each write gets its own temp name, created new (an existing path or link
/// there fails it), so two writes never share or clobber one temp file.
fn write_settings(path: &Path, value: &serde_json::Value) -> std::io::Result<()> {
    use std::io::Write as _;
    use std::sync::atomic::{AtomicU64, Ordering};
    static WRITES: AtomicU64 = AtomicU64::new(0);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut text = serde_json::to_string_pretty(value).map_err(std::io::Error::other)?;
    text.push('\n');
    let n = WRITES.fetch_add(1, Ordering::Relaxed);
    let tmp = path.with_extension(format!("json.octopush-tmp-{}-{n}", std::process::id()));
    // Not ours to clean up when it couldn't be created.
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
    let written = file.write_all(text.as_bytes());
    drop(file);
    if let Err(e) = written.and_then(|()| std::fs::rename(&tmp, path)) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

/// Run `cmd` to completion and return its stdout, or `None` when it can't
/// start, exits non-zero, or outlives `timeout` (then it is killed).
fn run_bounded(mut cmd: Command, timeout: Duration) -> Option<String> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                let mut out = String::new();
                child.stdout.take()?.read_to_string(&mut out).ok()?;
                return Some(out);
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_version_is_parsed_from_cli_output() {
        assert_eq!(parse_claude_version("2.1.316 (Claude Code)\n").as_deref(), Some("2.1.316"));
        assert_eq!(parse_claude_version("2.1.9").as_deref(), Some("2.1.9"));
        assert_eq!(parse_claude_version("Claude Code v2.2.0").as_deref(), Some("2.2.0"));
        assert_eq!(parse_claude_version("(2.1.320-beta.1)").as_deref(), Some("2.1.320"));
        assert_eq!(parse_claude_version("claude: command not found"), None);
        assert_eq!(parse_claude_version("2.1 (Claude Code)"), None);
        assert_eq!(parse_claude_version("1.2.3.4"), None);
        assert_eq!(parse_claude_version(""), None);
    }

    #[test]
    fn floor_comparison_is_numeric() {
        assert!(version_below("2.1.307", "2.1.314"));
        assert!(version_below("2.1.99", "2.1.314"));
        assert!(version_below("1.9.999", "2.0.0"));
        assert!(!version_below("2.1.314", "2.1.314"));
        assert!(!version_below("2.1.316", "2.1.314"));
        assert!(!version_below("2.2.0", "2.1.314"));
        assert!(!version_below("garbage", "2.1.314"));
        assert!(!version_below("2.1.0", "garbage"));
    }

    #[test]
    fn only_a_known_old_version_warns() {
        let old = ClaudeCliVersion::new(Some("2.1.307".into()), "2.1.314");
        assert!(old.below_floor);
        let note = old.update_notice().expect("old CLI warns");
        // The floor still trips the 2.1.325 security fix: recommend that.
        assert!(note.contains("2.1.307") && note.contains("older than 2.1.314"), "{note}");
        assert!(note.contains("2.1.325 or newer recommended"), "{note}");

        let current = ClaudeCliVersion::new(Some("2.1.316".into()), "2.1.314");
        assert!(!current.below_floor);
        assert_eq!(current.update_notice(), None);

        let unknown = ClaudeCliVersion::new(None, "2.1.314");
        assert!(!unknown.below_floor);
        assert_eq!(unknown.update_notice(), None);
    }

    #[test]
    fn hooks_need_a_known_version_at_the_floor() {
        assert!(ClaudeCliVersion::new(Some("2.1.314".into()), "2.1.314").supports_hooks());
        assert!(ClaudeCliVersion::new(Some("2.2.0".into()), "2.1.314").supports_hooks());
        assert!(!ClaudeCliVersion::new(Some("2.1.307".into()), "2.1.314").supports_hooks());
        assert!(!ClaudeCliVersion::new(None, "2.1.314").supports_hooks(), "unknown means no hooks");
    }

    const BIN: &str = "/Applications/Octopush.app/Contents/MacOS/octopush-mcp";

    fn our_commands(settings: &serde_json::Value) -> Vec<(String, Option<String>)> {
        let mut out = Vec::new();
        for (event, groups) in settings["hooks"].as_object().into_iter().flatten() {
            for g in groups.as_array().into_iter().flatten() {
                for h in g["hooks"].as_array().into_iter().flatten() {
                    if is_octopush_hook(h) {
                        out.push((event.clone(), g["matcher"].as_str().map(str::to_string)));
                    }
                }
            }
        }
        out
    }

    #[test]
    fn hook_command_quotes_the_binary_and_ends_with_the_marker() {
        assert_eq!(hook_command(Path::new(BIN), None), format!("'{BIN}' hook --octopush-hook"));
        assert_eq!(
            hook_command(Path::new(BIN), Some(HookSignal::NeedsPermission)),
            format!("'{BIN}' hook --kind permission --octopush-hook")
        );
        assert_eq!(
            hook_command(Path::new("/a b/it's/octopush-mcp"), Some(HookSignal::NeedsInput)),
            r"'/a b/it'\''s/octopush-mcp' hook --kind input --octopush-hook"
        );
    }

    #[test]
    fn merge_into_an_empty_file_registers_the_attention_and_session_hooks() {
        let merged = merge_claude_hooks(serde_json::json!({}), Path::new(BIN)).unwrap();
        let mut ours = our_commands(&merged);
        ours.sort();
        assert_eq!(ours, [
            ("Notification".to_string(), Some("elicitation_dialog".to_string())),
            ("Notification".to_string(), Some("elicitation_url_dialog".to_string())),
            ("Notification".to_string(), Some("idle_prompt".to_string())),
            ("Notification".to_string(), Some("permission_prompt".to_string())),
            ("SessionEnd".to_string(), None),
            ("SessionStart".to_string(), None),
            ("Stop".to_string(), None),
        ]);
        // The session hooks run the silent command. SessionStart is async;
        // SessionEnd is not, so it lands before the process is gone.
        let start = &merged["hooks"]["SessionStart"][0]["hooks"][0];
        let end = &merged["hooks"]["SessionEnd"][0]["hooks"][0];
        assert_eq!(start["command"], session_hook_command(Path::new(BIN)));
        assert_eq!(end["command"], session_hook_command(Path::new(BIN)));
        assert_eq!((start["type"].as_str(), start["async"].as_bool()), (Some("command"), Some(true)));
        assert_eq!((end["type"].as_str(), end.get("async")), (Some("command"), None));
        assert!(merged["hooks"]["SessionStart"][0].get("matcher").is_none(), "every source");
        let notifications = merged["hooks"]["Notification"].as_array().unwrap();
        assert!(notifications.iter().all(|g| g["hooks"][0]["async"] == true));
        let hook = &merged["hooks"]["Stop"][0]["hooks"][0];
        assert_eq!(hook["type"], "command");
        assert_eq!(hook["async"], true);
        assert_eq!(hook["command"], hook_command(Path::new(BIN), None));
        // Each matcher passes its own kind, so the matcher decides the signal.
        let command = |i: usize| merged["hooks"]["Notification"][i]["hooks"][0]["command"].clone();
        assert_eq!(command(0), hook_command(Path::new(BIN), Some(HookSignal::NeedsPermission)));
        assert_eq!(command(1), hook_command(Path::new(BIN), Some(HookSignal::NeedsInput)));
        assert_eq!(command(2), hook_command(Path::new(BIN), Some(HookSignal::NeedsInput)));
        assert_eq!(command(3), hook_command(Path::new(BIN), Some(HookSignal::NeedsInput)));
    }

    #[test]
    fn re_installing_upgrades_a_two_matcher_install_in_place() {
        // What a worktree hooked before #594 holds, beside the user's own hook.
        let ours = |kind: &str| {
            serde_json::json!({ "type": "command", "async": true,
                "command": format!("'{BIN}' hook --kind {kind} --octopush-hook") })
        };
        let user_hook = serde_json::json!({ "matcher": "idle_prompt", "hooks": [{ "type": "command", "command": "say idle" }] });
        let old = serde_json::json!({
            "permissions": { "allow": ["Bash(npm test)"] },
            "hooks": {
                "Notification": [
                    user_hook.clone(),
                    { "matcher": "permission_prompt", "hooks": [ours("permission")] },
                    { "matcher": "idle_prompt", "hooks": [ours("input")] }
                ],
                "Stop": [{ "hooks": [{ "type": "command", "async": true, "command": format!("'{BIN}' hook --octopush-hook") }] }]
            }
        });
        let wt = tempfile::tempdir().unwrap();
        let file = wt.path().join(LOCAL_SETTINGS_FILE);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, old.to_string()).unwrap();
        let read = || -> serde_json::Value { serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap() };

        // The launch sweep re-runs this install for every worktree it keeps hooked.
        assert!(install_claude_hooks(wt.path(), Path::new(BIN)).unwrap());
        let upgraded = read();
        let matchers: Vec<_> = our_commands(&upgraded)
            .into_iter()
            .filter(|(event, _)| event == "Notification" || event == "Stop")
            .map(|(_, m)| m)
            .collect();
        assert_eq!(matchers, [
            Some("permission_prompt".to_string()),
            Some("idle_prompt".to_string()),
            Some("elicitation_dialog".to_string()),
            Some("elicitation_url_dialog".to_string()),
            None,
        ]);
        // A worktree hooked before the session hooks existed gets them too,
        // with nothing for the user to do.
        let events: Vec<_> = our_commands(&upgraded).into_iter().map(|(event, _)| event).collect();
        assert!(events.contains(&"SessionStart".to_string()) && events.contains(&"SessionEnd".to_string()), "{events:?}");
        assert_eq!(upgraded["permissions"], old["permissions"]);
        assert_eq!(upgraded["hooks"]["Notification"][0], user_hook, "the user's hook stays first");
        // Another sweep changes nothing; removal gives the user's settings back.
        assert!(install_claude_hooks(wt.path(), Path::new(BIN)).unwrap());
        assert_eq!(read(), upgraded);
        remove_claude_hooks(wt.path()).unwrap();
        assert_eq!(read(), serde_json::json!({
            "permissions": { "allow": ["Bash(npm test)"] },
            "hooks": { "Notification": [user_hook] }
        }));
    }

    #[test]
    fn merge_keeps_the_users_settings_and_hooks_and_replaces_only_ours() {
        let user = serde_json::json!({
            "permissions": { "allow": ["Bash(npm test)"] },
            "hooks": {
                "Stop": [{ "hooks": [{ "type": "command", "command": "say done" }] }],
                "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "./guard.sh" }] }]
            }
        });
        let once = merge_claude_hooks(user.clone(), Path::new("/old/octopush-mcp")).unwrap();
        // Re-installing from a moved app replaces ours instead of adding more.
        let twice = merge_claude_hooks(once, Path::new(BIN)).unwrap();
        assert_eq!(our_commands(&twice).len(), 7);
        assert!(!twice.to_string().contains("/old/octopush-mcp"));
        assert_eq!(twice["permissions"], user["permissions"]);
        assert_eq!(twice["hooks"]["PreToolUse"], user["hooks"]["PreToolUse"]);
        assert_eq!(twice["hooks"]["Stop"][0], user["hooks"]["Stop"][0], "the user's Stop hook stays first");
        // Stripping gives the user's file back exactly.
        assert_eq!(strip_claude_hooks(twice), user);
    }

    #[test]
    fn strip_leaves_a_users_hook_that_shares_a_group_with_ours() {
        let shared = serde_json::json!({ "hooks": { "Stop": [{ "hooks": [
            { "type": "command", "command": "say done" },
            { "type": "command", "command": hook_command(Path::new(BIN), None) }
        ] }] } });
        let stripped = strip_claude_hooks(shared);
        assert_eq!(stripped, serde_json::json!({ "hooks": { "Stop": [{ "hooks": [
            { "type": "command", "command": "say done" }
        ] }] } }));
        // A `Notification` hook installed before `--kind` (no kind) is still ours.
        let old = serde_json::json!({ "hooks": { "Notification": [{ "matcher": "idle_prompt", "hooks": [
            { "type": "command", "command": format!("'{BIN}' hook --octopush-hook") }
        ] }] } });
        assert_eq!(strip_claude_hooks(old), serde_json::json!({}));
        // The user's own empty containers are theirs to keep.
        let empty = serde_json::json!({ "hooks": { "Stop": [] } });
        assert_eq!(strip_claude_hooks(empty.clone()), empty);
    }

    #[test]
    fn the_session_hook_command_keeps_the_marker_last_and_discards_all_output() {
        let cmd = session_hook_command(Path::new(BIN));
        assert_eq!(cmd, format!("'{BIN}' hook >/dev/null 2>&1 --octopush-hook"));
        // Still ours to re-install and to strip.
        assert!(is_octopush_hook(&serde_json::json!({ "type": "command", "command": cmd })));
        let merged = merge_claude_hooks(serde_json::json!({}), Path::new(BIN)).unwrap();
        assert_eq!(strip_claude_hooks(merged), serde_json::json!({}));
    }

    /// Claude Code adds a `SessionStart` hook's stdout to the conversation.
    /// Whatever the binary behind the command prints, to either stream, the
    /// installed command lets none of it out, and still hands it the payload
    /// and the arguments.
    #[cfg(unix)]
    #[test]
    fn the_session_hook_command_is_silent_even_when_its_binary_prints() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        // A stand-in for `octopush-mcp` that is as loud as it can be. The
        // path has a space and a quote, as an app bundle's can.
        let bin = dir.path().join("it's a bin");
        let seen = dir.path().join("seen");
        std::fs::write(
            &bin,
            format!("#!/bin/sh\necho LOUD-STDOUT\necho LOUD-STDERR >&2\n{{ echo \"$@\"; cat; }} > '{}'\n", seen.display()),
        )
        .unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let run = |command: &str| {
            let mut child = std::process::Command::new("sh")
                .arg("-c")
                .arg(command)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            child.stdin.take().unwrap().write_all(br#"{"hook_event_name":"SessionStart"}"#).unwrap();
            child.wait_with_output().unwrap()
        };
        let out = run(&session_hook_command(&bin));
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout), "", "nothing reaches the conversation");
        assert_eq!(String::from_utf8_lossy(&out.stderr), "");
        assert_eq!(
            std::fs::read_to_string(&seen).unwrap(),
            "hook --octopush-hook\n{\"hook_event_name\":\"SessionStart\"}",
            "the binary still gets its arguments and the payload",
        );
        // The stand-in really is loud: the other hooks' command shows it.
        let loud = run(&hook_command(&bin, None));
        assert!(String::from_utf8_lossy(&loud.stdout).contains("LOUD-STDOUT"));
    }

    #[test]
    fn hook_payloads_for_a_session_start_and_end_map_to_session_signals() {
        let p = |v: serde_json::Value| parse_hook_event(&v, None);
        let start = p(serde_json::json!({ "hook_event_name": "SessionStart", "source": "clear", "session_id": "s2", "cwd": "/wt" })).unwrap();
        assert_eq!((start.signal, start.session_id.as_deref()), (HookSignal::SessionStarted, Some("s2")));
        let end = p(serde_json::json!({ "hook_event_name": "SessionEnd", "reason": "prompt_input_exit", "session_id": "s1" })).unwrap();
        assert_eq!((end.signal, end.session_id.as_deref()), (HookSignal::SessionEnded, Some("s1")));
        for s in [HookSignal::SessionStarted, HookSignal::SessionEnded] {
            assert_eq!(HookSignal::parse(s.as_str()), Some(s));
            assert!(s.is_session());
        }
        assert!(!HookSignal::Settled.is_session());
        // Print mode and the SDKs are not the session a person drives.
        assert!(interactive_entrypoint(Some("cli")));
        assert!(interactive_entrypoint(None), "a CLI that doesn't say is taken as before");
        assert!(interactive_entrypoint(Some("claude-vscode")));
        assert!(!interactive_entrypoint(Some("sdk-cli")));
        assert!(!interactive_entrypoint(Some("sdk-ts")));
    }

    #[test]
    fn merge_refuses_shapes_it_cannot_merge_into() {
        let bin = Path::new(BIN);
        assert_eq!(merge_claude_hooks(serde_json::json!([]), bin), None);
        assert_eq!(merge_claude_hooks(serde_json::json!({ "hooks": "nope" }), bin), None);
        assert_eq!(merge_claude_hooks(serde_json::json!({ "hooks": { "Stop": {} } }), bin), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_claude_dir_or_file_is_never_written_through() {
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("settings.local.json");
        std::fs::write(&target, "{}").unwrap();

        // `.claude` committed as a link to a directory outside the worktree.
        let wt = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), wt.path().join(".claude")).unwrap();
        assert!(!install_claude_hooks(wt.path(), Path::new(BIN)).unwrap());
        remove_claude_hooks(wt.path()).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "{}");

        // The settings file itself a link.
        let wt = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(wt.path().join(".claude")).unwrap();
        std::os::unix::fs::symlink(&target, wt.path().join(LOCAL_SETTINGS_FILE)).unwrap();
        assert!(!install_claude_hooks(wt.path(), Path::new(BIN)).unwrap());
        remove_claude_hooks(wt.path()).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "{}");
        assert!(outside.path().read_dir().unwrap().count() == 1, "nothing else written outside");
    }

    #[test]
    fn each_write_uses_its_own_temp_file_and_leaves_none_behind() {
        let wt = tempfile::tempdir().unwrap();
        let file = wt.path().join(LOCAL_SETTINGS_FILE);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        // A leftover from the old fixed temp name doesn't block or get written.
        let old_tmp = file.with_extension("json.octopush-tmp");
        std::fs::write(&old_tmp, "stale").unwrap();
        let user = serde_json::json!({ "permissions": { "deny": ["Read(.env)"] } });
        std::fs::write(&file, user.to_string()).unwrap();

        assert!(install_claude_hooks(wt.path(), Path::new(BIN)).unwrap());
        assert!(install_claude_hooks(wt.path(), Path::new("/moved/octopush-mcp")).unwrap());
        remove_claude_hooks(wt.path()).unwrap();
        let mut names: Vec<_> = std::fs::read_dir(file.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        assert_eq!(names, ["settings.local.json", "settings.local.json.octopush-tmp"]);
        assert_eq!(std::fs::read_to_string(&old_tmp).unwrap(), "stale");
        let back: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(back, user);
    }

    #[test]
    fn install_and_remove_round_trip_on_disk() {
        let wt = tempfile::tempdir().unwrap();
        let file = wt.path().join(LOCAL_SETTINGS_FILE);

        // No file: created, then removed with its `.claude/` directory.
        assert!(install_claude_hooks(wt.path(), Path::new(BIN)).unwrap());
        let written: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(our_commands(&written).len(), 7);
        remove_claude_hooks(wt.path()).unwrap();
        assert!(!file.exists() && !wt.path().join(".claude").exists());

        // The user's file: merged, then given back.
        let user = serde_json::json!({ "permissions": { "deny": ["Read(.env)"] } });
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, user.to_string()).unwrap();
        assert!(install_claude_hooks(wt.path(), Path::new(BIN)).unwrap());
        remove_claude_hooks(wt.path()).unwrap();
        let back: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(back, user);

        // A file that isn't JSON is never overwritten.
        std::fs::write(&file, "{ not json").unwrap();
        assert!(!install_claude_hooks(wt.path(), Path::new(BIN)).unwrap());
        remove_claude_hooks(wt.path()).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "{ not json");
    }

    #[test]
    fn hook_payloads_map_to_signals() {
        let p = |v: serde_json::Value| parse_hook_event(&v, None).map(|e| e.signal);
        assert_eq!(p(serde_json::json!({ "hook_event_name": "Notification", "notification_type": "permission_prompt" })), Some(HookSignal::NeedsPermission));
        assert_eq!(p(serde_json::json!({ "hook_event_name": "Notification", "notification_type": "idle_prompt" })), Some(HookSignal::NeedsInput));
        // An MCP server's question, as a form or as a URL, waits on your input.
        assert_eq!(p(serde_json::json!({ "hook_event_name": "Notification", "notification_type": "elicitation_dialog" })), Some(HookSignal::NeedsInput));
        assert_eq!(p(serde_json::json!({ "hook_event_name": "Notification", "notification_type": "elicitation_url_dialog" })), Some(HookSignal::NeedsInput));
        let elicitation = serde_json::json!({ "hook_event_name": "Notification", "notification_type": "elicitation_dialog",
            "message": "secret text", "session_id": "s1", "cwd": "/wt" });
        assert_eq!(
            parse_hook_event(&elicitation, None),
            Some(HookEvent { signal: HookSignal::NeedsInput, session_id: Some("s1".into()), cwd: Some("/wt".into()) }),
            "the message text is never kept"
        );
        assert_eq!(p(serde_json::json!({ "hook_event_name": "Stop" })), Some(HookSignal::Settled));
        assert_eq!(p(serde_json::json!({ "hook_event_name": "Notification", "notification_type": "auth_success" })), None);
        assert_eq!(p(serde_json::json!({ "hook_event_name": "Notification" })), None);
        assert_eq!(p(serde_json::json!({ "hook_event_name": "PreToolUse" })), None);
        assert_eq!(p(serde_json::json!({})), None);
        for s in [HookSignal::NeedsPermission, HookSignal::NeedsInput, HookSignal::Settled] {
            assert_eq!(HookSignal::parse(s.as_str()), Some(s));
        }
    }

    #[test]
    fn the_hooks_kind_wins_over_the_payloads_notification_type() {
        let k = |v: serde_json::Value, kind: &str| parse_hook_event(&v, Some(kind)).map(|e| e.signal);
        let bare = serde_json::json!({ "hook_event_name": "Notification", "session_id": "s1" });
        // No `notification_type` at all (the field name is not confirmed upstream).
        assert_eq!(k(bare.clone(), "permission"), Some(HookSignal::NeedsPermission));
        assert_eq!(k(bare.clone(), "input"), Some(HookSignal::NeedsInput));
        assert_eq!(parse_hook_event(&bare, Some("input")).unwrap().session_id.as_deref(), Some("s1"));
        // The matcher Claude Code fired on is authoritative over the field.
        let idle = serde_json::json!({ "hook_event_name": "Notification", "notification_type": "idle_prompt" });
        assert_eq!(k(idle.clone(), "permission"), Some(HookSignal::NeedsPermission));
        // A kind that isn't a notification signal falls back to the field.
        assert_eq!(k(idle.clone(), "settled"), Some(HookSignal::NeedsInput));
        assert_eq!(k(idle, "bogus"), Some(HookSignal::NeedsInput));
        assert_eq!(k(bare, "settled"), None);
        // `Stop` is `Stop`, whatever kind; other events stay unmapped.
        assert_eq!(k(serde_json::json!({ "hook_event_name": "Stop" }), "permission"), Some(HookSignal::Settled));
        assert_eq!(k(serde_json::json!({ "hook_event_name": "PreToolUse" }), "permission"), None);
        assert_eq!(k(serde_json::json!({}), "permission"), None);
    }

    #[test]
    fn tested_floor_is_a_version() {
        assert_eq!(parse_claude_version(TESTED_CLAUDE_FLOOR).as_deref(), Some(TESTED_CLAUDE_FLOOR));
    }

    #[test]
    fn every_security_fix_is_a_version_with_a_reason() {
        assert!(!CLAUDE_SECURITY_FIXES.is_empty());
        for (v, reason) in CLAUDE_SECURITY_FIXES {
            assert_eq!(parse_claude_version(v).as_deref(), Some(*v), "{v} must be x.y.z");
            assert!(!reason.trim().is_empty() && !reason.ends_with('.'), "{v}: one line, no full stop");
        }
    }

    #[test]
    fn security_notice_below_at_and_above_the_fix() {
        let at = |v: Option<&str>| ClaudeCliVersion::new(v.map(Into::into), "2.1.314");
        let below = at(Some("2.1.316"));
        assert!(!below.below_floor, "independent of the tested floor");
        assert_eq!(
            below.security_notice().as_deref(),
            Some("Update Claude Code: 2.1.325 fixes the Bash sandbox not fully protecting a worktree's settings, hooks and shared git folder")
        );
        assert_eq!(below.security_fix.as_ref().map(|f| f.version.as_str()), Some("2.1.325"));
        // Each older fix release still lacks the newest fix: the notice names 2.1.325.
        for v in ["2.1.319", "2.1.321", "2.1.322", "2.1.323", "2.1.324"] {
            assert_eq!(at(Some(v)).security_fix.map(|f| f.version).as_deref(), Some("2.1.325"), "{v}");
        }
        assert_eq!(at(Some("2.1.325")).security_notice(), None);
        assert_eq!(at(Some("2.1.326")).security_notice(), None);
        assert_eq!(at(Some("2.2.0")).security_notice(), None);
        assert_eq!(at(None).security_notice(), None, "an unknown version never warns");
        // Below the floor too: both notes exist; surfaces pick which to show.
        assert!(at(Some("2.1.307")).below_floor && at(Some("2.1.307")).security_notice().is_some());
        assert_eq!(at(Some("2.1.307")).recommended, "2.1.325");

        // A stage journals each notice once.
        let notes = below.stage_notices();
        assert_eq!(notes.len(), 1);
        assert!(notes[0].contains("2.1.325 fixes the Bash sandbox not fully protecting") && notes[0].contains("installed: 2.1.316"), "{notes:?}");
        assert_eq!(at(Some("2.1.307")).stage_notices().len(), 2);
        assert!(at(Some("2.1.325")).stage_notices().is_empty());
        assert!(at(None).stage_notices().is_empty());
    }

    #[test]
    fn every_known_bad_release_is_a_version_with_a_reason() {
        assert!(!CLAUDE_KNOWN_BAD_RELEASES.is_empty());
        for (v, reason, _) in CLAUDE_KNOWN_BAD_RELEASES {
            assert!(version_key(v).is_some(), "{v}");
            assert!(!reason.trim().is_empty() && !reason.ends_with('.'), "{v}: one line, no full stop");
        }
    }

    #[test]
    fn known_bad_release_matches_the_exact_version_only() {
        let at = |v: Option<&str>| ClaudeCliVersion::new(v.map(Into::into), TESTED_CLAUDE_FLOOR);
        let bad = at(Some("2.1.329"));
        assert_eq!(
            bad.known_bad,
            Some(ClaudeKnownBadRelease {
                version: "2.1.329".into(),
                reason: "drops the retry gateway models need when a max_tokens error names a lower limit; 2.1.330 restores it"
                    .into(),
                scope: KnownBadScope::GatewayStages,
            })
        );
        assert_eq!(
            bad.known_bad_notice().as_deref(),
            Some("Claude Code 2.1.329 drops the retry gateway models need when a max_tokens error names a lower limit; 2.1.330 restores it")
        );
        assert!(bad.security_notice().is_none() && !bad.below_floor, "2.1.329 has every fix and is above the floor");
        assert!(at(Some("2.1.329-beta.1")).known_bad.is_some(), "a pre-release suffix is the same release");
        for v in ["2.1.328", "2.1.330", "2.2.329", "2.1.3290"] {
            assert_eq!(at(Some(v)).known_bad_notice(), None, "{v}: a known bad release is never a floor");
        }
        assert_eq!(at(None).known_bad, None, "an unknown version never warns");
        assert_eq!(known_bad_release("not a version", CLAUDE_KNOWN_BAD_RELEASES), None);
        let json = serde_json::to_value(&bad).unwrap();
        assert_eq!(json["knownBad"]["scope"], "gatewayStages");
    }

    #[test]
    fn known_bad_launch_note_is_for_gateway_stages_only() {
        let table = [("1.2.3", "drops a retry; 1.2.4 restores it", KnownBadScope::GatewayStages)];
        let models = |ms: &[&str]| ms.iter().map(|m| m.to_string()).collect::<Vec<_>>();
        let gateway = |m: &str| m.starts_with("gw/");
        assert_eq!(
            known_bad_launch_note(&models(&["claude-sonnet-5-5", "gw/kimi"]), Some("1.2.3"), &table, gateway).as_deref(),
            Some("Claude Code 1.2.3 drops a retry; 1.2.4 restores it. A stage on a gateway model may fail every turn; update Claude Code.")
        );
        assert_eq!(known_bad_launch_note(&models(&["claude-sonnet-5-5"]), Some("1.2.3"), &table, gateway), None, "no gateway stage");
        assert_eq!(known_bad_launch_note(&models(&["gw/kimi"]), Some("1.2.4"), &table, gateway), None, "another release");
        assert_eq!(known_bad_launch_note(&models(&["gw/kimi"]), None, &table, gateway), None, "version unknown");
        assert_eq!(known_bad_launch_note(&[], Some("1.2.3"), &table, gateway), None);
    }

    #[test]
    fn known_bad_stage_error_names_the_release_on_a_gateway_max_tokens_failure() {
        let table = [("1.2.3", "drops a retry; 1.2.4 restores it", KnownBadScope::GatewayStages)];
        let err = "API Error: 400 max_tokens: 64000 > 32768, the maximum allowed";
        assert_eq!(
            known_bad_stage_error(err, Some("1.2.3"), true, &table).as_deref(),
            Some(
                "Skip Claude Code 1.2.3 on a gateway model: it drops a retry; 1.2.4 restores it. \
                 Update Claude Code, then resume or re-run.\nAPI Error: 400 max_tokens: 64000 > 32768, the maximum allowed"
            )
        );
        assert!(known_bad_stage_error("Error: MAX_TOKENS exceeded", Some("1.2.3"), true, &table).is_some(), "any case");
        assert_eq!(known_bad_stage_error(err, Some("1.2.3"), false, &table), None, "a built-in model");
        assert_eq!(known_bad_stage_error(err, Some("1.2.4"), true, &table), None, "another release");
        assert_eq!(known_bad_stage_error(err, None, true, &table), None, "version unknown");
        assert_eq!(known_bad_stage_error("overloaded", Some("1.2.3"), true, &table), None, "another error");
    }

    #[test]
    fn security_fix_rows_are_in_version_order() {
        let keys: Vec<_> = CLAUDE_SECURITY_FIXES.iter().map(|(v, _)| version_key(v)).collect();
        assert!(keys.windows(2).all(|w| w[0] < w[1]), "oldest first, no duplicates: {CLAUDE_SECURITY_FIXES:?}");
        let versions: Vec<_> = CLAUDE_SECURITY_FIXES.iter().map(|(v, _)| *v).collect();
        assert_eq!(versions, ["2.1.319", "2.1.321", "2.1.323", "2.1.325"]);
    }

    #[test]
    fn codex_version_parses_only_the_codex_cli_line() {
        assert_eq!(parse_codex_version("codex-cli 0.169.0\n").as_deref(), Some("0.169.0"));
        assert_eq!(parse_codex_version("WARNING: proceeding\ncodex-cli 0.170.0-alpha.2\n").as_deref(), Some("0.170.0"));
        assert_eq!(parse_codex_version("0.169.0"), None, "no codex-cli prefix");
        assert_eq!(parse_codex_version("codex-cli dev"), None);
        assert_eq!(parse_codex_version("codex-cli 0.169"), None);
        assert_eq!(parse_codex_version(""), None);
    }

    #[test]
    fn codex_security_notice_below_at_and_above_the_fix() {
        assert!(!CODEX_SECURITY_FIXES.is_empty());
        let keys: Vec<_> = CODEX_SECURITY_FIXES.iter().map(|(v, _)| version_key(v)).collect();
        assert!(keys.iter().all(Option::is_some) && keys.windows(2).all(|w| w[0] < w[1]), "{CODEX_SECURITY_FIXES:?}");
        for (v, reason) in CODEX_SECURITY_FIXES {
            assert!(!reason.trim().is_empty() && !reason.ends_with('.'), "{v}: one line, no full stop");
        }
        assert_eq!(
            codex_security_notice("0.169.0").as_deref(),
            Some("Update Codex: 0.170.0 fixes permission updates and child threads losing sandbox restrictions")
        );
        assert!(codex_security_notice("0.9.99").is_some());
        assert_eq!(codex_security_notice("0.170.0"), None);
        assert_eq!(codex_security_notice("0.171.3"), None);
        assert_eq!(codex_security_notice("1.0.0"), None);
        assert_eq!(codex_security_notice("version unknown"), None, "an unparseable version never warns");
        // The newest missing fix wins.
        let fixes = [("0.1.0", "a"), ("0.3.0", "c"), ("0.2.0", "b")];
        assert_eq!(missing_security_fix("0.0.9", &fixes), Some(("0.3.0", "c")));
        assert_eq!(missing_security_fix("0.3.0", &fixes), None);
    }

    #[test]
    fn security_notice_names_the_newest_fix_still_missing() {
        let fixes = [("2.1.319", "fixes a"), ("2.1.330", "fixes b"), ("2.1.325", "fixes c")];
        let fix = |v: &str| ClaudeCliVersion::with_fixes(Some(v.into()), "2.1.314", &fixes).security_fix.map(|f| f.reason);
        assert_eq!(fix("2.1.300").as_deref(), Some("fixes b"));
        assert_eq!(fix("2.1.326").as_deref(), Some("fixes b"));
        assert_eq!(fix("2.1.330"), None);
    }

    #[test]
    fn recommended_is_the_higher_of_the_floor_and_the_missing_fix() {
        let fixes = [("2.1.319", "fixes a")];
        let rec = |v: Option<&str>, floor| ClaudeCliVersion::with_fixes(v.map(Into::into), floor, &fixes).recommended;
        assert_eq!(rec(Some("2.1.307"), "2.1.314"), "2.1.319");
        assert_eq!(rec(Some("2.1.316"), "2.1.314"), "2.1.319");
        assert_eq!(rec(Some("2.1.319"), "2.1.314"), "2.1.314");
        assert_eq!(rec(None, "2.1.314"), "2.1.314", "an unknown version lacks no fix");
        // A floor already past every fix wins.
        assert_eq!(rec(Some("2.1.300"), "2.1.320"), "2.1.320");
    }

    #[test]
    fn a_prerelease_of_a_fix_release_counts_as_having_the_fix() {
        let beta = parse_claude_version("2.1.319-beta.1 (Claude Code)");
        assert_eq!(beta.as_deref(), Some("2.1.319"), "the suffix is dropped");
        assert!(!version_below("2.1.319-beta.1", "2.1.319"));
        let info = ClaudeCliVersion::with_fixes(beta, "2.1.314", &[("2.1.319", "fixes a")]);
        assert_eq!(info.security_notice(), None);
        assert_eq!(info.security_fix, None);
        assert!(version_below("2.1.318-beta.1", "2.1.319"));
    }

    #[test]
    fn every_model_floor_is_a_normalized_id_and_a_version() {
        assert!(!CLAUDE_MODEL_FLOORS.is_empty());
        for (model, label, v) in CLAUDE_MODEL_FLOORS {
            assert_eq!(crate::token_engine::normalize_model_id(model), *model, "{model} must be normalized");
            assert!(!label.trim().is_empty(), "{model}: a display name");
            assert_eq!(parse_claude_version(v).as_deref(), Some(*v), "{v} must be x.y.z");
        }
    }

    #[test]
    fn version_below_each_model_floor() {
        assert_eq!(claude_model_floor("claude-fable-5-2"), Some(("Fable 5.2", "2.1.321")));
        assert_eq!(claude_model_floor("claude-fable-5-1"), Some(("Fable 5.1", "2.1.257")));
        assert!(version_below("2.1.320", "2.1.321") && !version_below("2.1.321", "2.1.321"));
        assert!(version_below("2.1.256", "2.1.257") && !version_below("2.1.257", "2.1.257"));
        // Matched on the normalized id: gateway prefixes, dots, snapshots.
        assert_eq!(claude_model_floor("anthropic/claude-fable-5.2").map(|f| f.1), Some("2.1.321"));
        assert_eq!(claude_model_floor("claude-fable-5-2-20261101").map(|f| f.1), Some("2.1.321"));
        assert_eq!(claude_model_floor("claude-fable-5"), None);
        assert_eq!(claude_model_floor("claude-opus-5-5"), None);
    }

    #[test]
    fn model_floor_note_names_the_newest_floor_still_missing() {
        fn models(m: &[&str]) -> Vec<String> {
            m.iter().map(|s| s.to_string()).collect()
        }
        let note = model_floor_note(&models(&["claude-sonnet-5-5", "claude-fable-5-1", "claude-fable-5-2"]), Some("2.1.316"))
            .expect("5.2 needs a newer CLI");
        assert_eq!((note.label.as_str(), note.needs.as_str(), note.installed.as_str()), ("Fable 5.2", "2.1.321", "2.1.316"));
        let older = model_floor_note(&models(&["claude-fable-5-1"]), Some("2.1.200")).expect("5.1 too");
        assert_eq!((older.label.as_str(), older.needs.as_str()), ("Fable 5.1", "2.1.257"));
        assert_eq!(model_floor_note(&models(&["claude-fable-5-1"]), Some("2.1.316")), None);
        assert_eq!(model_floor_note(&models(&["claude-fable-5-2"]), Some("2.1.321")), None);
        assert_eq!(model_floor_note(&models(&["claude-opus-5-5"]), Some("2.1.100")), None);
        assert_eq!(model_floor_note(&models(&["claude-fable-5-2"]), None), None, "the CLI isn't found: no line");
        assert_eq!(model_floor_note(&[], Some("2.1.100")), None);
    }

    #[test]
    fn the_version_cache_probes_once_until_forgotten() {
        let cache = VersionCache::new();
        let probes = std::cell::Cell::new(0);
        let probe = |v: &str| {
            probes.set(probes.get() + 1);
            Some(v.to_string())
        };
        assert_eq!(cache.peek(), None);
        assert_eq!(cache.get_or_probe(|| probe("2.1.316")).as_deref(), Some("2.1.316"));
        assert_eq!(cache.get_or_probe(|| probe("2.1.319")).as_deref(), Some("2.1.316"));
        assert_eq!((probes.get(), cache.peek()), (1, Some(Some("2.1.316".into()))));
        // Readiness re-probed: the updated CLI is seen without a restart, and
        // until then readers (escalation) keep the last answer.
        cache.forget();
        assert_eq!(cache.peek(), Some(Some("2.1.316".into())));
        assert_eq!(cache.get_or_probe(|| probe("2.1.319")).as_deref(), Some("2.1.319"));
        assert_eq!((probes.get(), cache.peek()), (2, Some(Some("2.1.319".into()))));
        // A probe that found nothing is cached as such.
        cache.forget();
        assert_eq!(cache.get_or_probe(|| None), None);
        assert_eq!(cache.peek(), Some(None));
    }

    #[test]
    fn the_version_cache_never_waits_on_a_running_probe() {
        let cache = VersionCache::new();
        assert_eq!(cache.get_or_probe(|| Some("2.1.316".into())).as_deref(), Some("2.1.316"));
        cache.forget();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let shared = &cache;
        std::thread::scope(|s| {
            let probing = s.spawn(move || {
                shared.get_or_probe(|| {
                    started_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Some("2.1.319".into())
                })
            });
            started_rx.recv().unwrap();
            // While the probe runs, neither reader nor forget blocks on it.
            let started = Instant::now();
            assert_eq!(cache.peek(), Some(Some("2.1.316".into())));
            cache.forget();
            assert!(started.elapsed() < Duration::from_secs(1));
            release_tx.send(()).unwrap();
            assert_eq!(probing.join().unwrap().as_deref(), Some("2.1.319"));
        });
        assert_eq!(cache.peek(), Some(Some("2.1.319".into())));
        // Forgotten mid-probe: that answer isn't kept as current.
        assert_eq!(cache.get_or_probe(|| Some("2.1.320".into())).as_deref(), Some("2.1.320"));
    }

    #[test]
    fn concurrent_first_callers_share_one_probe() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let cache = VersionCache::new();
        let probes = AtomicUsize::new(0);
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let (shared, count) = (&cache, &probes);
        std::thread::scope(|s| {
            let first = s.spawn(move || {
                shared.get_or_probe(|| {
                    count.fetch_add(1, Ordering::SeqCst);
                    started_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Some("2.1.319".into())
                })
            });
            started_rx.recv().unwrap();
            // Each of these would answer at once with its own probe.
            let later: Vec<_> = (0..3)
                .map(|_| {
                    s.spawn(move || {
                        shared.get_or_probe(|| {
                            count.fetch_add(1, Ordering::SeqCst);
                            Some("2.1.320".into())
                        })
                    })
                })
                .collect();
            std::thread::sleep(Duration::from_millis(100));
            // Waiting callers don't hold the lock.
            let started = Instant::now();
            assert_eq!(cache.peek(), None);
            assert!(started.elapsed() < Duration::from_millis(100));
            release_tx.send(()).unwrap();
            assert_eq!(first.join().unwrap().as_deref(), Some("2.1.319"));
            for t in later {
                assert_eq!(t.join().unwrap().as_deref(), Some("2.1.319"), "a later caller waits for the first probe");
            }
        });
        assert_eq!(probes.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_probe_that_panics_lets_the_next_caller_probe() {
        let cache = VersionCache::new();
        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            cache.get_or_probe(|| panic!("probe failed"));
        }));
        assert!(panicked.is_err());
        assert_eq!(cache.get_or_probe(|| Some("2.1.319".into())).as_deref(), Some("2.1.319"));
    }

    #[test]
    fn an_overtaken_probe_never_replaces_a_newer_answer() {
        let cache = VersionCache::new();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let shared = &cache;
        std::thread::scope(|s| {
            // Probe A starts on the old CLI...
            let stale = s.spawn(move || {
                shared.get_or_probe(|| {
                    started_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Some("2.1.316".into())
                })
            });
            started_rx.recv().unwrap();
            // ...Readiness forgets, and probe B stores the updated CLI.
            cache.forget();
            assert_eq!(cache.get_or_probe(|| Some("2.1.319".into())).as_deref(), Some("2.1.319"));
            release_tx.send(()).unwrap();
            assert_eq!(stale.join().unwrap().as_deref(), Some("2.1.316"));
        });
        // A finished last, but B's answer stays both current and last.
        assert_eq!(cache.peek(), Some(Some("2.1.319".into())));
        assert_eq!(cache.get_or_probe(|| Some("2.1.320".into())).as_deref(), Some("2.1.319"));
    }

    #[test]
    fn version_probe_is_bounded() {
        let mut ok = Command::new("/bin/sh");
        ok.args(["-c", "echo '2.1.316 (Claude Code)'"]);
        assert_eq!(run_bounded(ok, Duration::from_secs(5)).as_deref().and_then(parse_claude_version).as_deref(), Some("2.1.316"));

        let mut failing = Command::new("/bin/sh");
        failing.args(["-c", "echo 2.1.316; exit 1"]);
        assert_eq!(run_bounded(failing, Duration::from_secs(5)), None);

        let mut hung = Command::new("/bin/sh");
        hung.args(["-c", "sleep 5"]);
        let started = Instant::now();
        assert_eq!(run_bounded(hung, Duration::from_millis(200)), None);
        assert!(started.elapsed() < Duration::from_secs(4), "a hung CLI must be killed at the timeout");

        assert_eq!(run_bounded(Command::new("/nonexistent/claude"), Duration::from_secs(1)), None);
    }

    #[test]
    fn claude_code_command() {
        let adapter = ClaudeCodeAdapter;
        let cmd = adapter.build_command("claude-opus-4-6", "/tmp");
        let argv = cmd.get_argv();
        assert!(argv.iter().any(|a| a.to_str().map_or(false, |s| s == "claude")));
    }

    #[test]
    fn aider_command() {
        let adapter = AiderAdapter;
        let cmd = adapter.build_command("gpt-4o", "/home/user/project");
        let argv = cmd.get_argv();
        assert!(argv.iter().any(|a| a.to_str().map_or(false, |s| s == "aider")));
        assert!(argv.iter().any(|a| a.to_str().map_or(false, |s| s == "gpt-4o")));
    }

    #[test]
    fn parse_aider_output() {
        let output = "Tokens: 1,234 sent, 567 received. Cost: $0.05";
        let ev = parse_aider_tokens("sess-1", output).unwrap();
        assert_eq!(ev.input_tokens, 1234);
        assert_eq!(ev.output_tokens, 567);
    }

    #[test]
    fn parse_aider_no_match() {
        assert!(parse_aider_tokens("x", "no tokens here").is_none());
    }

    #[test]
    fn adapter_info_list_has_entries() {
        let list = adapter_info_list();
        assert!(list.len() >= 2);
        assert!(list.iter().any(|a| a.name == "claude-code"));
        assert!(list.iter().any(|a| a.name == "aider"));
    }

    #[test]
    fn custom_adapter() {
        let adapter = CustomAgentAdapter {
            agent_name: "my-agent".into(),
            command: "/usr/local/bin/my-agent".into(),
            args: vec!["--verbose".into()],
        };
        assert_eq!(adapter.name(), "my-agent");
        assert!(!adapter.supports_hot_swap());
    }
}
