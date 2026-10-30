//! App settings persisted to ~/.octopush/settings.json

use crate::error::AppResult;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

/// Stored credentials for a single git host.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitCredentialEntry {
    pub username: String,
    pub token: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default)]
    pub provider_keys: HashMap<String, String>,
    #[serde(default)]
    pub provider_base_urls: HashMap<String, String>,

    /// Per-host git credentials (username + PAT).  Key is the host name,
    /// e.g. `"github.com"`.
    #[serde(default)]
    pub git_credentials: HashMap<String, GitCredentialEntry>,

    /// ISO-8601 timestamp of the last successful pricing refresh from LiteLLM.
    #[serde(default)]
    pub last_pricing_refresh: Option<String>,

    /// Issue tracker (Jira Cloud) configuration.
    #[serde(default)]
    pub issue_tracker: Option<crate::issue_tracker::jira::JiraConfig>,

    /// Optional override command for "Open in editor" (e.g. "code", "cursor").
    /// When empty/None, the app autodetects an installed editor.
    #[serde(default)]
    pub editor_command: Option<String>,

    /// Tool-call rounds a single TALK turn may run before the engine asks the
    /// model to close with what it has. `None` = **no limit** — the turn runs
    /// until the model answers or the user stops it; the engine clamps a set
    /// value to the supported range.
    #[serde(default)]
    pub talk_max_iterations: Option<u32>,

    /// Tool-call rounds one sub-agent run may take (Settings › General ›
    /// "Limit sub-agent tool turns"). `None` = **no limit** — a sub-agent
    /// runs until it finishes or is stopped; a set value is clamped like the
    /// Talk turns and a definition's own `max-turns` never exceeds it.
    /// Independent of `talk_max_iterations`: a director's rounds and a
    /// sub-agent's are different budgets.
    #[serde(default)]
    pub subagent_max_turns: Option<u32>,

    /// Provider-agnostic model tiers — `fast`, `balanced`, `strong` → a
    /// configured model id. What a sub-agent definition's `model: haiku`
    /// (or an `Agent` call's `model: "fast"`) resolves to on THIS machine,
    /// whatever provider the user runs. Unset tiers fall back to a
    /// substring match over the configured ids.
    #[serde(default)]
    pub model_tiers: HashMap<String, String>,

    /// Opt-in: replicate finished Direct runs — metadata AND detail (per-stage
    /// journals, artifact texts, capped diff snapshots) — to Octopush's sync
    /// service so they appear on the user's other Macs. **Off by default**,
    /// including for every settings file written before this field existed
    /// (`serde(default)` ⇒ `false`). Pro-only on top (`history.sync`).
    #[serde(default)]
    pub history_sync_enabled: bool,

    /// Opt-in: replicate custom pipelines & roles via Library sync. **Off by
    /// default** (same rule as above). Pro-only on top (`library.sync`).
    #[serde(default)]
    pub library_sync_enabled: bool,

    /// The Clerk user id (`sub`) the opt-ins above were granted by. The opt-in
    /// is **per account, not per Mac**: when a different user is signed in (or
    /// nobody is) both opt-ins read as OFF, so a second person signing in on
    /// this Mac can never trigger a backfill of the first person's runs into
    /// their own account. Cleared (with both flags) on sign-out.
    #[serde(default)]
    pub sync_owner: Option<String>,

    #[serde(default, rename = "anthropicApiKey", skip_serializing)]
    pub legacy_anthropic_api_key: Option<String>,
    #[serde(default, rename = "openaiApiKey", skip_serializing)]
    pub legacy_openai_api_key: Option<String>,
}

fn settings_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".octopush")
        .join("settings.json")
}

pub fn load_settings() -> AppResult<AppSettings> {
    let path = settings_path();
    if !path.exists() {
        return Ok(AppSettings::default());
    }
    let content = std::fs::read_to_string(&path)?;
    let mut settings: AppSettings = serde_json::from_str(&content).unwrap_or_default();

    if let Some(k) = settings.legacy_anthropic_api_key.take() {
        if !k.is_empty() && !settings.provider_keys.contains_key("anthropic") {
            settings.provider_keys.insert("anthropic".to_string(), k);
        }
    }
    if let Some(k) = settings.legacy_openai_api_key.take() {
        if !k.is_empty() && !settings.provider_keys.contains_key("openai") {
            settings.provider_keys.insert("openai".to_string(), k);
        }
    }

    Ok(settings)
}

pub fn save_settings(settings: &AppSettings) -> AppResult<()> {
    let path = settings_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, serde_json::to_string_pretty(settings)?)?;
    Ok(())
}

/// The two cloud-sync opt-ins as one value — the wire shape of
/// `get_sync_prefs` / `set_sync_pref`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncPrefs {
    pub history_sync: bool,
    pub library_sync: bool,
}

impl AppSettings {
    /// The opt-ins as stored, ignoring who granted them.
    pub fn sync_prefs(&self) -> SyncPrefs {
        SyncPrefs {
            history_sync: self.history_sync_enabled,
            library_sync: self.library_sync_enabled,
        }
    }

    /// The opt-ins as they apply to `current_sub` (the signed-in Clerk user):
    /// both OFF unless that user is the one who granted them.
    pub fn sync_prefs_for(&self, current_sub: Option<&str>) -> SyncPrefs {
        SyncPrefs {
            history_sync: self.sync_opted_in_for(crate::sync::SyncKind::History, current_sub),
            library_sync: self.sync_opted_in_for(crate::sync::SyncKind::Library, current_sub),
        }
    }

    fn flag(&self, kind: crate::sync::SyncKind) -> bool {
        match kind {
            crate::sync::SyncKind::History => self.history_sync_enabled,
            crate::sync::SyncKind::Library => self.library_sync_enabled,
        }
    }

    /// Opted in for `kind` AND granted by `current_sub`. Signed out (`None`),
    /// an unowned flag, or a different owner ⇒ `false`.
    pub fn sync_opted_in_for(&self, kind: crate::sync::SyncKind, current_sub: Option<&str>) -> bool {
        match (current_sub, self.sync_owner.as_deref()) {
            (Some(me), Some(owner)) if !me.is_empty() && me == owner => self.flag(kind),
            _ => false,
        }
    }

    /// Set one opt-in on behalf of `sub`. Enabling under a different owner
    /// first clears the previous owner's flags (they never carry over), then
    /// binds the opt-ins to `sub`.
    pub fn set_sync_opted_in_by(&mut self, kind: crate::sync::SyncKind, enabled: bool, sub: &str) {
        if enabled && self.sync_owner.as_deref() != Some(sub) {
            self.history_sync_enabled = false;
            self.library_sync_enabled = false;
            self.sync_owner = Some(sub.to_string());
        }
        self.set_flag(kind, enabled);
    }

    fn set_flag(&mut self, kind: crate::sync::SyncKind, enabled: bool) {
        match kind {
            crate::sync::SyncKind::History => self.history_sync_enabled = enabled,
            crate::sync::SyncKind::Library => self.library_sync_enabled = enabled,
        }
    }

    /// Forget every opt-in (sign-out).
    pub fn clear_sync_opt_ins(&mut self) {
        self.history_sync_enabled = false;
        self.library_sync_enabled = false;
        self.sync_owner = None;
    }

    /// `set_sync_pref` is the ONLY writer of the opt-ins: a whole-file save
    /// from the frontend (read-modify-write in several panes) must never flip
    /// them, so carry the on-disk values over whatever the payload says.
    pub fn preserve_sync_fields_from(&mut self, on_disk: &AppSettings) {
        self.history_sync_enabled = on_disk.history_sync_enabled;
        self.library_sync_enabled = on_disk.library_sync_enabled;
        self.sync_owner = on_disk.sync_owner.clone();
    }
}

/// Has the signed-in user opted in to this kind of cloud sync? Reads
/// `settings.json` fresh each call (a toggle takes effect on the very next
/// push/pull); only when a flag is set is the session consulted for the
/// owner check. Any read/parse failure answers **no** — sync never turns
/// itself on.
pub fn sync_opted_in(kind: crate::sync::SyncKind) -> bool {
    #[cfg(test)]
    if let Some(v) = test_sync_override::get(kind) {
        return v;
    }
    let Ok(settings) = load_settings() else { return false };
    if !settings.flag(kind) {
        return false; // fast path: off ⇒ no keychain read
    }
    let sub = crate::auth::current_identity().map(|(sub, _)| sub);
    settings.sync_opted_in_for(kind, sub.as_deref())
}

/// The opt-ins as they apply to whoever is signed in now.
pub fn current_sync_prefs() -> AppResult<SyncPrefs> {
    let settings = load_settings()?;
    let sub = crate::auth::current_identity().map(|(sub, _)| sub);
    Ok(settings.sync_prefs_for(sub.as_deref()))
}

/// Persist one sync opt-in for the signed-in user (read-modify-write) and
/// return the new effective pair. Enabling requires a signed-in user (the
/// opt-in is bound to their Clerk id); disabling always succeeds.
pub fn set_sync_opted_in(kind: crate::sync::SyncKind, enabled: bool) -> AppResult<SyncPrefs> {
    let mut settings = load_settings()?;
    let sub = crate::auth::current_identity().map(|(sub, _)| sub);
    match sub.as_deref() {
        Some(me) if !me.is_empty() => settings.set_sync_opted_in_by(kind, enabled, me),
        _ if enabled => {
            return Err(crate::error::AppError::Other("Sign in to turn on sync".into()))
        }
        _ => settings.set_flag(kind, false),
    }
    save_settings(&settings)?;
    Ok(settings.sync_prefs_for(sub.as_deref()))
}

/// Sign-out: drop both opt-ins and their owner.
pub fn clear_sync_opt_ins() -> AppResult<()> {
    let mut settings = load_settings()?;
    settings.clear_sync_opt_ins();
    save_settings(&settings)
}

/// A whole-settings save coming from the frontend: everything but the sync
/// opt-ins (owned by `set_sync_pref`), which are carried over from disk.
pub fn save_settings_from_ui(mut incoming: AppSettings) -> AppResult<()> {
    let on_disk = load_settings()?;
    incoming.preserve_sync_fields_from(&on_disk);
    save_settings(&incoming)
}

/// Test-only, per-thread override of [`sync_opted_in`] so gating tests never
/// read (or depend on) the developer's real `~/.octopush/settings.json`.
#[cfg(test)]
pub mod test_sync_override {
    use std::cell::Cell;
    thread_local! {
        static HISTORY: Cell<Option<bool>> = const { Cell::new(None) };
        static LIBRARY: Cell<Option<bool>> = const { Cell::new(None) };
    }
    pub fn get(kind: crate::sync::SyncKind) -> Option<bool> {
        match kind {
            crate::sync::SyncKind::History => HISTORY.with(|c| c.get()),
            crate::sync::SyncKind::Library => LIBRARY.with(|c| c.get()),
        }
    }
    pub fn set(kind: crate::sync::SyncKind, v: Option<bool>) {
        match kind {
            crate::sync::SyncKind::History => HISTORY.with(|c| c.set(v)),
            crate::sync::SyncKind::Library => LIBRARY.with(|c| c.set(v)),
        }
    }
}

/// Get the API key for a named provider (settings file first, then well-known env vars).
pub fn get_provider_key(provider: &str) -> Option<String> {
    load_settings()
        .ok()
        .and_then(|s| s.provider_keys.get(provider).cloned())
        .filter(|k| !k.is_empty())
}

/// Get the base URL override for a named provider (used for Ollama / self-hosted servers).
pub fn get_provider_base_url(provider: &str) -> Option<String> {
    load_settings()
        .ok()
        .and_then(|s| s.provider_base_urls.get(provider).cloned())
        .filter(|u| !u.is_empty())
}

/// Get the Anthropic API key: settings file first, then env var fallback.
pub fn get_anthropic_key() -> Option<String> {
    get_provider_key("anthropic").or_else(|| std::env::var("ANTHROPIC_API_KEY").ok())
}

/// Get stored git credentials for a host (e.g. `"github.com"`).
pub fn get_git_credentials(host: &str) -> Option<GitCredentialEntry> {
    load_settings()
        .ok()
        .and_then(|s| s.git_credentials.get(host).cloned())
}

/// Get the saved issue tracker (Jira) configuration, if any.
pub fn get_issue_tracker_config() -> Option<crate::issue_tracker::jira::JiraConfig> {
    load_settings().ok().and_then(|s| s.issue_tracker)
}

/// Persist the issue tracker configuration.
pub fn save_issue_tracker_config(config: crate::issue_tracker::jira::JiraConfig) -> AppResult<()> {
    let mut settings = load_settings()?;
    settings.issue_tracker = Some(config);
    save_settings(&settings)
}

/// Persist git credentials for a host.  NOTE: save_settings does a full-file
/// overwrite (last-write-wins). Callers must read-modify-write to avoid
/// clobbering fields they don't own. Not safe for concurrent writers, but the
/// app is single-window so that's acceptable.
pub fn save_git_credentials(host: &str, username: &str, token: &str) -> AppResult<()> {
    let mut settings = load_settings()?;
    settings.git_credentials.insert(
        host.to_string(),
        GitCredentialEntry {
            username: username.to_string(),
            token: token.to_string(),
        },
    );
    save_settings(&settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_anthropic_key_migrates_to_provider_keys() {
        let json = r#"{"anthropicApiKey":"sk-ant-test"}"#;
        let mut settings: AppSettings = serde_json::from_str(json).unwrap();

        if let Some(k) = settings.legacy_anthropic_api_key.take() {
            if !k.is_empty() && !settings.provider_keys.contains_key("anthropic") {
                settings.provider_keys.insert("anthropic".into(), k);
            }
        }

        assert_eq!(
            settings.provider_keys.get("anthropic").map(String::as_str),
            Some("sk-ant-test")
        );
    }

    #[test]
    fn legacy_openai_key_migrates_to_provider_keys() {
        let json = r#"{"openaiApiKey":"sk-oai-test"}"#;
        let mut settings: AppSettings = serde_json::from_str(json).unwrap();

        if let Some(k) = settings.legacy_openai_api_key.take() {
            if !k.is_empty() && !settings.provider_keys.contains_key("openai") {
                settings.provider_keys.insert("openai".into(), k);
            }
        }

        assert_eq!(
            settings.provider_keys.get("openai").map(String::as_str),
            Some("sk-oai-test")
        );
    }

    #[test]
    fn new_provider_keys_field_round_trips() {
        let json = r#"{"providerKeys":{"anthropic":"sk-ant-new","deepseek":"ds-key"},"providerBaseUrls":{"ollama":"http://localhost:11434"}}"#;
        let settings: AppSettings = serde_json::from_str(json).unwrap();

        assert_eq!(
            settings.provider_keys.get("anthropic").map(String::as_str),
            Some("sk-ant-new")
        );
        assert_eq!(
            settings.provider_keys.get("deepseek").map(String::as_str),
            Some("ds-key")
        );
        assert_eq!(
            settings.provider_base_urls.get("ollama").map(String::as_str),
            Some("http://localhost:11434")
        );
    }

    #[test]
    fn subagent_max_turns_round_trips_and_defaults_to_none() {
        let settings: AppSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(settings.subagent_max_turns, None);
        let settings: AppSettings = serde_json::from_str(r#"{"subagentMaxTurns":40}"#).unwrap();
        assert_eq!(settings.subagent_max_turns, Some(40));
        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains(r#""subagentMaxTurns":40"#), "{json}");
    }

    #[test]
    fn talk_max_iterations_round_trips_and_defaults_to_none() {
        let settings: AppSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(settings.talk_max_iterations, None);

        let settings: AppSettings =
            serde_json::from_str(r#"{"talkMaxIterations":60}"#).unwrap();
        assert_eq!(settings.talk_max_iterations, Some(60));
        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains(r#""talkMaxIterations":60"#), "{json}");
    }

    #[test]
    fn model_tiers_round_trip_and_default_empty() {
        let settings: AppSettings = serde_json::from_str("{}").unwrap();
        assert!(settings.model_tiers.is_empty());
        let settings: AppSettings =
            serde_json::from_str(r#"{"modelTiers":{"fast":"gpt-4o-mini","strong":"claude-opus-5"}}"#).unwrap();
        assert_eq!(settings.model_tiers.get("fast").map(String::as_str), Some("gpt-4o-mini"));
        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains(r#""modelTiers":{"#), "{json}");
    }

    #[test]
    fn legacy_key_does_not_overwrite_new_key() {
        // If both old and new fields are present, the new providerKeys value wins.
        let json = r#"{"anthropicApiKey":"sk-ant-old","providerKeys":{"anthropic":"sk-ant-new"}}"#;
        let mut settings: AppSettings = serde_json::from_str(json).unwrap();

        if let Some(k) = settings.legacy_anthropic_api_key.take() {
            if !k.is_empty() && !settings.provider_keys.contains_key("anthropic") {
                settings.provider_keys.insert("anthropic".into(), k);
            }
        }

        assert_eq!(
            settings.provider_keys.get("anthropic").map(String::as_str),
            Some("sk-ant-new")
        );
    }
}
