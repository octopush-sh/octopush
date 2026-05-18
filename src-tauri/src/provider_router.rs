//! Provider and model registry with intelligent routing.
//!
//! Providers are loaded from `~/.octopus-sh/providers.json`. If the file
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
    pub max_context: u64,
    #[serde(default)]
    pub supports_vision: bool,
    #[serde(default)]
    pub supports_tools: bool,
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
        .join(".octopus-sh")
        .join("providers.json")
}

fn builtin_providers() -> HashMap<String, ProviderConfig> {
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
                    max_context: 1_000_000,
                    supports_vision: true,
                    supports_tools: true,
                },
                ModelInfo {
                    id: "claude-sonnet-4-6".into(),
                    display_name: "Claude Sonnet 4.6".into(),
                    input_cost_per_m: 3.0,
                    output_cost_per_m: 15.0,
                    max_context: 200_000,
                    supports_vision: true,
                    supports_tools: true,
                },
                ModelInfo {
                    id: "claude-haiku-4-5".into(),
                    display_name: "Claude Haiku 4.5".into(),
                    input_cost_per_m: 0.80,
                    output_cost_per_m: 4.0,
                    max_context: 200_000,
                    supports_vision: true,
                    supports_tools: true,
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
                    max_context: 128_000,
                    supports_vision: true,
                    supports_tools: true,
                },
                ModelInfo {
                    id: "gpt-4o-mini".into(),
                    display_name: "GPT-4o mini".into(),
                    input_cost_per_m: 0.15,
                    output_cost_per_m: 0.60,
                    max_context: 128_000,
                    supports_vision: true,
                    supports_tools: true,
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
                    max_context: 64_000,
                    supports_vision: false,
                    supports_tools: true,
                },
                ModelInfo {
                    id: "deepseek-reasoner".into(),
                    display_name: "DeepSeek Reasoner".into(),
                    input_cost_per_m: 0.55,
                    output_cost_per_m: 2.19,
                    max_context: 64_000,
                    supports_vision: false,
                    supports_tools: false,
                },
            ],
            rate_limits: RateLimits::default(),
            enabled: false,
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
            models: vec![],
            rate_limits: RateLimits::default(),
            enabled: false,
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
}
