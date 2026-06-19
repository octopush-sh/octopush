//! Async client for the `octopush-pty-server` daemon.
//!
//! [`DaemonClient`] holds a single `UnixStream` connection.  A background
//! reader thread multiplexes the incoming newline-delimited JSON stream into:
//!
//! - **Responses** (have a `type` field): dispatched to per-reqid oneshot
//!   channels that callers block on.
//! - **Events** (have an `event` field, `id` field): fan-out via a per-terminal
//!   broadcast channel that the attach thread subscribes to.
//!
//! Connection healing: if the socket EOF's, the client attempts one reconnect
//! (calls [`pty_daemon::ensure_daemon_running`] and re-opens the socket). If
//! that fails too, the error is surfaced to the next caller.

use crate::error::{AppError, AppResult};
use crate::pty_daemon;
use parking_lot::Mutex;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc as stdmpsc;
use std::sync::Arc;

/// A live terminal event pushed by the daemon (`data`, `exit`, `error`,
/// `attention`).
#[derive(Debug, Clone)]
pub enum TermEvent {
    Data { seq: u64, bytes: Vec<u8> },
    Exit { code: Option<i32> },
    Error { message: String },
    /// Emitted when the PTY has been idle long enough after a
    /// meaningful burst of output for the daemon to consider it
    /// "waiting for user input". Frontend uses this to drive the
    /// attention chime + monogram halo + mode-tab pulse.
    Attention,
    /// Emitted on a foreground-process state change: `busy` is true when a
    /// non-shell child owns the PTY (a command is running), false when the
    /// shell is back at its prompt. Drives the rail's processing bar.
    Foreground { busy: bool },
}

/// Minimal terminal descriptor returned by `list_terminals`.
#[derive(Debug, Clone)]
pub struct TerminalInfo {
    pub id: String,
    pub label: String,
    pub running: bool,
    pub cwd: String,
    pub started_at: i64,
}

// ---------------------------------------------------------------------------
// Inner mutable state held behind a Mutex
// ---------------------------------------------------------------------------

type ReqMap = HashMap<u64, stdmpsc::SyncSender<Value>>;
/// One subscriber per terminal id. The daemon keeps a single attached client
/// per session and pushes each byte over the socket exactly once, so the
/// client must route each event to exactly one receiver — the most recent
/// attach. A re-attach (terminal reopened) *replaces* the prior subscriber;
/// keeping a list here would fan every byte out to stale receivers from
/// previous attaches and duplicate the rendered output.
type EventMap = HashMap<String, stdmpsc::SyncSender<TermEvent>>;

struct Inner {
    /// The connection's socket. Requests are written through it directly
    /// (`Write` is implemented for `&UnixStream`), and a reconnect calls
    /// `shutdown()` on it to unblock the superseded reader thread — without
    /// that, the old reader stays parked in `read()` forever, pinning the
    /// half-open socket: one leaked fd here and two in the daemon per
    /// reconnect. `None` for the stub client (daemon unavailable).
    stream: Option<UnixStream>,
    /// Pending per-reqid response waiters.
    pending: Arc<Mutex<ReqMap>>,
    /// Per-terminal event subscribers.
    events: Arc<Mutex<EventMap>>,
    /// Whether the reader thread has detected a fatal error.
    broken: Arc<AtomicBool>,
}

// ---------------------------------------------------------------------------
// DaemonClient
// ---------------------------------------------------------------------------

pub struct DaemonClient {
    inner: Mutex<Inner>,
    next_reqid: AtomicU64,
    /// Bumped by every reconnect. Each reader thread remembers the value it
    /// was spawned with and, on EOF, only runs its broken/drain epilogue if
    /// it is still the CURRENT generation — a reader woken by the reconnect's
    /// `shutdown()` must not poison the fresh connection's shared state.
    reader_generation: Arc<AtomicU64>,
}

impl DaemonClient {
    /// Connect to the daemon socket and start the background reader thread.
    pub fn connect() -> AppResult<Arc<Self>> {
        let sock_path = pty_daemon::ensure_daemon_running()?;
        Self::connect_to(sock_path.to_str().unwrap_or(""))
    }

    /// Build a stub client that reports "daemon unavailable" on every call.
    ///
    /// Used when the daemon binary is absent so Octopush can still start.
    pub fn stub() -> Arc<Self> {
        // We need a real socket path for the writer; use /dev/null as a
        // placeholder write target that we'll never actually reach because
        // `broken` is pre-set to `true`.
        let pending: Arc<Mutex<ReqMap>> = Arc::new(Mutex::new(HashMap::new()));
        let events: Arc<Mutex<EventMap>> = Arc::new(Mutex::new(HashMap::new()));
        let broken = Arc::new(AtomicBool::new(true)); // pre-broken

        Arc::new(Self {
            inner: Mutex::new(Inner {
                stream: None,
                pending,
                events,
                broken,
            }),
            next_reqid: AtomicU64::new(1),
            reader_generation: Arc::new(AtomicU64::new(0)),
        })
    }

    /// Connect to a specific socket path (useful in tests).
    pub fn connect_to(sock_path: &str) -> AppResult<Arc<Self>> {
        let stream = UnixStream::connect(sock_path)
            .map_err(|e| AppError::Other(format!("connect to daemon: {e}")))?;

        let pending: Arc<Mutex<ReqMap>> = Arc::new(Mutex::new(HashMap::new()));
        let events: Arc<Mutex<EventMap>> = Arc::new(Mutex::new(HashMap::new()));
        let broken = Arc::new(AtomicBool::new(false));

        let reader_stream = stream
            .try_clone()
            .map_err(|e| AppError::Other(format!("clone socket: {e}")))?;

        let reader_generation = Arc::new(AtomicU64::new(0));
        let client = Arc::new(Self {
            inner: Mutex::new(Inner {
                stream: Some(stream),
                pending: Arc::clone(&pending),
                events: Arc::clone(&events),
                broken: Arc::clone(&broken),
            }),
            next_reqid: AtomicU64::new(1),
            reader_generation: Arc::clone(&reader_generation),
        });

        // Start reader thread (generation 0 — the value the counter holds).
        let reader = BufReader::new(reader_stream);
        let pending2 = Arc::clone(&pending);
        let events2 = Arc::clone(&events);
        let broken2 = Arc::clone(&broken);
        std::thread::Builder::new()
            .name("daemon-reader".into())
            .spawn(move || {
                run_reader(reader, pending2, events2, broken2, 0, reader_generation);
            })
            .map_err(|e| AppError::Other(format!("spawn reader thread: {e}")))?;

        Ok(client)
    }

    // -----------------------------------------------------------------------
    // Protocol methods
    // -----------------------------------------------------------------------

    /// List all terminals known to the daemon.
    pub fn list_terminals(&self) -> AppResult<Vec<TerminalInfo>> {
        let resp = self.send_request(serde_json::json!({"method": "list_terminals"}))?;
        let arr = resp["terminals"]
            .as_array()
            .ok_or_else(|| AppError::Other("list_terminals: bad response".into()))?;
        let infos = arr
            .iter()
            .map(|v| TerminalInfo {
                id: v["id"].as_str().unwrap_or("").to_string(),
                label: v["label"].as_str().unwrap_or("").to_string(),
                running: v["running"].as_bool().unwrap_or(false),
                cwd: v["cwd"].as_str().unwrap_or("").to_string(),
                started_at: v["started_at"].as_i64().unwrap_or(0),
            })
            .collect();
        Ok(infos)
    }

    /// Spawn a new PTY in the daemon.  Returns the OS pid.
    pub fn spawn(
        &self,
        id: &str,
        cwd: &str,
        env: &HashMap<String, String>,
        shell: Option<&str>,
        rows: u16,
        cols: u16,
    ) -> AppResult<u32> {
        let resp = self.send_request(serde_json::json!({
            "method": "spawn",
            "id": id,
            "cwd": cwd,
            "env": env,
            "shell": shell,
            "rows": rows,
            "cols": cols,
        }))?;
        resp["pid"]
            .as_u64()
            .map(|n| n as u32)
            .ok_or_else(|| AppError::Other(format!("spawn: unexpected response: {resp}")))
    }

    /// Attach to a terminal's event stream.
    ///
    /// Returns a `Receiver` that yields [`TermEvent`]s as they arrive from the
    /// daemon.  The caller must drain the receiver promptly (channel capacity 256).
    pub fn attach(
        &self,
        id: &str,
        since_seq: u64,
    ) -> AppResult<stdmpsc::Receiver<TermEvent>> {
        // Register the event listener BEFORE sending the attach request so we
        // don't miss early events. Inserting REPLACES any prior subscriber for
        // this id: dropping the old sender closes its receiver, which lets the
        // stale reader thread from a previous attach terminate cleanly instead
        // of duplicating every byte (see EventMap docs).
        let (tx, rx) = stdmpsc::sync_channel::<TermEvent>(256);
        {
            let inner_guard = self.inner.lock();
            let mut ev = inner_guard.events.lock();
            ev.insert(id.to_string(), tx);
        }

        let resp = self.send_request(serde_json::json!({
            "method": "attach",
            "id": id,
            "since_seq": since_seq,
        }));

        if let Err(e) = resp {
            // The send failed (broken connection). Leave cleanup to lazy
            // removal in `run_reader`: the caller drops `rx`, so the next
            // event for this id finds a closed channel and removes it. We
            // avoid removing here to not clobber a concurrent re-attach.
            return Err(e);
        }

        Ok(rx)
    }

    /// Detach from a terminal.
    pub fn detach(&self, id: &str) -> AppResult<()> {
        self.send_request(serde_json::json!({
            "method": "detach",
            "id": id,
        }))?;
        // Remove event listeners for this terminal.
        let inner_guard = self.inner.lock();
        let mut ev = inner_guard.events.lock();
        ev.remove(id);
        Ok(())
    }

    /// Write bytes to a terminal's stdin (base64-encodes for the wire).
    pub fn write(&self, id: &str, data: &[u8]) -> AppResult<()> {
        use base64::Engine as _;
        let encoded = base64::engine::general_purpose::STANDARD.encode(data);
        self.send_request(serde_json::json!({
            "method": "write",
            "id": id,
            "data": encoded,
        }))?;
        Ok(())
    }

    /// Resize a terminal.
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> AppResult<()> {
        self.send_request(serde_json::json!({
            "method": "resize",
            "id": id,
            "cols": cols,
            "rows": rows,
        }))?;
        Ok(())
    }

    /// Kill a terminal.  `signal` is `"TERM"` (default) or `"KILL"`.
    pub fn kill(&self, id: &str, signal: &str) -> AppResult<()> {
        self.send_request(serde_json::json!({
            "method": "kill",
            "id": id,
            "signal": signal,
        }))?;
        Ok(())
    }

    /// Permanently delete a terminal: the daemon kills the shell if running,
    /// drops the session (releasing its fds) and deletes its scrollback log.
    pub fn remove(&self, id: &str) -> AppResult<()> {
        // Drop the event listener first, unconditionally — the terminal is
        // being deleted, so a stale subscriber must not linger even when the
        // daemon no longer knows the id (e.g. it restarted in between).
        {
            let inner_guard = self.inner.lock();
            let mut ev = inner_guard.events.lock();
            ev.remove(id);
        }
        self.send_request(serde_json::json!({
            "method": "remove",
            "id": id,
        }))?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Connection healing
    // -----------------------------------------------------------------------

    /// Attempt one reconnect: re-spawn daemon if needed and swap in a new socket.
    ///
    /// Also heals a stub client (built when the daemon was unavailable at
    /// startup): `ensure_daemon_running()` (re)starts the daemon, and we swap
    /// the stub's NullWriter for the real socket and clear `broken`.
    pub fn try_reconnect(&self) -> AppResult<()> {
        let sock_path = pty_daemon::ensure_daemon_running()?;
        let stream = UnixStream::connect(&sock_path)
            .map_err(|e| AppError::Other(format!("reconnect to daemon: {e}")))?;
        let reader_stream = stream
            .try_clone()
            .map_err(|e| AppError::Other(format!("clone reconnected socket: {e}")))?;

        let mut inner = self.inner.lock();

        // Supersede the old reader BEFORE waking it: its EOF epilogue checks
        // the generation under the pending lock, so after this bump a reader
        // woken by the shutdown below exits silently instead of re-marking
        // the fresh connection broken and draining its pending waiters.
        {
            let _pend = inner.pending.lock();
            self.reader_generation.fetch_add(1, Ordering::SeqCst);
        }

        // Tear down the old connection fully: shutdown() unblocks the old
        // reader thread (it sees EOF and exits, dropping its socket clone),
        // which lets the daemon close its side too. Merely replacing the
        // stream would leave the old socket half-open forever.
        if let Some(old) = inner.stream.take() {
            let _ = old.shutdown(std::net::Shutdown::Both);
        }
        inner.stream = Some(stream);
        inner.broken.store(false, Ordering::SeqCst);

        // Restart reader thread with the current generation.
        let my_gen = self.reader_generation.load(Ordering::SeqCst);
        let generation = Arc::clone(&self.reader_generation);
        let pending2 = Arc::clone(&inner.pending);
        let events2 = Arc::clone(&inner.events);
        let broken2 = Arc::clone(&inner.broken);
        let reader = BufReader::new(reader_stream);
        std::thread::Builder::new()
            .name("daemon-reader-reconnect".into())
            .spawn(move || {
                run_reader(reader, pending2, events2, broken2, my_gen, generation);
            })
            .map_err(|e| AppError::Other(format!("spawn reconnect reader: {e}")))?;

        Ok(())
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    /// Assign the next request id.
    fn next_id(&self) -> u64 {
        self.next_reqid.fetch_add(1, Ordering::Relaxed)
    }

    /// Send a JSON request, wait for the matching response, return it.
    fn send_request(&self, mut payload: Value) -> AppResult<Value> {
        // If the connection is broken — the daemon was replaced during an
        // Octopush update, the socket EOF'd, or we fell back to the stub client
        // at startup — try to heal it once before giving up. `try_reconnect`
        // re-runs `ensure_daemon_running` (restarting the daemon if needed) and
        // reconnects the socket. We read the flag into a local first so the
        // lock is released before calling `try_reconnect` (parking_lot's Mutex
        // is not reentrant).
        let is_broken = self.inner.lock().broken.load(Ordering::SeqCst);
        if is_broken {
            let _ = self.try_reconnect();
        }
        // If it's still broken after the heal attempt, surface the error.
        {
            let inner = self.inner.lock();
            if inner.broken.load(Ordering::SeqCst) {
                return Err(AppError::Other("daemon connection is broken".into()));
            }
        }

        let reqid = self.next_id();
        payload["reqid"] = Value::Number(reqid.into());

        // Register waiter before writing to avoid race.
        let (tx, rx) = stdmpsc::sync_channel::<Value>(1);
        {
            let inner = self.inner.lock();
            inner.pending.lock().insert(reqid, tx);
        }

        // Write the request.
        let mut line = serde_json::to_vec(&payload)?;
        line.push(b'\n');
        {
            let inner = self.inner.lock();
            let Some(stream) = inner.stream.as_ref() else {
                return Err(AppError::Other("daemon unavailable".into()));
            };
            let mut w = stream; // Write is implemented for &UnixStream
            if let Err(e) = w.write_all(&line) {
                inner.broken.store(true, Ordering::SeqCst);
                return Err(AppError::Other(format!("write to daemon: {e}")));
            }
        }

        // Wait for response (5-second timeout to avoid deadlock on daemon hang).
        let resp = rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| AppError::Other("daemon response timeout".into()))?;

        if let Some(msg) = resp["message"].as_str() {
            if resp["type"].as_str() == Some("error") {
                return Err(AppError::Other(format!("daemon error: {msg}")));
            }
        }

        Ok(resp)
    }
}

// ---------------------------------------------------------------------------
// Background reader thread
// ---------------------------------------------------------------------------

fn run_reader(
    reader: BufReader<UnixStream>,
    pending: Arc<Mutex<ReqMap>>,
    events: Arc<Mutex<EventMap>>,
    broken: Arc<AtomicBool>,
    my_gen: u64,
    generation: Arc<AtomicU64>,
) {
    use base64::Engine as _;

    for line_result in reader.lines() {
        let line = match line_result {
            Ok(l) => l,
            Err(e) => {
                tracing::warn!(error = %e, "daemon reader: I/O error");
                break;
            }
        };
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }

        let v: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, raw = %line, "daemon reader: JSON parse error");
                continue;
            }
        };

        // Determine if this is a Response (has "type") or an Event (has "event").
        if v["event"].is_string() {
            // It's a streaming event; dispatch to per-terminal listeners.
            let id = v["id"].as_str().unwrap_or("").to_string();
            let event = match v["event"].as_str() {
                Some("data") => {
                    let seq = v["seq"].as_u64().unwrap_or(0);
                    let bytes = v["bytes"]
                        .as_str()
                        .and_then(|b| base64::engine::general_purpose::STANDARD.decode(b).ok())
                        .unwrap_or_default();
                    TermEvent::Data { seq, bytes }
                }
                Some("exit") => {
                    let code = v["code"].as_i64().map(|c| c as i32);
                    TermEvent::Exit { code }
                }
                Some("error") => {
                    let message = v["message"].as_str().unwrap_or("").to_string();
                    TermEvent::Error { message }
                }
                Some("attention") => TermEvent::Attention,
                Some("foreground") => {
                    let busy = v["busy"].as_bool().unwrap_or(false);
                    TermEvent::Foreground { busy }
                }
                _ => continue,
            };

            // Route to the single current subscriber for this id. If the
            // channel is gone (the receiver was dropped — i.e. superseded by a
            // newer attach, or the pane unmounted), remove the dead entry.
            let mut ev_map = events.lock();
            if let Some(sender) = ev_map.get(&id) {
                if sender.try_send(event).is_err() {
                    ev_map.remove(&id);
                }
            }
        } else if v["type"].is_string() {
            // It's a response; dispatch to the reqid waiter.
            let reqid = v["reqid"].as_u64();
            if let Some(id) = reqid {
                if let Some(tx) = pending.lock().remove(&id) {
                    let _ = tx.send(v);
                }
            } else {
                tracing::warn!(raw = %line, "daemon reader: response with no reqid, dropping");
            }
        } else {
            tracing::debug!(raw = %line, "daemon reader: unknown message shape");
        }
    }

    // EOF epilogue. The generation check (under the pending lock, which
    // try_reconnect holds while bumping) distinguishes a genuine connection
    // loss from this reader being superseded by a reconnect: a superseded
    // reader was woken by the reconnect's shutdown() and must exit silently —
    // the broken flag and pending map now belong to the new connection.
    let mut pend = pending.lock();
    if generation.load(Ordering::SeqCst) != my_gen {
        tracing::debug!("daemon reader: superseded by reconnect — exiting");
        return;
    }
    tracing::warn!("daemon reader: EOF — connection lost");
    broken.store(true, Ordering::SeqCst);

    // Wake all pending waiters with an error so callers don't block forever.
    for (_, tx) in pend.drain() {
        let _ = tx.send(serde_json::json!({
            "type": "error",
            "message": "daemon connection closed"
        }));
    }
}

// ---------------------------------------------------------------------------
// Tests
//
// These tests start the daemon as an external process (since the server code
// lives in the bin crate, not the lib crate).  We build the daemon binary
// before running — `cargo test` in the workspace takes care of this.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;
    use std::collections::HashMap;
    use std::fs;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use std::time::Duration;
    use tempfile::TempDir;

    /// Start the daemon binary on a given socket path (via env var override).
    ///
    /// The daemon reads `HOME` to locate its socket.  We override `HOME` to
    /// point at a temp directory so tests are isolated from each other and
    /// from the real daemon.
    fn start_daemon_process(home: &std::path::Path) -> std::process::Child {
        // Find the daemon binary (sibling of current exe or in target/debug).
        let daemon_bin = find_daemon_bin();

        let child = Command::new(&daemon_bin)
            .env("HOME", home)
            // Use a very short auto-exit timer so the daemon stops after tests.
            .env("OCTOPUSH_PTY_AUTO_EXIT_SECS", "10")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("failed to spawn daemon binary");

        // Give daemon time to start.
        std::thread::sleep(Duration::from_millis(200));
        child
    }

    fn find_daemon_bin() -> PathBuf {
        // Try sibling-of-exe.
        if let Ok(exe) = std::env::current_exe() {
            if let Some(parent) = exe.parent() {
                let c = parent.join("octopush-pty-server");
                if c.exists() {
                    return c;
                }
                // In cargo test the exe is in deps/; try one level up.
                if let Some(gp) = parent.parent() {
                    let c = gp.join("octopush-pty-server");
                    if c.exists() {
                        return c;
                    }
                }
            }
        }
        // Fallback: workspace target/debug.
        if let Ok(cwd) = std::env::current_dir() {
            for rel in &[
                "target/debug/octopush-pty-server",
                "../target/debug/octopush-pty-server",
            ] {
                let c = cwd.join(rel);
                if c.exists() {
                    return c;
                }
            }
        }
        panic!("octopush-pty-server binary not found; run `cargo build --bin octopush-pty-server` first");
    }

    /// Poll the socket until ready or timeout.
    fn wait_for_socket(sock: &PathBuf, timeout: Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            if sock.exists() && std::os::unix::net::UnixStream::connect(sock).is_ok() {
                return true;
            }
            if std::time::Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    #[serial]
    fn client_spawn_write_exit_flow() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        let base = home.join(".octopush");
        fs::create_dir_all(&base).unwrap();
        let sock_path = base.join("pty-server.sock");

        let mut daemon = start_daemon_process(home);
        assert!(
            wait_for_socket(&sock_path, Duration::from_secs(5)),
            "daemon socket did not appear"
        );

        let client = DaemonClient::connect_to(sock_path.to_str().unwrap()).unwrap();

        // Spawn a shell.
        let env = HashMap::new();
        let pid = client
            .spawn("tc-flow", "/tmp", &env, Some("/bin/sh"), 24, 80)
            .expect("spawn");
        assert!(pid > 0, "expected non-zero pid, got {pid}");

        // Attach before sending input so we catch all output.
        let rx = client.attach("tc-flow", 0).expect("attach");

        // Send `echo hi` + `exit`.
        client.write("tc-flow", b"echo hi\nexit\n").expect("write");

        // Collect events until we see "hi" in data or get exit.
        let deadline = std::time::Instant::now() + Duration::from_secs(8);
        let mut found_hi = false;
        let mut found_exit = false;
        while std::time::Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok(TermEvent::Data { bytes, .. }) => {
                    let text = String::from_utf8_lossy(&bytes);
                    if text.contains("hi") {
                        found_hi = true;
                    }
                }
                Ok(TermEvent::Exit { .. }) => {
                    found_exit = true;
                    break;
                }
                Ok(TermEvent::Error { message }) => {
                    if !message.is_empty() {
                        panic!("unexpected error event: {message}");
                    }
                }
                Ok(TermEvent::Attention) => {
                    // Daemon-driven attention pings — not under test here.
                }
                Ok(TermEvent::Foreground { .. }) => {
                    // Foreground busy transitions — not under test here.
                }
                Err(_) => {}
            }
        }

        daemon.kill().ok();
        assert!(found_hi, "expected 'hi' in PTY output");
        assert!(found_exit, "expected exit event after shell exits");
    }

    #[test]
    #[serial]
    fn client_self_heals_after_daemon_death() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        // Point THIS process's $HOME at the temp dir so the self-heal's
        // `ensure_daemon_running()` targets the temp socket — not the real
        // `~/.octopush` daemon on the dev machine.
        std::env::set_var("HOME", home);
        let base = home.join(".octopush");
        fs::create_dir_all(&base).unwrap();
        let sock_path = base.join("pty-server.sock");

        let mut daemon = start_daemon_process(home);
        assert!(
            wait_for_socket(&sock_path, Duration::from_secs(5)),
            "daemon socket did not appear"
        );

        let client = DaemonClient::connect_to(sock_path.to_str().unwrap()).unwrap();

        // Verify basic comms work.
        assert!(client.list_terminals().expect("list before kill").is_empty());

        // Kill the daemon + clear its socket → the client's connection breaks.
        daemon.kill().ok();
        let _ = daemon.wait();
        fs::remove_file(&sock_path).ok();
        // Let the reader thread notice EOF and mark the connection broken.
        std::thread::sleep(Duration::from_millis(200));

        // Self-heal: the next call must transparently respawn the daemon and
        // reconnect (returning Ok), NOT stay "daemon connection is broken".
        let healed = client.list_terminals();
        assert!(
            healed.is_ok(),
            "expected the client to self-heal after daemon death, got {healed:?}"
        );
        assert!(healed.unwrap().is_empty());

        // Clean up the daemon the heal respawned (detached → kill via pid file).
        if let Ok(pid_str) = fs::read_to_string(base.join("pty-server.pid")) {
            if let Ok(pid) = pid_str.trim().parse::<i32>() {
                unsafe {
                    libc::kill(pid, libc::SIGTERM);
                }
            }
        }
    }

    /// Helper: drain any pending events on a receiver (non-blocking-ish).
    fn drain(rx: &stdmpsc::Receiver<TermEvent>) {
        while rx.recv_timeout(Duration::from_millis(50)).is_ok() {}
    }

    /// Helper: poll a receiver up to `timeout` for a `Data` event whose bytes
    /// contain `needle`. Returns true if seen.
    fn saw_data_containing(rx: &stdmpsc::Receiver<TermEvent>, needle: &str, timeout: Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        while std::time::Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(TermEvent::Data { bytes, .. }) => {
                    if String::from_utf8_lossy(&bytes).contains(needle) {
                        return true;
                    }
                }
                Ok(_) => {}
                Err(_) => {}
            }
        }
        false
    }

    /// Regression test for the terminal "buffer duplicated on reopen" bug.
    ///
    /// Reopening a terminal causes a second `attach` for the same id. The
    /// daemon keeps a single attached client per session, so it sends each
    /// byte over the socket exactly once. The *client* must therefore route
    /// each event to exactly ONE subscriber — the most recent attach. If the
    /// old subscriber is left registered (the original bug), every byte is
    /// fanned out to both, so xterm writes the content twice.
    ///
    /// Assertion: after a second attach, the FIRST receiver must stop
    /// receiving live data (it has been superseded), while the second
    /// receives it exactly once.
    #[test]
    #[serial]
    fn second_attach_supersedes_first() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        let base = home.join(".octopush");
        fs::create_dir_all(&base).unwrap();
        let sock_path = base.join("pty-server.sock");

        let mut daemon = start_daemon_process(home);
        assert!(
            wait_for_socket(&sock_path, Duration::from_secs(5)),
            "daemon socket did not appear"
        );

        let client = DaemonClient::connect_to(sock_path.to_str().unwrap()).unwrap();

        let env = HashMap::new();
        client
            .spawn("dup-test", "/tmp", &env, Some("/bin/sh"), 24, 80)
            .expect("spawn");

        // First attach (terminal opened once).
        let rx1 = client.attach("dup-test", 0).expect("first attach");
        // Let the shell prompt settle, then clear rx1.
        std::thread::sleep(Duration::from_millis(300));
        drain(&rx1);

        // Second attach for the SAME id (terminal closed + reopened).
        let rx2 = client.attach("dup-test", 0).expect("second attach");
        std::thread::sleep(Duration::from_millis(300));
        drain(&rx2);

        // Produce fresh output after both attaches.
        client
            .write("dup-test", b"echo SUPERSEDE_MARKER\n")
            .expect("write");

        // The current (second) subscriber must receive the marker once.
        let got_on_rx2 = saw_data_containing(&rx2, "SUPERSEDE_MARKER", Duration::from_secs(5));

        // The superseded (first) subscriber must NOT receive the marker.
        let got_on_rx1 = saw_data_containing(&rx1, "SUPERSEDE_MARKER", Duration::from_secs(1));

        client.kill("dup-test", "KILL").ok();
        daemon.kill().ok();

        assert!(got_on_rx2, "expected the active subscriber to receive output");
        assert!(
            !got_on_rx1,
            "superseded subscriber still received output — events are being duplicated across attaches"
        );
    }
}
