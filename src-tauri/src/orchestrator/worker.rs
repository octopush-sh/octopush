//! Spawning detached segment workers (`octopush-run-worker`).
//!
//! A detached run is never handed to a resident daemon — each drive segment
//! (start → next pause/completion) runs in a short-lived worker process that
//! `setsid()`s into its own session, so it — and the `claude` CLI child
//! living inside that session — survives the app quitting. The cross-process
//! contract is the worker lease on the `runs` row (see `db.rs`); the app's
//! bridge (`bridge.rs`) turns the worker's persisted progress back into live
//! `run://*` events.

use std::path::PathBuf;
use std::process::Stdio;

use crate::error::{AppError, AppResult};

use super::Orchestrator;

pub const WORKER_BIN: &str = "octopush-run-worker";

/// Resolve the worker binary: sibling of the current executable (production
/// `.app/Contents/MacOS` and `cargo run`/`cargo test` target dirs), then
/// `$PATH`, then the dev target fallbacks — the same ladder as the PTY daemon.
fn resolve_worker_binary() -> AppResult<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let candidate = parent.join(WORKER_BIN);
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in path_var.split(':') {
            let candidate = PathBuf::from(dir).join(WORKER_BIN);
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }
    for relative in &[
        "target/debug/octopush-run-worker",
        "src-tauri/target/debug/octopush-run-worker",
    ] {
        if let Ok(cwd) = std::env::current_dir() {
            let candidate = cwd.join(relative);
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }
    Err(AppError::Other(format!(
        "{WORKER_BIN} binary not found next to executable or in $PATH"
    )))
}

impl Orchestrator {
    /// Hand the next drive segment of `run_id` to a detached worker process
    /// (Pro, `runs.detached`). Reserves the cross-process lease, spawns the
    /// worker in its own session, and primes the bridge so live events flow
    /// from the first tick. On ANY failure the lease is released and the
    /// error returned — callers fall back to the in-process drive, so a
    /// missing worker binary can never cost the user their run.
    pub fn spawn_detached_segment(&self, run_id: &str, budget_override: bool) -> AppResult<()> {
        let nonce = uuid::Uuid::new_v4().to_string();
        if !self.db.lock().reserve_worker_lease(run_id, &nonce)? {
            return Err(AppError::Other(
                "run is already executing in the background".into(),
            ));
        }
        let bin = match resolve_worker_binary() {
            Ok(b) => b,
            Err(e) => {
                let _ = self.db.lock().clear_worker_lease(run_id, &nonce);
                return Err(e);
            }
        };
        let mut cmd = std::process::Command::new(&bin);
        cmd.arg("drive")
            .arg(run_id)
            .arg("--nonce")
            .arg(&nonce)
            .arg("--app-pid")
            .arg(std::process::id().to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if budget_override {
            cmd.arg("--budget-override");
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // SAFETY: `setsid()` is async-signal-safe and is the only call
            // made in the forked child before exec (the PTY daemon recipe).
            unsafe {
                cmd.pre_exec(|| {
                    libc::setsid();
                    Ok(())
                });
            }
        }
        match cmd.spawn() {
            Ok(mut child) => {
                // Reap on exit — setsid detaches the SESSION, not the parent
                // link, so without this wait every finished segment would
                // linger as a zombie for the app's whole lifetime.
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
                self.prime_detached_watch(run_id);
                tracing::info!(run_id = %run_id, "detached segment worker spawned");
                Ok(())
            }
            Err(e) => {
                let _ = self.db.lock().clear_worker_lease(run_id, &nonce);
                Err(AppError::Other(format!("failed to spawn run worker: {e}")))
            }
        }
    }
}
