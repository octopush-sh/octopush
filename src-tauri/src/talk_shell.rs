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
//! TALK terminal-parity initiative is built on). Each session has its own lock,
//! so a long command in one thread never blocks another thread's shell, while
//! commands within a thread stay serialized (the turn lock). Long-running
//! commands that don't finish within the timeout are interrupted and the shell
//! recycled in place (preserving cwd); live-process support arrives in a later
//! phase.

use crate::error::{AppError, AppResult};
use crate::pty_client::{DaemonClient, TermEvent};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Cap on captured output (bytes), mirroring `execute_tool`'s run_command cap
/// so `$`-direct output can't bloat the DB row / chat render.
const MAX_OUTPUT_BYTES: usize = 50_000;

/// Outcome of running one command in a TALK shell.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellResult {
    pub output: String,
    pub exit_code: i32,
    pub ok: bool,
    pub cwd: String,
    /// True when the command didn't finish within the timeout (long-running);
    /// it was interrupted and the shell recycled in place.
    pub timed_out: bool,
}

/// A live bash PTY bound to one chat thread.
struct Session {
    /// Daemon terminal id (`talk-<threadId>`).
    id: String,
    /// The sole capture subscriber for this session's output.
    rx: Receiver<TermEvent>,
    /// Last known working directory (for the cwd badge / recycle).
    cwd: String,
    /// Per-session random token mixed into the capture markers, so a command
    /// that prints marker-like bytes in its own output can't be mistaken for
    /// the real terminator (the token is never written to the shell as input
    /// it could observe — it lives only in the marker emitter definitions).
    nonce: String,
}

pub struct TalkShell {
    client: Mutex<Option<Arc<DaemonClient>>>,
    /// Per-thread session handles. The outer lock is held only briefly to look
    /// up / insert a handle; the inner per-session lock guards the actual run,
    /// so threads never block each other.
    sessions: Mutex<HashMap<String, Arc<Mutex<Session>>>>,
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

        // Resolve a per-thread session handle WITHOUT holding the map lock
        // across the (slow) spawn or the (up-to-timeout) drain — so one thread's
        // long command never blocks another thread's shell.
        let existing = {
            let map = self.sessions.lock();
            map.get(thread_id).cloned()
        };
        let handle = match existing {
            Some(h) => h,
            None => {
                let session = Self::spawn_session(&client, thread_id, workspace_path)?;
                let h = Arc::new(Mutex::new(session));
                let mut map = self.sessions.lock();
                Arc::clone(map.entry(thread_id.to_string()).or_insert(h))
            }
        };

        // Per-session lock: serializes commands within a thread (the turn lock).
        let mut session = handle.lock();

        // Wrap the command between marker emitters defined at init. `$?` in the
        // end marker is the command's exit status (the start marker ran before
        // it); `$PWD` rides along so a `cd` updates the cwd badge for free.
        let payload = format!("__octo_start\n{command}\n__octo_end \"$?\"\n");
        client.write(&session.id, payload.as_bytes())?;

        match drain_capture(&session.rx, timeout, &session.nonce) {
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
                    output: cap_output(output),
                    exit_code,
                    ok: exit_code == 0,
                    cwd,
                    timed_out: false,
                })
            }
            Capture::TimedOut { partial } => {
                // Interrupt the still-running command and recycle the shell IN
                // PLACE at the saved cwd, so a later command still runs where
                // the user `cd`'d to (env vars are lost — that's the cost of a
                // recycle, surfaced via `timed_out`).
                let cwd = session.cwd.clone();
                let _ = client.write(&session.id, b"\x03"); // Ctrl-C
                let _ = client.remove(&session.id);
                if let Ok(fresh) = Self::spawn_session(&client, thread_id, &cwd) {
                    *session = fresh;
                }
                Ok(ShellResult {
                    output: cap_output(partial),
                    exit_code: -1,
                    ok: false,
                    cwd,
                    timed_out: true,
                })
            }
        }
    }

    /// Drop a thread's shell (on thread delete / cleanup) — kills the daemon
    /// PTY and releases the session entry.
    pub fn close(&self, thread_id: &str) {
        let client = self.client.lock().clone();
        let handle = self.sessions.lock().remove(thread_id);
        if let (Some(client), Some(handle)) = (client, handle) {
            let _ = client.remove(&handle.lock().id);
        }
    }

    /// Spawn a fresh bash PTY, quiet it (echo off, blank prompt), define the
    /// marker emitters and wait until it confirms readiness so the first
    /// command captures cleanly.
    fn spawn_session(
        client: &Arc<DaemonClient>,
        thread_id: &str,
        cwd: &str,
    ) -> AppResult<Session> {
        let id = format!("talk-{thread_id}");
        let nonce = gen_nonce();
        // Forward the app's PATH so commands resolve the same as the app sees
        // them (GUI launches otherwise get a minimal PATH).
        let mut env = HashMap::new();
        if let Ok(path) = std::env::var("PATH") {
            env.insert("PATH".to_string(), path);
        }
        client.spawn(&id, cwd, &env, Some("/bin/bash"), 40, 120)?;
        let rx = client.attach(&id, 0)?;

        // `$__OCTORS` holds a single raw RS byte built at runtime, so the
        // function *definitions* (which may be echoed) never contain the raw
        // marker bytes — only their *output* does. The nonce makes the marker
        // unguessable from command output.
        let mut init = String::new();
        init.push_str("stty -echo 2>/dev/null; PS1=''; PS2=''; PROMPT_COMMAND=''\n");
        init.push_str("__OCTORS=$(printf '\\036')\n");
        init.push_str(&format!(
            "__octo_start() {{ printf '%s%sOCTO_START_{nonce}%s%s\\n' \"$__OCTORS\" \"$__OCTORS\" \"$__OCTORS\" \"$__OCTORS\"; }}\n"
        ));
        init.push_str(&format!(
            "__octo_end() {{ printf '%s%sOCTO_END_{nonce}:%d:%s%s%s\\n' \"$__OCTORS\" \"$__OCTORS\" \"$1\" \"$PWD\" \"$__OCTORS\" \"$__OCTORS\"; }}\n"
        ));
        init.push_str(&format!(
            "__octo_ready() {{ printf '%s%sOCTO_READY_{nonce}%s%s\\n' \"$__OCTORS\" \"$__OCTORS\" \"$__OCTORS\" \"$__OCTORS\"; }}\n"
        ));
        init.push_str("__octo_ready\n");
        client.write(&id, init.as_bytes())?;

        // Discard the init echo/banner up to and including the ready marker.
        let ready = ready_marker(&nonce);
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut buf = String::new();
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(TermEvent::Data { bytes, .. }) => {
                    buf.push_str(&String::from_utf8_lossy(&bytes));
                    if buf.contains(&ready) {
                        return Ok(Session {
                            id,
                            rx,
                            cwd: cwd.to_string(),
                            nonce,
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

fn gen_nonce() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    format!("{:08x}{:08x}", t.wrapping_mul(2_654_435_761) ^ n, n)
}

fn start_marker(nonce: &str) -> String {
    format!("\u{1e}\u{1e}OCTO_START_{nonce}\u{1e}\u{1e}")
}

fn ready_marker(nonce: &str) -> String {
    format!("\u{1e}\u{1e}OCTO_READY_{nonce}\u{1e}\u{1e}")
}

fn end_re(nonce: &str) -> regex::Regex {
    regex::Regex::new(&format!(
        r"\x1e\x1eOCTO_END_{}:(\d+):([^\x1e]*)\x1e\x1e",
        regex::escape(nonce)
    ))
    .expect("valid end-marker regex")
}

/// Drain the event receiver until the end marker is seen or `timeout` elapses.
fn drain_capture(rx: &Receiver<TermEvent>, timeout: Duration, nonce: &str) -> Capture {
    let deadline = Instant::now() + timeout;
    let mut buf = String::new();
    loop {
        if Instant::now() >= deadline {
            return Capture::TimedOut {
                partial: extract_partial(&buf, nonce),
            };
        }
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(TermEvent::Data { bytes, .. }) => {
                buf.push_str(&String::from_utf8_lossy(&bytes));
                if let Some((output, exit_code, cwd)) = parse_capture(&buf, nonce) {
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
                    output: extract_partial(&buf, nonce),
                    exit_code: code.unwrap_or(-1),
                    cwd: String::new(),
                };
            }
            Ok(TermEvent::Error { .. }) => {
                return Capture::Done {
                    output: extract_partial(&buf, nonce),
                    exit_code: -1,
                    cwd: String::new(),
                };
            }
            Ok(TermEvent::Attention) => {}
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                return Capture::Done {
                    output: extract_partial(&buf, nonce),
                    exit_code: -1,
                    cwd: String::new(),
                };
            }
        }
    }
}

/// Parse a fully-captured buffer into (clean output, exit code, cwd). Returns
/// `None` until both markers are present.
fn parse_capture(buf: &str, nonce: &str) -> Option<(String, i32, String)> {
    let sm = start_marker(nonce);
    let start_idx = buf.find(&sm)?;
    let after_start = start_idx + sm.len();
    let tail = &buf[after_start..];
    let caps = end_re(nonce).captures(tail)?;
    let whole = caps.get(0).unwrap();
    let raw_output = &tail[..whole.start()];
    let exit_code: i32 = caps[1].parse().ok()?;
    let cwd = caps[2].to_string();
    Some((clean_output(raw_output), exit_code, cwd))
}

/// Best-effort output recovery when no end marker arrived (timeout / shell
/// death): everything after the start marker, cleaned.
fn extract_partial(buf: &str, nonce: &str) -> String {
    let sm = start_marker(nonce);
    let s = match buf.find(&sm) {
        Some(i) => &buf[i + sm.len()..],
        None => buf,
    };
    clean_output(s)
}

fn ansi_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
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

/// Cap output at `MAX_OUTPUT_BYTES` on a char boundary, with a truncation note.
fn cap_output(s: String) -> String {
    if s.len() <= MAX_OUTPUT_BYTES {
        return s;
    }
    let mut end = MAX_OUTPUT_BYTES;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n…(output truncated at {MAX_OUTPUT_BYTES} bytes)", &s[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Raw record-separator byte — what the shell's marker functions emit.
    const RS: char = '\u{1e}';
    const N: &str = "abc123"; // fixed nonce for deterministic tests

    fn buf(output: &str, code: i32, cwd: &str) -> String {
        format!("{RS}{RS}OCTO_START_{N}{RS}{RS}\n{output}\n{RS}{RS}OCTO_END_{N}:{code}:{cwd}{RS}{RS}\n")
    }

    #[test]
    fn parses_clean_capture() {
        let b = buf("hello world", 0, "/repo/src");
        let (out, code, cwd) = parse_capture(&b, N).expect("should parse");
        assert_eq!(out, "hello world");
        assert_eq!(code, 0);
        assert_eq!(cwd, "/repo/src");
    }

    #[test]
    fn parses_nonzero_exit_and_strips_ansi() {
        let b = buf("\x1b[31mError:\x1b[0m boom\r\n", 1, "/tmp");
        let (out, code, cwd) = parse_capture(&b, N).expect("should parse");
        assert_eq!(out, "Error: boom");
        assert_eq!(code, 1);
        assert_eq!(cwd, "/tmp");
    }

    #[test]
    fn none_until_end_marker_present() {
        let partial = format!("{RS}{RS}OCTO_START_{N}{RS}{RS}\npartial output not done");
        assert!(parse_capture(&partial, N).is_none());
    }

    #[test]
    fn none_before_start_marker() {
        assert!(parse_capture("just some boot noise", N).is_none());
    }

    #[test]
    fn ignores_echoed_prefix_before_start() {
        let b = format!("$ \x1b[1mwhoami\x1b[0m\r\n{}", buf("johnatan", 0, "/home"));
        let (out, code, cwd) = parse_capture(&b, N).expect("should parse");
        assert_eq!(out, "johnatan");
        assert_eq!(code, 0);
        assert_eq!(cwd, "/home");
    }

    #[test]
    fn cwd_with_colon_survives() {
        let b = buf("ok", 130, "/weird:path");
        let (_out, code, cwd) = parse_capture(&b, N).expect("should parse");
        assert_eq!(code, 130);
        assert_eq!(cwd, "/weird:path");
    }

    #[test]
    fn command_output_containing_a_foreign_marker_is_not_a_terminator() {
        // A command prints a marker with a DIFFERENT nonce in its own stdout;
        // the real terminator (our nonce) must still win and the foreign marker
        // be treated as ordinary output.
        let foreign = format!("{RS}{RS}OCTO_END_deadbeef:0:/x{RS}{RS}");
        let b = buf(&format!("see this {foreign} text"), 0, "/repo");
        let (out, code, cwd) = parse_capture(&b, N).expect("should parse");
        assert!(out.contains("OCTO_END_deadbeef"), "foreign marker kept as output: {out:?}");
        assert_eq!(code, 0);
        assert_eq!(cwd, "/repo");
    }

    #[test]
    fn extract_partial_recovers_output_without_end_marker() {
        let b = format!("{RS}{RS}OCTO_START_{N}{RS}{RS}\nstreaming line 1\r\nstreaming line 2\r\n");
        assert_eq!(extract_partial(&b, N), "streaming line 1\nstreaming line 2");
    }

    #[test]
    fn clean_output_normalizes_crlf_and_trims() {
        assert_eq!(clean_output("\r\n  line\r\n\r\n"), "line");
    }

    #[test]
    fn cap_output_truncates_on_char_boundary() {
        // A multi-byte char straddling the cap must not panic or split.
        let s = "é".repeat(40_000); // 80_000 bytes
        let capped = cap_output(s);
        assert!(capped.len() <= MAX_OUTPUT_BYTES + 64);
        assert!(capped.contains("truncated"));
    }

    #[test]
    fn nonces_are_unique() {
        assert_ne!(gen_nonce(), gen_nonce());
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

        // 5. A command that prints marker-like bytes is NOT mis-terminated.
        let r = shell
            .run("t", "/tmp", "printf 'OCTO_END_x:0:/y\\nreal tail\\n'", to)
            .expect("run marker-ish");
        assert!(r.output.contains("real tail"), "output truncated by fake marker: {:?}", r.output);

        shell.close("t");
        daemon.kill().ok();
    }
}
