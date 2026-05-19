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
use std::time::Instant;
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
}

/// Idle threshold (no PTY output for this long) before we consider
/// the session to be waiting on the user. 10s is long enough that
/// any agent that's actually thinking (Claude Code's spinner, LLM
/// streaming, npm install progress lines) emits something within
/// the window and resets the clock.
pub const IDLE_THRESHOLD_MS: u64 = 10_000;

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

    /// Returns whether there is an attached client.
    pub fn has_client(&self) -> bool {
        self.attached.is_some()
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

    /// Called by the periodic tick task. If the session has gone
    /// quiet long enough AND there's been a meaningful burst of
    /// output since the last attention emit, return true to signal
    /// the caller to emit an `Event::Attention` and latch
    /// `attention_pending` so we don't re-emit until new output
    /// arrives.
    pub fn check_attention(&mut self) -> bool {
        if !self.running {
            return false;
        }
        if self.attention_pending {
            return false;
        }
        if self.bytes_since_attention < MIN_BYTES_FOR_ATTENTION {
            return false;
        }
        if self.last_data_at.elapsed().as_millis() < IDLE_THRESHOLD_MS as u128 {
            return false;
        }
        // Latch + reset the counter so the next "burst then idle"
        // window has to clear the bar again.
        self.attention_pending = true;
        self.bytes_since_attention = 0;
        true
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
