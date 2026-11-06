//! Discovery and one-click registration of the bundled `octopush-mcp` server
//! with MCP clients (Claude Code today).
//!
//! The binary ships as a Tauri sidecar, so at runtime it sits next to the app
//! executable — we resolve it the same way `pty_daemon::resolve_daemon_binary`
//! resolves the PTY server. Registration shells out to the Claude Code CLI
//! (`claude mcp add`). Because a macOS GUI app does not inherit the user's
//! shell `PATH`, we also probe the well-known install locations, and always
//! hand back a copy-pasteable `manualCommand` so the user can self-serve when
//! the CLI can't be found.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::readiness::{run_probe, Probe, CHECK_TIMEOUT};

const MCP_BIN: &str = "octopush-mcp";
/// The MCP server name registered with the client. Tools then surface as
/// `mcp__octopush__<tool>`.
pub(crate) const SERVER_NAME: &str = "octopush";

/// Locate the bundled `octopush-mcp` binary. Mirrors the PTY daemon's resolver:
/// sibling-of-exe first (production `.app` and `cargo run`), then `$PATH`, then
/// the dev `target/{debug,release}` trees.
pub fn resolve_mcp_binary() -> AppResult<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let candidate = parent.join(MCP_BIN);
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }

    if let Ok(path_var) = std::env::var("PATH") {
        for dir in path_var.split(':') {
            let candidate = PathBuf::from(dir).join(MCP_BIN);
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }

    for relative in &[
        "target/release/octopush-mcp",
        "target/debug/octopush-mcp",
        "src-tauri/target/release/octopush-mcp",
        "src-tauri/target/debug/octopush-mcp",
    ] {
        if let Ok(cwd) = std::env::current_dir() {
            let candidate = cwd.join(relative);
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }

    Err(AppError::Other(
        "octopush-mcp binary not found next to the app or in $PATH".into(),
    ))
}

/// Find the Claude Code CLI. Checks `$PATH` first, then the locations the
/// official installers use — GUI apps launched from Finder don't see the shell
/// `PATH`, so the absolute probes are what make this work in a packaged build.
pub fn resolve_claude_cli() -> Option<PathBuf> {
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in path_var.split(':') {
            let candidate = PathBuf::from(dir).join("claude");
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    let mut candidates = vec![
        PathBuf::from("/opt/homebrew/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
        PathBuf::from("/usr/bin/claude"),
    ];
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".claude/local/claude"));
        candidates.push(home.join(".local/bin/claude"));
        candidates.push(home.join(".bun/bin/claude"));
        candidates.push(home.join(".npm-global/bin/claude"));
    }
    candidates.into_iter().find(|p| p.exists())
}

/// The argv (after `claude`) that registers the bundled server at user scope:
/// `mcp add octopush -s user -- <binary>`. One source for the one-click
/// connect and the contract test against Claude Code's recorded `mcp add`.
pub(crate) fn mcp_add_args(binary: &Path) -> Vec<std::ffi::OsString> {
    let mut args: Vec<std::ffi::OsString> =
        ["mcp", "add", SERVER_NAME, "-s", "user", "--"].iter().map(Into::into).collect();
    args.push(binary.as_os_str().to_owned());
    args
}

/// The argv (after `claude`) that removes a user-scope registration.
pub(crate) const MCP_REMOVE_ARGS: [&str; 5] = ["mcp", "remove", SERVER_NAME, "-s", "user"];

/// The terminal command a user can run to register the server by hand.
pub(crate) fn manual_command(binary_path: Option<&str>) -> String {
    let path = binary_path.unwrap_or("/path/to/octopush-mcp");
    format!("claude mcp add {SERVER_NAME} -s user -- \"{path}\"")
}

/// Whether Claude Code already has the `octopush` server registered. Runs
/// through the readiness probe so a slow CLI can't stall the Settings card.
fn is_registered(claude: &Path) -> bool {
    let mut cmd = Command::new(claude);
    cmd.args(["mcp", "get", SERVER_NAME]);
    registered_from(run_probe(Some(cmd), CHECK_TIMEOUT))
}

/// Only a clean exit counts; a timeout or a missing CLI reads as not registered.
fn registered_from(probe: Probe) -> bool {
    matches!(probe, Probe::Exited { success: true, .. })
}

/// Shown when Claude Code's config lock stays held after one retry.
const BUSY_MESSAGE: &str =
    "Claude Code's config is busy — try again in a moment, or run the command below.";
/// Pause before the one retry on a lock failure.
const LOCK_RETRY_PAUSE: Duration = Duration::from_secs(1);

/// Why a `claude mcp remove`/`add` exited non-zero, from its output.
#[derive(Debug, PartialEq, Eq)]
enum CliFailure {
    /// The server isn't registered (fine for `remove`).
    NotFound,
    /// Claude Code ≥ 2.1.318 couldn't take its config lock. Transient.
    Busy,
    Other,
}

fn classify_failure(output: &str) -> CliFailure {
    let text = output.to_lowercase();
    // Lock first: retrying a misread not-found is harmless, the reverse isn't.
    if text.contains("lock") || text.contains("busy") {
        CliFailure::Busy
    } else if ["no mcp server found", "not found", "does not exist", "no such server"]
        .iter()
        .any(|p| text.contains(p))
    {
        CliFailure::NotFound
    } else {
        CliFailure::Other
    }
}

/// One finished CLI call: exit status and its output (stderr, then stdout).
#[derive(Debug, Clone)]
struct CliRun {
    success: bool,
    output: String,
}

fn run_cli(claude: &Path, args: &[std::ffi::OsString]) -> Result<CliRun, String> {
    let o = Command::new(claude).args(args).output().map_err(|e| e.to_string())?;
    let mut output = String::from_utf8_lossy(&o.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&o.stdout);
    if !stdout.trim().is_empty() {
        if !output.is_empty() {
            output.push('\n');
        }
        output.push_str(stdout.trim());
    }
    Ok(CliRun { success: o.status.success(), output })
}

/// Run once; on a lock failure, `pause` and run once more.
fn with_lock_retry(
    mut run: impl FnMut() -> Result<CliRun, String>,
    pause: &mut impl FnMut(),
) -> Result<CliRun, String> {
    let first = run()?;
    if first.success || classify_failure(&first.output) != CliFailure::Busy {
        return Ok(first);
    }
    pause();
    run()
}

#[derive(Debug, PartialEq, Eq)]
enum Step {
    Remove,
    Add,
}

#[derive(Debug, PartialEq, Eq)]
struct ConnectOutcome {
    ok: bool,
    registered: bool,
    message: String,
}

impl ConnectOutcome {
    fn failed(message: impl Into<String>) -> Self {
        Self { ok: false, registered: false, message: message.into() }
    }
}

/// The remove → add → verify flow, with the CLI calls injected so it can be
/// tested against recorded output.
fn connect_flow(
    mut run: impl FnMut(&Step) -> Result<CliRun, String>,
    verify: impl FnOnce() -> bool,
    mut pause: impl FnMut(),
) -> ConnectOutcome {
    let could_not_run = |e: String| ConnectOutcome::failed(format!("Could not run the Claude Code CLI: {e}"));

    // Remove-then-add makes the operation idempotent. "Not registered" is fine.
    match with_lock_retry(|| run(&Step::Remove), &mut pause) {
        Err(e) => return could_not_run(e),
        Ok(r) if r.success => {}
        Ok(r) => match classify_failure(&r.output) {
            CliFailure::NotFound => {}
            CliFailure::Busy => return ConnectOutcome::failed(BUSY_MESSAGE),
            CliFailure::Other if r.output.is_empty() => {
                return ConnectOutcome::failed(
                    "Claude Code couldn't remove the old registration. Try the manual command below.",
                )
            }
            CliFailure::Other => {
                return ConnectOutcome::failed(format!(
                    "Claude Code couldn't remove the old registration: {}",
                    r.output
                ))
            }
        },
    }

    match with_lock_retry(|| run(&Step::Add), &mut pause) {
        Err(e) => could_not_run(e),
        Ok(r) if r.success => {
            if verify() {
                ConnectOutcome {
                    ok: true,
                    registered: true,
                    message: "Connected to Claude Code. Start a new Claude Code session to load the Octopush tools.".into(),
                }
            } else {
                ConnectOutcome::failed(
                    "Claude Code accepted the registration but doesn't list it — another save may have replaced it. Try again in a moment.",
                )
            }
        }
        Ok(r) if classify_failure(&r.output) == CliFailure::Busy => ConnectOutcome::failed(BUSY_MESSAGE),
        Ok(r) if r.output.is_empty() => {
            ConnectOutcome::failed("Claude Code rejected the registration. Try the manual command below.")
        }
        Ok(r) => ConnectOutcome::failed(format!("Claude Code error: {}", r.output)),
    }
}

/// Snapshot of the integration's state, for rendering the settings card.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    /// Resolved absolute path to the bundled binary, if found.
    pub binary_path: Option<String>,
    pub binary_found: bool,
    pub claude_found: bool,
    /// True when `claude mcp get octopush` succeeds.
    pub registered: bool,
    /// Copy-pasteable manual registration command.
    pub manual_command: String,
}

pub fn status() -> McpStatus {
    let binary = resolve_mcp_binary().ok();
    let binary_path = binary.as_ref().map(|p| p.display().to_string());
    let claude = resolve_claude_cli();
    let registered = claude.as_deref().map(is_registered).unwrap_or(false);
    McpStatus {
        binary_found: binary.is_some(),
        claude_found: claude.is_some(),
        registered,
        manual_command: manual_command(binary_path.as_deref()),
        binary_path,
    }
}

/// Result of attempting a one-click connect.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct McpConnectResult {
    pub ok: bool,
    pub registered: bool,
    /// Human-readable outcome to surface in the UI.
    pub message: String,
    pub manual_command: String,
    pub binary_path: Option<String>,
}

/// Register the bundled server with Claude Code at user scope. Idempotent:
/// removes any existing `octopush` entry first so re-running always converges
/// on the bundled binary's current path (important across app upgrades).
pub fn connect() -> McpConnectResult {
    let binary = match resolve_mcp_binary() {
        Ok(b) => b,
        Err(e) => {
            return McpConnectResult {
                ok: false,
                registered: false,
                message: format!("Could not locate the octopush-mcp binary: {e}"),
                manual_command: manual_command(None),
                binary_path: None,
            };
        }
    };
    let binary_path = binary.display().to_string();

    let Some(claude) = resolve_claude_cli() else {
        return McpConnectResult {
            ok: false,
            registered: false,
            message: "Claude Code CLI not found on this machine. Run the command below in your terminal instead.".into(),
            manual_command: manual_command(Some(&binary_path)),
            binary_path: Some(binary_path),
        };
    };

    let remove_args: Vec<std::ffi::OsString> = MCP_REMOVE_ARGS.iter().map(Into::into).collect();
    let add_args = mcp_add_args(&binary);
    let outcome = connect_flow(
        |step| match step {
            Step::Remove => run_cli(&claude, &remove_args),
            Step::Add => run_cli(&claude, &add_args),
        },
        || is_registered(&claude),
        || std::thread::sleep(LOCK_RETRY_PAUSE),
    );

    McpConnectResult {
        ok: outcome.ok,
        registered: outcome.registered,
        message: outcome.message,
        manual_command: manual_command(Some(&binary_path)),
        binary_path: Some(binary_path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn exit(success: bool, output: &str) -> Result<CliRun, String> {
        Ok(CliRun { success, output: output.into() })
    }

    /// Plays back scripted results per step; records every call and pause.
    struct Script {
        remove: RefCell<Vec<Result<CliRun, String>>>,
        add: RefCell<Vec<Result<CliRun, String>>>,
        calls: RefCell<Vec<&'static str>>,
    }

    impl Script {
        fn new(remove: Vec<Result<CliRun, String>>, add: Vec<Result<CliRun, String>>) -> Self {
            Self { remove: RefCell::new(remove), add: RefCell::new(add), calls: RefCell::new(vec![]) }
        }

        fn run(&self, verified: bool) -> ConnectOutcome {
            connect_flow(
                |step| {
                    let (name, queue) = match step {
                        Step::Remove => ("remove", &self.remove),
                        Step::Add => ("add", &self.add),
                    };
                    self.calls.borrow_mut().push(name);
                    queue.borrow_mut().remove(0)
                },
                || {
                    self.calls.borrow_mut().push("get");
                    verified
                },
                || self.calls.borrow_mut().push("pause"),
            )
        }
    }

    // Fixture strings: what `claude mcp remove`/`add` print on failure.
    const NOT_FOUND: &str = "No user-scoped MCP server found with name: octopush";
    const NOT_FOUND_OLD: &str = "No MCP server found with name: \"octopush\"";
    const LOCKED: &str = "Error: could not acquire lock on /Users/me/.claude.json (held by another process)";
    const ELOCKED: &str = "Error: ELOCKED: Lock file is already being held";
    const EXISTS: &str = "MCP server octopush already exists in user config";

    #[test]
    fn classifies_cli_failure_output() {
        assert_eq!(classify_failure(NOT_FOUND), CliFailure::NotFound);
        assert_eq!(classify_failure(NOT_FOUND_OLD), CliFailure::NotFound);
        assert_eq!(classify_failure("Server octopush does not exist"), CliFailure::NotFound);
        assert_eq!(classify_failure(LOCKED), CliFailure::Busy);
        assert_eq!(classify_failure(ELOCKED), CliFailure::Busy);
        assert_eq!(classify_failure("Config file is busy"), CliFailure::Busy);
        assert_eq!(classify_failure(EXISTS), CliFailure::Other);
        assert_eq!(classify_failure("Permission denied"), CliFailure::Other);
        assert_eq!(classify_failure(""), CliFailure::Other);
    }

    #[test]
    fn missing_server_on_remove_is_fine_and_add_is_verified() {
        let s = Script::new(vec![exit(false, NOT_FOUND)], vec![exit(true, "Added stdio MCP server octopush")]);
        let out = s.run(true);
        assert!(out.ok && out.registered, "{out:?}");
        assert_eq!(*s.calls.borrow(), ["remove", "add", "get"]);
    }

    #[test]
    fn other_remove_failure_is_surfaced_not_discarded() {
        let s = Script::new(vec![exit(false, "Permission denied: ~/.claude.json")], vec![]);
        let out = s.run(true);
        assert!(!out.ok && !out.registered);
        assert!(out.message.contains("Permission denied"), "{}", out.message);
        assert_eq!(*s.calls.borrow(), ["remove"]);
    }

    #[test]
    fn lock_on_remove_retries_once_then_continues() {
        let s = Script::new(vec![exit(false, LOCKED), exit(true, "")], vec![exit(true, "")]);
        let out = s.run(true);
        assert!(out.ok && out.registered, "{out:?}");
        assert_eq!(*s.calls.borrow(), ["remove", "pause", "remove", "add", "get"]);
    }

    #[test]
    fn lock_held_through_the_retry_reports_busy() {
        let s = Script::new(vec![exit(false, LOCKED), exit(false, ELOCKED)], vec![]);
        let out = s.run(true);
        assert_eq!(out, ConnectOutcome::failed(BUSY_MESSAGE));
        assert_eq!(*s.calls.borrow(), ["remove", "pause", "remove"]);

        let s = Script::new(vec![exit(true, "")], vec![exit(false, ELOCKED), exit(false, LOCKED)]);
        assert_eq!(s.run(true), ConnectOutcome::failed(BUSY_MESSAGE));
        assert_eq!(*s.calls.borrow(), ["remove", "add", "pause", "add"]);
    }

    #[test]
    fn lock_on_add_retries_once() {
        let s = Script::new(vec![exit(true, "")], vec![exit(false, ELOCKED), exit(true, "")]);
        assert!(s.run(true).registered);
        assert_eq!(*s.calls.borrow(), ["remove", "add", "pause", "add", "get"]);
    }

    #[test]
    fn non_lock_add_failure_keeps_the_cli_error_and_does_not_retry() {
        let s = Script::new(vec![exit(true, "")], vec![exit(false, EXISTS)]);
        let out = s.run(true);
        assert_eq!(out.message, format!("Claude Code error: {EXISTS}"));
        assert_eq!(*s.calls.borrow(), ["remove", "add"]);

        let s = Script::new(vec![exit(true, "")], vec![exit(false, "")]);
        assert!(s.run(true).message.contains("rejected the registration"));
    }

    #[test]
    fn registered_comes_from_mcp_get_not_the_add_exit_code() {
        let s = Script::new(vec![exit(true, "")], vec![exit(true, "")]);
        let out = s.run(false);
        assert!(!out.ok && !out.registered, "{out:?}");
        assert!(out.message.contains("Try again in a moment"), "{}", out.message);
    }

    #[test]
    fn cli_that_cannot_start_is_reported() {
        let s = Script::new(vec![Err("No such file or directory".into())], vec![]);
        assert!(s.run(true).message.starts_with("Could not run the Claude Code CLI"));
    }

    #[test]
    fn mcp_get_probe_counts_only_a_clean_exit() {
        assert!(registered_from(Probe::Exited { success: true, output: String::new() }));
        assert!(!registered_from(Probe::Exited { success: false, output: String::new() }));
        assert!(!registered_from(Probe::TimedOut));
        assert!(!registered_from(Probe::Missing));
    }

    #[test]
    fn remove_and_add_argv_are_unchanged() {
        assert_eq!(MCP_REMOVE_ARGS, ["mcp", "remove", SERVER_NAME, "-s", "user"]);
    }
}
