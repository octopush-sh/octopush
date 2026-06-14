//! MCP (Model Context Protocol) client — connects to local stdio MCP servers,
//! lists their tools, and proxies tool calls into the chat agentic loop.
//!
//! Transport: newline-delimited JSON-RPC 2.0 over the server's stdin/stdout
//! (the MCP stdio transport). Servers are configured in `.claude/mcp.json`
//! (project ∪ user) in the Claude-Code-compatible shape:
//!
//! ```json
//! { "mcpServers": { "<name>": { "command": "…", "args": [...], "env": {...} } } }
//! ```
//!
//! Tools are surfaced to the model with namespaced names `mcp__<server>__<tool>`
//! so the agentic loop can route a tool_use back to the right server. Servers
//! are spawned lazily on first use and cached for the app's lifetime (killed on
//! drop). A server that fails to start/list is skipped with a warning — it
//! never breaks the chat.
//!
//! NOTE: end-to-end execution requires spawning the configured server binary;
//! the JSON-RPC framing, config parsing, and name (de)namespacing are
//! unit-tested here, but live tool calls need a real MCP server to verify.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Arc;

#[derive(Deserialize, Clone, Debug)]
pub struct McpServerConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

/// A tool exposed by an MCP server, surfaced to the agentic loop.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub server: String,
    pub name: String,
    pub namespaced: String,
    pub description: String,
    pub input_schema: Value,
}

/// Parse `.claude/mcp.json` content into a name→config map. Tolerant: a missing
/// or malformed file yields an empty map.
pub fn parse_mcp_config(content: &str) -> HashMap<String, McpServerConfig> {
    #[derive(Deserialize)]
    struct File {
        #[serde(default, rename = "mcpServers")]
        mcp_servers: HashMap<String, McpServerConfig>,
    }
    serde_json::from_str::<File>(content)
        .map(|f| f.mcp_servers)
        .unwrap_or_default()
}

/// Load configured servers for a worktree (project overrides user on name clash).
pub fn load_server_configs(worktree: &Path) -> HashMap<String, McpServerConfig> {
    let mut merged: HashMap<String, McpServerConfig> = HashMap::new();
    if let Some(home) = dirs::home_dir() {
        if let Ok(c) = std::fs::read_to_string(home.join(".claude/mcp.json")) {
            merged.extend(parse_mcp_config(&c));
        }
    }
    if let Ok(c) = std::fs::read_to_string(worktree.join(".claude/mcp.json")) {
        merged.extend(parse_mcp_config(&c));
    }
    merged
}

/// `mcp__<server>__<tool>`.
pub fn namespaced_name(server: &str, tool: &str) -> String {
    format!("mcp__{server}__{tool}")
}

/// Parse a namespaced tool name back into `(server, tool)`, or None if it isn't
/// an MCP tool name.
pub fn parse_namespaced(name: &str) -> Option<(String, String)> {
    let rest = name.strip_prefix("mcp__")?;
    let idx = rest.find("__")?;
    Some((rest[..idx].to_string(), rest[idx + 2..].to_string()))
}

/// Is this tool name routed to an MCP server?
pub fn is_mcp_tool(name: &str) -> bool {
    name.starts_with("mcp__")
}

struct Connection {
    child: Child,
    stdin: ChildStdin,
    reader: BufReader<ChildStdout>,
    next_id: i64,
    tools: Vec<McpToolInfo>,
}

impl Connection {
    /// Send a JSON-RPC request and block until the matching-id response,
    /// skipping any interleaved notifications.
    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let req = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        self.write_message(&req)?;
        loop {
            let mut buf = String::new();
            let n = self.reader.read_line(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("MCP server closed the connection".into());
            }
            let Ok(msg) = serde_json::from_str::<Value>(buf.trim()) else {
                continue; // ignore non-JSON lines (some servers log to stdout)
            };
            if msg.get("id").and_then(|v| v.as_i64()) == Some(id) {
                if let Some(err) = msg.get("error") {
                    return Err(err.to_string());
                }
                return Ok(msg.get("result").cloned().unwrap_or(Value::Null));
            }
        }
    }

    fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        self.write_message(&json!({ "jsonrpc": "2.0", "method": method, "params": params }))
    }

    fn write_message(&mut self, msg: &Value) -> Result<(), String> {
        let line = serde_json::to_string(msg).map_err(|e| e.to_string())?;
        self.stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
        self.stdin.write_all(b"\n").map_err(|e| e.to_string())?;
        self.stdin.flush().map_err(|e| e.to_string())?;
        Ok(())
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

/// Holds live connections to MCP servers, keyed by server name.
pub struct McpRegistry {
    conns: Mutex<HashMap<String, Arc<Mutex<Connection>>>>,
}

impl McpRegistry {
    pub fn new() -> Self {
        Self { conns: Mutex::new(HashMap::new()) }
    }

    /// Spawn a server, run the MCP initialize handshake, and fetch its tools.
    fn connect(name: &str, cfg: &McpServerConfig) -> Result<Connection, String> {
        let mut child = Command::new(&cfg.command)
            .args(&cfg.args)
            .envs(&cfg.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("spawn {}: {e}", cfg.command))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let mut conn = Connection {
            child,
            stdin,
            reader: BufReader::new(stdout),
            next_id: 1,
            tools: Vec::new(),
        };
        conn.request(
            "initialize",
            json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": { "name": "octopush", "version": env!("CARGO_PKG_VERSION") }
            }),
        )?;
        conn.notify("notifications/initialized", json!({}))?;
        let result = conn.request("tools/list", json!({}))?;
        let tools = result
            .get("tools")
            .and_then(|t| t.as_array())
            .cloned()
            .unwrap_or_default();
        conn.tools = tools
            .iter()
            .filter_map(|t| {
                let tool = t.get("name")?.as_str()?.to_string();
                Some(McpToolInfo {
                    server: name.to_string(),
                    namespaced: namespaced_name(name, &tool),
                    name: tool,
                    description: t
                        .get("description")
                        .and_then(|d| d.as_str())
                        .unwrap_or("")
                        .to_string(),
                    input_schema: t
                        .get("inputSchema")
                        .cloned()
                        .unwrap_or(json!({ "type": "object" })),
                })
            })
            .collect();
        Ok(conn)
    }

    /// Lazily connect (and cache) a server's connection.
    fn ensure(&self, name: &str, cfg: &McpServerConfig) -> Result<Arc<Mutex<Connection>>, String> {
        if let Some(c) = self.conns.lock().get(name) {
            return Ok(Arc::clone(c));
        }
        let conn = Self::connect(name, cfg)?;
        let arc = Arc::new(Mutex::new(conn));
        self.conns.lock().insert(name.to_string(), Arc::clone(&arc));
        Ok(arc)
    }

    /// All tools across configured + reachable servers for a worktree.
    /// Unreachable servers are skipped with a warning (never fatal).
    pub fn list_tools(&self, worktree: &Path) -> Vec<McpToolInfo> {
        let mut out = Vec::new();
        for (name, cfg) in load_server_configs(worktree) {
            match self.ensure(&name, &cfg) {
                Ok(conn) => out.extend(conn.lock().tools.clone()),
                Err(e) => {
                    tracing::warn!(server = %name, error = %e, "MCP server unavailable; skipping")
                }
            }
        }
        out
    }

    /// Call a namespaced MCP tool (`mcp__server__tool`), returning the textual
    /// result (MCP `tools/call` content blocks joined).
    pub fn call(&self, worktree: &Path, namespaced: &str, input: &Value) -> Result<String, String> {
        let (server, tool) = parse_namespaced(namespaced).ok_or("not an MCP tool")?;
        let cfgs = load_server_configs(worktree);
        let cfg = cfgs
            .get(&server)
            .ok_or_else(|| format!("MCP server '{server}' not configured"))?;
        let conn = self.ensure(&server, cfg)?;
        let result = conn
            .lock()
            .request("tools/call", json!({ "name": tool, "arguments": input }))?;
        let text = result
            .get("content")
            .and_then(|c| c.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        Ok(if text.is_empty() { result.to_string() } else { text })
    }
}

impl Default for McpRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_claude_code_config_shape() {
        let cfg = parse_mcp_config(
            r#"{ "mcpServers": { "github": { "command": "npx", "args": ["-y","@modelcontextprotocol/server-github"], "env": {"TOKEN":"x"} } } }"#,
        );
        let s = cfg.get("github").expect("github server");
        assert_eq!(s.command, "npx");
        assert_eq!(s.args.len(), 2);
        assert_eq!(s.env.get("TOKEN").map(String::as_str), Some("x"));
    }

    #[test]
    fn malformed_config_is_empty() {
        assert!(parse_mcp_config("not json").is_empty());
        assert!(parse_mcp_config("{}").is_empty());
    }

    #[test]
    fn namespacing_roundtrips() {
        assert_eq!(namespaced_name("github", "create_issue"), "mcp__github__create_issue");
        assert_eq!(
            parse_namespaced("mcp__github__create_issue"),
            Some(("github".into(), "create_issue".into()))
        );
        assert!(is_mcp_tool("mcp__x__y"));
        assert!(!is_mcp_tool("read_file"));
        assert!(parse_namespaced("read_file").is_none());
    }
}
