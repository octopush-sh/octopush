//! What the user told Talk to stop asking about (#1243): "Always allow this
//! tool" and "Trust <server>" on an MCP approval card. App-wide, not per
//! conversation: one `app_meta` row per server (`mcp_trust:<server>`), so it
//! holds in every conversation and after a restart until Settings ›
//! Integrations revokes it. Bound to the server's user-level entry
//! ([`fingerprint`]): a changed entry lapses it, and a server whose name a
//! project's `.claude/mcp.json` defines is never offered it nor covered by
//! it. Only Edit freely reads it (`talk_guard::McpTools::card`): a tool its
//! server marks destructive asks whatever it says, and it never answers a
//! file, command, secret or credentials card.

use super::McpServerConfig;
use crate::db::Db;
use crate::error::AppResult;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;

/// Emitted after trust changes (a card's answer, a revoke), so Settings and
/// the Companion read it again.
pub const CHANGED_EVENT: &str = "mcp://trust-changed";

const PREFIX: &str = "mcp_trust:";

/// One server's trust.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpTrust {
    pub server: String,
    /// The [`fingerprint`] of the user-level entry it was given to.
    #[serde(default)]
    pub config: String,
    /// "Trust <server>": every tool of it, unless its server marks the tool
    /// destructive.
    #[serde(default)]
    pub all: bool,
    /// "Always allow this tool": the server's own tool names, sorted.
    #[serde(default)]
    pub tools: Vec<String>,
}

/// A user-level entry as trust is bound to it: its command, args, env names
/// and values (a Keychain value is `""` in the file) and remote URL, hashed.
/// Changing any of them lapses the trust.
pub fn fingerprint(cfg: &McpServerConfig) -> String {
    let mut env: Vec<(&str, &str)> = cfg.env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    env.sort_unstable();
    let url = cfg.remote.as_ref().map_or("", |r| r.url.as_str());
    let canonical = serde_json::json!([cfg.command, cfg.args, env, url]).to_string();
    Sha256::digest(canonical.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// What a card reads at a call: the stored trust, and the servers it may
/// apply to there, each with its entry's fingerprint now: user-level ones
/// whose name the worktree's own `.claude/mcp.json` doesn't define.
#[derive(Clone, Debug, Default)]
pub struct TrustView {
    entries: Vec<McpTrust>,
    eligible: HashMap<String, String>,
}

impl TrustView {
    pub fn from_configs(
        entries: Vec<McpTrust>,
        user: &HashMap<String, McpServerConfig>,
        project: &HashMap<String, McpServerConfig>,
    ) -> Self {
        let eligible = user.iter().filter(|(name, _)| !project.contains_key(*name)).map(|(name, cfg)| (name.clone(), fingerprint(cfg))).collect();
        Self { entries, eligible }
    }

    /// Read from disk for `worktree`: the user's `~/.claude/mcp.json` and the
    /// worktree's own `.claude/mcp.json`.
    pub fn read(db: &parking_lot::Mutex<Db>, worktree: &Path) -> Self {
        let (user, project) = (super::load_user_config(), super::project_config(worktree));
        Self::from_configs(load(&db.lock()), &user, &project)
    }

    /// The fingerprint a card may offer trust under, if `server` may have it.
    pub fn offer(&self, server: &str) -> Option<&str> {
        self.eligible.get(server).map(String::as_str)
    }

    /// Whether `server`'s `tool` runs without a card: trusted under the
    /// entry it has now.
    pub fn covers(&self, server: &str, tool: &str) -> bool {
        self.offer(server).is_some_and(|config| {
            self.entries.iter().any(|t| t.server == server && t.config == config && (t.all || t.tools.iter().any(|x| x == tool)))
        })
    }
}

/// Every stored trust. A read that fails trusts nothing, so a broken row asks
/// again rather than runs.
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

/// The trust that still holds for `user`'s entries (what Settings lists),
/// leaving out each server `project` defines when one is given.
pub fn listed(db: &Db, user: &HashMap<String, McpServerConfig>, project: &HashMap<String, McpServerConfig>) -> Vec<McpTrust> {
    let view = TrustView::from_configs(load(db), user, project);
    view.entries.iter().filter(|t| view.offer(&t.server) == Some(t.config.as_str())).cloned().collect()
}

/// Remove the trust whose entry changed or went (after Settings saves).
pub fn prune(db: &Db, user: &HashMap<String, McpServerConfig>) -> AppResult<()> {
    for t in load(db) {
        if user.get(&t.server).map(fingerprint).as_deref() != Some(t.config.as_str()) {
            db.meta_delete(&format!("{PREFIX}{}", t.server))?;
        }
    }
    Ok(())
}

/// Trust `server`'s `tool`, or the whole server (`None`), under the entry
/// `config` fingerprints. Trust kept for another entry is dropped.
pub fn grant(db: &Db, server: &str, config: &str, tool: Option<&str>) -> AppResult<()> {
    let mut t = one(db, server)?;
    if t.config != config {
        t = McpTrust { server: server.to_string(), config: config.to_string(), ..McpTrust::default() };
    }
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

    fn entry(command: &str) -> McpServerConfig {
        McpServerConfig { command: command.into(), args: vec!["--stdio".into()], ..Default::default() }
    }

    fn user(servers: &[(&str, McpServerConfig)]) -> HashMap<String, McpServerConfig> {
        servers.iter().map(|(n, c)| (n.to_string(), c.clone())).collect()
    }

    #[test]
    fn trust_survives_a_restart_and_a_revoke_applies_at_once() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let cfg = user(&[("sample-server", entry("sample")), ("other", entry("other"))]);
        let fp = |n: &str| fingerprint(&cfg[n]);
        {
            let db = Db::open(tmp.path()).unwrap();
            grant(&db, "sample-server", &fp("sample-server"), Some("create_report")).unwrap();
            grant(&db, "sample-server", &fp("sample-server"), Some("create_report")).unwrap();
            grant(&db, "other", &fp("other"), None).unwrap();
        }
        // A new connection to the same file: the app after a restart.
        let db = Db::open(tmp.path()).unwrap();
        let view = TrustView::from_configs(load(&db), &cfg, &HashMap::new());
        assert!(view.covers("sample-server", "create_report") && !view.covers("sample-server", "delete_report"));
        assert!(view.covers("other", "anything") && !view.covers("sample", "create_report"));
        assert_eq!(listed(&db, &cfg, &HashMap::new()).len(), 2);

        revoke(&db, "sample-server", Some("create_report")).unwrap();
        revoke(&db, "other", None).unwrap();
        assert!(load(&db).is_empty(), "nothing is left");
        assert_eq!(db.meta_get("mcp_trust:other").unwrap(), None, "an empty row is removed");
    }

    #[test]
    fn a_changed_entry_lapses_the_trust_and_a_project_name_never_gets_it() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let db = Db::open(tmp.path()).unwrap();
        let before = user(&[("s", entry("sample"))]);
        grant(&db, "s", &fingerprint(&before["s"]), None).unwrap();
        assert!(TrustView::from_configs(load(&db), &before, &HashMap::new()).covers("s", "post_note"));
        // Another command, args, env name or URL is another server.
        let mut env = entry("sample");
        env.env.insert("EXTRA".into(), String::new());
        let mut value = env.clone();
        value.env.insert("EXTRA".into(), "other".into());
        assert_ne!(fingerprint(&env), fingerprint(&value), "an env value counts too");
        let mut remote = entry("sample");
        remote.remote = Some(crate::mcp::remote::RemoteConfig { url: "https://sample.invalid/mcp".into(), ..Default::default() });
        for changed in [entry("other"), McpServerConfig { args: vec![], ..entry("sample") }, env, remote] {
            let after = user(&[("s", changed)]);
            let view = TrustView::from_configs(load(&db), &after, &HashMap::new());
            assert!(!view.covers("s", "post_note") && view.offer("s").is_some(), "lapsed, and offered again");
            assert!(listed(&db, &after, &HashMap::new()).is_empty());
        }
        // A worktree whose own .claude/mcp.json defines the name: no trust,
        // and none offered.
        let project = user(&[("s", entry("sample"))]);
        let view = TrustView::from_configs(load(&db), &before, &project);
        assert!(!view.covers("s", "post_note") && view.offer("s").is_none());
        assert!(TrustView::from_configs(load(&db), &HashMap::new(), &HashMap::new()).offer("s").is_none(), "only user-level servers");
        // Granting under the new entry drops what was kept for the old one.
        let after = user(&[("s", entry("other"))]);
        grant(&db, "s", &fingerprint(&after["s"]), Some("post_note")).unwrap();
        let view = TrustView::from_configs(load(&db), &after, &HashMap::new());
        assert!(view.covers("s", "post_note") && !view.covers("s", "close_note"));
        prune(&db, &before).unwrap();
        assert!(load(&db).is_empty(), "a save that changed the entry removes it");
    }

    #[test]
    fn revoking_the_server_keeps_the_tools_allowed_one_by_one() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let db = Db::open(tmp.path()).unwrap();
        let cfg = user(&[("s", entry("sample"))]);
        let fp = fingerprint(&cfg["s"]);
        grant(&db, "s", &fp, Some("post_note")).unwrap();
        grant(&db, "s", &fp, None).unwrap();
        revoke(&db, "s", None).unwrap();
        let view = TrustView::from_configs(load(&db), &cfg, &HashMap::new());
        assert!(view.covers("s", "post_note") && !view.covers("s", "close_note"));
        // A malformed row trusts nothing.
        db.meta_set("mcp_trust:bad", "not json").unwrap();
        let bad = user(&[("bad", entry("bad"))]);
        assert!(!TrustView::from_configs(load(&db), &bad, &HashMap::new()).covers("bad", "x"));
    }
}
