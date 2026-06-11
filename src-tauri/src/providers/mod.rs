// src-tauri/src/providers/mod.rs
//! Normalized LLM request/response types + the `LlmProvider` trait.
//!
//! All providers (Anthropic, OpenAI-compatible, etc.) speak this common
//! language.  `chat_engine.rs` builds an `LlmRequest`, calls the right
//! `LlmProvider::complete()`, and gets back an `LlmResponse` — no
//! provider-specific code leaks into the engine.

use crate::error::AppResult;
use serde::Serialize;

// ─── Request types ────────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
pub struct LlmRequest {
    pub model: String,
    pub max_tokens: u32,
    pub system: String,
    pub messages: Vec<LlmMessage>,
    pub tools: Vec<LlmTool>,
    /// Force the model to call this named tool (guaranteed-shape structured
    /// output — the schema-call primitive). `None` leaves tool use optional.
    pub tool_choice: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct LlmMessage {
    pub role: LlmRole,
    pub content: LlmContent,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub enum LlmRole {
    User,
    Assistant,
}

#[derive(Serialize, Clone, Debug)]
pub enum LlmContent {
    /// Plain text (most common — user prompts, simple assistant replies).
    Text(String),
    /// Assistant turn that called one or more tools.
    /// Also carries any text the assistant emitted alongside the tool calls.
    AssistantWithTools {
        text: String,
        tool_uses: Vec<LlmToolUse>,
    },
    /// User-role turn carrying the results of previously-called tools.
    ToolResults(Vec<LlmToolResult>),
}

#[derive(Serialize, Clone, Debug)]
pub struct LlmToolUse {
    /// Provider-assigned id used to correlate tool_result back to tool_use.
    pub id: String,
    pub name: String,
    pub input: serde_json::Value,
}

#[derive(Serialize, Clone, Debug)]
pub struct LlmToolResult {
    pub tool_use_id: String,
    pub content: String,
    pub is_error: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct LlmTool {
    pub name: String,
    pub description: String,
    /// JSON schema for the tool input.
    pub input_schema: serde_json::Value,
}

// ─── Response types ───────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct LlmResponse {
    pub text: String,
    pub tool_uses: Vec<LlmToolUse>,
    pub stop_reason: LlmStopReason,
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Tokens that were served from the prompt cache (cheaper than regular input).
    #[allow(dead_code)]
    pub cache_read_tokens: u64,
    /// Tokens written into the prompt cache this turn (slightly more expensive than regular input).
    #[allow(dead_code)]
    pub cache_creation_tokens: u64,
}

#[derive(Debug, PartialEq, Clone)]
pub enum LlmStopReason {
    EndTurn,
    ToolUse,
    MaxTokens,
    Other(String),
}

// ─── Trait ────────────────────────────────────────────────────────────────────

#[async_trait::async_trait]
pub trait LlmProvider: Send + Sync {
    async fn complete(
        &self,
        api_base: &str,
        api_key: Option<&str>,
        req: &LlmRequest,
        client: &reqwest::Client,
    ) -> AppResult<LlmResponse>;
}

// ─── Sub-modules ──────────────────────────────────────────────────────────────

pub mod anthropic;
pub mod openai_compat;

#[cfg(test)]
mod tests;
