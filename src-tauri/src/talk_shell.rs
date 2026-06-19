//! TALK shell — a persistent bash PTY per chat thread for `$`-direct execution.
//!
//! Reuses the `octopush-pty-server` daemon (the same PTY infra that backs RUN
//! mode), but in a *capture* access pattern instead of interactive streaming:
//! the backend is the sole attached client, writes a marker-wrapped command,
//! and drains the event stream until the end marker to recover clean stdout +
//! exit code + cwd. Echo is disabled and the prompt blanked so the captured
//! span is exactly the command's own output.
//!
//! A command that doesn't finish within a short *promotion* window is handed
//! off as a **live process**: the receiver is moved out of the session and the
//! caller streams raw output (for an xterm panel) until the command exits. The
//! thread's shell is "busy" (its receiver is gone) until then — a new `$` run
//! returns [`RunOutcome::Busy`] rather than interleaving into the same PTY.
//!
//! One shell per thread keeps cwd/env across commands (the unified-shell model).
//! Each session has its own lock, so a long command in one thread never blocks
//! another thread's shell.

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

/// Bytes held back at the tail of a live stream chunk so a marker split across
/// two chunks is still recognized (longer than any whole marker).
const MARKER_TAIL_HOLD: usize = 96;

/// Outcome of running one command in a TALK shell.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellResult {
    pub output: String,
    pub exit_code: i32,
    pub ok: bool,
    pub cwd: String,
    /// True when the command was promoted to a live process — output streams via
    /// `chat://shell-output` and the final card resolves on `chat://shell-exit`.
    #[serde(default)]
    pub live: bool,
}

/// What `run` decided about a command.
pub enum RunOutcome {
    /// Finished within the promotion window — a normal quick command.
    Done(ShellResult),
    /// Still running after the window — promoted to a live process. The caller
    /// owns the receiver and streams until exit (see [`LiveRun`]).
    Live(LiveRun),
    /// A live process is already occupying this thread's shell.
    Busy,
}

/// Hand-off for a promoted long-running command. The caller drives
/// [`LiveRun::stream`] to pump output to a sink until the command exits, then
/// the session is restored for the next `$` command.
pub struct LiveRun {
    rx: Receiver<TermEvent>,
    /// Raw output already seen during the promotion window (after the start
    /// marker), to paint immediately.
    pub initial: String,
    nonce: String,
    cwd: String,
    thread_id: String,
    handle: Arc<Mutex<Session>>,
    client: Arc<DaemonClient>,
}

/// Terminal state of a streamed live process.
#[derive(Debug, Clone)]
pub struct LiveExit {
    pub exit_code: i32,
    pub cwd: String,
    /// The full captured output (capped), for the resolved tool card / context.
    pub full_output: String,
}

/// A live bash PTY bound to one chat thread.
struct Session {
    /// Daemon terminal id (`talk-<threadId>`).
    id: String,
    /// The sole capture subscriber. `None` while a live process owns it.
    rx: Option<Receiver<TermEvent>>,
    /// Last known working directory (for the cwd badge / recycle).
    cwd: String,
    /// Per-session random token mixed into the capture markers, so a command
    /// that prints marker-like bytes in its own output can't be mistaken for
    /// the real terminator (it lives only in the marker emitter definitions).
    nonce: String,
}

pub struct TalkShell {
    client: Mutex<Option<Arc<DaemonClient>>>,
    /// Per-thread session handles. The outer lock is held only briefly to look
    /// up / insert a handle; the inner per-session lock guards a run, so threads
    /// never block each other.
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

    /// Run a command in the thread's shell. Captures normally; if it hasn't
    /// finished within `promote_after`, returns [`RunOutcome::Live`] so the
    /// caller can stream the rest. `overall_timeout` bounds the quick path's
    /// wait before promotion is forced.
    pub fn run(
        &self,
        thread_id: &str,
        workspace_path: &str,
        command: &str,
        promote_after: Duration,
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
                let session = Self::spawn_session(&client, thread_id, workspace_path)?;
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

        let payload = format!("__octo_start\n{command}\n__octo_end \"$?\"\n");
        if let Err(e) = client.write(&id, payload.as_bytes()) {
            // Return the receiver before surfacing the error.
            handle.lock().rx = Some(rx);
            return Err(e);
        }

        match probe(&rx, promote_after, &nonce) {
            Probe::Done {
                output,
                exit_code,
                cwd: new_cwd,
            } => {
                let final_cwd = if new_cwd.is_empty() { cwd } else { new_cwd };
                let mut session = handle.lock();
                session.rx = Some(rx);
                session.cwd = final_cwd.clone();
                Ok(RunOutcome::Done(ShellResult {
                    output: cap_output(output),
                    exit_code,
                    ok: exit_code == 0,
                    cwd: final_cwd,
                    live: false,
                }))
            }
            Probe::Dead { output } => {
                // Shell died — recycle in place at the saved cwd.
                let _ = client.remove(&id);
                let mut session = handle.lock();
                if let Ok(fresh) = Self::spawn_session(&client, thread_id, &cwd) {
                    *session = fresh;
                }
                Ok(RunOutcome::Done(ShellResult {
                    output: cap_output(output),
                    exit_code: -1,
                    ok: false,
                    cwd,
                    live: false,
                }))
            }
            Probe::NotYet { raw } => Ok(RunOutcome::Live(LiveRun {
                rx,
                // RAW (markers/ANSI intact): the stream filter both detects a
                // marker split across the promotion boundary and emits it.
                initial: raw,
                nonce,
                cwd,
                thread_id: thread_id.to_string(),
                handle,
                client,
            })),
        }
    }

    /// Send SIGINT (Ctrl-C) to a thread's live process. The streamer then sees
    /// the command exit (its `__octo_end` marker runs) and finishes cleanly.
    pub fn interrupt(&self, thread_id: &str) {
        if let Some(client) = self.client.lock().clone() {
            let _ = client.write(&format!("talk-{thread_id}"), b"\x03");
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

    fn spawn_session(
        client: &Arc<DaemonClient>,
        thread_id: &str,
        cwd: &str,
    ) -> AppResult<Session> {
        let id = format!("talk-{thread_id}");
        let nonce = gen_nonce();
        let mut env = HashMap::new();
        if let Ok(path) = std::env::var("PATH") {
            env.insert("PATH".to_string(), path);
        }
        client.spawn(&id, cwd, &env, Some("/bin/bash"), 40, 120)?;
        let rx = client.attach(&id, 0)?;

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
                            rx: Some(rx),
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
        let _ = client.remove(&id);
        Err(AppError::Other("talk shell did not become ready".into()))
    }
}

impl LiveRun {
    /// Pump live output to `on_chunk` (raw bytes for an xterm panel, markers
    /// stripped) until the command exits, then restore the session for the next
    /// `$` command and return the exit info. Blocking — run on a worker thread.
    pub fn stream<F: FnMut(&str)>(self, mut on_chunk: F) -> LiveExit {
        let mut filter = StreamFilter::new(&self.nonce);
        // The promotion probe already consumed the start marker; the output seen
        // during that window rides in `initial` (RAW). We feed it through the
        // filter (so an end marker that began arriving in the window is detected
        // — never leaving the panel stuck "running") and emit it as the FIRST
        // chunk, so the always-on store listener buffers it with no mount race.
        filter.started = true;
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
                    // Shell process itself ended — flush whatever's held back.
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
                Ok(TermEvent::Attention) | Err(RecvTimeoutError::Timeout) => {}
            }
        }

        self.finish(exit, full)
    }

    fn finish(self, mut exit: LiveExit, full: String) -> LiveExit {
        exit.full_output = cap_output(clean_output(&full));
        // Restore the session so the next `$` command can run.
        let mut session = self.handle.lock();
        session.rx = Some(self.rx);
        if !exit.cwd.is_empty() {
            session.cwd = exit.cwd.clone();
        } else {
            exit.cwd = session.cwd.clone();
        }
        drop(session);
        let _ = &self.client; // retained for symmetry / future kill paths
        let _ = &self.thread_id;
        exit
    }
}

impl Default for TalkShell {
    fn default() -> Self {
        Self::new()
    }
}

// ─── Capture (pure, unit-tested) ──────────────────────────────────────

enum Probe {
    Done {
        output: String,
        exit_code: i32,
        cwd: String,
    },
    /// Promotion window elapsed; `raw` is the post-start output seen so far.
    NotYet {
        raw: String,
    },
    Dead {
        output: String,
    },
}

/// Drain the receiver until the end marker is seen or `timeout` elapses,
/// accumulating raw output (kept verbatim so a promoted stream can render ANSI).
fn probe(rx: &Receiver<TermEvent>, timeout: Duration, nonce: &str) -> Probe {
    let deadline = Instant::now() + timeout;
    let mut buf = String::new();
    loop {
        if Instant::now() >= deadline {
            return Probe::NotYet {
                raw: after_start(&buf, nonce),
            };
        }
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(TermEvent::Data { bytes, .. }) => {
                buf.push_str(&String::from_utf8_lossy(&bytes));
                if let Some((output, exit_code, cwd)) = parse_capture(&buf, nonce) {
                    return Probe::Done {
                        output,
                        exit_code,
                        cwd,
                    };
                }
            }
            Ok(TermEvent::Exit { .. }) | Ok(TermEvent::Error { .. }) => {
                return Probe::Dead {
                    output: extract_partial(&buf, nonce),
                };
            }
            Ok(TermEvent::Attention) => {}
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                return Probe::Dead {
                    output: extract_partial(&buf, nonce),
                };
            }
        }
    }
}

/// Progressive marker filter for the live-stream path: strips the start marker
/// once, emits output as it arrives (holding back a tail that could be a split
/// end marker), and reports exit code + cwd when the end marker is seen.
struct StreamFilter {
    start_marker: String,
    end_re: regex::Regex,
    carry: String,
    started: bool,
}

impl StreamFilter {
    fn new(nonce: &str) -> Self {
        Self {
            start_marker: start_marker(nonce),
            end_re: end_re(nonce),
            carry: String::new(),
            started: false,
        }
    }

    /// Feed a raw chunk; returns (bytes safe to emit, Some(exit,cwd) if ended).
    fn feed(&mut self, chunk: &str) -> (String, Option<(i32, String)>) {
        self.carry.push_str(chunk);

        if !self.started {
            if let Some(i) = self.carry.find(&self.start_marker) {
                self.carry = self.carry[i + self.start_marker.len()..].to_string();
                self.started = true;
            } else {
                // Hold until the start marker arrives (cap unbounded growth).
                if self.carry.len() > MARKER_TAIL_HOLD {
                    let keep = self.carry.len() - MARKER_TAIL_HOLD;
                    let mut s = keep;
                    while s > 0 && !self.carry.is_char_boundary(s) {
                        s -= 1;
                    }
                    self.carry = self.carry[s..].to_string();
                }
                return (String::new(), None);
            }
        }

        if let Some(caps) = self.end_re.captures(&self.carry) {
            let whole = caps.get(0).unwrap();
            let emit = clean_inline(&self.carry[..whole.start()]);
            let code = caps[1].parse().unwrap_or(-1);
            let cwd = caps[2].to_string();
            self.carry.clear();
            return (emit, Some((code, cwd)));
        }

        // Emit eagerly. The end marker begins with a record-separator byte
        // (0x1e), which never occurs in normal command output — so hold back
        // only from the first such byte (a partial end marker forming); emit
        // everything before it immediately so live output isn't buffered.
        match self.carry.find('\u{1e}') {
            Some(i) => {
                let emit = self.carry[..i].to_string();
                self.carry = self.carry[i..].to_string();
                (emit, None)
            }
            None => {
                let emit = std::mem::take(&mut self.carry);
                (emit, None)
            }
        }
    }

    /// Emit any held-back tail (shell died without an end marker).
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

/// Everything after the start marker (raw, verbatim) — for the live stream's
/// initial paint.
fn after_start(buf: &str, nonce: &str) -> String {
    let sm = start_marker(nonce);
    match buf.find(&sm) {
        Some(i) => buf[i + sm.len()..].to_string(),
        None => String::new(),
    }
}

/// Best-effort output recovery when no end marker arrived (timeout / shell
/// death): everything after the start marker, cleaned.
fn extract_partial(buf: &str, nonce: &str) -> String {
    clean_output(&after_start(buf, nonce))
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

/// Strip ANSI escapes, normalize PTY CRLFs, and trim surrounding whitespace.
/// Used for the captured (non-live) result + the final full-output snapshot.
fn clean_output(s: &str) -> String {
    let no_ansi = ansi_re().replace_all(s, "");
    no_ansi.replace("\r\n", "\n").replace('\r', "").trim().to_string()
}

/// Lighter cleanup for live chunks: keep ANSI (xterm renders it) but drop the
/// bare control bytes our markers use, so stray RS bytes never reach xterm.
fn clean_inline(s: &str) -> String {
    s.replace('\u{1e}', "")
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

    fn buf(output: &str, code: i32, cwd: &str) -> String {
        format!("{RS}{RS}OCTO_START_{N}{RS}{RS}\n{output}\n{RS}{RS}OCTO_END_{N}:{code}:{cwd}{RS}{RS}\n")
    }

    #[test]
    fn parses_clean_capture() {
        let (out, code, cwd) = parse_capture(&buf("hello world", 0, "/repo/src"), N).unwrap();
        assert_eq!((out.as_str(), code, cwd.as_str()), ("hello world", 0, "/repo/src"));
    }

    #[test]
    fn parses_nonzero_exit_and_strips_ansi() {
        let (out, code, cwd) = parse_capture(&buf("\x1b[31mError:\x1b[0m boom\r\n", 1, "/tmp"), N).unwrap();
        assert_eq!((out.as_str(), code, cwd.as_str()), ("Error: boom", 1, "/tmp"));
    }

    #[test]
    fn none_until_end_marker_present() {
        let partial = format!("{RS}{RS}OCTO_START_{N}{RS}{RS}\npartial output not done");
        assert!(parse_capture(&partial, N).is_none());
    }

    #[test]
    fn ignores_echoed_prefix_before_start() {
        let b = format!("$ \x1b[1mwhoami\x1b[0m\r\n{}", buf("johnatan", 0, "/home"));
        let (out, _c, _w) = parse_capture(&b, N).unwrap();
        assert_eq!(out, "johnatan");
    }

    #[test]
    fn cwd_with_colon_survives() {
        let (_o, code, cwd) = parse_capture(&buf("ok", 130, "/weird:path"), N).unwrap();
        assert_eq!((code, cwd.as_str()), (130, "/weird:path"));
    }

    #[test]
    fn command_output_containing_a_foreign_marker_is_not_a_terminator() {
        let foreign = format!("{RS}{RS}OCTO_END_deadbeef:0:/x{RS}{RS}");
        let (out, code, _w) = parse_capture(&buf(&format!("see {foreign} text"), 0, "/repo"), N).unwrap();
        assert!(out.contains("OCTO_END_deadbeef"));
        assert_eq!(code, 0);
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

    // ── StreamFilter (live path) ──────────────────────────────────────

    #[test]
    fn stream_filter_emits_progressively_and_reports_exit() {
        let mut f = StreamFilter::new(N);
        f.started = true; // promotion already consumed the start marker
        // A big chunk of output, then the end marker in a later chunk.
        let big = "x".repeat(200);
        let (e1, d1) = f.feed(&big);
        assert!(d1.is_none());
        assert!(!e1.is_empty(), "should emit most of the buffered output");
        let (e2, d2) = f.feed(&format!("tail\n{RS}{RS}OCTO_END_{N}:0:/srv{RS}{RS}\n"));
        let (code, cwd) = d2.expect("end marker recognized");
        assert_eq!((code, cwd.as_str()), (0, "/srv"));
        let total = format!("{e1}{e2}");
        assert!(total.contains("tail"));
        assert!(!total.contains("OCTO_END"), "marker must not leak to xterm: {total:?}");
    }

    #[test]
    fn stream_filter_handles_marker_split_across_chunks() {
        let mut f = StreamFilter::new(N);
        f.started = true;
        let marker = format!("{RS}{RS}OCTO_END_{N}:7:/p{RS}{RS}\n");
        let (a, b) = marker.split_at(marker.len() / 2);
        let (_e1, d1) = f.feed(&format!("output\n{a}"));
        assert!(d1.is_none(), "half a marker must not terminate");
        let (e2, d2) = f.feed(b);
        let (code, _cwd) = d2.expect("reassembled marker recognized");
        assert_eq!(code, 7);
        assert!(!e2.contains("OCTO_END"));
    }

    #[test]
    fn stream_filter_strips_leading_start_marker() {
        let mut f = StreamFilter::new(N); // not started
        let (emit, done) = f.feed(&format!("{RS}{RS}OCTO_START_{N}{RS}{RS}\nhello\n"));
        assert!(done.is_none());
        assert!(emit.contains("hello"));
        assert!(!emit.contains("OCTO_START"));
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

    fn done(o: RunOutcome) -> ShellResult {
        match o {
            RunOutcome::Done(r) => r,
            RunOutcome::Live(_) => panic!("expected Done, got Live"),
            RunOutcome::Busy => panic!("expected Done, got Busy"),
        }
    }

    #[test]
    #[serial]
    fn quick_capture_persists_cwd_and_promotes_long_commands() {
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
        let quick = Duration::from_secs(5);

        // Quick command captured cleanly.
        let r = done(shell.run("t", "/tmp", "echo hello world", quick).unwrap());
        assert_eq!(r.output, "hello world");
        assert!(r.ok);

        // cwd persists.
        done(shell.run("t", "/tmp", "cd /tmp", quick).unwrap());
        let r = done(shell.run("t", "/tmp", "pwd", quick).unwrap());
        assert!(r.output.ends_with("tmp"), "cwd not inherited: {:?}", r.output);

        // A long command promotes; stream it and assert the live output + exit.
        let r = shell
            .run("t", "/tmp", "echo live-start; sleep 1; echo live-done", Duration::from_millis(300))
            .unwrap();
        let live = match r {
            RunOutcome::Live(l) => l,
            _ => panic!("expected promotion to Live"),
        };
        // While live, the shell is busy.
        assert!(matches!(shell.run("t", "/tmp", "echo x", quick).unwrap(), RunOutcome::Busy));

        // The stream emits ALL output — including what was seen during the
        // promotion window (fed through the filter, then emitted as the first
        // chunk so the store buffers it race-free).
        let chunks = Arc::new(StdMutex::new(String::new()));
        let c2 = Arc::clone(&chunks);
        let exit = live.stream(move |s| c2.lock().unwrap().push_str(s));
        let streamed = chunks.lock().unwrap().clone();
        assert!(streamed.contains("live-start"), "missing early output: {streamed:?}");
        assert!(streamed.contains("live-done"), "missing later output: {streamed:?}");
        assert!(!streamed.contains("OCTO_"), "marker leaked into stream: {streamed:?}");
        assert_eq!(exit.exit_code, 0);
        assert!(exit.full_output.contains("live-start") && exit.full_output.contains("live-done"));

        // After the live process ends the shell is usable again.
        let r = done(shell.run("t", "/tmp", "echo back", quick).unwrap());
        assert_eq!(r.output, "back");

        shell.close("t");
        daemon.kill().ok();
    }
}
