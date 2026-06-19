//! TALK shell — a persistent bash PTY per chat thread for `$`-direct execution
//! and the agent's `run_command` (the unified shell).
//!
//! Reuses the `octopush-pty-server` daemon (the same PTY infra that backs RUN
//! mode) in a *capture* access pattern: the backend is the sole attached client,
//! writes a command, and drains output until the shell's next prompt.
//!
//! Completion is detected by a **prompt marker**: `PS1` is set to emit
//! `␞␞OCTO_DONE_<nonce>:<exit>:<cwd>␞␞` (the RS bytes come from a variable so the
//! marker bytes appear only in *output*, never in echoed *input*). bash prints
//! it whenever it returns to its prompt — after a command finishes, exits, or is
//! killed — so an interactive process can't consume it and SIGINT can't flush
//! it (the failure modes of the old queued-trailer approach).
//!
//! A command that doesn't finish within a short *promotion* window is handed off
//! as a **live process**: the receiver is moved out of the session and the
//! caller streams raw output (for an xterm panel, with interactive stdin) until
//! the process exits. One shell per thread keeps cwd/env across commands and
//! across an Octopush restart (reattach); each session has its own lock so a
//! long command in one thread never blocks another.

use crate::error::{AppError, AppResult};
use crate::pty_client::{DaemonClient, TermEvent};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, TryRecvError};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Cap on captured output (bytes), mirroring `execute_tool`'s run_command cap
/// so output can't bloat the DB row / chat render.
const MAX_OUTPUT_BYTES: usize = 50_000;

/// Outcome of running one command in a TALK shell.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellResult {
    pub output: String,
    pub exit_code: i32,
    pub ok: bool,
    pub cwd: String,
    /// The cwd relativized for display (computed by the chat engine; empty at the
    /// workspace root). Single source of the cwd badge; rendered verbatim.
    #[serde(default)]
    pub cwd_label: String,
    /// True when the command was promoted to a live process.
    #[serde(default)]
    pub live: bool,
}

/// What `run` decided about a command.
pub enum RunOutcome {
    Done(ShellResult),
    Live(LiveRun),
    /// A live process is already occupying this thread's shell.
    Busy,
}

/// Result of a capture-only run (the agent loop): completed, or busy.
pub enum CaptureOutcome {
    Done(ShellResult),
    Busy,
}

/// Hand-off for a promoted long-running command. The caller drives
/// [`LiveRun::stream`] to pump output until the process exits, then the session
/// is restored for the next command.
pub struct LiveRun {
    rx: Receiver<TermEvent>,
    /// Raw output already seen during the promotion window, to paint first.
    pub initial: String,
    nonce: String,
    cwd: String,
    handle: Arc<Mutex<Session>>,
    client: Arc<DaemonClient>,
    thread_id: String,
}

/// Terminal state of a streamed live process.
#[derive(Debug, Clone)]
pub struct LiveExit {
    pub exit_code: i32,
    pub cwd: String,
    pub full_output: String,
}

/// A live bash PTY bound to one chat thread.
struct Session {
    id: String,
    /// The sole capture subscriber. `None` while a live process owns it.
    rx: Option<Receiver<TermEvent>>,
    cwd: String,
    /// Per-session random token mixed into the prompt marker.
    nonce: String,
}

pub struct TalkShell {
    client: Mutex<Option<Arc<DaemonClient>>>,
    sessions: Mutex<HashMap<String, Arc<Mutex<Session>>>>,
}

impl TalkShell {
    pub fn new() -> Self {
        Self {
            client: Mutex::new(None),
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn set_client(&self, client: Option<Arc<DaemonClient>>) {
        *self.client.lock() = client;
    }

    /// Whether a daemon client is attached — i.e. the shared shell is usable.
    pub fn available(&self) -> bool {
        self.client.lock().is_some()
    }

    /// Run a command in the thread's shell.
    ///
    /// `promote = true` ($-direct): if it hasn't finished within `timeout`,
    /// return [`RunOutcome::Live`] so the caller streams the rest.
    /// `promote = false` (agent capture): never promote — on `timeout`, interrupt
    /// (Ctrl-C) and return the partial output, keeping the shell (env preserved).
    pub fn run(
        &self,
        thread_id: &str,
        workspace_path: &str,
        command: &str,
        timeout: Duration,
        promote: bool,
    ) -> AppResult<RunOutcome> {
        let client = self
            .client
            .lock()
            .clone()
            .ok_or_else(|| AppError::Other("terminal daemon unavailable".into()))?;

        let existing = {
            let map = self.sessions.lock();
            map.get(thread_id).cloned()
        };
        let handle = match existing {
            Some(h) => h,
            None => {
                let session = Self::ensure_session(&client, thread_id, workspace_path)?;
                let h = Arc::new(Mutex::new(session));
                let mut map = self.sessions.lock();
                Arc::clone(map.entry(thread_id.to_string()).or_insert(h))
            }
        };

        // Take the receiver out under the lock, then drop the lock so the drain
        // never blocks another thread. A concurrent run for THIS thread finds
        // `rx == None` and returns Busy.
        let (rx, nonce, id, cwd) = {
            let mut session = handle.lock();
            let Some(rx) = session.rx.take() else {
                return Ok(RunOutcome::Busy);
            };
            (rx, session.nonce.clone(), session.id.clone(), session.cwd.clone())
        };

        // Discard any stale bytes (the idle prompt left in the buffer) so the
        // next prompt marker we see is unambiguously THIS command's completion.
        drain_pending(&rx);
        if let Err(e) = client.write(&id, format!("{command}\n").as_bytes()) {
            handle.lock().rx = Some(rx);
            return Err(e);
        }

        match probe(&rx, timeout, &nonce) {
            Probe::Done { output, exit_code, cwd: new_cwd } => {
                let final_cwd = if new_cwd.is_empty() { cwd } else { new_cwd };
                let mut session = handle.lock();
                session.rx = Some(rx);
                session.cwd = final_cwd.clone();
                Ok(RunOutcome::Done(ShellResult {
                    output: cap_output(output),
                    exit_code,
                    ok: exit_code == 0,
                    cwd: final_cwd,
                    cwd_label: String::new(),
                    live: false,
                }))
            }
            Probe::Dead { output } => {
                let _ = client.remove(&id);
                match Self::ensure_session(&client, thread_id, &cwd) {
                    Ok(fresh) => *handle.lock() = fresh,
                    Err(e) => {
                        self.sessions.lock().remove(thread_id);
                        return Err(e);
                    }
                }
                Ok(RunOutcome::Done(ShellResult {
                    output: cap_output(output),
                    exit_code: -1,
                    ok: false,
                    cwd,
                    cwd_label: String::new(),
                    live: false,
                }))
            }
            Probe::NotYet { raw } if promote => Ok(RunOutcome::Live(LiveRun {
                rx,
                initial: raw,
                nonce,
                cwd,
                handle,
                client,
                thread_id: thread_id.to_string(),
            })),
            // Capture-only timeout: interrupt, then read the prompt marker bash
            // prints once the killed command returns control — keeping the shell
            // (env preserved). Ctrl-C can't lose the marker now (it's a prompt,
            // not queued input). Recycle only if the marker never comes.
            Probe::NotYet { raw } => {
                let note = format!(
                    "(command was still running after {}s and was interrupted — the output \
                     above may be incomplete, and any process it backgrounded may still be \
                     running)",
                    timeout.as_secs()
                );
                let partial = strip_octo_markers(&clean_output(&raw));
                let body = if partial.is_empty() { note.clone() } else { format!("{partial}\n{note}") };
                let _ = client.write(&id, b"\x03");
                match probe(&rx, Duration::from_secs(3), &nonce) {
                    Probe::Done { cwd: new_cwd, .. } => {
                        let final_cwd = if new_cwd.is_empty() { cwd } else { new_cwd };
                        let mut session = handle.lock();
                        session.rx = Some(rx);
                        session.cwd = final_cwd.clone();
                        Ok(RunOutcome::Done(ShellResult {
                            output: cap_output(body),
                            exit_code: -1,
                            ok: false,
                            cwd: final_cwd,
                            cwd_label: String::new(),
                            live: false,
                        }))
                    }
                    _ => {
                        let _ = client.remove(&id);
                        match Self::ensure_session(&client, thread_id, &cwd) {
                            Ok(fresh) => *handle.lock() = fresh,
                            Err(e) => {
                                self.sessions.lock().remove(thread_id);
                                return Err(e);
                            }
                        }
                        Ok(RunOutcome::Done(ShellResult {
                            output: cap_output(body),
                            exit_code: -1,
                            ok: false,
                            cwd,
                            cwd_label: String::new(),
                            live: false,
                        }))
                    }
                }
            }
        }
    }

    /// Capture-only run for the agent loop (never promotes to a live process).
    pub fn run_capture(
        &self,
        thread_id: &str,
        workspace_path: &str,
        command: &str,
        timeout: Duration,
    ) -> AppResult<CaptureOutcome> {
        match self.run(thread_id, workspace_path, command, timeout, false)? {
            RunOutcome::Done(r) => Ok(CaptureOutcome::Done(r)),
            RunOutcome::Busy | RunOutcome::Live(_) => Ok(CaptureOutcome::Busy),
        }
    }

    /// Send SIGINT (Ctrl-C) to a thread's live process.
    pub fn interrupt(&self, thread_id: &str) {
        if let Some(client) = self.client.lock().clone() {
            let _ = client.write(&format!("talk-{thread_id}"), b"\x03");
        }
    }

    /// Forward keystrokes to a thread's live process (interactive stdin).
    pub fn write_stdin(&self, thread_id: &str, data: &[u8]) {
        if let Some(client) = self.client.lock().clone() {
            let _ = client.write(&format!("talk-{thread_id}"), data);
        }
    }

    /// Resize a thread's PTY so a full-screen TUI lays out to the panel size.
    pub fn resize(&self, thread_id: &str, cols: u16, rows: u16) {
        if let Some(client) = self.client.lock().clone() {
            let _ = client.resize(&format!("talk-{thread_id}"), cols, rows);
        }
    }

    /// Drop a thread's shell (on thread delete / cleanup).
    pub fn close(&self, thread_id: &str) {
        let client = self.client.lock().clone();
        let handle = self.sessions.lock().remove(thread_id);
        if let (Some(client), Some(handle)) = (client, handle) {
            let _ = client.remove(&handle.lock().id);
        }
    }

    /// Reattach to a surviving daemon PTY (so the shell persists across an
    /// Octopush restart) or spawn fresh; then (re-)install the prompt marker with
    /// a fresh nonce and wait until the shell confirms ready. Returns the cwd.
    fn ensure_session(
        client: &Arc<DaemonClient>,
        thread_id: &str,
        cwd: &str,
    ) -> AppResult<Session> {
        let id = format!("talk-{thread_id}");
        let reattaching = client
            .list_terminals()
            .unwrap_or_default()
            .iter()
            .any(|t| t.id == id && t.running);

        if !reattaching {
            Self::spawn_bash(client, &id, cwd)?;
        }
        let nonce = gen_nonce();
        let rx = client.attach(&id, 0)?;

        match init_and_wait_ready(client, &id, &rx, &nonce) {
            Ok(ready_cwd) => Ok(Session {
                id,
                rx: Some(rx),
                cwd: ready_cwd.unwrap_or_else(|| cwd.to_string()),
                nonce,
            }),
            // Reattached but never ready — the surviving shell is busy with a
            // process from before the restart. Do NOT kill it; surface an error.
            Err(_) if reattaching => Err(AppError::Other(
                "This conversation's shell is busy with a process still running from before \
                 the restart. Wait for it to finish, or delete the conversation to stop it."
                    .into(),
            )),
            Err(e) => {
                let _ = client.remove(&id);
                Err(e)
            }
        }
    }

    fn spawn_bash(client: &Arc<DaemonClient>, id: &str, cwd: &str) -> AppResult<()> {
        let mut env = HashMap::new();
        if let Ok(path) = std::env::var("PATH") {
            env.insert("PATH".to_string(), path);
        }
        client.spawn(id, cwd, &env, Some("/bin/bash"), 40, 120)?;
        Ok(())
    }
}

impl LiveRun {
    /// Pump live output to `on_chunk` (raw, with ANSI — xterm draws it) until the
    /// process exits (the prompt marker prints), then restore the session and
    /// return the exit info. Blocking — run on a worker thread.
    pub fn stream<F: FnMut(&str)>(self, mut on_chunk: F) -> LiveExit {
        let mut filter = StreamFilter::new(&self.nonce);
        let mut full = String::new();
        let mut push = |emit: &str, full: &mut String, on_chunk: &mut F| {
            if !emit.is_empty() {
                full.push_str(emit);
                on_chunk(emit);
            }
        };

        let mut exit = LiveExit {
            exit_code: -1,
            cwd: self.cwd.clone(),
            full_output: String::new(),
        };

        let (init_emit, init_done) = filter.feed(&self.initial);
        push(&init_emit, &mut full, &mut on_chunk);
        if let Some((code, cwd)) = init_done {
            exit.exit_code = code;
            exit.cwd = cwd;
            return self.finish(exit, full);
        }

        loop {
            match self.rx.recv_timeout(Duration::from_millis(500)) {
                Ok(TermEvent::Data { bytes, .. }) => {
                    let chunk = String::from_utf8_lossy(&bytes);
                    let (emit, done) = filter.feed(&chunk);
                    push(&emit, &mut full, &mut on_chunk);
                    if let Some((code, cwd)) = done {
                        exit.exit_code = code;
                        exit.cwd = cwd;
                        break;
                    }
                }
                Ok(TermEvent::Exit { code }) => {
                    let tail = filter.flush();
                    push(&tail, &mut full, &mut on_chunk);
                    exit.exit_code = code.unwrap_or(-1);
                    break;
                }
                Ok(TermEvent::Error { .. }) | Err(RecvTimeoutError::Disconnected) => {
                    let tail = filter.flush();
                    push(&tail, &mut full, &mut on_chunk);
                    break;
                }
                Ok(TermEvent::Attention) | Ok(TermEvent::Foreground { .. }) | Err(RecvTimeoutError::Timeout) => {}
            }
        }

        self.finish(exit, full)
    }

    fn finish(self, mut exit: LiveExit, full: String) -> LiveExit {
        exit.full_output = cap_output(clean_output(&full));
        let mut session = self.handle.lock();
        session.rx = Some(self.rx);
        if !exit.cwd.is_empty() {
            session.cwd = exit.cwd.clone();
        } else {
            exit.cwd = session.cwd.clone();
        }
        drop(session);
        let _ = (&self.client, &self.thread_id); // retained for future kill paths
        exit
    }
}

impl Default for TalkShell {
    fn default() -> Self {
        Self::new()
    }
}

// ─── Capture (pure where possible, unit-tested) ───────────────────────

enum Probe {
    Done { output: String, exit_code: i32, cwd: String },
    /// Promotion window elapsed; `raw` is the output seen so far.
    NotYet { raw: String },
    Dead { output: String },
}

/// Discard any bytes currently buffered on the receiver (the idle prompt) so the
/// next prompt marker is unambiguously the next command's completion.
fn drain_pending(rx: &Receiver<TermEvent>) {
    loop {
        match rx.try_recv() {
            Ok(_) => {}
            Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => break,
        }
    }
}

/// Drain until the prompt marker (command done) or `timeout`, accumulating raw
/// output (kept verbatim so a promoted stream can render ANSI).
fn probe(rx: &Receiver<TermEvent>, timeout: Duration, nonce: &str) -> Probe {
    let deadline = Instant::now() + timeout;
    let re = done_re(nonce);
    let mut buf = String::new();
    loop {
        if Instant::now() >= deadline {
            return Probe::NotYet { raw: buf };
        }
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(TermEvent::Data { bytes, .. }) => {
                buf.push_str(&String::from_utf8_lossy(&bytes));
                if let Some(caps) = re.captures(&buf) {
                    let whole = caps.get(0).unwrap();
                    let output = clean_output(&buf[..whole.start()]);
                    let exit_code = caps[1].parse().unwrap_or(-1);
                    let cwd = caps[2].to_string();
                    return Probe::Done { output, exit_code, cwd };
                }
            }
            Ok(TermEvent::Exit { .. }) | Ok(TermEvent::Error { .. }) => {
                return Probe::Dead { output: clean_output(&buf) };
            }
            Ok(TermEvent::Attention) | Ok(TermEvent::Foreground { .. }) => {}
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                return Probe::Dead { output: clean_output(&buf) };
            }
        }
    }
}

/// Progressive prompt-marker filter for the live-stream path: emits output as it
/// arrives (holding back a tail that could be a partial marker) and reports exit
/// code + cwd when the prompt marker is seen.
struct StreamFilter {
    done_re: regex::Regex,
    carry: String,
}

impl StreamFilter {
    fn new(nonce: &str) -> Self {
        Self { done_re: done_re(nonce), carry: String::new() }
    }

    fn feed(&mut self, chunk: &str) -> (String, Option<(i32, String)>) {
        self.carry.push_str(chunk);
        if let Some(caps) = self.done_re.captures(&self.carry) {
            let whole = caps.get(0).unwrap();
            let emit = clean_inline(&self.carry[..whole.start()]);
            let code = caps[1].parse().unwrap_or(-1);
            let cwd = caps[2].to_string();
            self.carry.clear();
            return (emit, Some((code, cwd)));
        }
        // The marker begins with a record-separator byte (0x1e), which never
        // occurs in normal output — hold back only from the first such byte.
        match self.carry.find('\u{1e}') {
            Some(i) => {
                let emit = self.carry[..i].to_string();
                self.carry = self.carry[i..].to_string();
                (emit, None)
            }
            None => (std::mem::take(&mut self.carry), None),
        }
    }

    fn flush(&mut self) -> String {
        clean_inline(&std::mem::take(&mut self.carry))
    }
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

/// The prompt marker: `␞␞OCTO_DONE_<nonce>:<exit>:<cwd>␞␞`.
fn done_re(nonce: &str) -> regex::Regex {
    regex::Regex::new(&format!(
        r"\x1e\x1eOCTO_DONE_{}:(-?\d+):([^\x1e]*)\x1e\x1e",
        regex::escape(nonce)
    ))
    .expect("valid prompt-marker regex")
}

/// Install the prompt marker with `nonce` and wait until the shell prints it
/// (ready). On reattach this drains replayed scrollback past it. Returns cwd.
fn init_and_wait_ready(
    client: &Arc<DaemonClient>,
    id: &str,
    rx: &Receiver<TermEvent>,
    nonce: &str,
) -> AppResult<Option<String>> {
    // Leading newline flushes any partial line a reattached shell left behind.
    // `$__OCTORS` (a runtime-built RS byte) keeps the raw marker out of the
    // (echoable) PS1 source; PROMPT_COMMAND captures the last exit code, and PS1
    // prints the marker each time bash returns to its prompt.
    let mut init = String::new();
    init.push('\n');
    init.push_str("stty -echo 2>/dev/null; PS2=''\n");
    init.push_str("__OCTORS=$(printf '\\036')\n");
    init.push_str("__octo_oc=0; PROMPT_COMMAND='__octo_oc=$?'\n");
    init.push_str(&format!(
        "PS1='${{__OCTORS}}${{__OCTORS}}OCTO_DONE_{nonce}:${{__octo_oc}}:${{PWD}}${{__OCTORS}}${{__OCTORS}}'\n"
    ));
    client.write(id, init.as_bytes())?;

    let re = done_re(nonce);
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut buf = String::new();
    while Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(TermEvent::Data { bytes, .. }) => {
                buf.push_str(&String::from_utf8_lossy(&bytes));
                if let Some(caps) = re.captures(&buf) {
                    return Ok(Some(caps[2].to_string()));
                }
            }
            Ok(TermEvent::Exit { .. }) | Ok(TermEvent::Error { .. }) => {
                return Err(AppError::Other("talk shell exited during init".into()));
            }
            Ok(TermEvent::Attention) | Ok(TermEvent::Foreground { .. }) => {}
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                return Err(AppError::Other("talk shell channel closed during init".into()));
            }
        }
    }
    Err(AppError::Other("talk shell did not become ready".into()))
}

fn ansi_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(
            r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()#][0-9A-Za-z]|\x1b[=>]|[\x00\x07]",
        )
        .unwrap()
    })
}

/// Strip ANSI escapes, normalize PTY CRLFs, and trim — for the captured result.
fn clean_output(s: &str) -> String {
    let no_ansi = ansi_re().replace_all(s, "");
    no_ansi.replace("\r\n", "\n").replace('\r', "").trim().to_string()
}

/// Light cleanup for live chunks: keep ANSI (xterm renders it) but drop the bare
/// RS bytes our marker uses, so a stray RS never reaches xterm.
fn clean_inline(s: &str) -> String {
    s.replace('\u{1e}', "")
}

fn octo_marker_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r"\x1e+|OCTO_DONE_[0-9a-f]*(?::-?\d*:?[^\n\x1e]*)?").unwrap()
    })
}

/// Remove leftover prompt-marker noise (RS bytes / a partial marker word) — used
/// on best-effort partial output where a marker may be unterminated.
fn strip_octo_markers(s: &str) -> String {
    octo_marker_re().replace_all(s, "").trim().to_string()
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

    const RS: char = '\u{1e}';
    const N: &str = "abc123";

    /// One command's captured stream: output then the prompt marker.
    fn stream_buf(output: &str, code: i32, cwd: &str) -> String {
        format!("{output}{RS}{RS}OCTO_DONE_{N}:{code}:{cwd}{RS}{RS}\n")
    }

    fn first_done(buf: &str) -> (String, i32, String) {
        let mut f = StreamFilter::new(N);
        let (emit, done) = f.feed(buf);
        let (code, cwd) = done.expect("marker present");
        (emit, code, cwd)
    }

    #[test]
    fn filter_parses_output_exit_and_cwd() {
        let (out, code, cwd) = first_done(&stream_buf("hello world\r\n", 0, "/repo/src"));
        assert!(out.contains("hello world"));
        assert_eq!((code, cwd.as_str()), (0, "/repo/src"));
    }

    #[test]
    fn filter_handles_nonzero_exit_and_keeps_ansi() {
        let (out, code, _cwd) = first_done(&stream_buf("\x1b[31mboom\x1b[0m\r\n", 1, "/tmp"));
        assert!(out.contains("\x1b[31mboom"), "ANSI kept for xterm: {out:?}");
        assert_eq!(code, 1);
    }

    #[test]
    fn filter_cwd_with_colon_survives() {
        let (_o, code, cwd) = first_done(&stream_buf("ok", 130, "/weird:path"));
        assert_eq!((code, cwd.as_str()), (130, "/weird:path"));
    }

    #[test]
    fn filter_emits_progressively_then_reports_exit() {
        let mut f = StreamFilter::new(N);
        let (e1, d1) = f.feed(&"x".repeat(200));
        assert!(d1.is_none());
        assert_eq!(e1.len(), 200, "non-marker output emitted immediately");
        let (e2, d2) = f.feed(&format!("tail{RS}{RS}OCTO_DONE_{N}:0:/srv{RS}{RS}\n"));
        assert_eq!(d2.expect("done").0, 0);
        assert!(e2.contains("tail") && !e2.contains("OCTO_DONE"));
    }

    #[test]
    fn filter_handles_marker_split_across_chunks() {
        let mut f = StreamFilter::new(N);
        let marker = format!("{RS}{RS}OCTO_DONE_{N}:7:/p{RS}{RS}\n");
        let (a, b) = marker.split_at(marker.len() / 2);
        let (_e1, d1) = f.feed(&format!("output\n{a}"));
        assert!(d1.is_none(), "half a marker must not terminate");
        let (e2, d2) = f.feed(b);
        assert_eq!(d2.expect("reassembled").0, 7);
        assert!(!e2.contains("OCTO_DONE"));
    }

    #[test]
    fn probe_done_parses_via_done_re() {
        // parse the same way probe() does, on a synthetic completed buffer.
        let buf = stream_buf("result line\r\n", 0, "/x");
        let caps = done_re(N).captures(&buf).unwrap();
        let out = clean_output(&buf[..caps.get(0).unwrap().start()]);
        assert_eq!(out, "result line");
        assert_eq!(&caps[1], "0");
        assert_eq!(&caps[2], "/x");
    }

    #[test]
    fn strip_octo_markers_removes_partial_marker() {
        let s = format!("partial output{RS}{RS}OCTO_DONE_{N}:0:");
        let cleaned = strip_octo_markers(&s);
        assert_eq!(cleaned, "partial output");
    }

    #[test]
    fn cap_output_truncates_on_char_boundary() {
        let capped = cap_output("é".repeat(40_000));
        assert!(capped.len() <= MAX_OUTPUT_BYTES + 64);
        assert!(capped.contains("truncated"));
    }

    #[test]
    fn nonces_are_unique() {
        assert_ne!(gen_nonce(), gen_nonce());
    }
}

#[cfg(all(test, unix))]
mod e2e {
    use super::*;
    use serial_test::serial;
    use std::fs;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use std::sync::{Arc, Mutex as StdMutex};
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

    fn shell_on(sock: &PathBuf) -> TalkShell {
        let client = DaemonClient::connect_to(sock.to_str().unwrap()).unwrap();
        let shell = TalkShell::new();
        shell.set_client(Some(client));
        shell
    }

    fn done(o: RunOutcome) -> ShellResult {
        match o {
            RunOutcome::Done(r) => r,
            RunOutcome::Live(_) => panic!("expected Done, got Live"),
            RunOutcome::Busy => panic!("expected Done, got Busy"),
        }
    }

    fn cap(o: CaptureOutcome) -> ShellResult {
        match o {
            CaptureOutcome::Done(r) => r,
            CaptureOutcome::Busy => panic!("expected Done, got Busy"),
        }
    }

    struct Daemon {
        _tmp: TempDir,
        child: std::process::Child,
        sock: PathBuf,
    }
    fn boot() -> Daemon {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path().join(".octopush");
        fs::create_dir_all(&base).unwrap();
        let sock = base.join("pty-server.sock");
        let child = start_daemon(tmp.path());
        assert!(wait_for_socket(&sock), "daemon socket did not appear");
        Daemon { _tmp: tmp, child, sock }
    }
    impl Drop for Daemon {
        fn drop(&mut self) {
            self.child.kill().ok();
        }
    }

    #[test]
    #[serial]
    fn quick_capture_persists_cwd_and_promotes_long_commands() {
        let d = boot();
        let shell = shell_on(&d.sock);
        let quick = Duration::from_secs(5);

        let r = done(shell.run("t", "/tmp", "echo hello world", quick, true).unwrap());
        assert_eq!(r.output, "hello world");
        assert!(r.ok);
        assert_eq!(r.exit_code, 0);

        let r = done(shell.run("t", "/tmp", "false", quick, true).unwrap());
        assert_eq!(r.exit_code, 1);
        assert!(!r.ok);

        done(shell.run("t", "/tmp", "cd /tmp", quick, true).unwrap());
        let r = done(shell.run("t", "/tmp", "pwd", quick, true).unwrap());
        assert!(r.output.ends_with("tmp"), "cwd not inherited: {:?}", r.output);

        // A long command promotes; streaming it yields all output + a clean exit.
        let live = match shell
            .run("t", "/tmp", "echo live-start; sleep 1; echo live-done", Duration::from_millis(300), true)
            .unwrap()
        {
            RunOutcome::Live(l) => l,
            _ => panic!("expected promotion to Live"),
        };
        assert!(matches!(shell.run("t", "/tmp", "echo x", quick, true).unwrap(), RunOutcome::Busy));
        let chunks = Arc::new(StdMutex::new(String::new()));
        let c2 = Arc::clone(&chunks);
        let exit = live.stream(move |s| c2.lock().unwrap().push_str(s));
        let streamed = chunks.lock().unwrap().clone();
        assert!(streamed.contains("live-start") && streamed.contains("live-done"), "{streamed:?}");
        assert!(!streamed.contains("OCTO_DONE"), "marker leaked: {streamed:?}");
        assert_eq!(exit.exit_code, 0);

        let r = done(shell.run("t", "/tmp", "echo back", quick, true).unwrap());
        assert_eq!(r.output, "back");

        shell.close("t");
    }

    #[test]
    #[serial]
    fn reattaches_to_surviving_shell_across_restart() {
        let d = boot();
        let quick = Duration::from_secs(5);
        {
            let shell = shell_on(&d.sock);
            done(shell.run("persist", "/", "cd /tmp && export OCTO_T3=kept", quick, true).unwrap());
            let r = done(shell.run("persist", "/", "pwd", quick, true).unwrap());
            assert!(r.output.ends_with("tmp"));
            // `shell` drops here — simulating an Octopush restart.
        }
        {
            let shell = shell_on(&d.sock);
            let r = done(shell.run("persist", "/", "pwd", quick, true).unwrap());
            assert!(r.output.ends_with("tmp"), "cwd not restored: {:?}", r.output);
            let r = done(shell.run("persist", "/", "echo \"$OCTO_T3\"", quick, true).unwrap());
            assert_eq!(r.output, "kept", "env var not restored on reattach");
            shell.close("persist");
        }
    }

    #[test]
    #[serial]
    fn agent_capture_shares_cwd_and_env_with_direct_shell() {
        let d = boot();
        let shell = shell_on(&d.sock);
        let quick = Duration::from_secs(5);

        done(shell.run("u", "/", "cd /tmp && export OCTO_T4=shared", quick, true).unwrap());
        let r = cap(shell.run_capture("u", "/", "pwd", quick).unwrap());
        assert!(r.output.ends_with("tmp"), "agent didn't share cwd: {:?}", r.output);
        let r = cap(shell.run_capture("u", "/", "echo \"$OCTO_T4\"", quick).unwrap());
        assert_eq!(r.output, "shared", "agent didn't share env");

        // A hanging agent command is interrupted — env survives (no recycle).
        let r = cap(shell.run_capture("u", "/", "sleep 30", Duration::from_secs(1)).unwrap());
        assert!(!r.ok && r.output.contains("was interrupted"), "{:?}", r.output);
        let r = cap(shell.run_capture("u", "/", "echo \"$OCTO_T4\"", quick).unwrap());
        assert_eq!(r.output, "shared", "env lost after a timeout interrupt");

        shell.close("u");
    }

    #[test]
    #[serial]
    fn live_process_accepts_interactive_stdin() {
        let d = boot();
        let shell = shell_on(&d.sock);

        // `cat` reads stdin and echoes it; it blocks → promotes to a live process.
        let live = match shell
            .run("i", "/tmp", "cat", Duration::from_millis(400), true)
            .unwrap()
        {
            RunOutcome::Live(l) => l,
            _ => panic!("expected cat to promote to a live process"),
        };

        let chunks = Arc::new(StdMutex::new(String::new()));
        let exit = std::thread::scope(|s| {
            s.spawn(|| {
                std::thread::sleep(Duration::from_millis(300));
                shell.write_stdin("i", b"hello from stdin\n");
                std::thread::sleep(Duration::from_millis(300));
                shell.write_stdin("i", b"\x04"); // Ctrl-D → cat exits → bash prompts
            });
            let c2 = Arc::clone(&chunks);
            live.stream(move |x| c2.lock().unwrap().push_str(x))
        });

        let streamed = chunks.lock().unwrap().clone();
        assert!(
            streamed.contains("hello from stdin"),
            "interactive stdin not echoed by the live process: {streamed:?}"
        );
        assert!(!streamed.contains("OCTO_DONE"), "marker leaked: {streamed:?}");
        // The prompt marker fired even though cat is interactive — the panel
        // closes cleanly and the shell is reusable.
        let _ = exit;
        let r = cap(shell.run_capture("i", "/tmp", "echo done", Duration::from_secs(5)).unwrap());
        assert_eq!(r.output, "done");

        shell.close("i");
    }

    #[test]
    #[serial]
    fn live_process_stop_via_interrupt_ends_cleanly() {
        let d = boot();
        let shell = shell_on(&d.sock);

        // A non-stdin long process (sleep); Stop (Ctrl-C) must end the stream —
        // the prompt marker fires after the kill (the old trailer would've been
        // flushed by SIGINT and hung).
        let live = match shell
            .run("s", "/tmp", "sleep 60", Duration::from_millis(300), true)
            .unwrap()
        {
            RunOutcome::Live(l) => l,
            _ => panic!("expected sleep to promote"),
        };
        let collected = Arc::new(StdMutex::new(String::new()));
        let exit = std::thread::scope(|s| {
            s.spawn(|| {
                std::thread::sleep(Duration::from_millis(300));
                shell.interrupt("s"); // Stop button
            });
            let c2 = Arc::clone(&collected);
            live.stream(move |x| c2.lock().unwrap().push_str(x))
        });
        // 130 = 128 + SIGINT(2).
        assert_eq!(exit.exit_code, 130, "Stop didn't end the stream cleanly");

        // Shell is immediately reusable after Stop (env/cwd intact, no recycle).
        let r = cap(shell.run_capture("s", "/tmp", "echo after-stop", Duration::from_secs(5)).unwrap());
        assert_eq!(r.output, "after-stop");

        shell.close("s");
    }
}
