//! PTY lifecycle management — thin wrapper over [`DaemonClient`].
//!
//! `PtyManager` no longer owns PTYs in-process.  Every operation is proxied
//! to the `octopush-pty-server` daemon via the Unix socket.
//!
//! The public API is preserved so the rest of the codebase (commands.rs,
//! lib.rs) requires minimal changes.  The `pty://data` and `pty://exit` Tauri
//! events continue to fire with the same `{ sessionId, bytes }` /
//! `{ sessionId, code }` payloads the frontend already consumes.
//!
//! Phase 3 additions:
//! - `spawn_or_attach`: checks the daemon's live session list before spawning;
//!   reattaches if the PTY is already running (e.g. after an Octopush restart).
//! - `pty://reattached` Tauri event emitted once per successful reattach so the
//!   frontend can mark the terminal as `restored`.

use crate::error::AppResult;
use crate::pty_client::{DaemonClient, TermEvent};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

// ---------------------------------------------------------------------------
// Tauri event payloads (unchanged — frontend depends on this shape)
// ---------------------------------------------------------------------------

/// Event payload for `pty://data`
#[derive(Serialize, Clone)]
struct PtyDataEvent {
    #[serde(rename = "sessionId")]
    session_id: String,
    /// Raw bytes read from the PTY.
    bytes: Vec<u8>,
}

/// Event payload for `pty://exit`
#[derive(Serialize, Clone)]
struct PtyExitEvent {
    #[serde(rename = "sessionId")]
    session_id: String,
    code: Option<i32>,
}

/// Event payload for `pty://reattached` — emitted once when a PTY is
/// reattached to a surviving daemon session (i.e., after an Octopush restart).
#[derive(Serialize, Clone)]
struct PtyReattachedEvent {
    #[serde(rename = "sessionId")]
    session_id: String,
}

// ---------------------------------------------------------------------------
// SpawnMode — result of spawn_or_attach
// ---------------------------------------------------------------------------

/// Indicates whether a session was freshly spawned or reattached to a
/// surviving daemon PTY.
#[derive(Debug, Clone, PartialEq)]
pub enum SpawnMode {
    /// A new shell was started in the daemon.
    Spawned { pid: u32 },
    /// An existing daemon PTY was found; scrollback is replayed from seq 0.
    Reattached,
}

// ---------------------------------------------------------------------------
// OutputHook type alias (preserved for scanner integration)
// ---------------------------------------------------------------------------

/// Optional callback invoked on each PTY read chunk (for token scanning).
pub type OutputHook = Box<dyn Fn(&str, &[u8]) + Send + 'static>;

// ---------------------------------------------------------------------------
// SpawnOptions (public API unchanged)
// ---------------------------------------------------------------------------

pub struct SpawnOptions {
    pub id: String,
    pub session_name: String,
    pub cwd: String,
    pub env: HashMap<String, String>,
    pub rows: u16,
    pub cols: u16,
    pub shell: Option<String>,
    /// If set, called with `(session_id, bytes)` on each PTY data chunk.
    pub on_output: Option<OutputHook>,
}

// ---------------------------------------------------------------------------
// PtyManager
// ---------------------------------------------------------------------------

pub struct PtyManager {
    /// Shared connection to the daemon.
    pub(crate) client: Arc<DaemonClient>,
    /// Track which session ids this manager has spawned.
    active: HashMap<String, ()>,
}

impl PtyManager {
    /// Create a new manager.  The `client` is shared so that the spawner and
    /// the attach threads all use the same underlying socket.
    pub fn new(client: Arc<DaemonClient>) -> Self {
        Self {
            client,
            active: HashMap::new(),
        }
    }

    /// Spawn a new PTY session via the daemon and start an attach thread that
    /// forwards events to the frontend.
    ///
    /// This is the legacy entry-point; prefer [`Self::spawn_or_attach`] for
    /// new call sites so that surviving daemon sessions are reused.
    pub fn spawn(&mut self, app: AppHandle, opts: SpawnOptions) -> AppResult<()> {
        let client = Arc::clone(&self.client);
        let id = opts.id.clone();

        // Ask the daemon to start the shell.
        client.spawn(
            &id,
            &opts.cwd,
            &opts.env,
            opts.shell.as_deref(),
            opts.rows,
            opts.cols,
        )?;

        // Attach: get an event receiver for live output.
        let rx = client.attach(&id, 0)?;

        start_reader_thread(app, id.clone(), rx, opts.on_output, false);

        self.active.insert(id, ());
        Ok(())
    }

    /// Spawn-or-attach: reuse an existing daemon PTY if one is already running
    /// for `opts.id`, otherwise start a new shell.
    ///
    /// On reattach the daemon replays all scrollback from seq 0, so xterm
    /// renders the prior session output as if the user never left.  A
    /// `pty://reattached` Tauri event is emitted once so the frontend can
    /// mark the terminal entry as `restored`.
    ///
    /// Returns [`SpawnMode`] indicating what happened.
    pub fn spawn_or_attach(
        &mut self,
        app: AppHandle,
        opts: SpawnOptions,
    ) -> AppResult<SpawnMode> {
        let id = opts.id.clone();
        let client = Arc::clone(&self.client);

        // Check daemon for a live session with this id.
        let live_sessions = client.list_terminals().unwrap_or_default();
        let is_running = live_sessions
            .iter()
            .any(|s| s.id == id && s.running);

        let mode = if is_running {
            // Reattach: the daemon already owns this PTY.
            tracing::info!(session_id = %id, "reattaching to surviving daemon PTY");
            let rx = client.attach(&id, 0)?;
            start_reader_thread(app.clone(), id.clone(), rx, opts.on_output, true);
            SpawnMode::Reattached
        } else {
            // Spawn fresh.
            let pid = client.spawn(
                &id,
                &opts.cwd,
                &opts.env,
                opts.shell.as_deref(),
                opts.rows,
                opts.cols,
            )?;
            let rx = client.attach(&id, 0)?;
            start_reader_thread(app.clone(), id.clone(), rx, opts.on_output, false);
            SpawnMode::Spawned { pid }
        };

        self.active.insert(id, ());
        Ok(mode)
    }

    pub fn write(&self, id: &str, data: &[u8]) -> AppResult<()> {
        self.client.write(id, data)
    }

    pub fn resize(&self, id: &str, rows: u16, cols: u16) -> AppResult<()> {
        self.client.resize(id, cols, rows)
    }

    pub fn kill(&mut self, id: &str) -> AppResult<()> {
        self.active.remove(id);
        self.client.kill(id, "TERM")
    }

    /// Query the daemon for all live PTY sessions.
    ///
    /// Used by [`crate::commands::list_pty_sessions`] to reconcile DB-persisted
    /// terminal records with reality on startup.
    pub fn list_live_sessions(&self) -> AppResult<Vec<crate::pty_client::TerminalInfo>> {
        self.client.list_terminals()
    }

    pub fn has(&self, id: &str) -> bool {
        self.active.contains_key(id)
    }

    pub fn ids(&self) -> Vec<String> {
        self.active.keys().cloned().collect()
    }
}

// ---------------------------------------------------------------------------
// Shared reader-thread helper
// ---------------------------------------------------------------------------

/// Spawn a background thread that forwards [`TermEvent`]s from `rx` to the
/// Tauri frontend as `pty://data` / `pty://exit` events.
///
/// If `is_reattach` is true, a `pty://reattached` event is fired once before
/// the normal event loop begins so the frontend can mark the terminal restored.
fn start_reader_thread(
    app: AppHandle,
    id: String,
    rx: std::sync::mpsc::Receiver<TermEvent>,
    on_output: Option<OutputHook>,
    is_reattach: bool,
) {
    let thread_name = format!("pty-attach-{id}");
    std::thread::Builder::new()
        .name(thread_name)
        .spawn(move || {
            // Signal the frontend that this is a reattach before the data
            // stream starts arriving.
            if is_reattach {
                let _ = app.emit(
                    "pty://reattached",
                    PtyReattachedEvent {
                        session_id: id.clone(),
                    },
                );
            }

            loop {
                match rx.recv() {
                    Ok(TermEvent::Data { bytes, .. }) => {
                        let _ = app.emit(
                            "pty://data",
                            PtyDataEvent {
                                session_id: id.clone(),
                                bytes: bytes.clone(),
                            },
                        );
                        if let Some(ref hook) = on_output {
                            hook(&id, &bytes);
                        }
                    }
                    Ok(TermEvent::Exit { code }) => {
                        let _ = app.emit(
                            "pty://exit",
                            PtyExitEvent {
                                session_id: id.clone(),
                                code,
                            },
                        );
                        break;
                    }
                    Ok(TermEvent::Error { message }) => {
                        tracing::warn!(
                            session_id = %id,
                            error = %message,
                            "pty daemon event error"
                        );
                        let _ = app.emit(
                            "pty://exit",
                            PtyExitEvent {
                                session_id: id.clone(),
                                code: None,
                            },
                        );
                        break;
                    }
                    Err(_) => {
                        // Channel closed — daemon disconnected or session ended.
                        let _ = app.emit(
                            "pty://exit",
                            PtyExitEvent {
                                session_id: id.clone(),
                                code: None,
                            },
                        );
                        break;
                    }
                }
            }
        })
        .ok(); // spawn failure is logged implicitly; we don't propagate
}
