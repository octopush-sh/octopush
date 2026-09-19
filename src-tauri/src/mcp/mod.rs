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
use std::process::{Child, ChildStdin, ChildStderr, ChildStdout, Command, Stdio};
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
    /// The server marked the tool read-only (`annotations.readOnlyHint`).
    /// Anything else is treated as a possible write when a sub-agent calls it.
    #[serde(default)]
    pub read_only: bool,
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

/// The server process, behind its own lock so it can be killed while a
/// request holds the connection lock (a hung `read_line` inside `request`
/// would otherwise keep the process alive for as long as the server likes).
type ChildHandle = Arc<Mutex<Child>>;

struct Connection {
    child: ChildHandle,
    stdin: ChildStdin,
    reader: BufReader<ChildStdout>,
    next_id: i64,
    tools: Vec<McpToolInfo>,
    /// Stderr drained by a background thread; included in "closed the connection"
    /// errors so bridge tools (e.g. mcp-remote) can surface auth/network failures.
    stderr_log: Arc<Mutex<String>>,
}

impl Connection {
    /// Send a JSON-RPC request and block until the matching-id response,
    /// skipping any interleaved notifications.
    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        let req = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        self.write_message(&req)?;
        // Non-JSON stdout lines collected for diagnostics (bridge tools like
        // mcp-remote print auth URLs and status to stdout before the handshake).
        let mut stdout_lines: Vec<String> = Vec::new();
        loop {
            let mut buf = String::new();
            let n = self.reader.read_line(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                let stderr = self.stderr_log.lock();
                let stderr = stderr.trim();
                let stdout = stdout_lines.join("\n");
                let stdout = stdout.trim();
                let mut parts: Vec<&str> = vec!["MCP server closed the connection"];
                if !stdout.is_empty() {
                    parts.push(stdout);
                }
                if !stderr.is_empty() {
                    parts.push(stderr);
                }
                return Err(parts.join("\n"));
            }
            let Ok(msg) = serde_json::from_str::<Value>(buf.trim()) else {
                // Collect non-JSON lines (bridge tools may print auth/status here).
                let line = buf.trim().to_string();
                if !line.is_empty() && stdout_lines.len() < 20 {
                    stdout_lines.push(line);
                }
                continue;
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

/// Kill AND reap a server process — std's Child doesn't wait on drop, so
/// without the wait a killed server lingers as a zombie. The server is
/// spawned in its own process group, and the whole group is killed: a
/// wrapper (`npx`, a shell) hands its stdout pipe to the real server, and
/// killing only the wrapper would leave that pipe open — and our reader
/// blocked — for as long as the grandchild lives.
fn kill_and_reap(child: &ChildHandle) {
    let mut c = child.lock();
    // Only while the child is unreaped: a reaped pid is free for reuse, and
    // the group signal is raw (std's `kill` guards itself, this must too).
    // The handle is shared, so a second caller after the reap is normal.
    if !matches!(c.try_wait(), Ok(None)) {
        return;
    }
    #[cfg(unix)]
    {
        let pgid = c.id() as libc::pid_t;
        if pgid > 0 {
            // SAFETY: plain syscall on a pid that is still ours — the child is
            // unreaped (checked above), so the number cannot have been reused.
            unsafe {
                libc::kill(-pgid, libc::SIGKILL);
            }
        }
    }
    let _ = c.kill();
    let _ = c.wait();
}

impl Drop for Connection {
    fn drop(&mut self) {
        kill_and_reap(&self.child);
    }
}

/// A live server: the connection (locked for the length of a request) and
/// its process handle (reachable without that lock — what an abort kills).
/// Kept together so the two can never describe different processes.
struct Entry {
    conn: Arc<Mutex<Connection>>,
    child: ChildHandle,
}

/// Drain `stderr` into `log`, capped at 4 KiB. Runs on a dedicated thread per
/// server so the child process is never blocked writing diagnostics.
fn drain_stderr(stderr: ChildStderr, log: Arc<Mutex<String>>) {
    let reader = BufReader::new(stderr);
    for line in reader.lines().map_while(Result::ok) {
        let mut buf = log.lock();
        if buf.len() < 4096 {
            buf.push_str(&line);
            buf.push('\n');
        }
    }
}

/// Holds live connections to MCP servers, keyed by server name.
pub struct McpRegistry {
    conns: Mutex<HashMap<String, Entry>>,
    /// Processes spawned whose handshake has not finished yet — abortable
    /// while `connect` is still reading, which would otherwise hang the
    /// per-server connect lock for every later caller.
    pending: Mutex<HashMap<String, ChildHandle>>,
    /// One lock per server around spawn + handshake, so two callers racing to
    /// a not-yet-connected server spawn it once, not twice.
    connecting: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// Servers that failed to start this session — skipped on subsequent turns
    /// so a broken config doesn't re-spawn a failing process every turn.
    failed: Mutex<std::collections::HashSet<String>>,
}

/// How long one MCP `tools/call` may take on the wire before the caller
/// gives up and stops the server (`call_bounded`).
pub const CALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// The server a namespaced tool name belongs to.
pub fn server_of(namespaced: &str) -> Option<String> {
    parse_namespaced(namespaced).map(|(s, _)| s)
}

/// `registry.call(...)` off the async runtime, bounded by `bound`. On a
/// timeout the server process is **stopped** (`abort_server`), so a call
/// reported as timed out can never complete later in the background — the
/// blocked worker gets EOF and returns, and the next call re-spawns the
/// server. The error says so, and warns that a request the server had
/// already sent (a write to a tracker) may still have landed.
pub async fn call_bounded(
    registry: Arc<McpRegistry>,
    worktree: std::path::PathBuf,
    namespaced: String,
    input: Value,
    bound: std::time::Duration,
) -> Result<String, String> {
    let reg = Arc::clone(&registry);
    let name = namespaced.clone();
    match tokio::time::timeout(bound, tokio::task::spawn_blocking(move || reg.call(&worktree, &name, &input))).await {
        Ok(Ok(Ok(out))) => Ok(out),
        Ok(Ok(Err(e))) => Err(format!("MCP error: {e}")),
        Ok(Err(e)) => Err(format!("MCP error: call task failed: {e}")),
        Err(_) => {
            if let Some(server) = server_of(&namespaced) {
                // Kill + reap off the runtime thread.
                let reg = Arc::clone(&registry);
                let _ = tokio::task::spawn_blocking(move || reg.abort_server(&server)).await;
            }
            Err(format!(
                "MCP error: `{namespaced}` timed out after {}s. The server was stopped, so this call \
                 cannot complete later; if it had already sent its request, the change may exist — \
                 check before retrying.",
                bound.as_secs()
            ))
        }
    }
}

impl McpRegistry {
    pub fn new() -> Self {
        Self {
            conns: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            connecting: Mutex::new(HashMap::new()),
            failed: Mutex::new(std::collections::HashSet::new()),
        }
    }

    /// Drop a server's cached connection after IT errored — only when the
    /// cached one is still `conn` (a sibling may have re-spawned the server
    /// in the meantime; that fresh connection must not be thrown away). The
    /// process itself is killed when the last holder lets go
    /// (`Connection::drop`).
    fn evict_if_current(&self, name: &str, conn: &Arc<Mutex<Connection>>) {
        let mut conns = self.conns.lock();
        if conns.get(name).is_some_and(|e| Arc::ptr_eq(&e.conn, conn)) {
            conns.remove(name);
        }
    }

    /// Stop a server now — kill its process and forget the connection — even
    /// while a request on it is blocked reading, or while its handshake is
    /// still in flight. That reader gets EOF and returns an error; the next
    /// call re-spawns the server.
    pub fn abort_server(&self, name: &str) {
        let live = self.conns.lock().remove(name);
        let pending = self.pending.lock().get(name).cloned();
        for child in live.iter().map(|e| &e.child).chain(pending.iter()) {
            tracing::warn!(server = %name, "stopping MCP server after a timed-out call");
            kill_and_reap(child);
        }
    }

    /// Spawn a server, run the MCP initialize handshake, and fetch its tools.
    /// The process is registered as `pending` for the length of the
    /// handshake so an abort can reach it.
    fn connect(&self, name: &str, cfg: &McpServerConfig) -> Result<Connection, String> {
        let child = Self::spawn(cfg)?;
        self.pending.lock().insert(name.to_string(), Arc::clone(&child));
        let result = Self::handshake(name, child);
        self.pending.lock().remove(name);
        result
    }

    fn spawn(cfg: &McpServerConfig) -> Result<ChildHandle, String> {
        let mut cmd = Command::new(&cfg.command);
        cmd.args(&cfg.args)
            .envs(&cfg.env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // Own process group, so an abort can take the wrapper AND the
        // server it spawned (see `kill_and_reap`).
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let child = cmd.spawn().map_err(|e| format!("spawn {}: {e}", cfg.command))?;
        Ok(Arc::new(Mutex::new(child)))
    }

    /// The MCP initialize handshake + `tools/list` over an already-spawned
    /// process. A failure drops the connection, which kills the process.
    fn handshake(name: &str, child: ChildHandle) -> Result<Connection, String> {
        let (stdin, stdout, stderr) = {
            let mut c = child.lock();
            (
                c.stdin.take().ok_or("no stdin")?,
                c.stdout.take().ok_or("no stdout")?,
                c.stderr.take(),
            )
        };
        // Drain stderr on a background thread so the process is never blocked
        // writing diagnostics. The buffer is capped at 4 KiB; we include it in
        // "closed the connection" errors so bridge tools (e.g. mcp-remote) can
        // surface auth and network failures instead of silently exiting.
        let stderr_log: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
        if let Some(stderr) = stderr {
            let log = Arc::clone(&stderr_log);
            std::thread::spawn(move || drain_stderr(stderr, log));
        }
        let mut conn = Connection {
            child,
            stdin,
            reader: BufReader::new(stdout),
            next_id: 1,
            tools: Vec::new(),
            stderr_log,
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
                    read_only: t
                        .get("annotations")
                        .and_then(|a| a.get("readOnlyHint"))
                        .and_then(|r| r.as_bool())
                        .unwrap_or(false),
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
        let conn = Self::handshake(name, Self::spawn(cfg)?)?;
        Ok(conn.tools.clone())
    }

    /// Lazily connect (and cache) a server's connection. Spawn + handshake
    /// run under a per-server lock: concurrent first callers (a sub-agent
    /// fan-out) wait for one connection instead of each spawning their own.
    fn ensure(&self, name: &str, cfg: &McpServerConfig) -> Result<Arc<Mutex<Connection>>, String> {
        if let Some(e) = self.conns.lock().get(name) {
            return Ok(Arc::clone(&e.conn));
        }
        let spawn_lock = Arc::clone(
            self.connecting.lock().entry(name.to_string()).or_insert_with(|| Arc::new(Mutex::new(()))),
        );
        let _spawning = spawn_lock.lock();
        if let Some(e) = self.conns.lock().get(name) {
            return Ok(Arc::clone(&e.conn));
        }
        if self.failed.lock().contains(name) {
            return Err(format!("MCP server '{name}' previously failed; skipping"));
        }
        match self.connect(name, cfg) {
            Ok(conn) => {
                let child = Arc::clone(&conn.child);
                let arc = Arc::new(Mutex::new(conn));
                self.conns.lock().insert(name.to_string(), Entry { conn: Arc::clone(&arc), child });
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
                self.evict_if_current(&server, &conn);
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

    // A fixture that answers the handshake but never answers `tools/call`
    // (it sleeps), and appends a line to `$SPAWN_LOG` each time it starts.
    const HANGING_FIXTURE: &str = r#"#!/usr/bin/env bash
echo start >> "$SPAWN_LOG"
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"hang","version":"0"}}}\n' "$id" ;;
    *'"method":"tools/list"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"slow","description":"never answers","inputSchema":{"type":"object"},"annotations":{"readOnlyHint":true}}]}}\n' "$id" ;;
    *'"method":"tools/call"'*)
      echo call >> "$SPAWN_LOG"; sleep 30 ;;
  esac
done
"#;

    // A fixture that never answers `initialize` at all.
    const MUTE_FIXTURE: &str = r#"#!/usr/bin/env bash
echo start >> "$SPAWN_LOG"
sleep 30
"#;

    #[cfg(unix)]
    fn log_lines(log: &std::path::Path, word: &str) -> usize {
        std::fs::read_to_string(log).unwrap_or_default().lines().filter(|l| *l == word).count()
    }

    #[cfg(unix)]
    fn wait_for(log: &std::path::Path, word: &str, n: usize) {
        let started = std::time::Instant::now();
        while log_lines(log, word) < n {
            assert!(started.elapsed() < std::time::Duration::from_secs(10), "fixture never wrote {word}");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }

    #[cfg(unix)]
    fn hanging_worktree() -> (tempfile::TempDir, std::path::PathBuf) {
        fixture_worktree(HANGING_FIXTURE)
    }

    #[cfg(unix)]
    fn fixture_worktree(fixture: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("hang.sh");
        std::fs::write(&script, fixture).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let log = dir.path().join("spawns.log");
        let claude = dir.path().join(".claude");
        std::fs::create_dir_all(&claude).unwrap();
        std::fs::write(
            claude.join("mcp.json"),
            format!(
                r#"{{"mcpServers":{{"hang":{{"command":"bash","args":[{:?}],"env":{{"SPAWN_LOG":{:?}}}}}}}}}"#,
                script.to_string_lossy(),
                log.to_string_lossy()
            ),
        )
        .unwrap();
        (dir, log)
    }

    #[cfg(unix)]
    #[test]
    fn abort_server_unblocks_a_hung_call_and_the_next_call_respawns() {
        let (dir, log) = hanging_worktree();
        let reg = Arc::new(McpRegistry::new());
        let tools = reg.list_tools(dir.path());
        assert_eq!(tools.len(), 1);
        assert!(tools[0].read_only, "readOnlyHint is parsed");
        // A call that the server never answers, on its own thread.
        let (r2, wt) = (Arc::clone(&reg), dir.path().to_path_buf());
        let worker = std::thread::spawn(move || r2.call(&wt, "mcp__hang__slow", &json!({})));
        wait_for(&log, "call", 1);
        assert!(!worker.is_finished(), "the call is blocked on the server");
        let started = std::time::Instant::now();
        reg.abort_server("hang");
        let res = worker.join().unwrap();
        assert!(res.is_err(), "the blocked call returns once the server is stopped: {res:?}");
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        // The next use re-spawns the server (a second start line) and works.
        assert_eq!(reg.list_tools(dir.path()).len(), 1);
        assert_eq!(log_lines(&log, "start"), 2, "one spawn before the abort, one after");
    }

    #[cfg(unix)]
    #[test]
    fn abort_reaches_a_server_stuck_in_its_handshake() {
        let (dir, log) = fixture_worktree(MUTE_FIXTURE);
        let reg = Arc::new(McpRegistry::new());
        let (r2, wt) = (Arc::clone(&reg), dir.path().to_path_buf());
        let worker = std::thread::spawn(move || r2.list_tools(&wt).len());
        wait_for(&log, "start", 1);
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(!worker.is_finished(), "the handshake is hung");
        let started = std::time::Instant::now();
        reg.abort_server("hang");
        assert_eq!(worker.join().unwrap(), 0, "the hung connect fails instead of blocking forever");
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        assert!(reg.pending.lock().is_empty() && reg.conns.lock().is_empty());
        // A second caller is not blocked behind the dead handshake.
        let started = std::time::Instant::now();
        let _ = reg.list_tools(dir.path());
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn call_bounded_times_out_stops_the_server_and_says_so() {
        let (dir, log) = hanging_worktree();
        let reg = Arc::new(McpRegistry::new());
        let err = call_bounded(
            Arc::clone(&reg),
            dir.path().to_path_buf(),
            "mcp__hang__slow".into(),
            json!({}),
            std::time::Duration::from_secs(3),
        )
        .await
        .unwrap_err();
        assert!(err.contains("timed out") && err.contains("server was stopped"), "{err}");
        // Stopped: the connection is gone and the process was reaped; a
        // later discovery spawns a fresh one.
        assert!(reg.conns.lock().is_empty() && reg.pending.lock().is_empty());
        let wt = dir.path().to_path_buf();
        let tools = tokio::task::spawn_blocking(move || reg.list_tools(&wt)).await.unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(log_lines(&log, "start"), 2);
    }

    #[cfg(unix)]
    #[test]
    fn concurrent_first_callers_spawn_a_server_once() {
        let (dir, log) = hanging_worktree();
        let reg = Arc::new(McpRegistry::new());
        let handles: Vec<_> = (0..4)
            .map(|_| {
                let (r, wt) = (Arc::clone(&reg), dir.path().to_path_buf());
                std::thread::spawn(move || r.list_tools(&wt).len())
            })
            .collect();
        for h in handles {
            assert_eq!(h.join().unwrap(), 1);
        }
        assert_eq!(log_lines(&log, "start"), 1, "one process for four callers");
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
        assert_eq!(server_of("mcp__github__create_issue").as_deref(), Some("github"));
        assert_eq!(server_of("read_file"), None);
    }
}
