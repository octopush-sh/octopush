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
