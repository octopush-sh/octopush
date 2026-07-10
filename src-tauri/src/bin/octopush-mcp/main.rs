//! `octopush-mcp` — a Model Context Protocol server for Octopush.
//!
//! Speaks JSON-RPC 2.0 over stdio (the transport Claude Code and other MCP
//! clients launch). It exposes a read-and-author slice of Octopush: list and
//! inspect pipelines / projects / workspaces / runs, author DIRECT-mode
//! pipeline templates, stage runs in `draft`, and create workspaces. It drives
//! the same local SQLite store the desktop app uses, so it works whether or
//! not the app is running. It never executes runs or spends tokens; the only
//! git mutation it performs is creating a workspace's worktree.
//!
//! The loop is deliberately synchronous: stdio MCP is one JSON object per line,
//! and a single rusqlite connection is neither needed on multiple threads nor
//! `Sync`, so a plain read→handle→write loop is the simplest correct design.

mod protocol;
mod tools;

use std::io::{self, BufRead, Write};

use octopush_lib::db::Db;
use parking_lot::Mutex;
use serde_json::Value;

fn main() {
    // Open the store once. A failure here is fatal and worth surfacing on
    // stderr (stdout is reserved for protocol frames). Wrapped in a Mutex so
    // workspace creation can lock per-operation (and never across its git
    // checkout); the loop is single-threaded so it's otherwise uncontended.
    let db = match Db::open(&Db::default_path()) {
        Ok(db) => Mutex::new(db),
        Err(e) => {
            eprintln!("octopush-mcp: failed to open the Octopush database: {e}");
            std::process::exit(1);
        }
    };

    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("octopush-mcp: stdin read error: {e}");
                break;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        if let Some(response) = handle_message(&db, &line) {
            // One compact JSON object per line — the stdio framing contract.
            if let Ok(text) = serde_json::to_string(&response) {
                if writeln!(out, "{text}").is_err() || out.flush().is_err() {
                    break; // client closed the pipe
                }
            }
        }
    }
}

/// Parse and route one incoming line. Returns `Some(response)` for requests
/// (messages with an `id`) and `None` for notifications.
fn handle_message(db: &Mutex<Db>, line: &str) -> Option<Value> {
    let msg: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => {
            // Can't recover an id from unparseable input — reply with a null-id
            // parse error per JSON-RPC.
            return Some(protocol::error(Value::Null, protocol::PARSE_ERROR, format!("parse error: {e}")));
        }
    };

    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let id = msg.get("id").cloned();
    let params = msg.get("params").cloned().unwrap_or(Value::Null);

    // Notifications carry no id; we act on them but never respond.
    let Some(id) = id else {
        // The only notification we care about is `initialized`; others are no-ops.
        return None;
    };

    let result = match method {
        "initialize" => {
            let client_proto = params
                .get("protocolVersion")
                .and_then(Value::as_str);
            Ok(protocol::initialize_result(client_proto))
        }
        "ping" => Ok(serde_json::json!({})),
        "tools/list" => Ok(tools::tool_definitions()),
        "tools/call" => handle_tools_call(db, &params),
        other => Err((
            protocol::METHOD_NOT_FOUND,
            format!("method not found: {other}"),
        )),
    };

    Some(match result {
        Ok(value) => protocol::success(id, value),
        Err((code, message)) => protocol::error(id, code, message),
    })
}

/// `tools/call`: validate the envelope, then dispatch. Tool-level failures come
/// back as a successful response whose result has `isError: true` (the MCP
/// convention) so the model can read and recover from them.
fn handle_tools_call(db: &Mutex<Db>, params: &Value) -> Result<Value, (i64, String)> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or((protocol::INVALID_PARAMS, "tools/call requires a tool 'name'".to_string()))?;
    let args = params.get("arguments").cloned().unwrap_or(serde_json::json!({}));
    Ok(tools::call_tool(db, name, &args))
}
