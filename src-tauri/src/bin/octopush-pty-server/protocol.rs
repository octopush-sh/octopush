//! Wire types for the PTY daemon JSON-over-socket protocol.
//!
//! Each message is a single JSON object terminated by a newline (`\n`).
//! Requests come from the client; responses and events flow from the daemon.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Wire-protocol version of the daemon. Bump this ONLY when the
/// JSON-over-socket protocol — or daemon behavior the app relies on — changes
/// incompatibly. The app keeps a running daemon whose protocol matches even
/// across Octopush *version* bumps, so live PTY sessions survive compatible
/// updates (and the daemon is only force-replaced on a protocol break).
///
/// MUST stay in sync with `EXPECTED_PROTOCOL_VERSION` in `src/pty_daemon.rs`.
///
/// v2: added the `remove` request (delete a session and release its fds);
///     exited sessions now release their PTY fds and log handle eagerly.
pub const DAEMON_PROTOCOL_VERSION: u32 = 2;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/// Top-level request envelope.  The `method` field selects which variant is
/// active; the remaining fields are the params.
///
/// `reqid` is an optional monotonic u64 set by the client. The daemon echoes
/// it back in the corresponding `Response` so the client can match async
/// responses to their originating call.  Backward-compatible: missing → `None`.
#[derive(Debug, Clone, Deserialize)]
pub struct Request {
    /// Optional request correlation id — echoed back in the `Response`.
    #[serde(default)]
    pub reqid: Option<u64>,
    /// The actual request payload, selected by the `method` tag.
    #[serde(flatten)]
    pub payload: RequestPayload,
}

/// Inner payload of a [`Request`], tagged by `method`.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "method", rename_all = "snake_case")]
pub enum RequestPayload {
    ListTerminals,
    Spawn(SpawnParams),
    Attach(AttachParams),
    Detach(DetachParams),
    Write(WriteParams),
    Resize(ResizeParams),
    Kill(KillParams),
    /// Permanently delete a session: kill the shell if running, drop the
    /// session from the registry (releasing its PTY fds + log handle) and
    /// delete its scrollback log from disk. Sent when the user deletes a
    /// terminal — unlike `kill`, the session cannot be reattached afterwards.
    Remove(RemoveParams),
    Shutdown,
    /// Compile-time version of the daemon binary. Clients use this to
    /// detect a stale daemon left over from an older Octopush bundle
    /// (the PID file lockout would otherwise keep them connected to it).
    Version,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SpawnParams {
    pub id: String,
    pub cwd: String,
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub shell: Option<String>,
    pub rows: u16,
    pub cols: u16,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AttachParams {
    pub id: String,
    /// If set, replay all buffered chunks with seq >= since_seq before live data.
    pub since_seq: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DetachParams {
    pub id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WriteParams {
    pub id: String,
    /// Base64-encoded bytes to write to the PTY stdin.
    pub data: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ResizeParams {
    pub id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Deserialize)]
pub struct KillParams {
    pub id: String,
    /// `"KILL"` for SIGKILL; anything else (or absent) defaults to SIGTERM.
    pub signal: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RemoveParams {
    pub id: String,
}

// ---------------------------------------------------------------------------
// Responses / events
// ---------------------------------------------------------------------------

/// One-shot response sent immediately after processing a request.
///
/// `reqid` echoes the value from the originating `Request`, allowing the
/// client to correlate asynchronous responses.  `None` when the request
/// carried no `reqid` (backward-compatible).
#[derive(Debug, Clone, Serialize)]
pub struct Response {
    /// Echoed request id, or `None` if the request had none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reqid: Option<u64>,
    /// The actual response payload.
    #[serde(flatten)]
    pub payload: ResponsePayload,
}

impl Response {
    /// Construct a response with an optional reqid.
    pub fn with_reqid(payload: ResponsePayload, reqid: Option<u64>) -> Self {
        Self { reqid, payload }
    }

    /// Construct a response without a reqid (for internal/sentinel use).
    pub fn bare(payload: ResponsePayload) -> Self {
        Self { reqid: None, payload }
    }
}

/// Inner payload of a [`Response`], tagged by `type`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ResponsePayload {
    /// `list_terminals` → array of descriptors.
    Terminals { terminals: Vec<TerminalInfo> },
    /// `spawn` → assigned id + OS pid.
    Spawned { id: String, pid: u32 },
    /// Generic OK for write/resize/kill/detach/shutdown.
    Ok {},
    /// Error response.
    Error { message: String },
    /// `version` → the daemon's compile-time version string + wire-protocol
    /// version. The app compares `protocol_version` (not `version`) to decide
    /// whether a running daemon is compatible.
    Version { version: String, protocol_version: u32 },
    /// Sentinel: the handler already sent its own response via the tx channel.
    /// `handle_connection` must NOT send this to the wire.
    #[serde(skip)]
    SentDirectly,
}

/// Per-terminal status descriptor returned by `list_terminals`.
#[derive(Debug, Clone, Serialize)]
pub struct TerminalInfo {
    pub id: String,
    pub label: String,
    pub running: bool,
    pub cwd: String,
    pub started_at: i64, // Unix timestamp seconds
}

/// Streaming events pushed to an attached client.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
#[allow(dead_code)] // Error variant reserved for future use
pub enum Event {
    /// PTY output chunk, base64-encoded.
    Data {
        id: String,
        seq: u64,
        bytes: String, // base64
    },
    /// PTY child exited.
    Exit { id: String, code: Option<i32> },
    /// Error on a streaming connection.
    Error { id: String, message: String },
    /// The PTY has been idle (no new output) for the configured
    /// threshold after a meaningful burst of output — heuristically,
    /// the inner program finished painting and is waiting for input.
    /// Detection lives in the daemon so it benefits from
    /// deterministic timing and authoritative access to the raw byte
    /// stream (the frontend WebView's xterm.js buffer + React render
    /// cycle made this unreliable in 0.1.4–0.1.10).
    Attention { id: String },
    /// The PTY's foreground process group flipped between the shell
    /// (idle, at a prompt) and a non-shell child (a command is running).
    /// Drives the rail's "processing" indicator. Distinct from
    /// `Attention`, which fires once a *running* command goes idle: this
    /// is a plain ownership signal (`fg != shell`) with no latch or grace
    /// window, emitted only on a state change.
    Foreground { id: String, busy: bool },
}

// ---------------------------------------------------------------------------
// Codec helpers
// ---------------------------------------------------------------------------

impl Response {
    /// Serialise to a newline-terminated JSON line.
    pub fn to_line(&self) -> Vec<u8> {
        let mut buf = serde_json::to_vec(self).expect("Response serialization is infallible");
        buf.push(b'\n');
        buf
    }
}

impl ResponsePayload {
    /// Wrap in a `Response` with no reqid and serialise.
    pub fn to_line_bare(self) -> Vec<u8> {
        Response::bare(self).to_line()
    }
}

impl Event {
    /// Serialise to a newline-terminated JSON line.
    pub fn to_line(&self) -> Vec<u8> {
        let mut buf = serde_json::to_vec(self).expect("Event serialization is infallible");
        buf.push(b'\n');
        buf
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_response_carries_protocol_version() {
        let line = Response::with_reqid(
            ResponsePayload::Version {
                version: "9.9.9".into(),
                protocol_version: DAEMON_PROTOCOL_VERSION,
            },
            Some(1),
        )
        .to_line();
        let s = String::from_utf8(line).unwrap();
        assert!(s.contains("\"type\":\"version\""), "got: {s}");
        assert!(s.contains(&format!("\"protocol_version\":{DAEMON_PROTOCOL_VERSION}")), "got: {s}");
        assert!(s.contains("\"version\":\"9.9.9\""), "got: {s}");
    }
}
