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
use std::sync::OnceLock;
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
}

impl ClaudeCliVersion {
    pub fn new(version: Option<String>, floor: &str) -> Self {
        let below_floor = version.as_deref().is_some_and(|v| version_below(v, floor));
        Self { version, floor: floor.to_string(), below_floor }
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
             sessions. Update Claude Code ({floor} or newer recommended); the run continues.",
            floor = self.floor
        ))
    }
}

/// `x.y.z` as numbers; a pre-release/build suffix (`-beta.1`, `+abc`) is ignored.
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

/// True when `version` is strictly older than `floor`. Unparseable input on
/// either side is never "below" — an unknown version must not warn.
pub fn version_below(version: &str, floor: &str) -> bool {
    match (version_key(version), version_key(floor)) {
        (Some(v), Some(f)) => v < f,
        _ => false,
    }
}

/// The installed CLI's version, probed once per app session with the same
/// login-shell PATH and environment the CLI stages run with.
pub fn claude_cli_version() -> ClaudeCliVersion {
    let version = CLAUDE_VERSION_CACHE.get_or_init(probe_claude_version).clone();
    ClaudeCliVersion::new(version, TESTED_CLAUDE_FLOOR)
}

/// The cached probe result without probing; `None` until a CLI stage, the
/// preflight or Settings has run [`claude_cli_version`] this session.
pub fn claude_cli_version_cached() -> Option<ClaudeCliVersion> {
    CLAUDE_VERSION_CACHE
        .get()
        .map(|v| ClaudeCliVersion::new(v.clone(), TESTED_CLAUDE_FLOOR))
}

static CLAUDE_VERSION_CACHE: OnceLock<Option<String>> = OnceLock::new();

fn probe_claude_version() -> Option<String> {
    use crate::orchestrator::cli_runner::{login_shell_env, resolve_executable, resolved_cli_path};
    let path_env = resolved_cli_path();
    let bin = resolve_executable("claude", &path_env)?;
    let mut cmd = Command::new(bin);
    cmd.arg("--version");
    for (k, v) in login_shell_env() {
        cmd.env(k, v);
    }
    cmd.env("PATH", &path_env);
    parse_claude_version(&run_bounded(cmd, VERSION_TIMEOUT)?)
}

// ─── Claude Code hooks (Run-mode attention, #287) ─────────────────
//
// In a worktree Octopush created, `Notification` (`permission_prompt`,
// `idle_prompt`) and `Stop` hooks go into `.claude/settings.local.json`,
// merged with whatever the user keeps there. Each runs `octopush-mcp hook`,
// which reads the payload below from stdin.

/// The worktree-local Claude Code settings file the hooks live in.
pub const LOCAL_SETTINGS_FILE: &str = ".claude/settings.local.json";

/// Ends every hook command Octopush installs, so re-installing or removing
/// touches only ours. A marker in the command rather than an extra JSON key:
/// Claude Code drops a settings file whose keys it doesn't know.
pub const HOOK_MARKER: &str = "--octopush-hook";

const NOTIFICATION_MATCHERS: [&str; 2] = ["permission_prompt", "idle_prompt"];

/// What a hook payload means for the attention beacon.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookSignal {
    /// `Notification` / `permission_prompt` — waiting on permission.
    NeedsPermission,
    /// `Notification` / `idle_prompt` — waiting on your input.
    NeedsInput,
    /// `Stop` — Claude finished its turn.
    Settled,
}

impl HookSignal {
    pub fn as_str(self) -> &'static str {
        match self {
            HookSignal::NeedsPermission => "permission",
            HookSignal::NeedsInput => "input",
            HookSignal::Settled => "settled",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "permission" => Some(HookSignal::NeedsPermission),
            "input" => Some(HookSignal::NeedsInput),
            "settled" => Some(HookSignal::Settled),
            _ => None,
        }
    }
}

/// A hook payload reduced to what Octopush keeps: never the message text or
/// the transcript path.
#[derive(Debug, Clone, PartialEq)]
pub struct HookEvent {
    pub signal: HookSignal,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
}

/// Read a hook's stdin payload. Keyed on `hook_event_name` and, for a
/// `Notification`, `notification_type`; anything else is `None`.
pub fn parse_hook_event(payload: &serde_json::Value) -> Option<HookEvent> {
    let signal = match payload.get("hook_event_name")?.as_str()? {
        "Notification" => match payload.get("notification_type")?.as_str()? {
            "permission_prompt" => HookSignal::NeedsPermission,
            "idle_prompt" => HookSignal::NeedsInput,
            _ => return None,
        },
        "Stop" => HookSignal::Settled,
        _ => return None,
    };
    let text = |key: &str| payload.get(key).and_then(serde_json::Value::as_str).map(str::to_string);
    Some(HookEvent { signal, session_id: text("session_id"), cwd: text("cwd") })
}

/// The command each hook runs: the quoted `octopush-mcp` path, then the marker.
pub fn hook_command(hook_bin: &Path) -> String {
    let bin = hook_bin.to_string_lossy().replace('\'', r"'\''");
    format!("'{bin}' hook {HOOK_MARKER}")
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

/// `settings` with Octopush's hooks (re)installed for `hook_cmd`, or `None`
/// when its shape isn't one we can merge into (then the file is left alone).
pub fn merge_claude_hooks(settings: serde_json::Value, hook_cmd: &str) -> Option<serde_json::Value> {
    use serde_json::json;
    let mut settings = strip_claude_hooks(settings);
    let hooks = settings.as_object_mut()?.entry("hooks").or_insert_with(|| json!({}));
    let hooks = hooks.as_object_mut()?;
    let ours = json!({ "type": "command", "command": hook_cmd, "async": true });
    let mut add = |event: &str, group: serde_json::Value| -> Option<()> {
        hooks.entry(event).or_insert_with(|| json!([])).as_array_mut()?.push(group);
        Some(())
    };
    for matcher in NOTIFICATION_MATCHERS {
        add("Notification", json!({ "matcher": matcher, "hooks": [ours.clone()] }))?;
    }
    add("Stop", json!({ "hooks": [ours] }))?;
    Some(settings)
}

/// Install the hooks into `<worktree>/.claude/settings.local.json`. A missing
/// file counts as `{}`; one that isn't valid JSON (or isn't an object) is
/// never overwritten — `Ok(false)`, the install is skipped.
pub fn install_claude_hooks(worktree: &Path, hook_bin: &Path) -> std::io::Result<bool> {
    let path = worktree.join(LOCAL_SETTINGS_FILE);
    let current = match std::fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(v) => v,
            Err(_) => return Ok(false),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
        Err(e) => return Err(e),
    };
    let Some(next) = merge_claude_hooks(current.clone(), &hook_command(hook_bin)) else {
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
fn write_settings(path: &Path, value: &serde_json::Value) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut text = serde_json::to_string_pretty(value).map_err(std::io::Error::other)?;
    text.push('\n');
    let tmp = path.with_extension("json.octopush-tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)
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
        assert!(note.contains("2.1.307") && note.contains("2.1.314 or newer"), "{note}");

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
        assert_eq!(hook_command(Path::new(BIN)), format!("'{BIN}' hook --octopush-hook"));
        assert_eq!(hook_command(Path::new("/a b/it's/octopush-mcp")), r"'/a b/it'\''s/octopush-mcp' hook --octopush-hook");
    }

    #[test]
    fn merge_into_an_empty_file_registers_three_async_hooks() {
        let merged = merge_claude_hooks(serde_json::json!({}), &hook_command(Path::new(BIN))).unwrap();
        assert_eq!(our_commands(&merged), [
            ("Notification".to_string(), Some("permission_prompt".to_string())),
            ("Notification".to_string(), Some("idle_prompt".to_string())),
            ("Stop".to_string(), None),
        ]);
        let hook = &merged["hooks"]["Stop"][0]["hooks"][0];
        assert_eq!(hook["type"], "command");
        assert_eq!(hook["async"], true);
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
        let once = merge_claude_hooks(user.clone(), &hook_command(Path::new("/old/octopush-mcp"))).unwrap();
        // Re-installing from a moved app replaces ours instead of adding more.
        let twice = merge_claude_hooks(once, &hook_command(Path::new(BIN))).unwrap();
        assert_eq!(our_commands(&twice).len(), 3);
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
            { "type": "command", "command": hook_command(Path::new(BIN)) }
        ] }] } });
        let stripped = strip_claude_hooks(shared);
        assert_eq!(stripped, serde_json::json!({ "hooks": { "Stop": [{ "hooks": [
            { "type": "command", "command": "say done" }
        ] }] } }));
        // The user's own empty containers are theirs to keep.
        let empty = serde_json::json!({ "hooks": { "Stop": [] } });
        assert_eq!(strip_claude_hooks(empty.clone()), empty);
    }

    #[test]
    fn merge_refuses_shapes_it_cannot_merge_into() {
        let cmd = hook_command(Path::new(BIN));
        assert_eq!(merge_claude_hooks(serde_json::json!([]), &cmd), None);
        assert_eq!(merge_claude_hooks(serde_json::json!({ "hooks": "nope" }), &cmd), None);
        assert_eq!(merge_claude_hooks(serde_json::json!({ "hooks": { "Stop": {} } }), &cmd), None);
    }

    #[test]
    fn install_and_remove_round_trip_on_disk() {
        let wt = tempfile::tempdir().unwrap();
        let file = wt.path().join(LOCAL_SETTINGS_FILE);

        // No file: created, then removed with its `.claude/` directory.
        assert!(install_claude_hooks(wt.path(), Path::new(BIN)).unwrap());
        let written: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(our_commands(&written).len(), 3);
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
        let p = |v: serde_json::Value| parse_hook_event(&v).map(|e| e.signal);
        assert_eq!(p(serde_json::json!({ "hook_event_name": "Notification", "notification_type": "permission_prompt" })), Some(HookSignal::NeedsPermission));
        assert_eq!(p(serde_json::json!({ "hook_event_name": "Notification", "notification_type": "idle_prompt" })), Some(HookSignal::NeedsInput));
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
    fn tested_floor_is_a_version() {
        assert_eq!(parse_claude_version(TESTED_CLAUDE_FLOOR).as_deref(), Some(TESTED_CLAUDE_FLOOR));
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
