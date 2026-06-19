//! TALK shell — a persistent bash PTY per chat thread for `$`-direct execution.
//!
//! Reuses the `octopush-pty-server` daemon (the same PTY infra that backs RUN
//! mode), but in a *capture* access pattern instead of interactive streaming:
//! the backend is the sole attached client, writes a marker-wrapped command,
//! and drains the event stream until the end marker to recover clean stdout +
//! exit code + cwd. Echo is disabled and the prompt blanked so the captured
//! span is exactly the command's own output.
//!
//! One shell per thread keeps cwd/env across commands (the "unified shell" the
//! TALK terminal-parity initiative is built on); a single lock serializes runs
//! so the user — and, later, the agent — never interleave writes into the same
//! PTY. Long-running commands that don't finish within the timeout are
//! interrupted and the session recycled; live-process support arrives in a
//! later phase.

use crate::error::{AppError, AppResult};
use crate::pty_client::{DaemonClient, TermEvent};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

// Capture markers are delimited by doubled record-separator bytes (0x1e), which
// don't occur in normal output. Crucially, the shell emits them via *functions*
// that assemble the RS bytes from a variable (`$__OCTORS`), so the raw marker
// bytes appear only in command OUTPUT — never in the command SOURCE. That means
// even if the PTY echoes a command back before `stty -echo` takes effect, the
// echoed text can't be mistaken for a marker.
const START_MARKER: &str = "\u{1e}\u{1e}OCTO_START\u{1e}\u{1e}";
const READY_MARKER: &str = "\u{1e}\u{1e}OCTO_READY\u{1e}\u{1e}";

/// Outcome of running one command in a TALK shell.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellResult {
    pub output: String,
    pub exit_code: i32,
    pub ok: bool,
    pub cwd: String,
    /// True when the command didn't finish within the timeout (long-running);
    /// it was interrupted and the session recycled.
    pub timed_out: bool,
}

/// A live bash PTY bound to one chat thread.
struct Session {
    /// Daemon terminal id (`talk-<threadId>`).
    id: String,
    /// The sole capture subscriber for this session's output.
    rx: Receiver<TermEvent>,
    /// Last known working directory (for the cwd badge).
    cwd: String,
}

pub struct TalkShell {
    client: Mutex<Option<Arc<DaemonClient>>>,
    sessions: Mutex<HashMap<String, Session>>,
}

impl TalkShell {
    pub fn new() -> Self {
        Self {
            client: Mutex::new(None),
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// Attach the daemon client. `None` (daemon absent) makes every `run` fail
    /// with a clear error instead of panicking.
    pub fn set_client(&self, client: Option<Arc<DaemonClient>>) {
        *self.client.lock() = client;
    }

    /// Run one command in the thread's shell, returning captured output, exit
    /// code and the resulting cwd. Spawns the shell on first use.
    pub fn run(
        &self,
        thread_id: &str,
        workspace_path: &str,
        command: &str,
        timeout: Duration,
    ) -> AppResult<ShellResult> {
        let client = self
            .client
            .lock()
            .clone()
            .ok_or_else(|| AppError::Other("terminal daemon unavailable".into()))?;

        // A single lock serializes every run — the "turn lock" that stops the
        // user (and, later, the agent) from interleaving writes into one PTY.
        let mut sessions = self.sessions.lock();
        if !sessions.contains_key(thread_id) {
            let session = Self::spawn_session(&client, thread_id, workspace_path)?;
            sessions.insert(thread_id.to_string(), session);
        }
        let session = sessions
            .get_mut(thread_id)
            .expect("session present after insert");

        // Wrap the command between marker emitters defined at init. `$?` in the
        // end marker is the command's exit status (the start marker ran before
        // it); `$PWD` rides along so a `cd` updates the cwd badge for free.
        let payload = format!("__octo_start\n{command}\n__octo_end \"$?\"\n");
        client.write(&session.id, payload.as_bytes())?;

        match drain_capture(&session.rx, timeout) {
            Capture::Done {
                output,
                exit_code,
                cwd,
            } => {
                if !cwd.is_empty() {
                    session.cwd = cwd.clone();
                }
                let cwd = if cwd.is_empty() { session.cwd.clone() } else { cwd };
                Ok(ShellResult {
                    output,
                    exit_code,
                    ok: exit_code == 0,
                    cwd,
                    timed_out: false,
                })
            }
            Capture::TimedOut { partial } => {
                // Interrupt the still-running command and recycle the session so
                // the next command starts from a clean, in-sync prompt.
                let cwd = session.cwd.clone();
                let id = session.id.clone();
                let _ = client.write(&id, b"\x03"); // Ctrl-C
                sessions.remove(thread_id);
                let _ = client.remove(&id);
                Ok(ShellResult {
                    output: partial,
                    exit_code: -1,
                    ok: false,
                    cwd,
                    timed_out: true,
                })
            }
        }
    }

    /// Drop a thread's shell (on thread delete / cleanup).
    pub fn close(&self, thread_id: &str) {
        let client = self.client.lock().clone();
        if let Some(session) = self.sessions.lock().remove(thread_id) {
            if let Some(client) = client {
                let _ = client.remove(&session.id);
            }
        }
    }

    /// Spawn a fresh bash PTY, quiet it (echo off, blank prompt) and wait until
    /// it confirms readiness so the first command captures cleanly.
    fn spawn_session(
        client: &Arc<DaemonClient>,
        thread_id: &str,
        cwd: &str,
    ) -> AppResult<Session> {
        let id = format!("talk-{thread_id}");
        // Forward the app's PATH so commands resolve the same as the app sees
        // them (GUI launches otherwise get a minimal PATH).
        let mut env = HashMap::new();
        if let Ok(path) = std::env::var("PATH") {
            env.insert("PATH".to_string(), path);
        }
        client.spawn(&id, cwd, &env, Some("/bin/bash"), 40, 120)?;
        let rx = client.attach(&id, 0)?;

        // Quiet the shell (echo off, blank prompt) and define the marker
        // emitters. `$__OCTORS` holds a single raw RS byte built at runtime, so
        // the function *definitions* (which may be echoed) never contain the
        // raw marker bytes — only their *output* does.
        let mut init = String::new();
        init.push_str("stty -echo 2>/dev/null; PS1=''; PS2=''; PROMPT_COMMAND=''\n");
        init.push_str("__OCTORS=$(printf '\\036')\n");
        init.push_str("__octo_start() { printf '%s%sOCTO_START%s%s\\n' \"$__OCTORS\" \"$__OCTORS\" \"$__OCTORS\" \"$__OCTORS\"; }\n");
        init.push_str("__octo_end() { printf '%s%sOCTO_END:%d:%s%s%s\\n' \"$__OCTORS\" \"$__OCTORS\" \"$1\" \"$PWD\" \"$__OCTORS\" \"$__OCTORS\"; }\n");
        init.push_str("__octo_ready() { printf '%s%sOCTO_READY%s%s\\n' \"$__OCTORS\" \"$__OCTORS\" \"$__OCTORS\" \"$__OCTORS\"; }\n");
        init.push_str("__octo_ready\n");
        client.write(&id, init.as_bytes())?;

        // Discard the init echo/banner up to and including the ready marker.
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut buf = String::new();
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(TermEvent::Data { bytes, .. }) => {
                    buf.push_str(&String::from_utf8_lossy(&bytes));
                    if buf.contains(READY_MARKER) {
                        return Ok(Session {
                            id,
                            rx,
                            cwd: cwd.to_string(),
                        });
                    }
                }
                Ok(TermEvent::Exit { .. }) | Ok(TermEvent::Error { .. }) => {
                    return Err(AppError::Other("talk shell exited during init".into()));
                }
                Ok(TermEvent::Attention) => {}
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(AppError::Other("talk shell channel closed during init".into()));
                }
            }
        }
        // Clean up the half-born shell before giving up.
        let _ = client.remove(&id);
        Err(AppError::Other("talk shell did not become ready".into()))
    }
}

impl Default for TalkShell {
    fn default() -> Self {
        Self::new()
    }
}

// ─── Capture (pure, unit-tested) ──────────────────────────────────────

enum Capture {
    Done {
        output: String,
        exit_code: i32,
        cwd: String,
    },
    TimedOut {
        partial: String,
    },
}

/// Drain the event receiver until the end marker is seen or `timeout` elapses.
fn drain_capture(rx: &Receiver<TermEvent>, timeout: Duration) -> Capture {
    let deadline = Instant::now() + timeout;
    let mut buf = String::new();
    loop {
        if Instant::now() >= deadline {
            return Capture::TimedOut {
                partial: extract_partial(&buf),
            };
        }
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(TermEvent::Data { bytes, .. }) => {
                buf.push_str(&String::from_utf8_lossy(&bytes));
                if let Some((output, exit_code, cwd)) = parse_capture(&buf) {
                    return Capture::Done {
                        output,
                        exit_code,
                        cwd,
                    };
                }
            }
            // Shell died mid-command — return whatever we captured.
            Ok(TermEvent::Exit { code }) => {
                return Capture::Done {
                    output: extract_partial(&buf),
                    exit_code: code.unwrap_or(-1),
                    cwd: String::new(),
                };
            }
            Ok(TermEvent::Error { .. }) => {
                return Capture::Done {
                    output: extract_partial(&buf),
                    exit_code: -1,
                    cwd: String::new(),
                };
            }
            Ok(TermEvent::Attention) => {}
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                return Capture::Done {
                    output: extract_partial(&buf),
                    exit_code: -1,
                    cwd: String::new(),
                };
            }
        }
    }
}

fn end_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"\x1e\x1eOCTO_END:(\d+):([^\x1e]*)\x1e\x1e").unwrap())
}

/// Parse a fully-captured buffer into (clean output, exit code, cwd). Returns
/// `None` until both markers are present.
fn parse_capture(buf: &str) -> Option<(String, i32, String)> {
    let start_idx = buf.find(START_MARKER)?;
    let after_start = start_idx + START_MARKER.len();
    let tail = &buf[after_start..];
    let caps = end_re().captures(tail)?;
    let whole = caps.get(0).unwrap();
    let raw_output = &tail[..whole.start()];
    let exit_code: i32 = caps[1].parse().ok()?;
    let cwd = caps[2].to_string();
    Some((clean_output(raw_output), exit_code, cwd))
}

/// Best-effort output recovery when no end marker arrived (timeout / shell
/// death): everything after the start marker, cleaned.
fn extract_partial(buf: &str) -> String {
    let s = match buf.find(START_MARKER) {
        Some(i) => &buf[i + START_MARKER.len()..],
        None => buf,
    };
    clean_output(s)
}

fn ansi_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // CSI sequences, OSC strings, charset selects, and a few standalone
        // escapes + bare control bytes.
        regex::Regex::new(
            r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()#][0-9A-Za-z]|\x1b[=>]|[\x00\x07]",
        )
        .unwrap()
    })
}

/// Strip ANSI escapes, normalize PTY CRLFs, and trim surrounding whitespace.
fn clean_output(s: &str) -> String {
    let no_ansi = ansi_re().replace_all(s, "");
    no_ansi.replace("\r\n", "\n").replace('\r', "").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Raw record-separator byte — what the shell's marker functions emit.
    const RS: char = '\u{1e}';

    fn buf(output: &str, code: i32, cwd: &str) -> String {
        format!("{START_MARKER}\n{output}\n{RS}{RS}OCTO_END:{code}:{cwd}{RS}{RS}\n")
    }

    #[test]
    fn parses_clean_capture() {
        let b = buf("hello world", 0, "/repo/src");
        let (out, code, cwd) = parse_capture(&b).expect("should parse");
        assert_eq!(out, "hello world");
        assert_eq!(code, 0);
        assert_eq!(cwd, "/repo/src");
    }

    #[test]
    fn parses_nonzero_exit_and_strips_ansi() {
        // Color codes + CRLF line endings as a real PTY emits.
        let b = buf("\x1b[31mError:\x1b[0m boom\r\n", 1, "/tmp");
        let (out, code, cwd) = parse_capture(&b).expect("should parse");
        assert_eq!(out, "Error: boom");
        assert_eq!(code, 1);
        assert_eq!(cwd, "/tmp");
    }

    #[test]
    fn none_until_end_marker_present() {
        // Start marker seen, output streaming, but no end marker yet.
        let partial = format!("{START_MARKER}\npartial output not done");
        assert!(parse_capture(&partial).is_none());
    }

    #[test]
    fn none_before_start_marker() {
        assert!(parse_capture("just some boot noise").is_none());
    }

    #[test]
    fn ignores_echoed_prefix_before_start() {
        // Anything before the start marker (prompt/echo noise) is discarded.
        let b = format!("$ \x1b[1mwhoami\x1b[0m\r\n{}", buf("johnatan", 0, "/home"));
        let (out, code, cwd) = parse_capture(&b).expect("should parse");
        assert_eq!(out, "johnatan");
        assert_eq!(code, 0);
        assert_eq!(cwd, "/home");
    }

    #[test]
    fn cwd_with_colon_survives() {
        let b = buf("ok", 130, "/weird:path");
        let (_out, code, cwd) = parse_capture(&b).expect("should parse");
        assert_eq!(code, 130);
        assert_eq!(cwd, "/weird:path");
    }

    #[test]
    fn extract_partial_recovers_output_without_end_marker() {
        let b = format!("{START_MARKER}\nstreaming line 1\r\nstreaming line 2\r\n");
        assert_eq!(extract_partial(&b), "streaming line 1\nstreaming line 2");
    }

    #[test]
    fn clean_output_normalizes_crlf_and_trims() {
        assert_eq!(clean_output("\r\n  line\r\n\r\n"), "line");
    }
}

// End-to-end tests against a real daemon + bash PTY: the genuine proof that the
// marker capture, echo suppression, exit-code reporting and cwd persistence all
// work over a live PTY (not just the pure parser). Mirrors the daemon-spawning
// scaffolding in `pty_client::tests`.
#[cfg(all(test, unix))]
mod e2e {
    use super::*;
    use serial_test::serial;
    use std::fs;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use std::time::Duration;
    use tempfile::TempDir;

    fn find_daemon_bin() -> PathBuf {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(parent) = exe.parent() {
                for cand in [parent.join("octopush-pty-server"), {
                    let mut p = parent.to_path_buf();
                    p.pop();
                    p.join("octopush-pty-server")
                }] {
                    if cand.exists() {
                        return cand;
                    }
                }
            }
        }
        panic!("octopush-pty-server not built; run `cargo build --bin octopush-pty-server`");
    }

    fn start_daemon(home: &std::path::Path) -> std::process::Child {
        let child = Command::new(find_daemon_bin())
            .env("HOME", home)
            .env("OCTOPUSH_PTY_AUTO_EXIT_SECS", "20")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn daemon");
        std::thread::sleep(Duration::from_millis(250));
        child
    }

    fn wait_for_socket(sock: &PathBuf) -> bool {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if sock.exists() && std::os::unix::net::UnixStream::connect(sock).is_ok() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    #[test]
    #[serial]
    fn captures_output_exit_codes_and_persists_cwd() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        let base = home.join(".octopush");
        fs::create_dir_all(&base).unwrap();
        let sock = base.join("pty-server.sock");

        let mut daemon = start_daemon(home);
        assert!(wait_for_socket(&sock), "daemon socket did not appear");

        let client = DaemonClient::connect_to(sock.to_str().unwrap()).unwrap();
        let shell = TalkShell::new();
        shell.set_client(Some(client));

        let to = Duration::from_secs(10);

        // 1. Clean stdout capture + exit 0.
        let r = shell.run("t", "/tmp", "echo hello world", to).expect("run echo");
        assert_eq!(r.output, "hello world");
        assert_eq!(r.exit_code, 0);
        assert!(r.ok && !r.timed_out);

        // 2. Non-zero exit is reported structurally.
        let r = shell.run("t", "/tmp", "false", to).expect("run false");
        assert_eq!(r.exit_code, 1);
        assert!(!r.ok);

        // 3. cwd persists across commands in the same thread (the unified shell).
        let r = shell.run("t", "/tmp", "cd /tmp && pwd", to).expect("run cd");
        assert!(r.cwd.ends_with("tmp"), "cwd after cd was {:?}", r.cwd);
        let r = shell.run("t", "/tmp", "pwd", to).expect("run pwd");
        assert!(
            r.output.ends_with("tmp"),
            "second command did not inherit cwd: {:?}",
            r.output
        );

        // 4. Output is captured cleanly even with ANSI color codes.
        let r = shell
            .run("t", "/tmp", "printf '\\033[31mRED\\033[0m\\n'", to)
            .expect("run color");
        assert_eq!(r.output, "RED");

        shell.close("t");
        daemon.kill().ok();
    }
}
