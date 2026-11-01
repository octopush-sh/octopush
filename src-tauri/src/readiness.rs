//! "Is this Mac ready for a crew?" — the Settings › General readiness card.
//! Each check runs one local command (Ollama: a TCP connect to a loopback
//! port) within 3 s, in parallel, never cached and with no telemetry.

use crate::agent_adapter::{parse_claude_version, ClaudeCliVersion, TESTED_CLAUDE_FLOOR};
use serde::Serialize;
use std::io::Read;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub const CHECK_TIMEOUT: Duration = Duration::from_secs(3);
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
    /// `claude` | `auth` | `git` | `gh` | `ollama`.
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

/// Run `cmd` within `timeout` (killed after it), joining stdout and stderr.
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
    let Ok(mut child) = cmd.stdin(Stdio::null()).stdout(io()).stderr(io()).spawn() else {
        return Probe::Missing;
    };
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut output = String::new();
                if let Some(mut out) = child.stdout.take() {
                    let _ = out.read_to_string(&mut output);
                }
                if let Some(mut err) = child.stderr.take() {
                    let _ = err.read_to_string(&mut output);
                }
                return Probe::Exited { success: status.success(), output };
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Probe::TimedOut;
            }
        }
    }
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
                    not_ok(CheckStatus::Warn, &format!("{v} · tested with {floor}"), &format!("Update to {floor} or newer; {old}"), UPDATE_CLAUDE)
                }
                Some(v) => ReadinessCheck::ok(ID, LABEL, v),
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

/// An Anthropic key (settings or `ANTHROPIC_API_KEY`) → API key; otherwise
/// CLI stages run on the `claude` login and API stages can't run.
pub fn auth_check(has_anthropic_key: bool) -> ReadinessCheck {
    if has_anthropic_key {
        ReadinessCheck::ok("auth", "Claude auth", "API key")
    } else {
        let fix = "CLI stages use your claude login. API stages need an Anthropic key in Settings › Models.";
        ReadinessCheck::not_ok("auth", "Claude auth", CheckStatus::Warn, "Subscription", fix, None)
    }
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
pub fn run_all() -> Vec<ReadinessCheck> {
    let claude = std::thread::spawn(|| {
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
        auth_check(crate::settings::get_anthropic_key().is_some_and(|k| !k.trim().is_empty())),
        git.join().unwrap_or_else(|_| lost("git", "git")),
        gh.join().unwrap_or_else(|_| lost("gh", "GitHub CLI")),
    ];
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
    fn claude_found_missing_old_timeout_and_broken() {
        let ok = claude_check(probe("echo '2.1.316 (Claude Code)'"), "2.1.314");
        assert_eq!((ok.status, ok.value.as_str(), ok.fix.as_deref()), (CheckStatus::Ok, "2.1.316", None));
        let missing = claude_check(Probe::Missing, "2.1.314");
        assert_eq!((missing.status, missing.command.as_deref()), (CheckStatus::Fail, Some(INSTALL_CLAUDE)));
        let old = claude_check(probe("echo '2.1.307 (Claude Code)'"), "2.1.314");
        assert_eq!((old.status, old.value.as_str()), (CheckStatus::Warn, "2.1.307 · tested with 2.1.314"));
        assert_eq!(old.command.as_deref(), Some(UPDATE_CLAUDE));
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
        assert_eq!(auth_check(true).value, "API key");
        let sub = auth_check(false);
        assert_eq!((sub.status, sub.value.as_str()), (CheckStatus::Warn, "Subscription"));

        let lost = ReadinessCheck::failed_to_run("git", "git");
        assert_eq!((lost.status, lost.value.as_str(), lost.timed_out), (CheckStatus::Warn, "Check failed to run", false));
        assert_eq!(lost.command, None);
        assert!(!lost.fix.as_deref().unwrap_or_default().contains("3 s"));
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
        let down = ollama_check(&addr, Duration::from_millis(500));
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
