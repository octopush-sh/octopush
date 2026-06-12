//! Per-PTY session state: ring buffer, log file, seq counter, attached client.

use crate::protocol::Event;
use crate::storage::{append_pty_log, open_pty_log};
use base64::Engine as _;
use portable_pty::{Child, MasterPty, PtySize};
use std::collections::VecDeque;
use std::fs::File;
use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tracing::{debug, warn};

/// Capacity of the in-memory ring buffer (64 KiB).
pub const RING_CAP: usize = 64 * 1024;

/// Unique identifier for a terminal.
pub type TerminalId = String;

/// Newtype wrapping a send handle to a client's write loop.
/// Sending `None` signals the client to close.
pub type ClientSender = mpsc::UnboundedSender<Vec<u8>>;

/// Shared state for a single PTY session, protected by a `Mutex` in
/// `ServerState`.
pub struct Session {
    pub id: TerminalId,
    pub label: String,
    pub cwd: String,
    pub started_at: i64,
    pub running: bool,
    pub pid: Option<u32>,

    /// Monotonically increasing sequence number for each chunk.
    seq: Arc<AtomicU64>,

    /// Ring buffer: (seq, bytes). Oldest items are popped from the front when
    /// RING_CAP is exceeded.
    ring: VecDeque<(u64, Vec<u8>)>,
    ring_bytes: usize,

    /// Disk log file handle (append mode).
    log_file: Option<File>,

    /// Optional attached client channel; at most one at a time.
    attached: Option<ClientSender>,

    // ── Attention-detection state ─────────────────────────────────
    // Implementation note: previous releases tried to detect "the
    // inner program is waiting on input" purely from the byte
    // stream (idle timer + byte threshold + content patterns + alt-
    // screen). Every variant had false positives or misses on
    // INK-based TUIs like Claude Code. Switching to kernel signals:
    //
    //   - `tcgetpgrp(master_fd)` (exposed via portable_pty's
    //     `process_group_leader()`) tells us which process group
    //     currently owns the PTY. When it transitions away from a
    //     child and back to the shell, the child just exited:
    //     `Event::Attention` for "command finished".
    //
    //   - `proc_pidinfo(PROC_PIDTASKINFO)` gives us the foreground
    //     process's total CPU nanoseconds. Two consecutive samples
    //     1s apart whose delta is <1% of elapsed wall time mean the
    //     process is parked (blocked on `read()`). When the fg
    //     process is parked AND the byte stream has been quiet
    //     AND there was substantial recent output, fire
    //     `Event::Attention` for "TUI waiting on input".
    /// Wall-clock time of the most recent `push_output`.
    last_data_at: Instant,
    /// Bytes written since the last Attention event was emitted (or
    /// since session start). Used to filter out empty-shell-prompt
    /// false positives — small bursts under MIN_BYTES_FOR_ATTENTION
    /// never fire.
    bytes_since_attention: u64,
    /// Latched so we don't re-emit Attention for the same idle
    /// window. Cleared on the next chunk of output.
    attention_pending: bool,
    /// PID of the *shell* process spawned at session start. We
    /// compare the PTY's current foreground pgroup against this to
    /// classify "child is running" vs "shell is at prompt".
    pub shell_pid: Option<i32>,
    /// Previous foreground pgroup observed by `check_attention`.
    /// `None` until the first tick.
    last_fg_pgroup: Option<i32>,
    /// Last CPU sample: (when, total ns). The next tick computes
    /// (delta_ns, elapsed_ns) and decides whether the process is
    /// idle this tick.
    last_cpu_sample: Option<(Instant, u64)>,
    /// Number of consecutive ticks the foreground process has been
    /// observed at <1% CPU. We require two in a row before firing
    /// to filter out single quiet-tick blips.
    consecutive_idle_ticks: u8,
}

/// Output-quiet window before considering the byte stream "calm"
/// enough to even consider a notification. Short — kernel signals
/// do most of the discriminating now.
pub const OUTPUT_QUIET_MS: u64 = 2_000;

/// Minimum bytes since the last attention emit. Filters out a
/// freshly-spawned shell whose only output is the prompt itself.
pub const MIN_BYTES_FOR_ATTENTION: u64 = 200;

impl Session {
    pub fn new(id: TerminalId, label: String, cwd: String, started_at: i64) -> Self {
        let log_file = match open_pty_log(&id) {
            Ok(f) => Some(f),
            Err(e) => {
                warn!(id = %id, error = %e, "failed to open pty log file");
                None
            }
        };
        Self {
            id,
            label,
            cwd,
            started_at,
            running: true,
            pid: None,
            seq: Arc::new(AtomicU64::new(0)),
            ring: VecDeque::new(),
            ring_bytes: 0,
            log_file,
            attached: None,
            last_data_at: Instant::now(),
            bytes_since_attention: 0,
            attention_pending: false,
            shell_pid: None,
            last_fg_pgroup: None,
            last_cpu_sample: None,
            consecutive_idle_ticks: 0,
        }
    }

    /// Record a chunk of output from the PTY reader thread.
    ///
    /// 1. Assigns the next seq number.
    /// 2. Stores in ring buffer (evicting oldest if over RING_CAP).
    /// 3. Appends to disk log.
    /// 4. Forwards to attached client (if any).
    pub fn push_output(&mut self, data: &[u8]) {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed);

        // ---- attention-detection state ----
        self.last_data_at = Instant::now();
        self.bytes_since_attention = self.bytes_since_attention.saturating_add(data.len() as u64);
        // New output → reset the latch so the next idle window can
        // re-fire if conditions remain met.
        self.attention_pending = false;

        // ---- ring buffer ----
        self.ring.push_back((seq, data.to_vec()));
        self.ring_bytes += data.len();
        while self.ring_bytes > RING_CAP {
            if let Some((_, old)) = self.ring.pop_front() {
                self.ring_bytes = self.ring_bytes.saturating_sub(old.len());
            } else {
                break;
            }
        }

        // ---- disk log ----
        if let Some(ref mut f) = self.log_file {
            if let Err(e) = append_pty_log(f, data) {
                warn!(id = %self.id, error = %e, "pty log write failed");
            }
        }

        // ---- attached client ----
        if let Some(ref tx) = self.attached {
            let event = Event::Data {
                id: self.id.clone(),
                seq,
                bytes: base64::engine::general_purpose::STANDARD.encode(data),
            };
            let line = event.to_line();
            if tx.send(line).is_err() {
                debug!(id = %self.id, "attached client disconnected during push");
                self.attached = None;
            }
        }
    }

    /// Mark the PTY as exited and notify attached client.
    ///
    /// Deliberately does NOT close the disk log: `cmd_kill` calls this right
    /// after signalling, while the shell may still be flushing output that
    /// must reach the log. The reader thread closes the log via
    /// [`Self::close_log`] once the PTY actually EOFs.
    pub fn mark_exit(&mut self, code: Option<i32>) {
        self.running = false;
        if let Some(ref tx) = self.attached {
            let event = Event::Exit {
                id: self.id.clone(),
                code,
            };
            let _ = tx.send(event.to_line());
        }
        self.attached = None;
    }

    /// Close the disk-log handle. An exited session only serves scrollback
    /// replays, which read the log from disk by path — keeping the fd open
    /// would leak it for the daemon's lifetime (sessions outlive their shells
    /// so reattach keeps working across app restarts).
    pub fn close_log(&mut self) {
        self.log_file = None;
    }

    /// Attach a client.  Returns the backlog of (seq, bytes) tuples with
    /// seq >= since_seq so the caller can replay them.
    pub fn attach(&mut self, client: ClientSender, since_seq: u64) -> Vec<(u64, Vec<u8>)> {
        // Drop previous attachment if any (send nothing; the old client's TCP
        // loop will get an error on next read and close gracefully).
        self.attached = Some(client);

        // Collect backlog from ring buffer.
        self.ring
            .iter()
            .filter(|(s, _)| *s >= since_seq)
            .map(|(s, d)| (*s, d.clone()))
            .collect()
    }

    /// Detach whichever client is currently attached.
    pub fn detach(&mut self) {
        self.attached = None;
    }

    /// Returns whether there is a LIVE attached client. A sender whose
    /// receiving end is gone (its connection's writer thread exited without
    /// the per-connection cleanup running, e.g. on a panic) counts as
    /// detached — otherwise a quiet session would hold a dead attachment
    /// forever and pin the daemon's idle auto-exit.
    pub fn has_client(&self) -> bool {
        self.attached.as_ref().is_some_and(|tx| !tx.is_closed())
    }

    /// Returns whether the attached client (if any) sends through the same
    /// channel as `tx` — i.e. whether `tx`'s connection owns the attachment.
    pub fn is_attached_to(&self, tx: &ClientSender) -> bool {
        self.attached
            .as_ref()
            .is_some_and(|a| a.same_channel(tx))
    }

    /// Returns the current highest seq (0 if nothing received yet).
    #[allow(dead_code)] // Used in Phase 2 for attach optimisation
    pub fn current_seq(&self) -> u64 {
        self.seq.load(Ordering::Relaxed)
    }

    /// Returns the oldest seq still in the ring buffer, or `u64::MAX` if empty.
    pub fn ring_oldest_seq(&self) -> u64 {
        self.ring.front().map(|(s, _)| *s).unwrap_or(u64::MAX)
    }

    /// Called by the periodic tick task. Uses kernel signals
    /// (foreground pgroup + foreground process CPU delta) to decide
    /// whether the session is waiting on the user.
    ///
    /// `fg_pgroup` is the result of `tcgetpgrp(master_fd)` —
    /// supplied by the caller because only the caller can access
    /// the `MasterPty` handles. `None` means "couldn't determine"
    /// (we bail safely).
    ///
    /// Two events can fire, both reported as a single boolean:
    ///   - **command-finished**: fg pgroup transitioned away from a
    ///     non-shell child back to the shell. The child just exited
    ///     (npm install done, tests finished, etc.).
    ///   - **tui-parked**: fg is not the shell, the foreground
    ///     process's CPU usage has been <1% for two consecutive
    ///     ticks, and the byte stream has been quiet for
    ///     OUTPUT_QUIET_MS. The process is blocked on `read()` —
    ///     classic "Claude Code is waiting" signature.
    pub fn check_attention(&mut self, fg_pgroup: Option<i32>) -> bool {
        if !self.running {
            return false;
        }
        if self.attention_pending {
            return false;
        }
        if self.bytes_since_attention < MIN_BYTES_FOR_ATTENTION {
            return false;
        }

        let Some(fg) = fg_pgroup else {
            return false;
        };
        if fg <= 0 {
            return false;
        }
        let Some(shell_pid) = self.shell_pid else {
            return false;
        };

        let prev_fg = self.last_fg_pgroup;
        self.last_fg_pgroup = Some(fg);

        // ── Event A: command-finished ─────────────────────────────
        // Shell just regained PTY control after a non-shell child.
        if fg == shell_pid {
            // Reset CPU tracking — we only care about CPU while a
            // child is foreground.
            self.last_cpu_sample = None;
            self.consecutive_idle_ticks = 0;
            if let Some(prev) = prev_fg {
                if prev != 0 && prev != shell_pid {
                    self.attention_pending = true;
                    self.bytes_since_attention = 0;
                    return true;
                }
            }
            return false;
        }

        // ── Event B: TUI parked ───────────────────────────────────
        // A child process is foreground; sample CPU and check if
        // it's been quiet on both fronts (CPU + bytes).
        let total_ns = match proc_total_cpu_ns(fg) {
            Some(n) => n,
            None => {
                self.consecutive_idle_ticks = 0;
                return false;
            }
        };
        let now = Instant::now();
        let is_idle_now = match self.last_cpu_sample {
            Some((t, prev_ns)) => {
                let wall_ns = now.duration_since(t).as_nanos() as u64;
                if wall_ns == 0 {
                    false
                } else {
                    let cpu_delta = total_ns.saturating_sub(prev_ns);
                    // <1% CPU over the sample window.
                    cpu_delta.saturating_mul(100) < wall_ns
                }
            }
            None => false, // First sample — can't tell yet.
        };
        self.last_cpu_sample = Some((now, total_ns));

        if is_idle_now {
            self.consecutive_idle_ticks = self.consecutive_idle_ticks.saturating_add(1);
        } else {
            self.consecutive_idle_ticks = 0;
        }

        let quiet = self.last_data_at.elapsed() >= Duration::from_millis(OUTPUT_QUIET_MS);

        if self.consecutive_idle_ticks >= 2 && quiet {
            self.attention_pending = true;
            self.bytes_since_attention = 0;
            self.consecutive_idle_ticks = 0;
            return true;
        }
        false
    }

    /// Emit an `Event::Attention` to the attached client, if any.
    /// Caller is expected to have just gotten `true` from
    /// `check_attention()`.
    pub fn emit_attention(&self) {
        if let Some(ref tx) = self.attached {
            let event = Event::Attention {
                id: self.id.clone(),
            };
            let _ = tx.send(event.to_line());
        }
    }
}

/// Sum of user + system CPU time for `pid` in nanoseconds, as
/// reported by `proc_pidinfo(PROC_PIDTASKINFO)`. Returns `None` if
/// the process has gone away or libc rejects the call.
///
/// We only sum the parent's CPU because the cost of walking the
/// whole process group every second would be too high for what is
/// already a heuristic; modern TUIs (Claude Code, vim, less) keep
/// almost all CPU in the parent process anyway. If we ever need
/// process-group totals the right tool is `proc_listpidspath` or a
/// `kqueue` walk.
fn proc_total_cpu_ns(pid: i32) -> Option<u64> {
    let mut info: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_taskinfo>() as libc::c_int;
    // SAFETY: `proc_pidinfo` is documented to write exactly `size`
    // bytes when it returns `size`, and our buffer is exactly that
    // big. `pid` may be invalid; libc handles that by returning <= 0.
    let ret = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTASKINFO,
            0,
            &mut info as *mut _ as *mut libc::c_void,
            size,
        )
    };
    if ret == size {
        Some(info.pti_total_user + info.pti_total_system)
    } else {
        None
    }
}

/// Owned PTY handles held separately from the `Session` so we can take them
/// out of the lock when starting the reader thread.
pub struct PtyHandles {
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Box<dyn Write + Send>,
    pub child: Box<dyn Child + Send + Sync>,
}

impl PtyHandles {
    pub fn resize(&mut self, rows: u16, cols: u16) -> anyhow::Result<()> {
        self.master
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| anyhow::anyhow!("resize: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_evicts_oldest_when_full() {
        let tmp = tempfile::TempDir::new().unwrap();
        std::env::set_var("HOME", tmp.path());

        let mut sess = Session::new("ring-test".into(), "label".into(), "/tmp".into(), 0);
        // Push exactly RING_CAP + 1 bytes in two chunks.
        let big = vec![0u8; RING_CAP];
        sess.push_output(&big);
        sess.push_output(b"tail");
        // Ring should have evicted the big chunk.
        assert!(sess.ring_bytes <= RING_CAP);
        // The most recent chunk should still be present.
        assert!(sess.ring.back().map(|(_, d)| d.as_slice()) == Some(b"tail".as_ref()));
    }

    #[test]
    fn attach_returns_backlog_since_seq() {
        let tmp = tempfile::TempDir::new().unwrap();
        std::env::set_var("HOME", tmp.path());

        let mut sess = Session::new("bl-test".into(), "label".into(), "/tmp".into(), 0);
        sess.push_output(b"first"); // seq 0
        sess.push_output(b"second"); // seq 1
        sess.push_output(b"third"); // seq 2

        let (tx, _rx) = mpsc::unbounded_channel();
        let backlog = sess.attach(tx, 1);
        // Should get seq 1 and seq 2.
        assert_eq!(backlog.len(), 2);
        assert_eq!(backlog[0].0, 1);
        assert_eq!(backlog[0].1, b"second");
        assert_eq!(backlog[1].0, 2);
        assert_eq!(backlog[1].1, b"third");
    }
}
