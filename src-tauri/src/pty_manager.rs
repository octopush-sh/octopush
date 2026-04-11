//! PTY lifecycle management — one `PtyInstance` per session.
//!
//! Each PTY spawns a shell (from `$SHELL`, falling back to `/bin/zsh`) with
//! `OCTOPUS_SESSION`/`OCTOPUS_SESSION_ID` injected for context isolation.
//!
//! A dedicated reader thread forwards stdout bytes to the frontend via
//! `pty://data` events. When the child exits, a `pty://exit` event is
//! emitted and the instance removed from the manager.

use crate::error::{AppError, AppResult};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

/// Event payload for `pty://data`
#[derive(Serialize, Clone)]
struct PtyDataEvent {
    #[serde(rename = "sessionId")]
    session_id: String,
    /// Raw bytes read from the PTY. Sent as a JS number array which the
    /// frontend wraps in a `Uint8Array` before writing to xterm.
    bytes: Vec<u8>,
}

/// Event payload for `pty://exit`
#[derive(Serialize, Clone)]
struct PtyExitEvent {
    #[serde(rename = "sessionId")]
    session_id: String,
    code: Option<i32>,
}

pub struct PtyInstance {
    pub id: String,
    pub session_name: String,
    pub master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
}

#[derive(Default)]
pub struct PtyManager {
    instances: HashMap<String, PtyInstance>,
}

pub struct SpawnOptions {
    pub id: String,
    pub session_name: String,
    pub cwd: String,
    pub env: HashMap<String, String>,
    pub rows: u16,
    pub cols: u16,
    pub shell: Option<String>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn spawn(&mut self, app: AppHandle, opts: SpawnOptions) -> AppResult<()> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: opts.rows.max(1),
                cols: opts.cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AppError::Pty(e.to_string()))?;

        // Resolve shell: caller override → $SHELL → zsh fallback.
        let shell = opts
            .shell
            .or_else(|| std::env::var("SHELL").ok())
            .unwrap_or_else(|| "/bin/zsh".to_string());

        let mut cmd = CommandBuilder::new(&shell);
        // Login shell for nice env defaults.
        cmd.arg("-l");
        cmd.cwd(&opts.cwd);

        // Minimal env that makes interactive terminal behavior sane.
        // portable_pty starts from an empty env by default on some
        // platforms, so we forward a curated slice of the parent env.
        for key in [
            "HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL", "LC_CTYPE",
            "SHELL", "TMPDIR", "SSH_AUTH_SOCK",
        ] {
            if let Ok(v) = std::env::var(key) {
                cmd.env(key, v);
            }
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("OCTOPUS_SESSION", &opts.session_name);
        cmd.env("OCTOPUS_SESSION_ID", &opts.id);
        for (k, v) in &opts.env {
            cmd.env(k, v);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| AppError::Pty(e.to_string()))?;
        // Release the slave fd now that the child owns it.
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| AppError::Pty(e.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| AppError::Pty(e.to_string()))?;

        let instance = PtyInstance {
            id: opts.id.clone(),
            session_name: opts.session_name.clone(),
            master: Arc::new(Mutex::new(pair.master)),
            writer: Arc::new(Mutex::new(writer)),
            child: Arc::new(Mutex::new(child)),
        };

        // Reader thread: blocking reads from the PTY master and emits
        // `pty://data` events until EOF.
        let reader_id = opts.id.clone();
        let reader_app = app.clone();
        std::thread::Builder::new()
            .name(format!("pty-reader-{}", opts.id))
            .spawn(move || {
                let mut buf = [0u8; 4096];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break, // EOF
                        Ok(n) => {
                            let _ = reader_app.emit(
                                "pty://data",
                                PtyDataEvent {
                                    session_id: reader_id.clone(),
                                    bytes: buf[..n].to_vec(),
                                },
                            );
                        }
                        Err(e) => {
                            tracing::warn!(session_id = %reader_id, error = %e, "pty read error");
                            break;
                        }
                    }
                }
                let _ = reader_app.emit(
                    "pty://exit",
                    PtyExitEvent {
                        session_id: reader_id,
                        code: None,
                    },
                );
            })
            .map_err(|e| AppError::Pty(format!("spawn reader thread: {e}")))?;

        self.instances.insert(opts.id, instance);
        Ok(())
    }

    pub fn write(&self, id: &str, data: &[u8]) -> AppResult<()> {
        let inst = self
            .instances
            .get(id)
            .ok_or_else(|| AppError::SessionNotFound(id.to_string()))?;
        let mut w = inst.writer.lock();
        w.write_all(data)?;
        w.flush()?;
        Ok(())
    }

    pub fn resize(&self, id: &str, rows: u16, cols: u16) -> AppResult<()> {
        let inst = self
            .instances
            .get(id)
            .ok_or_else(|| AppError::SessionNotFound(id.to_string()))?;
        inst.master
            .lock()
            .resize(PtySize {
                rows: rows.max(1),
                cols: cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AppError::Pty(e.to_string()))
    }

    pub fn kill(&mut self, id: &str) -> AppResult<()> {
        let inst = self
            .instances
            .remove(id)
            .ok_or_else(|| AppError::SessionNotFound(id.to_string()))?;
        let _ = inst.child.lock().kill();
        Ok(())
    }

    pub fn has(&self, id: &str) -> bool {
        self.instances.contains_key(id)
    }

    pub fn ids(&self) -> Vec<String> {
        self.instances.keys().cloned().collect()
    }
}
