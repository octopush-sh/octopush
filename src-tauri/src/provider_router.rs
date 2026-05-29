//! Provider and model registry with intelligent routing.
//!
//! Providers are loaded from `~/.octopush/providers.json`. If the file
//! doesn't exist, a set of built-in defaults (Anthropic, OpenAI, Ollama)
//! is used and persisted on first run.

use crate::error::AppResult;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

// ─── Models ───────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub name: String,
    pub api_base: String,
    /// Name of the env var holding the API key (e.g. `ANTHROPIC_API_KEY`).
    pub api_key_env: String,
    pub models: Vec<ModelInfo>,
    #[serde(default)]
    pub rate_limits: RateLimits,
    #[serde(default)]
    pub enabled: bool,

    /// Wire protocol the provider speaks: "anthropic" or "openai-compatible".
    /// "openai-compatible" covers OpenAI, DeepSeek, Ollama, and any
    /// self-hosted server (vllm, llama.cpp, LMStudio, etc.).
    #[serde(default = "default_protocol")]
    pub protocol: String,

    /// True for providers running on this machine (Ollama, self-hosted).
    /// Affects the UI: no API key field, base URL is editable.
    #[serde(default)]
    pub local: bool,
}

fn default_protocol() -> String {
    "anthropic".into()
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub display_name: String,
    /// Cost per million input tokens (USD).
    pub input_cost_per_m: f64,
    /// Cost per million output tokens (USD).
    pub output_cost_per_m: f64,
    /// Cost per million cache-read tokens (USD). 0 = not applicable.
    /// Anthropic: 10% of input cost. Others: 0.
    #[serde(default)]
    pub cache_read_cost_per_m: f64,
    /// Cost per million cache-creation tokens (USD). 0 = not applicable.
    /// Anthropic: 125% of input cost. Others: 0.
    #[serde(default)]
    pub cache_creation_cost_per_m: f64,
    pub max_context: u64,
    #[serde(default)]
    pub supports_vision: bool,
    #[serde(default)]
    pub supports_tools: bool,
    /// Short curated labels shown next to the model name in the picker, e.g.
    /// "fastest", "largest", "reasoning". Static configuration today — the
    /// model picker UI rests on these to help users choose between options.
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct RateLimits {
    pub requests_per_minute: Option<u32>,
    pub tokens_per_minute: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub enum TaskType {
    CodeReview,
    Architecture,
    QuickFix,
    Debugging,
    Documentation,
    Testing,
    Refactoring,
    General,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModelSuggestion {
    pub model_id: String,
    pub provider: String,
    pub reason: String,
    pub estimated_cost_tier: CostTier,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub enum CostTier {
    Low,
    Medium,
    High,
}

// ─── Router ───────────────────────────────────────────────────────

pub struct ProviderRouter {
    providers: HashMap<String, ProviderConfig>,
}

impl ProviderRouter {
    pub fn load() -> AppResult<Self> {
        let path = config_path();
        let providers = if path.exists() {
            let content = std::fs::read_to_string(&path)?;
            let mut list: Vec<ProviderConfig> = serde_json::from_str(&content)?;

            for p in &mut list {
                if p.protocol.is_empty() || p.protocol == "anthropic" {
                    match p.name.as_str() {
                        "openai" | "deepseek" => p.protocol = "openai-compatible".into(),
                        "ollama" => {
                            p.protocol = "openai-compatible".into();
                            p.local = true;
                        }
                        _ => {}
                    }
                }
            }

            let defaults = builtin_providers();

            // Migration: pre-Phase-8 shipped DeepSeek and Ollama as disabled.
            // If a provider is still in that initial state (matches the old
            // default shape), bring it up to the current default so users get
            // them without manually editing providers.json.
            for p in &mut list {
                if let Some(def) = defaults.get(&p.name) {
                    if p.name == "deepseek" && !p.enabled && p.models.len() == def.models.len() {
                        p.enabled = true;
                    }
                    if p.name == "ollama" && p.models.is_empty() {
                        p.enabled = true;
                        p.models = def.models.clone();
                        p.api_base = def.api_base.clone();
                    }
                }
            }

            // Migration: backfill `tags` on built-in models. Users who upgraded
            // from a pre-tags version have `"tags": []` written to disk and
            // serde happily preserves that empty vec, which would hide the
            // Recommended section + tag pills in the UI. For every on-disk
            // model whose id matches a built-in AND whose tags are empty,
            // copy the curated tags over.
            for p in &mut list {
                let Some(def) = defaults.get(&p.name) else { continue };
                for m in &mut p.models {
                    if m.tags.is_empty() {
                        if let Some(def_model) = def.models.iter().find(|x| x.id == m.id) {
                            m.tags = def_model.tags.clone();
                        }
                    }
                }
            }

            // Migration: backfill `cache_read_cost_per_m` / `cache_creation_cost_per_m`
            // for Anthropic models that were persisted before these fields were added.
            // A value of 0.0 on an Anthropic model means the field is missing — copy
            // it from the builtin definition so cost calculations are correct.
            for p in &mut list {
                let Some(def) = defaults.get(&p.name) else { continue };
                for m in &mut p.models {
                    if m.cache_read_cost_per_m == 0.0 && m.cache_creation_cost_per_m == 0.0 {
                        if let Some(def_model) = def.models.iter().find(|x| x.id == m.id) {
                            m.cache_read_cost_per_m = def_model.cache_read_cost_per_m;
                            m.cache_creation_cost_per_m = def_model.cache_creation_cost_per_m;
                        }
                    }
                }
            }

            for (name, def) in &defaults {
                if !list.iter().any(|p| p.name == *name) {
                    list.push(def.clone());
                }
            }

            let snapshot: Vec<&ProviderConfig> = list.iter().collect();
            let _ = std::fs::write(&path, serde_json::to_string_pretty(&snapshot)?);

            list.into_iter().map(|p| (p.name.clone(), p)).collect()
        } else {
            let defaults = builtin_providers();
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let list: Vec<&ProviderConfig> = defaults.values().collect();
            let _ = std::fs::write(&path, serde_json::to_string_pretty(&list)?);
            defaults
        };
        Ok(Self { providers })
    }

    /// Construct a router directly from a map — for tests only.
    #[cfg(test)]
    pub(crate) fn from_map(providers: HashMap<String, ProviderConfig>) -> Self {
        Self { providers }
    }

    pub fn list_providers(&self) -> Vec<&ProviderConfig> {
        self.providers.values().collect()
    }

    pub fn list_models(&self) -> Vec<ModelWithProvider> {
        let mut out = Vec::new();
        for p in self.providers.values() {
            if !p.enabled {
                continue;
            }
            for m in &p.models {
                out.push(ModelWithProvider {
                    provider: p.name.clone(),
                    model: m.clone(),
                });
            }
        }
        out.sort_by(|a, b| a.model.input_cost_per_m.partial_cmp(&b.model.input_cost_per_m).unwrap());
        out
    }

    pub fn find_model(&self, model_id: &str) -> Option<(&ProviderConfig, &ModelInfo)> {
        for p in self.providers.values() {
            for m in &p.models {
                if m.id == model_id {
                    return Some((p, m));
                }
            }
        }
        None
    }

    pub fn suggest_model(&self, task: &TaskType) -> ModelSuggestion {
        match task {
            TaskType::Architecture | TaskType::Debugging => ModelSuggestion {
                model_id: "claude-opus-4-6".into(),
                provider: "anthropic".into(),
                reason: "Deep reasoning needed for complex analysis".into(),
                estimated_cost_tier: CostTier::High,
            },
            TaskType::CodeReview | TaskType::Refactoring | TaskType::General => ModelSuggestion {
                model_id: "claude-sonnet-4-6".into(),
                provider: "anthropic".into(),
                reason: "Fast, cost-effective for reviews and general work".into(),
                estimated_cost_tier: CostTier::Medium,
            },
            TaskType::QuickFix | TaskType::Documentation | TaskType::Testing => ModelSuggestion {
                model_id: "claude-haiku-4-5".into(),
                provider: "anthropic".into(),
                reason: "Simple task — minimize cost".into(),
                estimated_cost_tier: CostTier::Low,
            },
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModelWithProvider {
    pub provider: String,
    pub model: ModelInfo,
}

// ─── Defaults ─────────────────────────────────────────────────────

fn config_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".octopush")
        .join("providers.json")
}

/// Default providers as a list (for "reset to defaults" in the UI).
pub fn default_providers_list() -> Vec<ProviderConfig> {
    builtin_providers().into_values().collect()
}

/// Write the provider catalog to `~/.octopush/providers.json` (pretty JSON).
pub fn write_providers(list: &[ProviderConfig]) -> AppResult<()> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(list)?)?;
    Ok(())
}

/// Validate a provider list before persisting. Returns Err(message) on the
/// first problem found.
pub fn validate_providers(list: &[ProviderConfig]) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    for p in list {
        let name = p.name.trim();
        if name.is_empty() {
            return Err("Provider name cannot be empty".into());
        }
        if !seen.insert(name.to_lowercase()) {
            return Err(format!("Duplicate provider name: {name}"));
        }
        if p.protocol != "anthropic" && p.protocol != "openai-compatible" {
            return Err(format!("Provider {name}: protocol must be 'anthropic' or 'openai-compatible'"));
        }
        if !p.local && p.api_base.trim().is_empty() {
            return Err(format!("Provider {name}: base URL is required"));
        }
        let mut model_ids = std::collections::HashSet::new();
        for m in &p.models {
            if m.id.trim().is_empty() {
                return Err(format!("Provider {name}: a model id is empty"));
            }
            if !model_ids.insert(m.id.trim().to_lowercase()) {
                return Err(format!("Provider {name}: duplicate model id {}", m.id));
            }
        }
    }
    Ok(())
}

pub(crate) fn builtin_providers() -> HashMap<String, ProviderConfig> {
    let mut map = HashMap::new();

    map.insert(
        "anthropic".into(),
        ProviderConfig {
            name: "anthropic".into(),
            api_base: "https://api.anthropic.com".into(),
            api_key_env: "ANTHROPIC_API_KEY".into(),
            models: vec![
                ModelInfo {
                    id: "claude-opus-4-6".into(),
                    display_name: "Claude Opus 4.6".into(),
                    input_cost_per_m: 15.0,
                    output_cost_per_m: 75.0,
                    cache_read_cost_per_m: 15.0 * 0.10,    // $1.50 / M
                    cache_creation_cost_per_m: 15.0 * 1.25, // $18.75 / M
                    max_context: 1_000_000,
                    supports_vision: true,
                    supports_tools: true,
                    tags: vec!["largest ctx".into(), "best reasoning".into()],
                },
                ModelInfo {
                    id: "claude-sonnet-4-6".into(),
                    display_name: "Claude Sonnet 4.6".into(),
                    input_cost_per_m: 3.0,
                    output_cost_per_m: 15.0,
                    cache_read_cost_per_m: 3.0 * 0.10,    // $0.30 / M
                    cache_creation_cost_per_m: 3.0 * 1.25, // $3.75 / M
                    max_context: 200_000,
                    supports_vision: true,
                    supports_tools: true,
                    tags: vec!["balanced".into(), "coding".into()],
                },
                ModelInfo {
                    id: "claude-haiku-4-5".into(),
                    display_name: "Claude Haiku 4.5".into(),
                    input_cost_per_m: 0.80,
                    output_cost_per_m: 4.0,
                    cache_read_cost_per_m: 0.80 * 0.10,    // $0.08 / M
                    cache_creation_cost_per_m: 0.80 * 1.25, // $1.00 / M
                    max_context: 200_000,
                    supports_vision: true,
                    supports_tools: true,
                    tags: vec!["fast".into(), "cheap".into()],
                },
            ],
            rate_limits: RateLimits {
                requests_per_minute: Some(50),
                tokens_per_minute: Some(80_000),
            },
            enabled: true,
            protocol: "anthropic".into(),
            local: false,
        },
    );

    map.insert(
        "openai".into(),
        ProviderConfig {
            name: "openai".into(),
            api_base: "https://api.openai.com/v1".into(),
            api_key_env: "OPENAI_API_KEY".into(),
            models: vec![
                ModelInfo {
                    id: "gpt-4o".into(),
                    display_name: "GPT-4o".into(),
                    input_cost_per_m: 2.50,
                    output_cost_per_m: 10.0,
                    cache_read_cost_per_m: 0.0,
                    cache_creation_cost_per_m: 0.0,
                    max_context: 128_000,
                    supports_vision: true,
                    supports_tools: true,
                    tags: vec!["balanced".into(), "vision".into()],
                },
                ModelInfo {
                    id: "gpt-4o-mini".into(),
                    display_name: "GPT-4o mini".into(),
                    input_cost_per_m: 0.15,
                    output_cost_per_m: 0.60,
                    cache_read_cost_per_m: 0.0,
                    cache_creation_cost_per_m: 0.0,
                    max_context: 128_000,
                    supports_vision: true,
                    supports_tools: true,
                    tags: vec!["fast".into(), "cheap".into()],
                },
            ],
            rate_limits: RateLimits::default(),
            enabled: true,
            protocol: "openai-compatible".into(),
            local: false,
        },
    );

    map.insert(
        "deepseek".into(),
        ProviderConfig {
            name: "deepseek".into(),
            api_base: "https://api.deepseek.com/v1".into(),
            api_key_env: "DEEPSEEK_API_KEY".into(),
            models: vec![
                ModelInfo {
                    id: "deepseek-chat".into(),
                    display_name: "DeepSeek Chat".into(),
                    input_cost_per_m: 0.14,
                    output_cost_per_m: 0.28,
                    cache_read_cost_per_m: 0.0,
                    cache_creation_cost_per_m: 0.0,
                    max_context: 64_000,
                    supports_vision: false,
                    supports_tools: true,
                    tags: vec!["cheapest cloud".into()],
                },
                ModelInfo {
                    id: "deepseek-reasoner".into(),
                    display_name: "DeepSeek Reasoner".into(),
                    input_cost_per_m: 0.55,
                    output_cost_per_m: 2.19,
                    cache_read_cost_per_m: 0.0,
                    cache_creation_cost_per_m: 0.0,
                    max_context: 64_000,
                    supports_vision: false,
                    supports_tools: false,
                    tags: vec!["reasoning".into(), "cheap".into()],
                },
            ],
            rate_limits: RateLimits::default(),
            enabled: true,
            protocol: "openai-compatible".into(),
            local: false,
        },
    );

    map.insert(
        "ollama".into(),
        ProviderConfig {
            name: "ollama".into(),
            api_base: "http://localhost:11434/v1".into(),
            api_key_env: String::new(),
            models: vec![
                ModelInfo {
                    id: "llama3.3".into(),
                    display_name: "Llama 3.3".into(),
                    input_cost_per_m: 0.0,
                    output_cost_per_m: 0.0,
                    cache_read_cost_per_m: 0.0,
                    cache_creation_cost_per_m: 0.0,
                    max_context: 128_000,
                    supports_vision: false,
                    supports_tools: true,
                    tags: vec!["local".into(), "free".into()],
                },
                ModelInfo {
                    id: "qwen2.5-coder".into(),
                    display_name: "Qwen 2.5 Coder".into(),
                    input_cost_per_m: 0.0,
                    output_cost_per_m: 0.0,
                    cache_read_cost_per_m: 0.0,
                    cache_creation_cost_per_m: 0.0,
                    max_context: 128_000,
                    supports_vision: false,
                    supports_tools: true,
                    tags: vec!["local".into(), "coding".into(), "free".into()],
                },
                ModelInfo {
                    id: "deepseek-r1".into(),
                    display_name: "DeepSeek R1".into(),
                    input_cost_per_m: 0.0,
                    output_cost_per_m: 0.0,
                    cache_read_cost_per_m: 0.0,
                    cache_creation_cost_per_m: 0.0,
                    max_context: 64_000,
                    supports_vision: false,
                    supports_tools: false,
                    tags: vec!["local".into(), "reasoning".into(), "free".into()],
                },
            ],
            rate_limits: RateLimits::default(),
            enabled: true,
            protocol: "openai-compatible".into(),
            local: true,
        },
    );

    map
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_providers_have_models() {
        let providers = builtin_providers();
        assert!(providers.contains_key("anthropic"));
        assert!(providers.contains_key("openai"));
        let anthropic = &providers["anthropic"];
        assert_eq!(anthropic.models.len(), 3);
        assert!(anthropic.enabled);
    }

    #[test]
    fn suggest_model_architecture() {
        let router = ProviderRouter {
            providers: builtin_providers(),
        };
        let suggestion = router.suggest_model(&TaskType::Architecture);
        assert_eq!(suggestion.model_id, "claude-opus-4-6");
    }

    #[test]
    fn suggest_model_quick_fix() {
        let router = ProviderRouter {
            providers: builtin_providers(),
        };
        let suggestion = router.suggest_model(&TaskType::QuickFix);
        assert_eq!(suggestion.model_id, "claude-haiku-4-5");
    }

    #[test]
    fn find_model_existing() {
        let router = ProviderRouter {
            providers: builtin_providers(),
        };
        let (provider, model) = router.find_model("gpt-4o").unwrap();
        assert_eq!(provider.name, "openai");
        assert_eq!(model.display_name, "GPT-4o");
    }

    #[test]
    fn find_model_missing() {
        let router = ProviderRouter {
            providers: builtin_providers(),
        };
        assert!(router.find_model("nonexistent-model").is_none());
    }

    #[test]
    fn list_models_sorted_by_cost() {
        let router = ProviderRouter {
            providers: builtin_providers(),
        };
        let models = router.list_models();
        assert!(models.len() >= 5);
        // Cheapest first.
        assert!(models[0].model.input_cost_per_m <= models[1].model.input_cost_per_m);
    }

    #[test]
    fn builtin_providers_includes_all_four() {
        let providers = builtin_providers();
        assert!(providers.contains_key("anthropic"));
        assert!(providers.contains_key("openai"));
        assert!(providers.contains_key("deepseek"));
        assert!(providers.contains_key("ollama"));
    }

    #[test]
    fn protocols_are_set_correctly() {
        let providers = builtin_providers();
        assert_eq!(providers["anthropic"].protocol, "anthropic");
        assert_eq!(providers["openai"].protocol, "openai-compatible");
        assert_eq!(providers["deepseek"].protocol, "openai-compatible");
        assert_eq!(providers["ollama"].protocol, "openai-compatible");
    }

    #[test]
    fn ollama_is_local() {
        let providers = builtin_providers();
        assert!(providers["ollama"].local);
        assert!(!providers["anthropic"].local);
        assert!(!providers["openai"].local);
        assert!(!providers["deepseek"].local);
    }

    #[test]
    fn find_model_returns_provider_with_protocol() {
        let router = ProviderRouter { providers: builtin_providers() };
        let (p, m) = router.find_model("gpt-4o").expect("gpt-4o must be findable");
        assert_eq!(p.name, "openai");
        assert_eq!(p.protocol, "openai-compatible");
        assert_eq!(m.id, "gpt-4o");

        let (p, _) = router.find_model("deepseek-chat").expect("deepseek-chat must be findable");
        assert_eq!(p.name, "deepseek");
    }

    #[test]
    fn provider_config_serde_roundtrip_with_new_fields() {
        let cfg = builtin_providers().get("openai").unwrap().clone();
        let json = serde_json::to_string(&cfg).unwrap();
        let back: ProviderConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.protocol, "openai-compatible");
        assert!(!back.local);
    }

    #[test]
    fn deepseek_enabled_by_default() {
        let providers = builtin_providers();
        assert!(providers["deepseek"].enabled, "deepseek should ship enabled");
        assert!(providers["ollama"].enabled, "ollama should ship enabled");
    }

    #[test]
    fn ollama_has_default_models() {
        let providers = builtin_providers();
        let ollama = &providers["ollama"];
        assert!(!ollama.models.is_empty(), "ollama must ship with default models");
        assert!(ollama.models.iter().any(|m| m.id == "llama3.3"));
    }
}
