//! MCP server secrets in the macOS login Keychain.
//!
//! An entry lists in `secret_env` the env names whose values live in the
//! Keychain (service [`SERVICE`], account `<server>/<NAME>`); `mcp.json`
//! holds an empty string for each. The values are read at spawn
//! ([`resolve`]) and written when Settings saves ([`plan_secrets`], then
//! [`apply_before_save`] / [`apply_after_save`]). They never leave this Mac
//! and are never sent back to the frontend.
//!
//! Only user-level entries (the ones Settings writes) can name Keychain
//! items: a project's `.claude/mcp.json` is a file in someone's repo, so its
//! `secret_env` is ignored (`load_server_configs`), and the file is never
//! rewritten.

use super::{remote, McpServerConfig};
use parking_lot::Mutex;
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock};

/// The Keychain service every MCP secret is stored under.
pub const SERVICE: &str = "octopush-mcp";

/// Where secret values are kept. The Keychain in the app; a map in tests.
pub trait SecretStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, value: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

/// The Keychain account of server `server`'s env var `name`.
pub fn account(server: &str, name: &str) -> String {
    format!("{server}/{name}")
}

/// An env name that reads as a credential: it moves to the Keychain on save
/// unless the user chose to keep it in `mcp.json` (`plain_env`), and the
/// form's "Keep in Keychain" starts on for it.
static SECRET_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)TOKEN|KEY|SECRET|PASSWORD|AUTH|BEARER").unwrap());

pub fn looks_secret(name: &str) -> bool {
    SECRET_NAME.is_match(name)
}

/// The login Keychain. Each item is read at most once per launch and then
/// served from memory: an ad-hoc-signed build prompts on every read (as
/// `auth.rs` notes for the session).
#[derive(Default)]
pub struct Keychain {
    cache: Mutex<HashMap<String, Option<String>>>,
}

impl Keychain {
    fn entry(account: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, account).map_err(|e| format!("the Keychain is unavailable: {e}"))
    }
}

impl SecretStore for Keychain {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        if let Some(hit) = self.cache.lock().get(account) {
            return Ok(hit.clone());
        }
        let value = match Self::entry(account)?.get_password() {
            Ok(v) => Some(v),
            Err(keyring::Error::NoEntry) => None,
            Err(e) => return Err(format!("couldn't read it from the Keychain: {e}")),
        };
        self.cache.lock().insert(account.to_string(), value.clone());
        Ok(value)
    }

    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        Self::entry(account)?
            .set_password(value)
            .map_err(|e| format!("couldn't save it to the Keychain: {e}"))?;
        self.cache.lock().insert(account.to_string(), Some(value.to_string()));
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        let result = match Self::entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("couldn't delete it from the Keychain: {e}")),
        };
        self.cache.lock().insert(account.to_string(), None);
        result
    }
}

static KEYCHAIN: LazyLock<Arc<Keychain>> = LazyLock::new(|| Arc::new(Keychain::default()));

/// The app's one Keychain store (one cache for Talk, Settings and saves).
pub fn keychain() -> Arc<dyn SecretStore> {
    Arc::clone(&*KEYCHAIN) as Arc<dyn SecretStore>
}

/// The values of `cfg.secret_env`, for server `server`'s process. A missing
/// one fails the start, naming what to do; an entry without secrets never
/// touches the store.
pub fn resolve(server: &str, cfg: &McpServerConfig, store: &dyn SecretStore) -> Result<Vec<(String, String)>, String> {
    let mut out = Vec::with_capacity(cfg.secret_env.len());
    for name in &cfg.secret_env {
        match store.get(&account(server, name)) {
            Ok(Some(value)) => out.push((name.clone(), value)),
            Ok(None) => {
                return Err(format!(
                    "The token for {server} isn't in the Keychain; edit the server to enter it.\n{name} has no saved value."
                ))
            }
            Err(e) => return Err(format!("Octopush couldn't read the token for {server}: {e}")),
        }
    }
    Ok(out)
}

/// `text` with every resolved secret value replaced, so a server that echoes
/// its credentials can't show them in a failure.
pub fn scrub(text: &str, secrets: &[(String, String)]) -> String {
    let mut out = text.to_string();
    for (_, value) in secrets.iter().filter(|(_, v)| v.len() >= 4) {
        out = out.replace(value.as_str(), crate::secret_scan::REDACTED);
    }
    out
}

/// What a save does to the Keychain, worked out before anything is written.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct SecretPlan {
    /// A renamed server's saved values: `(from, to)` accounts.
    pub copies: Vec<(String, String)>,
    /// New values: `(account, value)`.
    pub writes: Vec<(String, String)>,
    /// Items no entry names any more.
    pub deletes: Vec<String>,
    /// Servers whose secret values changed: Talk restarts them even when
    /// their entry reads the same.
    pub touched: Vec<String>,
}

/// Move every secret value out of the user-level `servers` about to be
/// saved, and plan the Keychain changes.
///
/// - A `secret_env` name with a value is a new value to store; with none
///   (`""`) it keeps the saved one (copied along a rename).
/// - **Migration:** any other env value whose name [`looks_secret`], isn't
///   empty or a `$VAR` reference and isn't in `plain_env` moves too.
/// - A server that went, or a name it no longer lists, loses its item.
///
/// `renamed` maps a new name to the old one it replaces. Every name in
/// `secret_env` ends with `""` in `env`, sorted and once.
pub fn plan_secrets(
    old: &HashMap<String, McpServerConfig>,
    servers: &mut HashMap<String, McpServerConfig>,
    renamed: &HashMap<String, String>,
) -> SecretPlan {
    let mut plan = SecretPlan::default();
    // The old entry each saved server continues: its rename source, else itself.
    let source = |name: &str| -> Option<String> {
        match renamed.get(name) {
            Some(from) if from != name && old.contains_key(from) => Some(from.clone()),
            _ => old.contains_key(name).then(|| name.to_string()),
        }
    };
    let mut kept: HashSet<String> = HashSet::new();
    let mut names: Vec<String> = servers.keys().cloned().collect();
    names.sort();
    for name in &names {
        let from = source(name);
        let prev = from.as_deref().and_then(|f| old.get(f));
        let cfg = servers.get_mut(name).expect("listed above");
        let plain: HashSet<&String> = cfg.plain_env.iter().collect();
        let migrate: Vec<String> = cfg
            .env
            .iter()
            .filter(|(k, v)| {
                looks_secret(k)
                    && !cfg.secret_env.contains(k)
                    && !plain.contains(k)
                    && !k.starts_with(remote::HEADER_ENV_PREFIX)
                    && !v.trim().is_empty()
                    && !v.trim_start().starts_with('$')
            })
            .map(|(k, _)| k.clone())
            .collect();
        drop(plain);
        cfg.secret_env.extend(migrate);
        cfg.secret_env.retain(|n| !n.trim().is_empty());
        cfg.secret_env.sort();
        cfg.secret_env.dedup();
        let mut wrote = false;
        for key in cfg.secret_env.clone() {
            let value = cfg.env.insert(key.clone(), String::new()).unwrap_or_default();
            let to = account(name, &key);
            if !value.is_empty() {
                plan.writes.push((to.clone(), value));
                wrote = true;
            } else if let (Some(f), Some(p)) = (from.as_deref(), prev) {
                if f != name && p.secret_env.contains(&key) {
                    plan.copies.push((account(f, &key), to.clone()));
                }
            }
            kept.insert(to);
        }
        if wrote {
            plan.touched.push(name.clone());
        }
    }
    let mut olds: Vec<&String> = old.keys().collect();
    olds.sort();
    for oname in olds {
        for key in &old[oname].secret_env {
            let item = account(oname, key);
            if !kept.contains(&item) {
                plan.deletes.push(item);
            }
        }
    }
    plan
}

/// Before `mcp.json` is written: copy a renamed server's values and store
/// the new ones. A failure stops the save, so the file never names a value
/// that wasn't stored.
pub fn apply_before_save(store: &dyn SecretStore, plan: &SecretPlan) -> Result<(), String> {
    for (from, to) in &plan.copies {
        if let Some(value) = store.get(from)? {
            store.set(to, &value)?;
        }
    }
    for (item, value) in &plan.writes {
        store.set(item, value)?;
    }
    Ok(())
}

/// After `mcp.json` is written: delete the items nothing names any more. A
/// failure is logged, not fatal; the item is then only unused.
pub fn apply_after_save(store: &dyn SecretStore, plan: &SecretPlan) {
    for item in &plan.deletes {
        if let Err(e) = store.delete(item) {
            tracing::warn!(item = %item, error = %e, "couldn't delete an MCP secret from the Keychain");
        }
    }
}

/// Merge the values the form sent separately (`secrets`: server → name →
/// value) into the entries as `secret_env` values, the shape
/// [`plan_secrets`] moves out again. An empty value keeps the saved one.
pub fn merge_new_values(
    servers: &mut HashMap<String, McpServerConfig>,
    secrets: HashMap<String, HashMap<String, String>>,
) {
    for (server, values) in secrets {
        let Some(cfg) = servers.get_mut(&server) else { continue };
        for (name, value) in values {
            if !cfg.secret_env.contains(&name) {
                cfg.secret_env.push(name.clone());
            }
            if !value.is_empty() {
                cfg.env.insert(name, value);
            }
        }
    }
}

/// A store in memory, for tests.
#[cfg(test)]
#[derive(Default)]
pub struct MemoryStore {
    pub items: Mutex<HashMap<String, String>>,
    /// Every account read, in order.
    pub reads: Mutex<Vec<String>>,
}

#[cfg(test)]
impl MemoryStore {
    pub fn with(items: &[(&str, &str)]) -> Self {
        let store = Self::default();
        store.items.lock().extend(items.iter().map(|(k, v)| (k.to_string(), v.to_string())));
        store
    }
}

#[cfg(test)]
impl SecretStore for MemoryStore {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        self.reads.lock().push(account.to_string());
        Ok(self.items.lock().get(account).cloned())
    }
    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        self.items.lock().insert(account.to_string(), value.to_string());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        self.items.lock().remove(account);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local(env: &[(&str, &str)], secret: &[&str]) -> McpServerConfig {
        McpServerConfig {
            command: "uvx".into(),
            args: vec!["example-server".into()],
            env: env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            secret_env: secret.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }
    }

    fn map(entries: Vec<(&str, McpServerConfig)>) -> HashMap<String, McpServerConfig> {
        entries.into_iter().map(|(k, v)| (k.to_string(), v)).collect()
    }

    fn save(
        store: &MemoryStore,
        old: &HashMap<String, McpServerConfig>,
        mut servers: HashMap<String, McpServerConfig>,
        renamed: &[(&str, &str)],
    ) -> (HashMap<String, McpServerConfig>, SecretPlan) {
        let renamed: HashMap<String, String> = renamed.iter().map(|(n, o)| (n.to_string(), o.to_string())).collect();
        let plan = plan_secrets(old, &mut servers, &renamed);
        apply_before_save(store, &plan).unwrap();
        apply_after_save(store, &plan);
        (servers, plan)
    }

    #[test]
    fn the_pattern() {
        for name in ["GITHUB_TOKEN", "api_key", "CLIENT_SECRET", "DB_PASSWORD", "AUTH_HEADER", "bearer"] {
            assert!(looks_secret(name), "{name}");
        }
        for name in ["PATH", "LOG_LEVEL", "NODE_EXTRA_CA_CERTS", "REGION"] {
            assert!(!looks_secret(name), "{name}");
        }
    }

    #[test]
    fn resolution_reads_each_secret_and_names_a_missing_one() {
        let cfg = local(&[("GITHUB_TOKEN", ""), ("LOG", "debug")], &["GITHUB_TOKEN"]);
        let store = MemoryStore::with(&[("example/GITHUB_TOKEN", "ghp_value")]);
        assert_eq!(resolve("example", &cfg, &store).unwrap(), vec![("GITHUB_TOKEN".to_string(), "ghp_value".to_string())]);

        let err = resolve("other", &cfg, &store).unwrap_err();
        assert!(err.starts_with("The token for other isn't in the Keychain; edit the server to enter it."), "{err}");
        assert!(err.contains("GITHUB_TOKEN"), "{err}");

        // No secrets: the store isn't touched at all.
        let store = MemoryStore::default();
        assert!(resolve("example", &local(&[("LOG", "debug")], &[]), &store).unwrap().is_empty());
        assert!(store.reads.lock().is_empty());
    }

    #[test]
    fn a_save_stores_new_values_and_writes_the_file_without_them() {
        let store = MemoryStore::default();
        let (servers, plan) = save(&store, &HashMap::new(), map(vec![("example", local(&[("GITHUB_TOKEN", "ghp_new")], &["GITHUB_TOKEN"]))]), &[]);
        assert_eq!(store.items.lock().get("example/GITHUB_TOKEN").map(String::as_str), Some("ghp_new"));
        assert_eq!(servers["example"].env["GITHUB_TOKEN"], "", "the file holds an empty string");
        assert_eq!(plan.touched, vec!["example"]);
        let json = serde_json::to_string(&servers).unwrap();
        assert!(!json.contains("ghp_new"), "{json}");
        assert!(json.contains(r#""secret_env":["GITHUB_TOKEN"]"#), "{json}");
    }

    #[test]
    fn a_saved_secret_stays_saved_unless_a_new_value_is_typed() {
        let old = map(vec![("example", local(&[("GITHUB_TOKEN", "")], &["GITHUB_TOKEN"]))]);
        let store = MemoryStore::with(&[("example/GITHUB_TOKEN", "ghp_saved")]);
        let (servers, plan) = save(&store, &old, old.clone(), &[]);
        assert_eq!(plan, SecretPlan::default(), "nothing to do");
        assert_eq!(servers, old);
        assert_eq!(store.items.lock()["example/GITHUB_TOKEN"], "ghp_saved");
    }

    #[test]
    fn migration_moves_plain_values_that_look_secret() {
        let old = map(vec![("example", local(&[("API_KEY", "k-123"), ("LOG", "debug")], &[]))]);
        let mut legacy = local(&[("GITHUB_TOKEN", "ghp_x"), ("TOKEN_REF", "${GITHUB_TOKEN}"), ("EMPTY_TOKEN", "")], &[]);
        legacy.plain_env = vec!["AUTH_MODE".into()];
        legacy.env.insert("AUTH_MODE".into(), "basic".into());
        let mut servers = old.clone();
        servers.insert("legacy".into(), legacy);
        let store = MemoryStore::default();
        let (servers, plan) = save(&store, &old, servers, &[]);
        assert_eq!(servers["example"].secret_env, vec!["API_KEY"]);
        assert_eq!(servers["example"].env["API_KEY"], "");
        assert_eq!(servers["example"].env["LOG"], "debug");
        assert_eq!(servers["legacy"].secret_env, vec!["GITHUB_TOKEN"]);
        assert_eq!(servers["legacy"].env["TOKEN_REF"], "${GITHUB_TOKEN}", "a reference isn't a value");
        assert_eq!(servers["legacy"].env["AUTH_MODE"], "basic", "a name the user kept in the file stays");
        assert_eq!(servers["legacy"].env["EMPTY_TOKEN"], "");
        let items = store.items.lock();
        assert_eq!((items["example/API_KEY"].as_str(), items["legacy/GITHUB_TOKEN"].as_str()), ("k-123", "ghp_x"));
        assert_eq!(plan.touched, vec!["example", "legacy"]);
    }

    #[test]
    fn a_rename_moves_the_items() {
        let old = map(vec![("before", local(&[("GITHUB_TOKEN", ""), ("API_KEY", "")], &["API_KEY", "GITHUB_TOKEN"]))]);
        let store = MemoryStore::with(&[("before/GITHUB_TOKEN", "ghp_saved"), ("before/API_KEY", "k-saved")]);
        // Renamed, with a new API key typed and the token left as saved.
        let mut after = old["before"].clone();
        after.env.insert("API_KEY".into(), "k-new".into());
        let (servers, plan) = save(&store, &old, map(vec![("after", after)]), &[("after", "before")]);
        let items = store.items.lock().clone();
        assert_eq!(items.get("after/GITHUB_TOKEN").map(String::as_str), Some("ghp_saved"));
        assert_eq!(items.get("after/API_KEY").map(String::as_str), Some("k-new"));
        assert!(!items.contains_key("before/GITHUB_TOKEN") && !items.contains_key("before/API_KEY"), "{items:?}");
        assert_eq!(plan.copies, vec![("before/GITHUB_TOKEN".to_string(), "after/GITHUB_TOKEN".to_string())]);
        assert_eq!(servers["after"].env["API_KEY"], "");
    }

    #[test]
    fn deleting_a_server_or_a_secret_removes_its_items() {
        let old = map(vec![
            ("gone", local(&[("GITHUB_TOKEN", "")], &["GITHUB_TOKEN"])),
            ("kept", local(&[("API_KEY", ""), ("DB_PASSWORD", "")], &["API_KEY", "DB_PASSWORD"])),
        ]);
        let store = MemoryStore::with(&[("gone/GITHUB_TOKEN", "a"), ("kept/API_KEY", "b"), ("kept/DB_PASSWORD", "c")]);
        // `gone` is deleted; `kept` keeps its key in the Keychain and its
        // password goes back to the file as a value the user typed.
        let mut kept = local(&[("API_KEY", ""), ("DB_PASSWORD", "plain")], &["API_KEY"]);
        kept.plain_env = vec!["DB_PASSWORD".into()];
        let (_, plan) = save(&store, &old, map(vec![("kept", kept)]), &[]);
        assert_eq!(plan.deletes, vec!["gone/GITHUB_TOKEN", "kept/DB_PASSWORD"]);
        let items = store.items.lock();
        assert_eq!(items.keys().collect::<Vec<_>>(), vec!["kept/API_KEY"]);
    }

    #[test]
    fn values_sent_apart_merge_into_secret_env() {
        let mut servers = map(vec![("example", local(&[("GITHUB_TOKEN", "")], &[]))]);
        merge_new_values(
            &mut servers,
            HashMap::from([
                ("example".to_string(), HashMap::from([("GITHUB_TOKEN".to_string(), "ghp_new".to_string()), ("API_KEY".to_string(), String::new())])),
                ("missing".to_string(), HashMap::from([("X".to_string(), "y".to_string())])),
            ]),
        );
        let cfg = &servers["example"];
        assert_eq!(cfg.env["GITHUB_TOKEN"], "ghp_new");
        assert!(cfg.secret_env.contains(&"GITHUB_TOKEN".to_string()) && cfg.secret_env.contains(&"API_KEY".to_string()));
        assert!(!cfg.env.contains_key("API_KEY"), "an empty value keeps the saved one");
        assert!(!servers.contains_key("missing"));
    }

    #[test]
    fn a_remote_servers_header_and_client_secret_go_to_the_keychain() {
        let mut cfg = McpServerConfig {
            env: HashMap::from([
                ("OCTOPUSH_MCP_H_AUTHORIZATION".to_string(), "tok-123".to_string()),
                (remote::CLIENT_SECRET_ENV.to_string(), "shh".to_string()),
            ]),
            remote: Some(remote::RemoteConfig {
                url: "https://mcp.example.com/mcp".into(),
                auth: "token".into(),
                transport: "auto".into(),
                ..Default::default()
            }),
            ..Default::default()
        };
        remote::apply_bridge(&mut cfg, "npx");
        let store = MemoryStore::default();
        let (servers, _) = save(&store, &HashMap::new(), map(vec![("example-remote", cfg)]), &[]);
        assert_eq!(servers["example-remote"].secret_env, vec!["OCTOPUSH_MCP_H_AUTHORIZATION"]);
        assert_eq!(store.items.lock()["example-remote/OCTOPUSH_MCP_H_AUTHORIZATION"], "Bearer tok-123");
        assert!(!serde_json::to_string(&servers).unwrap().contains("tok-123"));
    }

    #[test]
    fn scrub_replaces_resolved_values() {
        let secrets = vec![("T".to_string(), "tok-123".to_string()), ("S".to_string(), "ab".to_string())];
        assert_eq!(scrub("auth failed for tok-123 (ab)", &secrets), "auth failed for [redacted] (ab)");
    }
}
