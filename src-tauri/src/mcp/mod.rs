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

#[derive(Serialize, Deserialize, Clone, Debug)]
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

/// The user-level config path (`~/.claude/mcp.json`), if a home dir exists.
fn user_config_path() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude/mcp.json"))
}

/// Load ONLY the user-level (`~/.claude/mcp.json`) servers — the set the
/// Settings UI manages (project-level `.claude/mcp.json` is repo-committed and
/// edited in the repo, not here).
pub fn load_user_config() -> HashMap<String, McpServerConfig> {
    user_config_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|c| parse_mcp_config(&c))
        .unwrap_or_default()
}

/// Persist the user-level server map to `~/.claude/mcp.json` (pretty JSON under
/// the `mcpServers` key, matching the Claude-Code shape).
pub fn save_user_config(servers: &HashMap<String, McpServerConfig>) -> Result<(), String> {
    let path = user_config_path().ok_or("no home directory")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // Preserve any sibling top-level keys the user keeps in mcp.json — only the
    // `mcpServers` object is ours to rewrite. (Comments aren't preserved; JSON.)
    let mut root = std::fs::read_to_string(&path)
        .ok()
        .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
        .filter(|v| v.is_object())
        .unwrap_or_else(|| serde_json::json!({}));
    root["mcpServers"] = serde_json::to_value(servers).map_err(|e| e.to_string())?;
    let pretty = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(&path, pretty).map_err(|e| e.to_string())
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
            // A server→client REQUEST (has both id and method, e.g.
            // sampling/createMessage, roots/list) — reply method-not-found so
            // the server isn't left blocked waiting on us (which would deadlock
            // our own read). Plain notifications (method, no id) are ignored.
            if msg.get("method").is_some() {
                if let Some(req_id) = msg.get("id") {
                    let _ = self.write_message(&json!({
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "error": { "code": -32601, "message": "method not supported" }
                    }));
                }
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
        // Kill AND reap — std's Child doesn't wait on drop, so without this the
        // killed server lingers as a zombie process.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Holds live connections to MCP servers, keyed by server name.
pub struct McpRegistry {
    conns: Mutex<HashMap<String, Arc<Mutex<Connection>>>>,
    /// Servers that failed to start this session — skipped on subsequent turns
    /// so a broken config doesn't re-spawn a failing process every turn.
    failed: Mutex<std::collections::HashSet<String>>,
}

impl McpRegistry {
    pub fn new() -> Self {
        Self {
            conns: Mutex::new(HashMap::new()),
            failed: Mutex::new(std::collections::HashSet::new()),
        }
    }

    /// Drop a server's cached connection (e.g. after it errored) so the next
    /// use re-spawns it.
    fn evict(&self, name: &str) {
        self.conns.lock().remove(name);
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

    /// One-shot smoke test: spawn the server, run the handshake, and return its
    /// tools — then drop the connection (the child is killed on drop). Used by
    /// the Settings "Test connection" button and the integration test. Does NOT
    /// touch the cache or the failed-set, so testing a broken config doesn't
    /// poison a real session.
    pub fn test_connect(name: &str, cfg: &McpServerConfig) -> Result<Vec<McpToolInfo>, String> {
        let conn = Self::connect(name, cfg)?;
        Ok(conn.tools.clone())
    }

    /// Lazily connect (and cache) a server's connection.
    fn ensure(&self, name: &str, cfg: &McpServerConfig) -> Result<Arc<Mutex<Connection>>, String> {
        if let Some(c) = self.conns.lock().get(name) {
            return Ok(Arc::clone(c));
        }
        if self.failed.lock().contains(name) {
            return Err(format!("MCP server '{name}' previously failed; skipping"));
        }
        match Self::connect(name, cfg) {
            Ok(conn) => {
                let arc = Arc::new(Mutex::new(conn));
                self.conns.lock().insert(name.to_string(), Arc::clone(&arc));
                Ok(arc)
            }
            Err(e) => {
                // Remember the failure so we don't re-spawn it every turn.
                self.failed.lock().insert(name.to_string());
                Err(e)
            }
        }
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
        let result = match conn
            .lock()
            .request("tools/call", json!({ "name": tool, "arguments": input }))
        {
            Ok(r) => r,
            Err(e) => {
                // The connection is likely dead (broken pipe / closed) — evict
                // it so the next call re-spawns a fresh server instead of
                // reusing a corpse forever.
                self.evict(&server);
                return Err(e);
            }
        };
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

    // A minimal MCP server (bash) that speaks just enough JSON-RPC to exercise
    // the real stdio client: initialize → tools/list → tools/call, echoing back
    // each request's id. Used to verify the client end-to-end without network.
    const FIXTURE: &str = r#"#!/usr/bin/env bash
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"fixture","version":"0"}}}\n' "$id" ;;
    *'"method":"tools/list"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"echo","description":"echoes","inputSchema":{"type":"object"}}]}}\n' "$id" ;;
    *'"method":"tools/call"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"pong"}]}}\n' "$id" ;;
  esac
done
"#;

    #[cfg(unix)]
    #[test]
    fn client_connects_and_lists_tools_against_a_fixture_server() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("fixture.sh");
        std::fs::write(&script, FIXTURE).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        let cfg = McpServerConfig {
            command: "bash".into(),
            args: vec![script.to_string_lossy().to_string()],
            env: HashMap::new(),
        };
        // Real spawn + initialize handshake + tools/list over stdio JSON-RPC.
        let tools = McpRegistry::test_connect("fix", &cfg).expect("fixture should connect");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "echo");
        assert_eq!(tools[0].namespaced, "mcp__fix__echo");

        // Full path incl. tools/call via the cached registry against a worktree
        // config pointing at the same fixture.
        let claude = dir.path().join(".claude");
        std::fs::create_dir_all(&claude).unwrap();
        std::fs::write(
            claude.join("mcp.json"),
            format!(
                r#"{{"mcpServers":{{"fix":{{"command":"bash","args":[{:?}]}}}}}}"#,
                script.to_string_lossy()
            ),
        )
        .unwrap();
        let reg = McpRegistry::new();
        let out = reg
            .call(dir.path(), "mcp__fix__echo", &serde_json::json!({"x": 1}))
            .expect("tools/call should succeed");
        assert_eq!(out, "pong");
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
