//! Daemon spawner — ensures `octopush-pty-server` is running and returns the
//! path to its Unix socket.
//!
//! # Lookup order for the daemon binary
//!
//! 1. Sibling to the running Octopush executable:
//!    - Production: `Octopush.app/Contents/MacOS/octopush-pty-server`
//!    - Dev (`cargo run`): `target/debug/octopush-pty-server`
//!
//!    Both cases resolve via `std::env::current_exe()?.parent()?.join(...)`.
//!
//! 2. If the computed path doesn't exist, we fall back to `which`-style
//!    resolution through `$PATH` (useful during integration tests).

use crate::error::{AppError, AppResult};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// Maximum time to wait for the daemon socket to become ready.
const SOCKET_READY_TIMEOUT: Duration = Duration::from_millis(2500);
/// Polling interval while waiting.
const SOCKET_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Wire-protocol version this Octopush build speaks. The app reuses a running
/// daemon whose reported `protocol_version` matches this — even across Octopush
/// *version* bumps — so live PTY sessions survive compatible updates. Only a
/// protocol MISMATCH (or a daemon too old to report one) forces a replace,
/// which kills its child shells. Bump this ONLY when the daemon's wire protocol
/// (or behavior the app depends on) changes incompatibly.
///
/// MUST stay in sync with `DAEMON_PROTOCOL_VERSION` in
/// `bin/octopush-pty-server/protocol.rs`.
///
/// v2: `remove` request + eager fd release for exited sessions. The bump
/// forces a one-time daemon replacement on update so the fd-leak fixes
/// actually deploy (the daemon is otherwise immortal by design).
const EXPECTED_PROTOCOL_VERSION: u32 = 2;

/// Return the path to the PTY daemon's Unix socket, starting the daemon
/// first if it is not already running OR replacing it if the running
/// daemon is from a stale Octopush build.
pub fn ensure_daemon_running() -> AppResult<PathBuf> {
    let sock_path = socket_path()?;

    // Fast path: daemon already up *and* protocol-compatible. We reuse a
    // compatible daemon even if it's from a different Octopush version, so its
    // live PTY sessions survive the update.
    if is_socket_ready(&sock_path) {
        match query_daemon_protocol(&sock_path) {
            Ok(p) if p == EXPECTED_PROTOCOL_VERSION => {
                return Ok(sock_path);
            }
            Ok(p) => {
                tracing::warn!(
                    running_protocol = p,
                    expected = EXPECTED_PROTOCOL_VERSION,
                    "incompatible PTY daemon protocol — replacing"
                );
            }
            Err(e) => {
                // Daemon responded but didn't report a protocol version — it
                // predates protocol versioning (≤ v0.1.22), so it's incompatible.
                tracing::warn!(
                    error = %e,
                    "running PTY daemon predates the protocol handshake — replacing"
                );
            }
        }
        // Old daemon → kill it and wait for the socket to disappear.
        if let Err(e) = kill_existing_daemon() {
            tracing::warn!(error = %e, "failed to terminate stale daemon");
        }
        // Wait briefly for the socket to clear, otherwise the new
        // daemon will see a stale `~/.octopush/pty-server.sock` file.
        let deadline = Instant::now() + Duration::from_secs(3);
        while sock_path.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    // Locate the binary.
    let daemon_bin = resolve_daemon_binary()?;
    tracing::info!(binary = %daemon_bin.display(), "spawning PTY daemon");

    // Spawn fully detached.
    spawn_detached(&daemon_bin)?;

    // Poll until socket ready or timeout.
    let deadline = Instant::now() + SOCKET_READY_TIMEOUT;
    loop {
        std::thread::sleep(SOCKET_POLL_INTERVAL);
        if is_socket_ready(&sock_path) {
            tracing::info!(socket = %sock_path.display(), "PTY daemon ready");
            return Ok(sock_path);
        }
        if Instant::now() >= deadline {
            break;
        }
    }

    Err(AppError::Other(
        "PTY daemon failed to start within 2.5s".into(),
    ))
}

/// Send a `version` request to the daemon and return its reported wire-protocol
/// version. Times out at ~1 second. A daemon that predates protocol versioning
/// (≤ v0.1.22) omits the field → reported as `0` (always a mismatch → replace).
fn query_daemon_protocol(sock_path: &PathBuf) -> Result<u32, String> {
    use std::io::{BufRead, BufReader, Write};
    let mut stream =
        UnixStream::connect(sock_path).map_err(|e| format!("connect: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(1)))
        .map_err(|e| format!("set timeout: {e}"))?;
    // The daemon expects newline-delimited JSON of {"method": "...", ...}.
    let req = br#"{"method":"version"}
"#;
    stream
        .write_all(req)
        .map_err(|e| format!("write: {e}"))?;
    let mut reader = BufReader::new(&stream);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|e| format!("read: {e}"))?;
    // Defensive: any non-{type:"version"} response (e.g. an old daemon
    // returning Error) is treated as incompatible.
    let v: serde_json::Value =
        serde_json::from_str(&line).map_err(|e| format!("parse: {e}"))?;
    if v["type"] == "version" {
        Ok(v["protocol_version"].as_u64().unwrap_or(0) as u32)
    } else {
        Err(format!("non-version response: {}", v))
    }
}

/// Best-effort kill of the running daemon. Reads the PID file and
/// sends SIGTERM. The daemon's own signal handler cleans up the PID
/// file and the socket; we wait for that asynchronously in the caller.
fn kill_existing_daemon() -> Result<(), String> {
    let home =
        dirs::home_dir().ok_or_else(|| "no HOME".to_string())?;
    let pid_file = home.join(".octopush").join("pty-server.pid");
    if !pid_file.exists() {
        return Ok(()); // nothing to kill
    }
    let pid_str = std::fs::read_to_string(&pid_file)
        .map_err(|e| format!("read pid file: {e}"))?;
    let pid: i32 = pid_str
        .trim()
        .parse()
        .map_err(|e| format!("parse pid: {e}"))?;
    // SAFETY: `kill(pid, SIGTERM)` is async-signal-safe and has well-
    // defined semantics — sends a signal to the named process.
    let rc = unsafe { libc::kill(pid, libc::SIGTERM) };
    if rc != 0 {
        return Err(format!("kill({pid}, SIGTERM) returned {rc}"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// `~/.octopush/pty-server.sock`
pub fn socket_path() -> AppResult<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| AppError::Other("cannot determine $HOME".into()))?;
    Ok(home.join(".octopush").join("pty-server.sock"))
}

/// Returns `true` if the socket file exists and a connection attempt succeeds.
fn is_socket_ready(sock_path: &PathBuf) -> bool {
    if !sock_path.exists() {
        return false;
    }
    UnixStream::connect(sock_path).is_ok()
}

/// Resolve the daemon binary path.
///
/// Primary: sibling of the current executable (works in production `.app` and
/// in `cargo run` / `cargo test`).
/// Fallback: search `$PATH` for `octopush-pty-server`.
fn resolve_daemon_binary() -> AppResult<PathBuf> {
    // Try sibling-of-exe first.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let candidate = parent.join("octopush-pty-server");
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }

    // Fallback: $PATH lookup (useful in `cargo test` where the daemon is
    // built into target/debug but our exe is the test runner somewhere else).
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in path_var.split(':') {
            let candidate = PathBuf::from(dir).join("octopush-pty-server");
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }

    // Last resort: current dir / target/debug (helpful in workspace tests).
    for relative in &[
        "target/debug/octopush-pty-server",
        "src-tauri/target/debug/octopush-pty-server",
    ] {
        if let Ok(cwd) = std::env::current_dir() {
            let candidate = cwd.join(relative);
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }

    Err(AppError::Other(
        "octopush-pty-server binary not found next to executable or in $PATH".into(),
    ))
}

/// Spawn the daemon fully detached so it survives Octopush's exit.
///
/// On Unix we call `setsid()` in the child so it escapes the parent's process
/// group and is adopted by `launchd` when Octopush exits.
fn spawn_detached(binary: &PathBuf) -> AppResult<()> {
    use std::process::{Command, Stdio};

    let mut cmd = Command::new(binary);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: `setsid()` is async-signal-safe.  We're in a forked child
        // at this point and the only system call we make is setsid(2).
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }

    cmd.spawn()
        .map_err(|e| AppError::Other(format!("failed to spawn daemon: {e}")))?;
    Ok(())
}
