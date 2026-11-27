//! What the user told Talk to stop asking about (#1243): "Always allow this
//! tool" and "Trust <server>" on an MCP approval card. App-wide, not per
//! conversation: one `app_meta` row per server (`mcp_trust:<server>`), so it
//! holds in every conversation and after a restart until Settings ›
//! Integrations revokes it. Keyed by the server's name as configured. Only
//! Edit freely reads it (`talk_guard::McpTools::card`): a tool its server
//! marks destructive asks whatever it says, and it never answers a file,
//! command, secret or credentials card.

use crate::db::Db;
use crate::error::AppResult;
use serde::{Deserialize, Serialize};

/// Emitted after trust changes (a card's answer, a revoke), so Settings and
/// the Companion read it again.
pub const CHANGED_EVENT: &str = "mcp://trust-changed";

const PREFIX: &str = "mcp_trust:";

/// One server's trust.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpTrust {
    pub server: String,
    /// "Trust <server>": every tool of it, unless its server marks the tool
    /// destructive.
    #[serde(default)]
    pub all: bool,
    /// "Always allow this tool": the server's own tool names, sorted.
    #[serde(default)]
    pub tools: Vec<String>,
}

/// Every server's trust. A read that fails trusts nothing, so a broken row
/// asks again rather than runs.
pub fn load(db: &Db) -> Vec<McpTrust> {
    match db.meta_list_prefix(PREFIX) {
        Ok(rows) => rows
            .into_iter()
            .filter_map(|(key, value)| {
                let server = key.strip_prefix(PREFIX)?.to_string();
                let stored: McpTrust = serde_json::from_str(&value).ok()?;
                Some(McpTrust { server, ..stored })
            })
            .filter(|t| t.all || !t.tools.is_empty())
            .collect(),
        Err(e) => {
            tracing::warn!(error = %e, "could not read MCP trust; every MCP card asks");
            Vec::new()
        }
    }
}

/// Whether `trust` lets `server`'s `tool` run without a card.
pub fn covers(trust: &[McpTrust], server: &str, tool: &str) -> bool {
    trust.iter().any(|t| t.server == server && (t.all || t.tools.iter().any(|x| x == tool)))
}

/// Trust `server`'s `tool`, or the whole server (`None`).
pub fn grant(db: &Db, server: &str, tool: Option<&str>) -> AppResult<()> {
    let mut t = one(db, server)?;
    match tool {
        Some(tool) if !t.tools.iter().any(|x| x == tool) => {
            t.tools.push(tool.to_string());
            t.tools.sort();
        }
        Some(_) => {}
        None => t.all = true,
    }
    store(db, &t)
}

/// Take back the trust in `server`'s `tool`, or in the whole server (`None`),
/// which leaves the tools allowed one by one as they are.
pub fn revoke(db: &Db, server: &str, tool: Option<&str>) -> AppResult<()> {
    let mut t = one(db, server)?;
    match tool {
        Some(tool) => t.tools.retain(|x| x != tool),
        None => t.all = false,
    }
    store(db, &t)
}

/// The stored row (a malformed one reads as empty and is replaced).
fn one(db: &Db, server: &str) -> AppResult<McpTrust> {
    let stored = db.meta_get(&format!("{PREFIX}{server}"))?.and_then(|v| serde_json::from_str::<McpTrust>(&v).ok());
    Ok(McpTrust { server: server.to_string(), ..stored.unwrap_or_default() })
}

fn store(db: &Db, t: &McpTrust) -> AppResult<()> {
    let key = format!("{PREFIX}{}", t.server);
    if !t.all && t.tools.is_empty() {
        return db.meta_delete(&key);
    }
    db.meta_set(&key, &serde_json::to_string(t)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trust_survives_a_restart_and_a_revoke_applies_at_once() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        {
            let db = Db::open(tmp.path()).unwrap();
            grant(&db, "sample-server", Some("create_report")).unwrap();
            grant(&db, "sample-server", Some("create_report")).unwrap();
            grant(&db, "other", None).unwrap();
        }
        // A new connection to the same file: the app after a restart.
        let db = Db::open(tmp.path()).unwrap();
        let trust = load(&db);
        assert_eq!(trust.len(), 2, "{trust:?}");
        assert!(covers(&trust, "sample-server", "create_report") && !covers(&trust, "sample-server", "delete_report"));
        assert!(covers(&trust, "other", "anything") && !covers(&trust, "sample", "create_report"));
        assert_eq!(trust.iter().find(|t| t.server == "sample-server").unwrap().tools, vec!["create_report".to_string()]);

        revoke(&db, "sample-server", Some("create_report")).unwrap();
        revoke(&db, "other", None).unwrap();
        assert!(load(&db).is_empty(), "nothing is left");
        assert_eq!(db.meta_get("mcp_trust:other").unwrap(), None, "an empty row is removed");
    }

    #[test]
    fn revoking_the_server_keeps_the_tools_allowed_one_by_one() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let db = Db::open(tmp.path()).unwrap();
        grant(&db, "s", Some("post_note")).unwrap();
        grant(&db, "s", None).unwrap();
        revoke(&db, "s", None).unwrap();
        let trust = load(&db);
        assert!(covers(&trust, "s", "post_note") && !covers(&trust, "s", "close_note"));
        // A malformed row trusts nothing.
        db.meta_set("mcp_trust:bad", "not json").unwrap();
        assert!(!covers(&load(&db), "bad", "x"));
    }
}
