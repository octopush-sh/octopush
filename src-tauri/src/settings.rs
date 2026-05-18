//! App settings persisted to ~/.octopus-sh/settings.json

use crate::error::AppResult;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default)]
    pub provider_keys: HashMap<String, String>,
    #[serde(default)]
    pub provider_base_urls: HashMap<String, String>,

    #[serde(default, rename = "anthropicApiKey", skip_serializing)]
    pub legacy_anthropic_api_key: Option<String>,
    #[serde(default, rename = "openaiApiKey", skip_serializing)]
    pub legacy_openai_api_key: Option<String>,
}

fn settings_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".octopus-sh")
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
