//! Session model — a Session is a first-class container for an agentic
//! coding workflow: a named PTY, an attached model, token budget, tags, etc.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub name: String,
    pub color: String,
    pub icon: String,
    pub project_root: String,
    pub agent: AgentConfig,
    pub token_budget: Option<u64>,
    pub tokens_used: u64,
    pub tokens_input: u64,
    pub tokens_output: u64,
    pub status: SessionStatus,
    pub context_files: Vec<String>,
    pub tags: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub last_active: DateTime<Utc>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Active,
    Idle,
    Paused,
    Completed,
    Error,
}

impl SessionStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            SessionStatus::Active => "active",
            SessionStatus::Idle => "idle",
            SessionStatus::Paused => "paused",
            SessionStatus::Completed => "completed",
            SessionStatus::Error => "error",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "active" => Self::Active,
            "paused" => Self::Paused,
            "completed" => Self::Completed,
            "error" => Self::Error,
            _ => Self::Idle,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    pub provider: Provider,
    pub model: String,
    #[serde(default = "default_temperature")]
    pub temperature: f32,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
    #[serde(default)]
    pub system_prompt_override: Option<String>,
}

fn default_temperature() -> f32 {
    1.0
}
fn default_max_tokens() -> u32 {
    8192
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            provider: Provider::Anthropic,
            model: "claude-opus-4-8".to_string(),
            temperature: 1.0,
            max_tokens: 8192,
            system_prompt_override: None,
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum Provider {
    Anthropic,
    AnthropicBedrock,
    OpenAI,
    Google,
    Ollama,
    Custom(String),
}

/// Parameters for creating a new session. Defaults applied server-side.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionArgs {
    pub name: String,
    pub project_root: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub agent: Option<AgentConfig>,
    #[serde(default)]
    pub token_budget: Option<u64>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub context_files: Vec<String>,
}

impl Session {
    pub fn from_args(id: String, args: CreateSessionArgs) -> Self {
        let now = Utc::now();
        Self {
            id,
            name: args.name,
            color: args.color.unwrap_or_else(|| "#a78bfa".into()),
            icon: args.icon.unwrap_or_else(|| "🐙".into()),
            project_root: args.project_root,
            agent: args.agent.unwrap_or_default(),
            token_budget: args.token_budget,
            tokens_used: 0,
            tokens_input: 0,
            tokens_output: 0,
            status: SessionStatus::Idle,
            context_files: args.context_files,
            tags: args.tags,
            created_at: now,
            last_active: now,
        }
    }
}
