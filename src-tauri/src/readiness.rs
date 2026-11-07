//! "Is this Mac ready for a crew?" — the Settings › General readiness card.
//! Each check runs one local command (Ollama: a TCP connect to a loopback
//! port; disk space: the footer's volume reading) within 3 s, in parallel,
//! never cached and with no telemetry.

use crate::agent_adapter::{parse_claude_version, ClaudeCliVersion, TESTED_CLAUDE_FLOOR};
use serde::Serialize;
use std::io::Read;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

pub const CHECK_TIMEOUT: Duration = Duration::from_secs(3);
/// After a probed command exits, how long its output may still take to
/// arrive (only something that left its group can hold it open that long).
const DRAIN_FLOOR: Duration = Duration::from_millis(250);
/// What a probe keeps of each stream; the rest is read and dropped.
const OUTPUT_CAP: usize = 64 * 1024;
pub const INSTALL_CLAUDE: &str = "npm i -g @anthropic-ai/claude-code";
pub const UPDATE_CLAUDE: &str = "npm i -g @anthropic-ai/claude-code@latest";

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CheckStatus {
    Ok,
    /// A crew can still run, but something will bite.
    Warn,
    /// A crew will fail on this.
    Fail,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReadinessCheck {
    /// `claude` | `auth` | `git` | `gh` | `disk` | `ollama`.
    pub id: String,
    pub label: String,
    pub status: CheckStatus,
    /// The live value: a version, "Token found", "No answer in 3 s"…
    pub value: String,
    /// One-line fix, only when not ok.
    pub fix: Option<String>,
    /// A copyable command that fixes it.
    pub command: Option<String>,
    pub timed_out: bool,
}

impl ReadinessCheck {
    fn ok(id: &str, label: &str, value: impl Into<String>) -> Self {
        let (id, label, value) = (id.into(), label.into(), value.into());
        Self { id, label, status: CheckStatus::Ok, value, fix: None, command: None, timed_out: false }
    }

    fn not_ok(id: &str, label: &str, status: CheckStatus, value: &str, fix: &str, command: Option<&str>) -> Self {
        let (id, label, value, fix) = (id.into(), label.into(), value.into(), Some(fix.into()));
        Self { id, label, status, value, fix, command: command.map(Into::into), timed_out: false }
    }

    fn timed_out(id: &str, label: &str, command: &str) -> Self {
        let fix = "It didn't answer in time. Run it yourself to see why, then check again.";
        Self { timed_out: true, ..Self::not_ok(id, label, CheckStatus::Warn, "No answer in 3 s", fix, Some(command)) }
    }

    /// The check's thread panicked: nothing is known about this Mac.
    fn failed_to_run(id: &str, label: &str) -> Self {
        let fix = "Octopush couldn't run this check. Check again; if it keeps failing, please report it.";
        Self::not_ok(id, label, CheckStatus::Warn, "Check failed to run", fix, None)
    }
}

#[derive(Debug, PartialEq)]
pub enum Probe {
    /// Not on the PATH, or couldn't start.
    Missing,
    TimedOut,
    Exited { success: bool, output: String },
}

/// Run `cmd` within `timeout`, joining stdout and stderr (the first
/// [`OUTPUT_CAP`] bytes of each). Its whole process group is killed at the
/// timeout or when it exits, so whatever it spawned dies with it unless it
/// left the group.
pub fn run_probe(cmd: Option<Command>, timeout: Duration) -> Probe {
    probe_with(cmd, timeout, true)
}

/// Like [`run_probe`], but output goes to `/dev/null` and is never read.
pub fn run_status_probe(cmd: Option<Command>, timeout: Duration) -> Probe {
    probe_with(cmd, timeout, false)
}

fn probe_with(cmd: Option<Command>, timeout: Duration, capture: bool) -> Probe {
    let Some(mut cmd) = cmd else { return Probe::Missing };
    let io = || if capture { Stdio::piped() } else { Stdio::null() };
    cmd.stdin(Stdio::null()).stdout(io()).stderr(io());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let Ok(mut child) = cmd.spawn() else {
        return Probe::Missing;
    };
    let pid = child.id();
    track(pid);
    // Read while it runs: a reply bigger than the pipe buffer would otherwise
    // block the command until the timeout.
    let mut pipes: Vec<Pipe> = [child.stdout.take().map(Pipe::read), child.stderr.take().map(Pipe::read)]
        .into_iter()
        .flatten()
        .collect();
    let deadline = Instant::now() + timeout;
    while !has_exited(&mut child) {
        if Instant::now() >= deadline {
            untrack(pid);
            kill_process_group(&mut child);
            return Probe::TimedOut;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    // Not reaped yet, so its zombie still holds the pid and with it the group
    // id: kill what it left running (holding its output or not) before the
    // reap, when neither can belong to another process yet. Untracked first,
    // so `kill_in_flight` can't signal it after the reap either.
    kill_group(pid);
    untrack(pid);
    let success = child.wait().is_ok_and(|s| s.success());
    // What it printed is already in the pipes; the floor gives the readers
    // time to take it.
    collect(&mut pipes, Instant::now() + DRAIN_FLOOR);
    let output = pipes.iter().map(|p| String::from_utf8_lossy(&p.bytes)).collect();
    Probe::Exited { success, output }
}

/// True once `child` has exited, without reaping it.
#[cfg(unix)]
fn has_exited(child: &mut Child) -> bool {
    // `si_code` values, the same on macOS and Linux.
    const CLD_EXITED: i32 = 1;
    const CLD_KILLED: i32 = 2;
    const CLD_DUMPED: i32 = 3;
    // SAFETY: a zeroed siginfo_t is valid; waitid only writes into it.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let flags = libc::WEXITED | libc::WNOWAIT | libc::WNOHANG;
    // SAFETY: `info` is a live, writable siginfo_t; WNOWAIT leaves the child waitable.
    let rc = unsafe { libc::waitid(libc::P_PID, child.id() as libc::id_t, &mut info, flags) };
    if rc == 0 {
        // Still zeroed when nothing changed; macOS also reports a stopped
        // child despite WEXITED, so only an exit counts.
        return matches!(info.si_code, CLD_EXITED | CLD_KILLED | CLD_DUMPED);
    }
    if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
        return false;
    }
    // waitid unusable: reap the plain way (the pid is then no longer pinned).
    !matches!(child.try_wait(), Ok(None))
}

#[cfg(not(unix))]
fn has_exited(child: &mut Child) -> bool {
    !matches!(child.try_wait(), Ok(None))
}

/// One stdout/stderr pipe, read on its own thread: chunks arrive as they are
/// read, so whatever came before a kill is kept. Only the first
/// [`OUTPUT_CAP`] bytes are sent; the reader drains the rest so the command
/// never blocks on a full pipe, and stops once the probe has returned.
struct Pipe {
    rx: mpsc::Receiver<Vec<u8>>,
    bytes: Vec<u8>,
    /// False once the reader hit end of file.
    open: bool,
    /// Dropped with the pipe: tells a reader past the cap to stop.
    _alive: Arc<()>,
}

impl Pipe {
    fn read(mut pipe: impl Read + Send + 'static) -> Self {
        let (tx, rx) = mpsc::channel();
        let alive = Arc::new(());
        let watch = Arc::downgrade(&alive);
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            let mut room = OUTPUT_CAP;
            loop {
                match pipe.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) if room > 0 => {
                        let keep = n.min(room);
                        if tx.send(buf[..keep].to_vec()).is_err() {
                            break;
                        }
                        room -= keep;
                    }
                    Ok(_) if watch.strong_count() > 0 => {}
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                    _ => break,
                }
            }
        });
        Self { rx, bytes: Vec::new(), open: true, _alive: alive }
    }
}

/// Take what each pipe delivers until it closes or `until` passes; after
/// `until`, only what has already arrived (at most [`OUTPUT_CAP`]).
fn collect(pipes: &mut [Pipe], until: Instant) {
    for pipe in pipes {
        while pipe.open {
            let left = until.saturating_duration_since(Instant::now());
            let next = if left.is_zero() {
                pipe.rx.try_recv().map_err(|e| match e {
                    mpsc::TryRecvError::Empty => mpsc::RecvTimeoutError::Timeout,
                    mpsc::TryRecvError::Disconnected => mpsc::RecvTimeoutError::Disconnected,
                })
            } else {
                pipe.rx.recv_timeout(left)
            };
            match next {
                Ok(chunk) => pipe.bytes.extend(chunk),
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => pipe.open = false,
            }
        }
    }
}

/// The process groups of the probes running right now. Each has its own
/// group, so quitting doesn't take them down: `kill_in_flight` (on
/// `RunEvent::Exit`) does.
static IN_FLIGHT: Mutex<Vec<u32>> = Mutex::new(Vec::new());

fn track(pid: u32) {
    IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner()).push(pid);
}

/// Called before the child is reaped. `kill_in_flight` signals under the same
/// lock, so it either sees the pid while the unreaped child still holds it,
/// or not at all: never a pid that may have been handed out again.
fn untrack(pid: u32) {
    IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner()).retain(|&p| p != pid);
}

/// SIGKILL every probe still running, with what it spawned (the app is quitting).
pub fn kill_in_flight() {
    let mut in_flight = IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner());
    for pid in in_flight.drain(..) {
        kill_group(pid);
    }
}

/// SIGKILL the process group `process_group(0)` gave the child `pid`.
#[cfg(unix)]
fn kill_group(pid: u32) {
    // SAFETY: kill(-pid, SIGKILL) only sends a signal; it touches no memory.
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}

#[cfg(not(unix))]
fn kill_group(_pid: u32) {}

/// Kill `child` and everything in its process group, then reap it.
fn kill_process_group(child: &mut Child) {
    kill_group(child.id());
    let _ = child.kill();
    let _ = child.wait();
}

/// `claude --version` against the tested floor (#278).
pub fn claude_check(probe: Probe, floor: &str) -> ReadinessCheck {
    const ID: &str = "claude";
    const LABEL: &str = "Claude Code";
    let not_ok = |status, value: &str, fix: &str, command| ReadinessCheck::not_ok(ID, LABEL, status, value, fix, Some(command));
    match probe {
        Probe::Missing => not_ok(CheckStatus::Fail, "Not found", "Install Claude Code, then check again.", INSTALL_CLAUDE),
        Probe::TimedOut => ReadinessCheck::timed_out(ID, LABEL, "claude --version"),
        Probe::Exited { success, output } => {
            let version = if success { parse_claude_version(&output) } else { None };
            let info = ClaudeCliVersion::new(version, floor);
            let (unknown, old) = ("claude --version didn't print a version. Reinstalling usually fixes it.", "older releases can record wrong token usage.");
            match info.version.as_deref() {
                None => not_ok(CheckStatus::Warn, "Version unknown", unknown, INSTALL_CLAUDE),
                Some(v) if info.below_floor => {
                    let fix = format!("Update to {} or newer; {old}", info.recommended);
                    not_ok(CheckStatus::Warn, &format!("{v} · tested with {floor}"), &fix, UPDATE_CLAUDE)
                }
                Some(v) => match info.security_notice() {
                    Some(note) => not_ok(CheckStatus::Warn, v, &format!("{note}."), UPDATE_CLAUDE),
                    None => ReadinessCheck::ok(ID, LABEL, v),
                },
            }
        }
    }
}

/// `git --version`. A fresh Mac's `/usr/bin/git` stub exits non-zero.
pub fn git_check(probe: Probe) -> ReadinessCheck {
    match probe {
        Probe::Exited { success: true, output } => ReadinessCheck::ok("git", "git", parse_claude_version(&output).unwrap_or("Found".into())),
        Probe::TimedOut => ReadinessCheck::timed_out("git", "git", "git --version"),
        _ => {
            let fix = "Workspaces are git worktrees. Install the command-line tools.";
            ReadinessCheck::not_ok("git", "git", CheckStatus::Fail, "Not found", fix, Some("xcode-select --install"))
        }
    }
}

/// Only looks up gh's stored credential; unlike `gh auth status` it never
/// contacts GitHub. Run under [`run_status_probe`], so the token is never read.
pub const GH_PROBE_ARGS: [&str; 4] = ["auth", "token", "--hostname", "github.com"];
pub const GH_PROBE: &str = "gh auth token --hostname github.com";

/// The token isn't validated online, hence "Token found", not "Signed in".
pub fn gh_check(probe: Probe) -> ReadinessCheck {
    const ID: &str = "gh";
    const LABEL: &str = "GitHub CLI";
    let warn = |value, fix, command| ReadinessCheck::not_ok(ID, LABEL, CheckStatus::Warn, value, fix, Some(command));
    match probe {
        Probe::Missing => warn("Not found", "Crews open pull requests with gh. Install it to ship a run.", "brew install gh"),
        Probe::TimedOut => ReadinessCheck::timed_out(ID, LABEL, GH_PROBE),
        Probe::Exited { success: true, .. } => ReadinessCheck::ok(ID, LABEL, "Token found"),
        Probe::Exited { success: false, .. } => warn("Not signed in", "Sign gh in so a crew can open its pull request.", "gh auth login"),
    }
}

pub const CLAUDE_LOGIN: &str = "claude auth login";

/// `12 Dec` in the Mac's time zone.
pub fn day_label(epoch_secs: i64) -> String {
    chrono::DateTime::from_timestamp(epoch_secs, 0)
        .map(|d| d.with_timezone(&chrono::Local).format("%-d %b").to_string())
        .unwrap_or_else(|| "an unknown date".into())
}

/// An Anthropic key (settings or `ANTHROPIC_API_KEY`) → API key; otherwise
/// CLI stages run on the `claude` login and API stages can't run. With no
/// key, `login_expires_at` (the sign-in end a CLI stage last reported, see
/// `claude_login`) says how long that login lasts; without one the row
/// stays as it was (older CLIs never report it). Never contacts the network.
pub fn auth_check(has_anthropic_key: bool, login_expires_at: Option<i64>, now: i64) -> ReadinessCheck {
    use crate::claude_login::{state, LoginState};
    const ID: &str = "auth";
    const LABEL: &str = "Claude auth";
    if has_anthropic_key {
        return ReadinessCheck::ok(ID, LABEL, "API key");
    }
    let Some(ends) = login_expires_at else {
        let fix = "CLI stages use your claude login. API stages need an Anthropic key in Settings › Models.";
        return ReadinessCheck::not_ok(ID, LABEL, CheckStatus::Warn, "Subscription", fix, None);
    };
    let day = day_label(ends);
    match state(ends, now) {
        LoginState::Ok => ReadinessCheck::ok(ID, LABEL, format!("Signed in · until {day}")),
        LoginState::EndingSoon => {
            let fix = "Sign in again before it ends so overnight crews keep running.";
            ReadinessCheck::not_ok(ID, LABEL, CheckStatus::Warn, &format!("Sign-in ends {day}"), fix, Some(CLAUDE_LOGIN))
        }
        LoginState::Ended => {
            let fix = "CLI stages and Routines can't run on it. Sign in again; this clears after the next Claude Code stage reports the new date.";
            ReadinessCheck::not_ok(ID, LABEL, CheckStatus::Fail, &format!("Sign-in ended {day}"), fix, Some(CLAUDE_LOGIN))
        }
    }
}

const GIB: u64 = 1024 * 1024 * 1024;
/// Under this much free space the disk row turns amber.
pub const DISK_WARN_BYTES: u64 = 10 * GIB;
/// Under this much it turns rouge, and the Direct launcher warns
/// (`LOW_DISK_BYTES` in `src/lib/diskSpace.ts`).
pub const DISK_FAIL_BYTES: u64 = 2 * GIB;

/// `18 GB`, `1.4 GB`, `600 MB`, `0 B`: the footer's `formatBytes`
/// (`src/lib/formatBytes.ts`), whole numbers from 10 of a unit up.
pub fn format_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    const UNITS: [&str; 4] = ["KB", "MB", "GB", "TB"];
    let mut v = bytes as f64 / 1024.0;
    let mut i = 0;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    let unit = UNITS[i];
    let one = (v * 10.0).round() / 10.0;
    if one < 10.0 { format!("{one:.1} {unit}") } else { format!("{} {unit}", v.round()) }
}

/// Free space on the home volume (`perf::home_disk`, the footer's reading).
/// Each workspace is a worktree its setup script may fill with gigabytes.
/// `None` when the volume couldn't be read (total 0): no row, never a guess.
pub fn disk_check(disk: &crate::perf::DiskInfo) -> Option<ReadinessCheck> {
    const ID: &str = "disk";
    const LABEL: &str = "Disk space";
    if disk.total_bytes == 0 {
        return None;
    }
    let free = disk.free_bytes;
    let value = format!("{} free", format_bytes(free));
    Some(if free < DISK_FAIL_BYTES {
        let fix = "A crew will likely fail when the disk fills. Free some space or archive old workspaces before a run.";
        ReadinessCheck::not_ok(ID, LABEL, CheckStatus::Fail, &value, fix, None)
    } else if free < DISK_WARN_BYTES {
        let fix = "Crews create worktrees and run setup scripts; free some space or archive old workspaces.";
        ReadinessCheck::not_ok(ID, LABEL, CheckStatus::Warn, &value, fix, None)
    } else {
        ReadinessCheck::ok(ID, LABEL, value)
    })
}

/// `host:port` of a loopback base URL; `None` (never probed) otherwise.
pub fn loopback_addr(base_url: &str) -> Option<String> {
    let rest = base_url.split_once("://").map_or(base_url, |(_, r)| r);
    let authority = rest.split('/').next()?;
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (h, p.parse::<u16>().ok()?),
        _ => (authority, if base_url.starts_with("https") { 443 } else { 80 }),
    };
    matches!(host, "localhost" | "127.0.0.1" | "[::1]").then(|| format!("{host}:{port}"))
}

pub fn ollama_check(addr: &str, timeout: Duration) -> ReadinessCheck {
    let addrs = addr.to_socket_addrs().map(|addrs| addrs.collect::<Vec<SocketAddr>>()).unwrap_or_default();
    let reachable = connect_any(&addrs, timeout, |a, left| TcpStream::connect_timeout(a, left).is_ok());
    if reachable {
        ReadinessCheck::ok("ollama", "Ollama", addr)
    } else {
        let fix = "Start Ollama, or turn its provider off in Settings › Models.";
        ReadinessCheck::not_ok("ollama", "Ollama", CheckStatus::Warn, "Not running", fix, Some("ollama serve"))
    }
}

/// Try each address until one connects; all share one `timeout`
/// (`localhost` resolves to both `::1` and `127.0.0.1`).
pub fn connect_any(addrs: &[SocketAddr], timeout: Duration, mut connect: impl FnMut(&SocketAddr, Duration) -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    addrs.iter().any(|a| {
        let left = deadline.saturating_duration_since(Instant::now());
        !left.is_zero() && connect(a, left)
    })
}

/// `name` resolved on the login-shell PATH the CLI stages use.
fn local_command(name: &str, args: &[&str]) -> Option<Command> {
    use crate::orchestrator::cli_runner::{login_shell_env, resolve_executable, resolved_cli_path};
    let path_env = resolved_cli_path();
    let bin = resolve_executable(name, &path_env)?;
    let mut cmd = Command::new(bin);
    cmd.args(args);
    for (k, v) in login_shell_env() {
        cmd.env(k, v);
    }
    cmd.env("PATH", &path_env);
    Some(cmd)
}

fn enabled_ollama_addr() -> Option<String> {
    let router = crate::provider_router::ProviderRouter::load().ok()?;
    let ollama = router.list_providers().into_iter().find(|p| p.name == "ollama" && p.enabled)?;
    let base = crate::settings::get_provider_base_url("ollama").unwrap_or_else(|| ollama.api_base.clone());
    loopback_addr(&base)
}

/// Every check, in card order. Blocking: call it off the async runtime.
/// `login_expires_at` is the stored claude.ai sign-in end (`claude_login`).
pub fn run_all(login_expires_at: Option<i64>) -> Vec<ReadinessCheck> {
    let claude = std::thread::spawn(|| {
        // Its answer may be newer than the session's cached version (the
        // user just updated): the launcher and the next stage probe again.
        crate::agent_adapter::forget_claude_cli_version();
        claude_check(run_probe(local_command("claude", &["--version"]), CHECK_TIMEOUT), TESTED_CLAUDE_FLOOR)
    });
    let git = std::thread::spawn(|| git_check(run_probe(local_command("git", &["--version"]), CHECK_TIMEOUT)));
    let gh = std::thread::spawn(|| {
        let cmd = local_command("gh", &GH_PROBE_ARGS).map(|mut c| {
            // No update checks or prompts from gh.
            c.env("GH_NO_UPDATE_NOTIFIER", "1").env("GH_NO_EXTENSION_UPDATE_NOTIFIER", "1").env("GH_PROMPT_DISABLED", "1");
            c
        });
        gh_check(run_status_probe(cmd, CHECK_TIMEOUT))
    });
    let ollama = std::thread::spawn(|| enabled_ollama_addr().map(|a| ollama_check(&a, CHECK_TIMEOUT)));

    let lost = ReadinessCheck::failed_to_run;
    let mut checks = vec![
        claude.join().unwrap_or_else(|_| lost("claude", "Claude Code")),
        auth_check(
            crate::claude_login::has_anthropic_key(),
            login_expires_at,
            chrono::Utc::now().timestamp(),
        ),
        git.join().unwrap_or_else(|_| lost("git", "git")),
        gh.join().unwrap_or_else(|_| lost("gh", "GitHub CLI")),
    ];
    checks.extend(disk_check(&crate::perf::home_disk()));
    if let Ok(Some(c)) = ollama.join() {
        checks.push(c);
    }
    checks
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(script: &str) -> Option<Command> {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", script]);
        Some(cmd)
    }

    fn probe(script: &str) -> Probe {
        run_probe(sh(script), Duration::from_secs(5))
    }

    #[test]
    fn probes_report_missing_exit_and_timeout() {
        assert_eq!(run_probe(None, CHECK_TIMEOUT), Probe::Missing);
        assert_eq!(run_probe(Some(Command::new("/nonexistent/gh")), CHECK_TIMEOUT), Probe::Missing);
        assert_eq!(probe("echo out; echo err >&2"), Probe::Exited { success: true, output: "out\nerr\n".into() });
        assert!(matches!(probe("exit 1"), Probe::Exited { success: false, .. }));
        let started = Instant::now();
        assert_eq!(run_probe(sh("sleep 5"), Duration::from_millis(200)), Probe::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(4), "a hung command must be killed at the timeout");

        // The status probe never reads what the command prints.
        let quiet = run_status_probe(sh("echo gho_secret; echo err >&2"), Duration::from_secs(5));
        assert_eq!(quiet, Probe::Exited { success: true, output: String::new() });
        assert_eq!(run_status_probe(sh("sleep 5"), Duration::from_millis(100)), Probe::TimedOut);
    }

    #[test]
    fn output_past_the_pipe_buffer_is_read_while_the_command_runs_and_capped() {
        // 2 MB on each stream: read only after exit, the command would block
        // on a full pipe and time out; kept whole, a chatty CLI grows without bound.
        let big = "head -c 2000000 /dev/zero | tr '\\0' o; head -c 2000000 /dev/zero | tr '\\0' e >&2";
        let started = Instant::now();
        let Probe::Exited { success: true, output } = run_probe(sh(big), Duration::from_secs(5)) else {
            panic!("a large reply must not read as a timeout");
        };
        assert!(started.elapsed() < Duration::from_secs(4));
        assert_eq!(output.len(), 2 * OUTPUT_CAP, "the first {OUTPUT_CAP} bytes of each stream");
        assert!(output.starts_with('o') && output.ends_with('e'), "stdout first, then stderr");
    }

    /// Endless output until `stop` is set.
    struct Endless(Arc<std::sync::atomic::AtomicBool>);

    impl Read for Endless {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            if self.0.load(std::sync::atomic::Ordering::Relaxed) {
                return Ok(0);
            }
            buf.fill(b'y');
            Ok(buf.len())
        }
    }

    #[test]
    fn collecting_an_endless_stream_keeps_the_cap_and_stops_on_time() {
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut pipes = [Pipe::read(Endless(stop.clone()))];
        std::thread::sleep(Duration::from_millis(100));
        let started = Instant::now();
        collect(&mut pipes, started + Duration::from_millis(200));
        let took = started.elapsed();
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        assert!(took < Duration::from_secs(1), "collect must return at `until`: {took:?}");
        assert_eq!(pipes[0].bytes.len(), OUTPUT_CAP);
        assert!(pipes[0].open, "the stream never ended");
        // Already past `until`: takes nothing more, at once.
        let started = Instant::now();
        collect(&mut pipes, started);
        assert!(started.elapsed() < Duration::from_millis(100));
        assert_eq!(pipes[0].bytes.len(), OUTPUT_CAP);
    }

    #[cfg(unix)]
    #[test]
    fn a_timeout_kills_what_the_command_spawned() {
        let dir = tempfile::tempdir().unwrap();
        let pidfile = dir.path().join("grandchild.pid");
        let script = format!("sleep 30 & echo $! > '{}'; wait", pidfile.display());
        assert_eq!(run_probe(sh(&script), Duration::from_millis(300)), Probe::TimedOut);
        assert_dies(read_pid(&pidfile), "the background sleep must die with the group");
    }

    #[cfg(unix)]
    fn read_pid(path: &std::path::Path) -> u32 {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(pid) = std::fs::read_to_string(path).ok().and_then(|s| s.trim().parse().ok()) {
                return pid;
            }
            assert!(Instant::now() < deadline, "no pid in {}", path.display());
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Orphaned by a kill and reaped by init shortly after; poll so a
    /// not-yet-reaped zombie doesn't flake the test.
    #[cfg(unix)]
    fn assert_dies(pid: u32, why: &str) {
        let deadline = Instant::now() + Duration::from_secs(3);
        // SAFETY: kill(pid, 0) performs no action — existence probe only.
        while unsafe { libc::kill(pid as libc::pid_t, 0) } == 0 {
            assert!(Instant::now() < deadline, "{why}");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[cfg(unix)]
    #[test]
    fn an_exit_keeps_its_output_and_kills_what_it_left_holding_the_pipe() {
        // `sleep` inherits stdout and keeps it open after the shell exits.
        let dir = tempfile::tempdir().unwrap();
        let pidfile = dir.path().join("background.pid");
        let script = format!("echo hi; sleep 30 & echo $! > '{}'", pidfile.display());
        let started = Instant::now();
        assert_eq!(run_probe(sh(&script), Duration::from_secs(5)), Probe::Exited { success: true, output: "hi\n".into() });
        assert!(started.elapsed() < Duration::from_secs(2), "must not wait out the deadline: {:?}", started.elapsed());
        assert_dies(read_pid(&pidfile), "what the command left running must die with its group");
    }

    #[cfg(unix)]
    #[test]
    fn an_exit_kills_what_it_left_running_even_off_the_pipe() {
        let dir = tempfile::tempdir().unwrap();
        // Output to /dev/null: nothing keeps the probe's pipe open.
        let pidfile = dir.path().join("detached.pid");
        let script = format!("echo hi; sleep 30 >/dev/null 2>&1 & echo $! > '{}'", pidfile.display());
        assert_eq!(run_probe(sh(&script), Duration::from_secs(5)), Probe::Exited { success: true, output: "hi\n".into() });
        assert_dies(read_pid(&pidfile), "a leftover off the pipe must die with its group");

        // The status probe has no pipes at all.
        let pidfile = dir.path().join("status.pid");
        let script = format!("sleep 30 & echo $! > '{}'", pidfile.display());
        assert_eq!(run_status_probe(sh(&script), Duration::from_secs(5)), Probe::Exited { success: true, output: String::new() });
        assert_dies(read_pid(&pidfile), "a status probe's leftover must die with its group");
    }

    #[cfg(unix)]
    #[test]
    fn a_running_probe_is_tracked_for_kill_in_flight_until_it_returns() {
        let dir = tempfile::tempdir().unwrap();
        let pidfile = dir.path().join("probe.pid");
        let script = format!("echo $$ > '{}'; sleep 30", pidfile.display());
        let running = std::thread::spawn(move || run_probe(sh(&script), Duration::from_secs(20)));
        let pid = read_pid(&pidfile);
        // The shell can write its pid before the probe thread tracks it.
        let deadline = Instant::now() + Duration::from_secs(3);
        while !IN_FLIGHT.lock().unwrap_or_else(|e| e.into_inner()).contains(&pid) {
            assert!(Instant::now() < deadline, "the running probe must be tracked");
            std::thread::sleep(Duration::from_millis(20));
        }
        // What `kill_in_flight` does to each one (not called here: it would
        // kill the probes of tests running alongside).
        let started = Instant::now();
        kill_group(pid);
        assert!(matches!(running.join().unwrap(), Probe::Exited { success: false, .. }));
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(!IN_FLIGHT.lock().unwrap().contains(&pid));
    }

    #[test]
    fn claude_found_missing_old_timeout_and_broken() {
        let ok = claude_check(probe("echo '2.1.319 (Claude Code)'"), "2.1.314");
        assert_eq!((ok.status, ok.value.as_str(), ok.fix.as_deref()), (CheckStatus::Ok, "2.1.319", None));
        // At the floor but without a security fix: amber, never blocked.
        let unsafe_cli = claude_check(probe("echo '2.1.316 (Claude Code)'"), "2.1.314");
        assert_eq!((unsafe_cli.status, unsafe_cli.value.as_str()), (CheckStatus::Warn, "2.1.316"));
        assert_eq!(
            unsafe_cli.fix.as_deref(),
            Some("Update Claude Code: 2.1.319 fixes a sandbox escape when creating a worktree.")
        );
        assert_eq!(unsafe_cli.command.as_deref(), Some(UPDATE_CLAUDE));
        let missing = claude_check(Probe::Missing, "2.1.314");
        assert_eq!((missing.status, missing.command.as_deref()), (CheckStatus::Fail, Some(INSTALL_CLAUDE)));
        let old = claude_check(probe("echo '2.1.307 (Claude Code)'"), "2.1.314");
        assert_eq!((old.status, old.value.as_str()), (CheckStatus::Warn, "2.1.307 · tested with 2.1.314"));
        assert_eq!(old.command.as_deref(), Some(UPDATE_CLAUDE));
        // 2.1.314 itself lacks the 2.1.319 fix: recommend the fix.
        assert_eq!(old.fix.as_deref(), Some("Update to 2.1.319 or newer; older releases can record wrong token usage."));
        let hung = claude_check(run_probe(sh("sleep 5"), Duration::from_millis(100)), "2.1.314");
        assert_eq!((hung.status, hung.timed_out), (CheckStatus::Warn, true));
        let broken = claude_check(probe("echo 2.1.316; exit 1"), "2.1.314");
        assert_eq!((broken.status, broken.value.as_str()), (CheckStatus::Warn, "Version unknown"));
    }

    #[test]
    fn git_found_missing_stub_and_timeout() {
        let ok = git_check(probe("echo 'git version 2.39.3 (Apple Git-146)'"));
        assert_eq!((ok.status, ok.value.as_str()), (CheckStatus::Ok, "2.39.3"));
        assert_eq!(git_check(Probe::Missing).status, CheckStatus::Fail);
        let stub = git_check(probe("echo 'xcode-select: note: no developer tools' >&2; exit 1"));
        assert_eq!((stub.status, stub.command.as_deref()), (CheckStatus::Fail, Some("xcode-select --install")));
        assert!(git_check(Probe::TimedOut).timed_out);
    }

    #[test]
    fn gh_is_a_local_token_lookup() {
        assert_eq!(GH_PROBE, format!("gh {}", GH_PROBE_ARGS.join(" ")));
        assert!(!GH_PROBE.contains("status"), "gh auth status validates the token online");
        let ok = gh_check(run_status_probe(sh("echo gho_secret"), Duration::from_secs(5)));
        assert_eq!((ok.status, ok.value.as_str()), (CheckStatus::Ok, "Token found"));
        let out = gh_check(run_status_probe(sh("exit 1"), Duration::from_secs(5)));
        assert_eq!((out.status, out.command.as_deref()), (CheckStatus::Warn, Some("gh auth login")));
        let missing = gh_check(Probe::Missing);
        assert_eq!((missing.status, missing.command.as_deref()), (CheckStatus::Warn, Some("brew install gh")));
        let hung = gh_check(Probe::TimedOut);
        assert_eq!((hung.timed_out, hung.command.as_deref()), (true, Some(GH_PROBE)));
    }

    #[test]
    fn auth_mode_and_a_check_that_failed_to_run() {
        let now = 1_800_000_000;
        assert_eq!(auth_check(true, None, now).value, "API key");
        // A key wins over a stored login, even an ended one.
        assert_eq!(auth_check(true, Some(now - 1), now).status, CheckStatus::Ok);
        let sub = auth_check(false, None, now);
        assert_eq!((sub.status, sub.value.as_str(), sub.command), (CheckStatus::Warn, "Subscription", None));

        let lost = ReadinessCheck::failed_to_run("git", "git");
        assert_eq!((lost.status, lost.value.as_str(), lost.timed_out), (CheckStatus::Warn, "Check failed to run", false));
        assert_eq!(lost.command, None);
        assert!(!lost.fix.as_deref().unwrap_or_default().contains("3 s"));
    }

    #[test]
    fn auth_shows_the_claude_sign_in_end() {
        let now = 1_800_000_000;
        let far = now + 30 * 86_400;
        let ok = auth_check(false, Some(far), now);
        assert_eq!(ok.status, CheckStatus::Ok);
        assert_eq!(ok.value, format!("Signed in · until {}", day_label(far)));
        assert_eq!((ok.fix, ok.command), (None, None));

        let soon = now + 3 * 86_400;
        let warn = auth_check(false, Some(soon), now);
        assert_eq!((warn.status, warn.value.clone()), (CheckStatus::Warn, format!("Sign-in ends {}", day_label(soon))));
        assert_eq!(warn.fix.as_deref(), Some("Sign in again before it ends so overnight crews keep running."));
        assert_eq!(warn.command.as_deref(), Some("claude auth login"));

        let gone = now - 86_400;
        let ended = auth_check(false, Some(gone), now);
        assert_eq!((ended.status, ended.value.clone()), (CheckStatus::Fail, format!("Sign-in ended {}", day_label(gone))));
        assert_eq!(ended.command.as_deref(), Some(CLAUDE_LOGIN));
        // Check again only re-reads the stored date; it clears on the next report.
        assert!(ended.fix.as_deref().is_some_and(|f| f.contains("clears after the next Claude Code stage") && !f.contains("check again")));

        // `%-d %b`: a day number and a month, no leading zero.
        let label = day_label(far);
        let (d, m) = label.split_once(' ').unwrap();
        assert!(d.parse::<u32>().is_ok_and(|n| (1..=31).contains(&n)) && !d.starts_with('0') && m.len() == 3, "{label}");
    }

    #[test]
    fn disk_space_ok_warn_and_fail() {
        use crate::perf::DiskInfo;
        let disk = |free| DiskInfo { free_bytes: free, total_bytes: 500 * GIB };

        let ok = disk_check(&disk(18 * GIB)).unwrap();
        assert_eq!((ok.id.as_str(), ok.status, ok.value.as_str(), ok.fix), ("disk", CheckStatus::Ok, "18 GB free", None));
        assert_eq!(disk_check(&disk(DISK_WARN_BYTES)).unwrap().status, CheckStatus::Ok);

        let warn = disk_check(&disk(DISK_WARN_BYTES - 1)).unwrap();
        assert_eq!(warn.status, CheckStatus::Warn);
        assert!(warn.fix.as_deref().is_some_and(|f| f.contains("archive old workspaces")));
        assert_eq!(disk_check(&disk(DISK_FAIL_BYTES)).unwrap().status, CheckStatus::Warn);

        let fail = disk_check(&disk(DISK_FAIL_BYTES - 1)).unwrap();
        assert_eq!(fail.status, CheckStatus::Fail);
        let low = disk_check(&disk(14 * GIB / 10)).unwrap();
        assert_eq!((low.status, low.value.as_str(), low.command), (CheckStatus::Fail, "1.4 GB free", None));

        // An unreadable volume reports zeros: no row rather than a false alarm.
        assert_eq!(disk_check(&DiskInfo { free_bytes: 0, total_bytes: 0 }), None);
    }

    #[test]
    fn disk_sizes_read_like_the_footer() {
        assert_eq!(format_bytes(0), "0 B");
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(1536), "1.5 KB");
        assert_eq!(format_bytes(600 * 1024 * 1024), "600 MB");
        assert_eq!(format_bytes(14 * GIB / 10), "1.4 GB");
        assert_eq!(format_bytes(10 * GIB), "10 GB");
        assert_eq!(format_bytes(460 * GIB), "460 GB");
        assert_eq!(format_bytes(2048 * GIB), "2.0 TB");
    }

    #[test]
    fn only_loopback_ollama_urls_are_probed() {
        assert_eq!(loopback_addr("http://localhost:11434").as_deref(), Some("localhost:11434"));
        assert_eq!(loopback_addr("http://127.0.0.1:11434/v1").as_deref(), Some("127.0.0.1:11434"));
        assert_eq!(loopback_addr("http://[::1]:8080/v1").as_deref(), Some("[::1]:8080"));
        assert_eq!(loopback_addr("http://localhost/v1").as_deref(), Some("localhost:80"));
        assert_eq!(loopback_addr("http://gpu-box.lan:11434"), None);
        assert_eq!(loopback_addr("https://api.example.com/v1"), None);
    }

    #[test]
    fn ollama_reachable_and_not_running() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = format!("127.0.0.1:{}", listener.local_addr().unwrap().port());
        let up = ollama_check(&addr, CHECK_TIMEOUT);
        assert_eq!((up.status, up.value.as_str()), (CheckStatus::Ok, addr.as_str()));
        drop(listener);
        // Not the port just released: with tests running in parallel another
        // test's `bind(":0")` can be handed that same ephemeral port at once,
        // and the probe then reaches *it* (flaked on CI 2026-11-04). Port 0
        // can never accept a connection.
        let down = ollama_check("127.0.0.1:0", Duration::from_millis(500));
        assert_eq!((down.status, down.command.as_deref()), (CheckStatus::Warn, Some("ollama serve")));
    }

    #[test]
    fn ollama_addresses_share_one_deadline() {
        // Both addresses filtered: each attempt hangs for the time it's given.
        let addrs: Vec<SocketAddr> = vec!["[::1]:11434".parse().unwrap(), "127.0.0.1:11434".parse().unwrap()];
        let mut given = Vec::new();
        let started = Instant::now();
        let reachable = connect_any(&addrs, Duration::from_millis(500), |_, left| {
            given.push(left);
            std::thread::sleep(left);
            false
        });
        assert!(!reachable);
        assert!(started.elapsed() < Duration::from_millis(900), "all addresses share one timeout");
        assert!(given.len() <= 2 && given.iter().skip(1).all(|d| *d < Duration::from_millis(250)));

        let mut tried = 0;
        assert!(connect_any(&addrs, CHECK_TIMEOUT, |_, _| {
            tried += 1;
            tried == 2
        }));
    }
}
