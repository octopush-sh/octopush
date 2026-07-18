//! Minimal JSON-RPC 2.0 + MCP wire helpers.
//!
//! We hand-roll the protocol instead of pulling in an SDK: the stdio transport
//! is just newline-delimited JSON-RPC 2.0, and owning the ~120 lines here keeps
//! the dependency surface at `serde_json` (already in the tree) and makes the
//! handshake fully auditable. The shape mirrors the MCP spec's stateful
//! lifecycle: `initialize` → `notifications/initialized` → `tools/*`.

use serde_json::{json, Value};

/// The newest spec revision we implement, used when the client omits one or
/// asks for a version we don't speak.
pub const PROTOCOL_VERSION: &str = "2025-06-18";

/// Dated revisions this server can speak. On `initialize` we echo the client's
/// requested version only if it's one of these; otherwise we answer with our
/// latest and let the client decide, per the MCP version-negotiation rule.
const SUPPORTED_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

fn negotiate_version(client_protocol: Option<&str>) -> &'static str {
    match client_protocol {
        Some(v) => SUPPORTED_VERSIONS
            .iter()
            .copied()
            .find(|&s| s == v)
            .unwrap_or(PROTOCOL_VERSION),
        None => PROTOCOL_VERSION,
    }
}

pub const SERVER_NAME: &str = "octopush";
pub const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

// ── JSON-RPC error codes (subset we use) ──────────────────────────────────
pub const PARSE_ERROR: i64 = -32700;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;

/// A successful JSON-RPC response carrying `result`.
pub fn success(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

/// A JSON-RPC error response.
pub fn error(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message.into() }
    })
}

/// The `initialize` result: advertise the tools capability and our identity.
pub fn initialize_result(client_protocol: Option<&str>) -> Value {
    json!({
        "protocolVersion": negotiate_version(client_protocol),
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION },
        "instructions": INSTRUCTIONS,
    })
}

/// Server-level guidance surfaced to the model on connect — sets expectations
/// about what this server is for and its safety envelope.
const INSTRUCTIONS: &str = "\
Octopush MCP — author DIRECT-mode pipelines and inspect Octopush missions, \
workspaces, projects, and runs over the same local store the desktop app uses. \
A mission is the first-level unit of intent; every workspace is paired with one \
(create_workspace does this automatically).\n\n\
This server is read-and-author only: it never executes runs, spends tokens, or \
mutates git working trees. Pipelines you create/update are saved as reusable \
templates; runs you create are staged in 'draft' for the user to launch from \
the Octopush app's DIRECT mode.\n\n\
Before authoring a pipeline, call `describe_pipeline_schema` to learn the valid \
stage roles, tools, substrates, and the loop/checkpoint rules the validator \
enforces.";

/// Wrap a handler's JSON payload as an MCP `tools/call` result. The data is
/// returned as pretty-printed JSON text content — the lingua franca an MCP
/// client's model can parse and reason over.
pub fn tool_text_result(payload: &Value) -> Value {
    let text = serde_json::to_string_pretty(payload)
        .unwrap_or_else(|e| format!("<failed to serialize result: {e}>"));
    json!({
        "content": [ { "type": "text", "text": text } ],
        "isError": false
    })
}

/// Wrap an error message as an MCP `tools/call` result with `isError: true`.
/// Tool-level failures are reported in-band (not as JSON-RPC errors) so the
/// model sees them and can correct course, per the MCP tool-error convention.
pub fn tool_error_result(message: impl Into<String>) -> Value {
    json!({
        "content": [ { "type": "text", "text": message.into() } ],
        "isError": true
    })
}
