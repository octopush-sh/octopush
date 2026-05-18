//! Wire types for the PTY daemon JSON-over-socket protocol.
//!
//! Each message is a single JSON object terminated by a newline (`\n`).
//! Requests come from the client; responses and events flow from the daemon.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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
    Shutdown,
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
