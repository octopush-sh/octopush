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
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::readiness::{run_probe, run_probe_on_quit, run_status_probe, OnQuit, Probe, CHECK_TIMEOUT};

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
    registered_from(probe_registration(claude, CHECK_TIMEOUT))
}

fn probe_registration(claude: &Path, timeout: Duration) -> Probe {
    let mut cmd = Command::new(claude);
    cmd.args(["mcp", "get", SERVER_NAME]);
    // Only the exit status matters, so the output is never read.
    run_status_probe(Some(cmd), timeout)
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
fn already_registered_with(claude: &Path, binary: &Path, timeout: Duration) -> bool {
    let mut cmd = Command::new(claude);
    cmd.args(["mcp", "get", SERVER_NAME]);
    match run_probe(Some(cmd), timeout) {
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
/// One deadline for a whole Connect press: the pre-check, `remove`, `add`,
/// their retries and the verify. Each call gets what is left, capped at its
/// own timeout; with nothing left a call isn't started.
const CONNECT_BUDGET: Duration = Duration::from_secs(30);

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
fn run_cli(claude: &Path, args: &[std::ffi::OsString], timeout: Duration, on_quit: OnQuit) -> Result<CliRun, String> {
    let mut cmd = Command::new(claude);
    cmd.args(args);
    match run_probe_on_quit(Some(cmd), timeout, on_quit) {
        Probe::Missing => Err(format!("{} could not be started", claude.display())),
        Probe::TimedOut => Ok(CliRun { success: false, timed_out: true, output: String::new() }),
        Probe::Exited { success, output } => Ok(CliRun { success, timed_out: false, output: output.trim().to_string() }),
    }
}

/// Run once; on a lock failure (or a timeout), `pause` and run once more —
/// unless the pause would use up what is `left` of the Connect budget.
fn with_lock_retry(
    mut run: impl FnMut() -> Result<CliRun, String>,
    pause: &mut impl FnMut(),
    left: &impl Fn() -> Duration,
) -> Result<CliRun, String> {
    let first = run()?;
    if first.success || first.failure() != CliFailure::Busy || left() <= LOCK_RETRY_PAUSE {
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

impl Step {
    /// Quitting mid-`add` waits for it briefly: by then `remove` may have
    /// succeeded, and killing the `add` would leave Octopush unregistered.
    fn on_quit(&self) -> OnQuit {
        match self {
            Step::Remove => OnQuit::Kill,
            Step::Add => OnQuit::Finish,
        }
    }
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

/// How much of the CLI's own output a failure message quotes.
const SHOWN_OUTPUT_CHARS: usize = 300;

/// `output` cut to [`SHOWN_OUTPUT_CHARS`] with an ellipsis: a CLI can print a
/// whole stack trace, and the card shows it verbatim.
fn shown(output: &str) -> String {
    match output.char_indices().nth(SHOWN_OUTPUT_CHARS) {
        Some((cut, _)) => format!("{}…", output[..cut].trim_end()),
        None => output.to_string(),
    }
}

/// The add failed after a successful remove: the user's old entry is gone.
fn removed_then_failed(reason: &str) -> ConnectOutcome {
    ConnectOutcome::failed(format!(
        "The previous Octopush registration was removed, but adding it back failed: {}. Press Connect to Claude Code again to restore it, or run the command below.",
        reason.trim_end_matches('.')
    ))
}

/// The verify after `add`, within what is `left` (at most the probe timeout).
/// With nothing left it isn't run: unconfirmed.
fn verify_within(verify: impl FnOnce(Duration) -> Verification, left: Duration) -> Verification {
    match left.min(CHECK_TIMEOUT) {
        t if t.is_zero() => Verification::Unconfirmed,
        t => verify(t),
    }
}

/// Shown if Connect stopped because the app is quitting (never seen in practice).
const QUITTING_MESSAGE: &str = "Octopush is quitting; nothing was changed.";

/// The check → remove → add → verify flow, with the CLI calls injected so it
/// can be tested against recorded output. Each call is handed its timeout:
/// its own cap or what is `left` of the Connect budget, whichever is less.
/// Once `quitting`, nothing new starts but an `add` that restores a removed
/// registration; the verify is skipped.
fn connect_flow(
    already_registered: impl FnOnce(Duration) -> bool,
    mut run: impl FnMut(&Step, Duration) -> Result<CliRun, String>,
    verify: impl FnOnce(Duration) -> Verification,
    mut pause: impl FnMut(),
    left: impl Fn() -> Duration,
    quitting: impl Fn() -> bool,
) -> ConnectOutcome {
    // Already pointing at this exact binary: nothing to change, nothing to risk.
    if already_registered(left().min(CHECK_TIMEOUT)) {
        return ConnectOutcome { ok: true, registered: true, message: CONNECTED_MESSAGE.into() };
    }

    let could_not_run = |e: String| ConnectOutcome::failed(format!("Could not run the Claude Code CLI: {e}"));
    // Out of budget reads like a call killed at its timeout: busy.
    let mut attempt = |step: &Step| match left().min(CLI_TIMEOUT) {
        t if t.is_zero() => Ok(CliRun { success: false, timed_out: true, output: String::new() }),
        _ if *step == Step::Remove && quitting() => Err(QUITTING_MESSAGE.to_string()),
        t => run(step, t),
    };

    // Remove-then-add makes the operation idempotent. "Not registered" is fine.
    let removed = match with_lock_retry(|| attempt(&Step::Remove), &mut pause, &left) {
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
                    shown(&r.output)
                ))
            }
        },
    };

    match with_lock_retry(|| attempt(&Step::Add), &mut pause, &left) {
        Err(e) if removed => removed_then_failed(&format!("could not run the Claude Code CLI: {e}")),
        Err(e) => could_not_run(e),
        // Quitting: a verify could outlive the app, so it isn't run.
        Ok(r) if r.success => match verify_within(verify, if quitting() { Duration::ZERO } else { left() }) {
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
            _ => format!("Claude Code error: {}", shown(&r.output)),
        }),
        Ok(r) if r.failure() == CliFailure::Busy => ConnectOutcome::failed(BUSY_MESSAGE),
        Ok(r) if r.output.is_empty() => {
            ConnectOutcome::failed("Claude Code rejected the registration. Try the manual command below.")
        }
        Ok(r) => ConnectOutcome::failed(format!("Claude Code error: {}", shown(&r.output))),
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
    let deadline = Instant::now() + CONNECT_BUDGET;
    // Quitting waits for this (within `QUIT_GRACE`), so a quit between a
    // successful `remove` and the `add` — the retry pause included — doesn't
    // leave the registration removed.
    let _finishing = crate::readiness::finish_before_quit();
    let outcome = connect_flow(
        |timeout| already_registered_with(&claude, &binary, timeout),
        |step, timeout| match step {
            Step::Remove => run_cli(&claude, &remove_args, timeout, step.on_quit()),
            Step::Add => run_cli(&claude, &add_args, timeout, step.on_quit()),
        },
        |timeout| verification_from(probe_registration(&claude, timeout)),
        || std::thread::sleep(LOCK_RETRY_PAUSE),
        || deadline.saturating_duration_since(Instant::now()),
        crate::readiness::quitting,
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
    use std::cell::{Cell, RefCell};

    /// A scripted CLI call: its result and how long it takes (at most the
    /// timeout it is given).
    type Scripted = (Result<CliRun, String>, Duration);

    fn exit(success: bool, output: &str) -> Scripted {
        (Ok(CliRun { success, timed_out: false, output: output.into() }), Duration::ZERO)
    }

    /// Runs until it is killed at the timeout it was given.
    fn timed_out() -> Scripted {
        (Ok(CliRun { success: false, timed_out: true, output: String::new() }), Duration::MAX)
    }

    fn cannot_start(reason: &str) -> Scripted {
        (Err(reason.into()), Duration::ZERO)
    }

    fn after(takes: f64, (result, _): Scripted) -> Scripted {
        (result, Duration::from_secs_f64(takes))
    }

    /// Plays back scripted results per step on a fake clock that starts with
    /// the whole Connect budget; records every call, pause and timeout given.
    struct Script {
        /// What the pre-check (`mcp get` shows exactly our binary) answers.
        current: bool,
        remove: RefCell<Vec<Scripted>>,
        add: RefCell<Vec<Scripted>>,
        calls: RefCell<Vec<&'static str>>,
        /// The timeout each check, remove, add and get was handed, in order.
        timeouts: RefCell<Vec<Duration>>,
        left: Cell<Duration>,
        /// The app starts quitting after this many calls and pauses.
        quit_after: Option<usize>,
    }

    impl Script {
        fn new(remove: Vec<Scripted>, add: Vec<Scripted>) -> Self {
            Self {
                current: false,
                remove: RefCell::new(remove),
                add: RefCell::new(add),
                calls: RefCell::new(vec![]),
                timeouts: RefCell::new(vec![]),
                left: Cell::new(CONNECT_BUDGET),
                quit_after: None,
            }
        }

        fn spend(&self, d: Duration) {
            self.left.set(self.left.get().saturating_sub(d));
        }

        fn call(&self, name: &'static str, timeout: Duration) {
            self.calls.borrow_mut().push(name);
            self.timeouts.borrow_mut().push(timeout);
        }

        fn run(&self, verified: Verification) -> ConnectOutcome {
            connect_flow(
                |t| {
                    self.call("check", t);
                    self.current
                },
                |step, t| {
                    let (name, queue) = match step {
                        Step::Remove => ("remove", &self.remove),
                        Step::Add => ("add", &self.add),
                    };
                    self.call(name, t);
                    let (result, takes) = queue.borrow_mut().remove(0);
                    self.spend(takes.min(t));
                    result
                },
                |t| {
                    self.call("get", t);
                    verified
                },
                || {
                    self.calls.borrow_mut().push("pause");
                    self.spend(LOCK_RETRY_PAUSE);
                },
                || self.left.get(),
                || self.quit_after.is_some_and(|n| self.calls.borrow().len() >= n),
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
    fn long_cli_output_is_cut_in_every_failure_message() {
        // Multi-byte, so a byte-indexed cut would panic mid-character.
        let trace = format!("Error: boom é\n{}", "    at frame (/usr/lib/node/é.js:1:1)\n".repeat(200));
        let cut = shown(&trace);
        assert!(cut.starts_with("Error: boom é") && cut.ends_with('…') && cut.chars().count() <= SHOWN_OUTPUT_CHARS + 1);
        assert_eq!(shown(EXISTS), EXISTS, "short output is kept whole");

        let remove = Script::new(vec![exit(false, &trace)], vec![]).run(Verification::Listed);
        let add = Script::new(vec![exit(false, NOT_FOUND)], vec![exit(false, &trace)]).run(Verification::Listed);
        let after_remove = Script::new(vec![exit(true, "")], vec![exit(false, &trace)]).run(Verification::Listed);
        for out in [remove, add, after_remove] {
            assert!(out.message.contains(&cut) && out.message.chars().count() < 600, "{}", out.message);
        }
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
        let s = Script::new(vec![cannot_start("No such file or directory")], vec![]);
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

        let s = Script::new(vec![exit(true, "")], vec![cannot_start("No such file or directory")]);
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
        run_cli(Path::new("/bin/sh"), &argv, timeout, OnQuit::Kill)
    }

    #[test]
    fn quitting_lets_only_the_add_finish() {
        assert_eq!(Step::Add.on_quit(), OnQuit::Finish);
        assert_eq!(Step::Remove.on_quit(), OnQuit::Kill);
    }

    #[test]
    fn quitting_after_the_remove_still_adds_but_skips_the_verify() {
        // Quit lands in the gap after `remove`: the add restores the entry,
        // and no `mcp get` is started that could outlive the app.
        let s = Script { quit_after: Some(2), ..Script::new(vec![exit(true, "")], vec![exit(true, "")]) };
        let out = s.run(Verification::Listed);
        assert_eq!(*s.calls.borrow(), ["check", "remove", "add"]);
        assert!(out.message.contains("didn't confirm it in time"), "{}", out.message);

        // Quit during the pause before a busy add's retry: the retry still runs.
        let s = Script { quit_after: Some(4), ..Script::new(vec![exit(true, "")], vec![exit(false, ELOCKED), exit(true, "")]) };
        s.run(Verification::Listed);
        assert_eq!(*s.calls.borrow(), ["check", "remove", "add", "pause", "add"]);
    }

    #[test]
    fn quitting_before_the_remove_changes_nothing() {
        let s = Script { quit_after: Some(1), ..Script::new(vec![exit(true, "")], vec![exit(true, "")]) };
        let out = s.run(Verification::Listed);
        assert!(!out.ok && !out.registered, "{out:?}");
        assert!(out.message.contains(QUITTING_MESSAGE), "{}", out.message);
        assert_eq!(*s.calls.borrow(), ["check"]);

        // Quit during the pause before a busy remove's retry: no second remove.
        let s = Script { quit_after: Some(3), ..Script::new(vec![exit(false, LOCKED), exit(true, "")], vec![]) };
        s.run(Verification::Listed);
        assert_eq!(*s.calls.borrow(), ["check", "remove", "pause"]);
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
            |_| false,
            |step, _| {
                assert_eq!(*step, Step::Remove, "add must not run after a busy remove");
                run_stub(&script, &MCP_REMOVE_ARGS, Duration::from_millis(150))
            },
            |_| panic!("no verify after a busy remove"),
            || {},
            || CONNECT_BUDGET,
            || false,
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

        assert!(run_cli(Path::new("/nonexistent/claude"), &[], CLI_TIMEOUT, OnQuit::Kill).is_err());
    }

    #[test]
    fn cli_timeout_outlasts_claude_codes_lock_wait() {
        assert!(CLI_TIMEOUT >= Duration::from_secs(15), "{CLI_TIMEOUT:?}");
        assert!(CONNECT_BUDGET >= CHECK_TIMEOUT + CLI_TIMEOUT, "{CONNECT_BUDGET:?}");
    }

    const fn secs(s: u64) -> Duration {
        Duration::from_secs(s)
    }

    /// The case from the #563 review: a slow remove, then an add that times
    /// out twice. Each call used to get its full timeout (about 64 s in all).
    #[test]
    fn the_whole_connect_stays_within_one_deadline() {
        let s = Script::new(vec![after(19.5, exit(true, ""))], vec![timed_out(), timed_out()]);
        s.spend(CHECK_TIMEOUT); // a pre-check that ran to its timeout
        let out = s.run(Verification::Listed);
        assert_says_removed(&out);
        assert!(out.message.contains("config is busy"), "{}", out.message);
        // The add gets the 7.5 s left, and with nothing left there is no retry.
        assert_eq!(*s.calls.borrow(), ["check", "remove", "add"]);
        assert_eq!(*s.timeouts.borrow(), [CHECK_TIMEOUT, CLI_TIMEOUT, Duration::from_millis(7500)]);
        assert_eq!(s.left.get(), Duration::ZERO);

        // A lock error late in the budget: the retry gets what the pause leaves.
        let s = Script::new(vec![exit(true, "")], vec![after(18.0, exit(false, ELOCKED)), timed_out()]);
        s.spend(CHECK_TIMEOUT);
        assert_says_removed(&s.run(Verification::Listed));
        assert_eq!(*s.calls.borrow(), ["check", "remove", "add", "pause", "add"]);
        assert_eq!(*s.timeouts.borrow(), [CHECK_TIMEOUT, CLI_TIMEOUT, CLI_TIMEOUT, secs(8)]);
        assert_eq!(s.left.get(), Duration::ZERO);
    }

    #[test]
    fn no_retry_when_the_pause_would_use_up_the_budget() {
        let s = Script::new(vec![after(20.0, exit(false, ELOCKED))], vec![]);
        s.spend(Duration::from_secs_f64(9.5));
        assert_eq!(s.run(Verification::Listed), ConnectOutcome::failed(BUSY_MESSAGE));
        assert_eq!(*s.calls.borrow(), ["check", "remove"]);
    }

    #[test]
    fn out_of_budget_skips_the_remaining_calls() {
        // Nothing left for the add: it isn't started, and reads as busy.
        let s = Script::new(vec![after(20.0, exit(false, NOT_FOUND))], vec![]);
        s.spend(secs(10));
        assert_eq!(s.run(Verification::Listed), ConnectOutcome::failed(BUSY_MESSAGE));
        assert_eq!(*s.calls.borrow(), ["check", "remove"]);

        // Nothing left for the verify: unconfirmed, never claimed missing.
        let s = Script::new(vec![after(10.0, exit(true, ""))], vec![after(20.0, exit(true, ""))]);
        let out = s.run(Verification::NotListed);
        assert!(out.message.contains("didn't confirm it in time"), "{}", out.message);
        assert_eq!(*s.calls.borrow(), ["check", "remove", "add"]);

        // A little left: the verify gets that, not its full 3 s.
        let s = Script::new(vec![after(10.0, exit(true, ""))], vec![after(19.0, exit(true, ""))]);
        assert!(s.run(Verification::Listed).registered);
        assert_eq!(*s.timeouts.borrow(), [CHECK_TIMEOUT, CLI_TIMEOUT, CLI_TIMEOUT, secs(1)]);
    }

    #[test]
    fn remove_and_add_argv_are_unchanged() {
        assert_eq!(MCP_REMOVE_ARGS, ["mcp", "remove", SERVER_NAME, "-s", "user"]);
    }
}
