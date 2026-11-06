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
use crate::readiness::{run_probe, run_status_probe, Probe, CHECK_TIMEOUT};

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
    registered_from(probe_registration(claude))
}

fn probe_registration(claude: &Path) -> Probe {
    let mut cmd = Command::new(claude);
    cmd.args(["mcp", "get", SERVER_NAME]);
    // Only the exit status matters; output goes to /dev/null so a large listing can't fill a pipe.
    run_status_probe(Some(cmd), CHECK_TIMEOUT)
}

/// Whether `claude mcp get octopush` output shows a user-scope stdio entry that
/// runs exactly `binary` with no args — i.e. what `mcp_add_args(binary)` writes.
/// Anything else (another path, args, another scope, unparseable) reads as no.
pub(crate) fn registered_with(get_output: &str, binary: &Path) -> bool {
    let field = |name: &str| {
        get_output
            .lines()
            .map(str::trim)
            .find_map(|l| l.strip_prefix(name).and_then(|rest| rest.strip_prefix(':')))
            .map(str::trim)
    };
    let (binary, header) = (binary.to_string_lossy(), format!("{SERVER_NAME}:"));
    get_output.lines().any(|l| l.trim() == header)
        && field("Scope").is_some_and(|v| v.starts_with("User"))
        && field("Type") == Some("stdio")
        && field("Command") == Some(binary.as_ref())
        && field("Args") == Some("")
}

/// Whether Claude Code already lists our server with exactly this binary, so
/// Connect can skip the remove → add. A slow or failing `mcp get` reads as no.
fn already_registered_with(claude: &Path, binary: &Path) -> bool {
    let mut cmd = Command::new(claude);
    cmd.args(["mcp", "get", SERVER_NAME]);
    match run_probe(Some(cmd), CHECK_TIMEOUT) {
        Probe::Exited { success: true, output } => registered_with(&output, binary),
        _ => false,
    }
}

/// Only a clean exit counts; a timeout or a missing CLI reads as not registered.
fn registered_from(probe: Probe) -> bool {
    verification_from(probe) == Verification::Listed
}

/// What `claude mcp get octopush` said after a successful `add`.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum Verification {
    Listed,
    /// The CLI answered, and the entry isn't there.
    NotListed,
    /// `mcp get` timed out or couldn't start — we don't know.
    Unconfirmed,
}

fn verification_from(probe: Probe) -> Verification {
    match probe {
        Probe::Exited { success: true, .. } => Verification::Listed,
        Probe::Exited { success: false, .. } => Verification::NotListed,
        Probe::TimedOut | Probe::Missing => Verification::Unconfirmed,
    }
}

/// Shown when Claude Code's config lock stays held after one retry.
const BUSY_MESSAGE: &str =
    "Claude Code's config is busy — try again in a moment, or run the command below.";
/// Bound on one `claude mcp remove`/`add`. Claude Code 2.1.318+ waits on its
/// config lock before giving up; this sits comfortably past that wait, and a
/// call still running at it is killed and treated as a held lock (busy).
const CLI_TIMEOUT: Duration = Duration::from_secs(20);
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

/// Lock wording, matched as whole phrases so `blocked`, `clock`, `unlock` or a
/// path like `/Users/lockhart/` don't read as a held config lock.
const LOCK_PHRASES: [&str; 7] =
    ["elocked", "ebusy", "acquire lock", "acquire the lock", "lock file", "is locked", "is busy"];

fn classify_failure(output: &str) -> CliFailure {
    let text = output.to_lowercase();
    // Lock first: retrying a misread not-found is harmless, the reverse isn't.
    // "mcp server found" covers both "No MCP server found…" and the scoped
    // "No user-scoped MCP server found…".
    if LOCK_PHRASES.iter().any(|p| text.contains(p)) {
        CliFailure::Busy
    } else if ["mcp server found", "not found", "does not exist", "no such server"]
        .iter()
        .any(|p| text.contains(p))
    {
        CliFailure::NotFound
    } else {
        CliFailure::Other
    }
}

/// One finished (or timed-out) CLI call: exit status and its output.
#[derive(Debug, Clone)]
struct CliRun {
    success: bool,
    /// Killed at the timeout — read as a held config lock.
    timed_out: bool,
    output: String,
}

impl CliRun {
    fn failure(&self) -> CliFailure {
        if self.timed_out {
            CliFailure::Busy
        } else {
            classify_failure(&self.output)
        }
    }
}

/// Run `claude <args>` through the readiness module's bounded spawn: killed
/// once `timeout` passes, so a CLI stuck on its config lock can't hang Connect.
fn run_cli(claude: &Path, args: &[std::ffi::OsString], timeout: Duration) -> Result<CliRun, String> {
    let mut cmd = Command::new(claude);
    cmd.args(args);
    match run_probe(Some(cmd), timeout) {
        Probe::Missing => Err(format!("{} could not be started", claude.display())),
        Probe::TimedOut => Ok(CliRun { success: false, timed_out: true, output: String::new() }),
        Probe::Exited { success, output } => Ok(CliRun { success, timed_out: false, output: output.trim().to_string() }),
    }
}

/// Run once; on a lock failure (or a timeout), `pause` and run once more.
fn with_lock_retry(
    mut run: impl FnMut() -> Result<CliRun, String>,
    pause: &mut impl FnMut(),
) -> Result<CliRun, String> {
    let first = run()?;
    if first.success || first.failure() != CliFailure::Busy {
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

const CONNECTED_MESSAGE: &str =
    "Connected to Claude Code. Start a new Claude Code session to load the Octopush tools.";

/// The add failed after a successful remove: the user's old entry is gone.
fn removed_then_failed(reason: &str) -> ConnectOutcome {
    ConnectOutcome::failed(format!(
        "The previous Octopush registration was removed, but adding it back failed: {}. Press Connect to Claude Code again to restore it, or run the command below.",
        reason.trim_end_matches('.')
    ))
}

/// The check → remove → add → verify flow, with the CLI calls injected so it
/// can be tested against recorded output.
fn connect_flow(
    already_registered: impl FnOnce() -> bool,
    mut run: impl FnMut(&Step) -> Result<CliRun, String>,
    verify: impl FnOnce() -> Verification,
    mut pause: impl FnMut(),
) -> ConnectOutcome {
    // Already pointing at this exact binary: nothing to change, nothing to risk.
    if already_registered() {
        return ConnectOutcome { ok: true, registered: true, message: CONNECTED_MESSAGE.into() };
    }

    let could_not_run = |e: String| ConnectOutcome::failed(format!("Could not run the Claude Code CLI: {e}"));

    // Remove-then-add makes the operation idempotent. "Not registered" is fine.
    let removed = match with_lock_retry(|| run(&Step::Remove), &mut pause) {
        Err(e) => return could_not_run(e),
        Ok(r) if r.success => true,
        Ok(r) => match r.failure() {
            CliFailure::NotFound => false,
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
    };

    match with_lock_retry(|| run(&Step::Add), &mut pause) {
        Err(e) if removed => removed_then_failed(&format!("could not run the Claude Code CLI: {e}")),
        Err(e) => could_not_run(e),
        Ok(r) if r.success => match verify() {
            Verification::Listed => ConnectOutcome { ok: true, registered: true, message: CONNECTED_MESSAGE.into() },
            Verification::NotListed => ConnectOutcome::failed(
                "Claude Code accepted the registration but doesn't list it — another save may have replaced it. Try again in a moment.",
            ),
            Verification::Unconfirmed => ConnectOutcome::failed(
                "Claude Code accepted the registration but didn't confirm it in time — press Connect to Claude Code again in a moment to check.",
            ),
        },
        Ok(r) if removed => removed_then_failed(&match r.failure() {
            CliFailure::Busy => "Claude Code's config is busy".to_string(),
            _ if r.output.is_empty() => "Claude Code rejected the registration".to_string(),
            _ => format!("Claude Code error: {}", r.output),
        }),
        Ok(r) if r.failure() == CliFailure::Busy => ConnectOutcome::failed(BUSY_MESSAGE),
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
        || already_registered_with(&claude, &binary),
        |step| match step {
            Step::Remove => run_cli(&claude, &remove_args, CLI_TIMEOUT),
            Step::Add => run_cli(&claude, &add_args, CLI_TIMEOUT),
        },
        || verification_from(probe_registration(&claude)),
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
        Ok(CliRun { success, timed_out: false, output: output.into() })
    }

    fn timed_out() -> Result<CliRun, String> {
        Ok(CliRun { success: false, timed_out: true, output: String::new() })
    }

    /// Plays back scripted results per step; records every call and pause.
    struct Script {
        /// What the pre-check (`mcp get` shows exactly our binary) answers.
        current: bool,
        remove: RefCell<Vec<Result<CliRun, String>>>,
        add: RefCell<Vec<Result<CliRun, String>>>,
        calls: RefCell<Vec<&'static str>>,
    }

    impl Script {
        fn new(remove: Vec<Result<CliRun, String>>, add: Vec<Result<CliRun, String>>) -> Self {
            Self { current: false, remove: RefCell::new(remove), add: RefCell::new(add), calls: RefCell::new(vec![]) }
        }

        fn run(&self, verified: Verification) -> ConnectOutcome {
            connect_flow(
                || {
                    self.calls.borrow_mut().push("check");
                    self.current
                },
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
        // "lock" inside other words or paths is not a held config lock.
        assert_eq!(classify_failure("Request blocked by policy"), CliFailure::Other);
        assert_eq!(classify_failure("Error: system clock is skewed"), CliFailure::Other);
        assert_eq!(classify_failure("Failed to unlock keychain"), CliFailure::Other);
        assert_eq!(
            classify_failure("EACCES: permission denied, open '/Users/lockhart/.claude.json'"),
            CliFailure::Other
        );
        assert_eq!(classify_failure(""), CliFailure::Other);
    }

    #[test]
    fn missing_server_on_remove_is_fine_and_add_is_verified() {
        let s = Script::new(vec![exit(false, NOT_FOUND)], vec![exit(true, "Added stdio MCP server octopush")]);
        let out = s.run(Verification::Listed);
        assert!(out.ok && out.registered, "{out:?}");
        assert_eq!(*s.calls.borrow(), ["check", "remove", "add", "get"]);
    }

    #[test]
    fn other_remove_failure_is_surfaced_not_discarded() {
        let s = Script::new(vec![exit(false, "Permission denied: ~/.claude.json")], vec![]);
        let out = s.run(Verification::Listed);
        assert!(!out.ok && !out.registered);
        assert!(out.message.contains("Permission denied"), "{}", out.message);
        assert_eq!(*s.calls.borrow(), ["check", "remove"]);
    }

    #[test]
    fn lock_on_remove_retries_once_then_continues() {
        let s = Script::new(vec![exit(false, LOCKED), exit(true, "")], vec![exit(true, "")]);
        let out = s.run(Verification::Listed);
        assert!(out.ok && out.registered, "{out:?}");
        assert_eq!(*s.calls.borrow(), ["check", "remove", "pause", "remove", "add", "get"]);
    }

    #[test]
    fn lock_held_through_the_retry_reports_busy() {
        let s = Script::new(vec![exit(false, LOCKED), exit(false, ELOCKED)], vec![]);
        let out = s.run(Verification::Listed);
        assert_eq!(out, ConnectOutcome::failed(BUSY_MESSAGE));
        assert_eq!(*s.calls.borrow(), ["check", "remove", "pause", "remove"]);

        let s = Script::new(vec![exit(false, NOT_FOUND)], vec![exit(false, ELOCKED), exit(false, LOCKED)]);
        assert_eq!(s.run(Verification::Listed), ConnectOutcome::failed(BUSY_MESSAGE));
        assert_eq!(*s.calls.borrow(), ["check", "remove", "add", "pause", "add"]);
    }

    #[test]
    fn lock_on_add_retries_once() {
        let s = Script::new(vec![exit(true, "")], vec![exit(false, ELOCKED), exit(true, "")]);
        assert!(s.run(Verification::Listed).registered);
        assert_eq!(*s.calls.borrow(), ["check", "remove", "add", "pause", "add", "get"]);
    }

    #[test]
    fn non_lock_add_failure_keeps_the_cli_error_and_does_not_retry() {
        let s = Script::new(vec![exit(false, NOT_FOUND)], vec![exit(false, EXISTS)]);
        let out = s.run(Verification::Listed);
        assert_eq!(out.message, format!("Claude Code error: {EXISTS}"));
        assert_eq!(*s.calls.borrow(), ["check", "remove", "add"]);

        let s = Script::new(vec![exit(false, NOT_FOUND)], vec![exit(false, "")]);
        assert!(s.run(Verification::Listed).message.contains("rejected the registration"));
    }

    #[test]
    fn registered_comes_from_mcp_get_not_the_add_exit_code() {
        let s = Script::new(vec![exit(true, "")], vec![exit(true, "")]);
        let out = s.run(Verification::NotListed);
        assert!(!out.ok && !out.registered, "{out:?}");
        assert!(out.message.contains("doesn't list it"), "{}", out.message);
    }

    #[test]
    fn mcp_get_timeout_after_add_is_not_reported_as_unlisted() {
        let s = Script::new(vec![exit(true, "")], vec![exit(true, "")]);
        let out = s.run(Verification::Unconfirmed);
        assert!(!out.ok && !out.registered, "{out:?}");
        assert!(out.message.contains("didn't confirm it in time"), "{}", out.message);
        // The card has no status check of its own; pressing Connect again re-runs the verify.
        assert!(out.message.contains("press Connect to Claude Code again"), "{}", out.message);
        assert!(!out.message.contains("check the status"), "{}", out.message);
        assert!(!out.message.contains("doesn't list it"), "{}", out.message);
        assert_eq!(*s.calls.borrow(), ["check", "remove", "add", "get"]);
    }

    #[test]
    fn cli_that_cannot_start_is_reported() {
        let s = Script::new(vec![Err("No such file or directory".into())], vec![]);
        assert!(s.run(Verification::Listed).message.starts_with("Could not run the Claude Code CLI"));
    }

    #[test]
    fn mcp_get_probe_counts_only_a_clean_exit() {
        assert!(registered_from(Probe::Exited { success: true, output: String::new() }));
        assert!(!registered_from(Probe::Exited { success: false, output: String::new() }));
        assert!(!registered_from(Probe::TimedOut));
        assert!(!registered_from(Probe::Missing));
    }

    #[test]
    fn mcp_get_probe_tells_not_listed_from_unconfirmed() {
        let exited = |success| Probe::Exited { success, output: String::new() };
        assert_eq!(verification_from(exited(true)), Verification::Listed);
        assert_eq!(verification_from(exited(false)), Verification::NotListed);
        assert_eq!(verification_from(Probe::TimedOut), Verification::Unconfirmed);
        assert_eq!(verification_from(Probe::Missing), Verification::Unconfirmed);
    }

    fn assert_says_removed(out: &ConnectOutcome) {
        assert!(!out.ok && !out.registered, "{out:?}");
        assert!(out.message.contains("previous Octopush registration was removed"), "{}", out.message);
        assert!(out.message.contains("Press Connect to Claude Code again to restore it"), "{}", out.message);
        assert!(out.message.contains("run the command below"), "{}", out.message);
    }

    #[test]
    fn add_failing_after_a_real_remove_says_the_old_registration_is_gone() {
        // Busy through the retry.
        let s = Script::new(vec![exit(true, "")], vec![exit(false, ELOCKED), exit(false, LOCKED)]);
        let out = s.run(Verification::Listed);
        assert_says_removed(&out);
        assert!(out.message.contains("config is busy"), "{}", out.message);
        assert_eq!(*s.calls.borrow(), ["check", "remove", "add", "pause", "add"]);

        // Timed out through the retry.
        let s = Script::new(vec![exit(true, "")], vec![timed_out(), timed_out()]);
        let out = s.run(Verification::Listed);
        assert_says_removed(&out);
        assert!(out.message.contains("config is busy"), "{}", out.message);

        // A non-lock error keeps the CLI's words.
        let s = Script::new(vec![exit(true, "")], vec![exit(false, EXISTS)]);
        let out = s.run(Verification::Listed);
        assert_says_removed(&out);
        assert!(out.message.contains(EXISTS), "{}", out.message);
        assert_eq!(*s.calls.borrow(), ["check", "remove", "add"]);

        let s = Script::new(vec![exit(true, "")], vec![exit(false, "")]);
        assert_says_removed(&s.run(Verification::Listed));

        let s = Script::new(vec![exit(true, "")], vec![Err("No such file or directory".into())]);
        assert_says_removed(&s.run(Verification::Listed));

        // Nothing was removed: the plain messages stand.
        let s = Script::new(vec![exit(false, NOT_FOUND)], vec![timed_out(), timed_out()]);
        assert_eq!(s.run(Verification::Listed), ConnectOutcome::failed(BUSY_MESSAGE));
    }

    #[test]
    fn timeout_on_remove_reads_as_busy_and_is_retried_once() {
        let s = Script::new(vec![timed_out(), timed_out()], vec![]);
        assert_eq!(s.run(Verification::Listed), ConnectOutcome::failed(BUSY_MESSAGE));
        assert_eq!(*s.calls.borrow(), ["check", "remove", "pause", "remove"]);

        let s = Script::new(vec![timed_out(), exit(true, "")], vec![exit(true, "")]);
        assert!(s.run(Verification::Listed).registered);
        assert_eq!(*s.calls.borrow(), ["check", "remove", "pause", "remove", "add", "get"]);
    }

    #[test]
    fn already_registered_with_our_binary_skips_remove_and_add() {
        let s = Script { current: true, ..Script::new(vec![], vec![]) };
        let out = s.run(Verification::Listed);
        assert!(out.ok && out.registered, "{out:?}");
        assert_eq!(out.message, CONNECTED_MESSAGE);
        assert_eq!(*s.calls.borrow(), ["check"]);
    }

    const BIN: &str = "/Users/dev/Applications/Octopush.app/Contents/MacOS/octopush-mcp";
    /// Shape of a recorded `claude mcp get octopush` (2.1.314 fixture).
    const GET_OURS: &str = "octopush:\n  Scope: User config (available in all your projects)\n  Status: \u{2717} Failed to connect\n  Type: stdio\n  Command: /Users/dev/Applications/Octopush.app/Contents/MacOS/octopush-mcp\n  Args:\n  Environment:\n\nTo remove this server, run: claude mcp remove octopush -s user\n";

    #[test]
    fn mcp_get_output_matches_only_our_exact_registration() {
        assert!(registered_with(GET_OURS, Path::new(BIN)));
        assert!(!registered_with(GET_OURS, Path::new("/Applications/Octopush.app/Contents/MacOS/octopush-mcp")));
        assert!(!registered_with(&GET_OURS.replace("Args:", "Args: --verbose"), Path::new(BIN)));
        assert!(!registered_with(&GET_OURS.replace("Scope: User", "Scope: Local"), Path::new(BIN)));
        assert!(!registered_with(&GET_OURS.replace("Type: stdio", "Type: http"), Path::new(BIN)));
        assert!(!registered_with(&GET_OURS.replace("octopush:", "other:"), Path::new(BIN)));
        assert!(!registered_with("", Path::new(BIN)));
    }

    /// A stub `claude` that logs each call, then hangs past the timeout; it
    /// would touch `finished` if it were allowed to run to the end.
    #[cfg(unix)]
    fn hanging_stub(dir: &Path) -> (PathBuf, PathBuf, PathBuf) {
        let (script, log, finished) = (dir.join("claude"), dir.join("calls.log"), dir.join("finished"));
        let body = format!(
            "echo \"$@\" >> '{}'\nsleep 1\ntouch '{}'\n",
            log.display(),
            finished.display()
        );
        std::fs::write(&script, body).unwrap();
        (script, log, finished)
    }

    /// Run the stub through `/bin/sh` (not exec'd directly) so a freshly
    /// written script can't hit ETXTBSY while other tests fork.
    #[cfg(unix)]
    fn run_stub(script: &Path, args: &[&str], timeout: Duration) -> Result<CliRun, String> {
        let mut argv: Vec<std::ffi::OsString> = vec![script.as_os_str().to_owned()];
        argv.extend(args.iter().map(Into::into));
        run_cli(Path::new("/bin/sh"), &argv, timeout)
    }

    #[cfg(unix)]
    #[test]
    fn hung_cli_is_killed_at_the_timeout_and_reads_as_busy() {
        let dir = tempfile::tempdir().unwrap();
        let (script, log, finished) = hanging_stub(dir.path());

        let started = std::time::Instant::now();
        let run = run_stub(&script, &MCP_REMOVE_ARGS, Duration::from_millis(150)).unwrap();
        assert!(started.elapsed() < Duration::from_millis(900), "must not wait the stub out");
        assert!(run.timed_out && !run.success, "{run:?}");
        assert_eq!(run.failure(), CliFailure::Busy);

        // Through the whole flow: remove hangs twice (one retry), then busy.
        let out = connect_flow(
            || false,
            |step| {
                assert_eq!(*step, Step::Remove, "add must not run after a busy remove");
                run_stub(&script, &MCP_REMOVE_ARGS, Duration::from_millis(150))
            },
            || panic!("no verify after a busy remove"),
            || {},
        );
        assert_eq!(out, ConnectOutcome::failed(BUSY_MESSAGE));
        assert_eq!(std::fs::read_to_string(&log).unwrap().lines().count(), 3);

        // Had any of the three runs survived, it would have finished by now.
        std::thread::sleep(Duration::from_millis(1300));
        assert!(!finished.exists(), "the timed-out CLI was left running");
    }

    #[cfg(unix)]
    #[test]
    fn cli_output_and_exit_status_come_back_through_the_bounded_run() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("claude");
        std::fs::write(&script, format!("echo '{NOT_FOUND}' >&2\nexit 1\n")).unwrap();
        let run = run_stub(&script, &MCP_REMOVE_ARGS, CLI_TIMEOUT).unwrap();
        assert!(!run.success && !run.timed_out, "{run:?}");
        assert_eq!(run.output, NOT_FOUND);
        assert_eq!(run.failure(), CliFailure::NotFound);

        assert!(run_cli(Path::new("/nonexistent/claude"), &[], CLI_TIMEOUT).is_err());
    }

    #[test]
    fn cli_timeout_outlasts_claude_codes_lock_wait() {
        assert!(CLI_TIMEOUT >= Duration::from_secs(15), "{CLI_TIMEOUT:?}");
    }

    #[test]
    fn remove_and_add_argv_are_unchanged() {
        assert_eq!(MCP_REMOVE_ARGS, ["mcp", "remove", SERVER_NAME, "-s", "user"]);
    }
}
