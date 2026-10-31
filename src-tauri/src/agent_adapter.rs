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
    static CACHE: OnceLock<Option<String>> = OnceLock::new();
    let version = CACHE.get_or_init(probe_claude_version).clone();
    ClaudeCliVersion::new(version, TESTED_CLAUDE_FLOOR)
}

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
