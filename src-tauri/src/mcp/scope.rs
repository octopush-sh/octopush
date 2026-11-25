//! Which MCP servers a Talk conversation may use, and what the registry knows
//! about each one: the Companion's "can use" chips.
//!
//! Kept apart from `mod.rs`, which owns the transport and the registry's life
//! cycle. Nothing here starts, stops or resets a server: discovery only leaves
//! out the servers a conversation switched off, and the status read spawns
//! nothing.

use super::{load_server_configs, McpRegistry, McpToolInfo};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;

/// Emitted after Settings saves the MCP config (`save_mcp_config`).
pub const CONFIG_CHANGED_EVENT: &str = "mcp://config-changed";
/// Emitted when what the registry knows about a server may have changed:
/// Settings' Reconnect, or a turn's discovery starting (or failing to start)
/// servers.
pub const STATUS_CHANGED_EVENT: &str = "mcp://status-changed";

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum McpServerState {
    /// Running, started with the config on disk now.
    Connected,
    /// Not started yet, or stopped since (a save, Reconnect, a broken pipe):
    /// the next use starts it.
    Idle,
    /// Its last start with this config failed; turns skip it until the
    /// config changes or the user reconnects it.
    Failed,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatus {
    pub name: String,
    pub state: McpServerState,
    /// How many tools it offers, when connected (`None` while a call holds
    /// the connection: the status never waits on one).
    pub tools: Option<usize>,
    /// The first line of why it failed, when it did.
    pub reason: Option<String>,
}

impl McpRegistry {
    /// [`Self::list_tools`] without the servers in `off`. A server switched
    /// off in a conversation is never started for it, so a broken one costs
    /// that conversation nothing.
    pub fn list_tools_except(&self, worktree: &Path, off: &HashSet<String>) -> Vec<McpToolInfo> {
        let mut out = Vec::new();
        for (name, cfg) in load_server_configs(worktree) {
            if off.contains(&name) {
                continue;
            }
            match self.ensure(&name, &cfg) {
                Ok((conn, _)) => out.extend(conn.lock().tools.clone()),
                Err(e) => tracing::warn!(server = %name, error = %e, "MCP server unavailable; skipping"),
            }
        }
        out
    }

    /// Every server configured for `worktree` (project ∪ user), sorted, with
    /// what this session knows about it. Reads the registry only: it spawns
    /// nothing, and takes one registry lock at a time and never a
    /// connection's own lock (a call in flight can hold that for a minute).
    pub fn status(&self, worktree: &Path) -> Vec<McpServerStatus> {
        let cfgs = load_server_configs(worktree);
        let mut names: Vec<&String> = cfgs.keys().collect();
        names.sort();
        // A connection or failure counts only for the config on disk now: one
        // left from an edited entry is replaced on the next use.
        let live: HashMap<&str, Option<usize>> = {
            let conns = self.conns.lock();
            names
                .iter()
                .filter_map(|n| {
                    let e = conns.get(n.as_str()).filter(|e| e.cfg == cfgs[*n])?;
                    Some((n.as_str(), e.conn.try_lock().map(|c| c.tools.len())))
                })
                .collect()
        };
        let failed: HashMap<&str, String> = {
            let failed = self.failed.lock();
            names
                .iter()
                .filter_map(|n| {
                    let f = failed.get(n.as_str()).filter(|f| f.cfg == cfgs[*n])?;
                    Some((n.as_str(), f.reason.trim().lines().next().unwrap_or("").trim().to_string()))
                })
                .collect()
        };
        names
            .into_iter()
            .map(|n| {
                let (state, tools, reason) = if let Some(tools) = live.get(n.as_str()) {
                    (McpServerState::Connected, *tools, None)
                } else if let Some(reason) = failed.get(n.as_str()) {
                    (McpServerState::Failed, None, Some(reason.clone()))
                } else {
                    (McpServerState::Idle, None, None)
                };
                McpServerStatus { name: n.clone(), state, tools, reason }
            })
            .collect()
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::mcp::McpServerConfig;

    // Answers the handshake with two tools; never answers a call.
    const TWO_TOOLS: &str = r#"#!/usr/bin/env bash
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"docs","version":"0"}}}\n' "$id" ;;
    *'"method":"tools/list"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"search","inputSchema":{"type":"object"}},{"name":"read","inputSchema":{"type":"object"}}]}}\n' "$id" ;;
  esac
done
"#;

    /// Write `servers` as `dir`'s project-level `.claude/mcp.json`.
    fn write_servers(dir: &Path, servers: &[(&str, McpServerConfig)]) {
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        let map: HashMap<&str, &McpServerConfig> = servers.iter().map(|(n, c)| (*n, c)).collect();
        std::fs::write(dir.join(".claude/mcp.json"), serde_json::json!({ "mcpServers": map }).to_string()).unwrap();
    }

    fn of<'a>(all: &'a [McpServerStatus], name: &str) -> &'a McpServerStatus {
        all.iter().find(|s| s.name == name).unwrap_or_else(|| panic!("{name} missing from {all:?}"))
    }

    #[test]
    fn a_connected_server_reports_its_tools_until_it_is_reset() {
        use std::os::unix::fs::PermissionsExt;
        let wt = tempfile::tempdir().unwrap();
        let script = wt.path().join("docs.sh");
        std::fs::write(&script, TWO_TOOLS).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let cfg = McpServerConfig {
            command: "bash".into(),
            args: vec![script.to_string_lossy().into_owned()],
            ..Default::default()
        };
        write_servers(wt.path(), &[("docs-server", cfg)]);
        let reg = McpRegistry::new();

        let tools = reg.list_tools_except(wt.path(), &HashSet::new());
        assert_eq!(tools.iter().map(|t| t.namespaced.as_str()).collect::<Vec<_>>(), vec!["mcp__docs-server__search", "mcp__docs-server__read"]);
        let status = reg.status(wt.path());
        assert_eq!(
            status,
            vec![McpServerStatus { name: "docs-server".into(), state: McpServerState::Connected, tools: Some(2), reason: None }]
        );

        reg.reset_server("docs-server");
        assert_eq!(of(&reg.status(wt.path()), "docs-server").state, McpServerState::Idle);
    }
}
