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
    /// A user turn carrying text plus one or more inline image blocks
    /// (attachments). Text-only providers degrade to the text part.
    Multimodal(Vec<LlmBlock>),
    /// Assistant turn that called one or more tools.
    /// Also carries any text the assistant emitted alongside the tool calls.
    AssistantWithTools {
        text: String,
        tool_uses: Vec<LlmToolUse>,
    },
    /// User-role turn carrying the results of previously-called tools.
    ToolResults(Vec<LlmToolResult>),
}

/// A single block within a multimodal message.
#[derive(Serialize, Clone, Debug)]
pub enum LlmBlock {
    Text(String),
    /// A base64-encoded image with its IANA media type (e.g. `image/png`).
    Image { media_type: String, data: String },
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
    /// The provider's reported rate-limit state for this response, when it
    /// surfaces one (Anthropic does via `anthropic-ratelimit-*` headers). Lets
    /// the agentic loop pace itself under the org's per-minute budget instead of
    /// charging into a 429. `None` when the provider reports nothing.
    pub rate_limit: Option<RateLimitSnapshot>,
}

/// A provider's reported rate-limit headroom, normalized across providers.
#[derive(Debug, Clone, Copy, Default)]
pub struct RateLimitSnapshot {
    /// Input tokens still available in the current window, if reported.
    pub input_tokens_remaining: Option<u64>,
    /// Seconds until the input-token window resets, if reported (already
    /// converted from the provider's absolute reset timestamp to a delay).
    pub reset_after_secs: Option<f64>,
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

// ─── Transient-failure resilience ──────────────────────────────────────────────

use crate::error::{AppError, ProviderErrorKind};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// Default number of automatic retries for a transient provider failure before
/// the stage is allowed to halt. Five attempts across exponential backoff spans
/// roughly a minute of grace — long enough to ride out a rate-limit window or a
/// brief overload, short enough not to strand a run.
pub const DEFAULT_MAX_RETRIES: u32 = 5;

/// Base unit for exponential backoff. Delay for attempt N (1-indexed) is
/// `BASE * 2^(N-1)`, capped at [`RETRY_MAX_DELAY_SECS`]: 2, 4, 8, 16, 32, …
const RETRY_BASE_SECS: u64 = 2;
/// Ceiling on any single backoff wait (also the ceiling applied to a
/// server-advised `retry-after`, so a hostile header can't park a run forever).
const RETRY_MAX_DELAY_SECS: u64 = 60;

/// Backoff delay (seconds) for a given 1-indexed attempt, capped.
fn backoff_secs(attempt: u32) -> u64 {
    RETRY_BASE_SECS
        .saturating_mul(1u64 << (attempt - 1).min(16))
        .min(RETRY_MAX_DELAY_SECS)
}

/// Sleep `secs`, but wake early (returning `false`) if `cancel` is raised. The
/// wait is broken into short chunks so a director "stop" interrupts a long
/// backoff/throttle instead of having to wait it out. Returns `true` if the
/// full delay elapsed without a cancel.
pub async fn interruptible_sleep(secs: u64, cancel: &AtomicBool) -> bool {
    let mut remaining_ms = secs.saturating_mul(1000);
    while remaining_ms > 0 {
        if cancel.load(Ordering::Relaxed) {
            return false;
        }
        let chunk = remaining_ms.min(200);
        tokio::time::sleep(Duration::from_millis(chunk)).await;
        remaining_ms -= chunk;
    }
    !cancel.load(Ordering::Relaxed)
}

/// Call `provider.complete`, automatically retrying *transient* failures (rate
/// limit, overload, 5xx, dropped connection) with capped exponential backoff
/// that honors a server `retry-after`. Non-transient errors (auth, bad request)
/// return immediately — retrying can't fix them. The backoff is interruptible:
/// a raised `cancel` aborts the wait and surfaces the last error so the stage
/// lands in the normal halt/abort flow. `on_retry(attempt, delay_secs, kind)`
/// is invoked before each wait so callers can narrate it into the run journal.
#[allow(clippy::too_many_arguments)]
pub async fn complete_with_retry(
    provider: &dyn LlmProvider,
    api_base: &str,
    api_key: Option<&str>,
    req: &LlmRequest,
    client: &reqwest::Client,
    cancel: &AtomicBool,
    max_retries: u32,
    on_retry: &mut (dyn FnMut(u32, u64, ProviderErrorKind) + Send),
) -> AppResult<LlmResponse> {
    let mut attempt: u32 = 0;
    loop {
        match provider.complete(api_base, api_key, req, client).await {
            Ok(resp) => return Ok(resp),
            Err(e) => {
                // Only transient failures are worth waiting on.
                let Some((kind, retry_after)) = e.transient_retry() else {
                    return Err(e);
                };
                attempt += 1;
                if attempt > max_retries {
                    return Err(e);
                }
                // Prefer the server's advice; fall back to exponential backoff.
                // Either way, never wait longer than the cap.
                let delay = retry_after
                    .unwrap_or_else(|| backoff_secs(attempt))
                    .min(RETRY_MAX_DELAY_SECS);
                on_retry(attempt, delay, kind);
                if !interruptible_sleep(delay, cancel).await {
                    // A stop landed mid-backoff — don't keep retrying.
                    return Err(e);
                }
            }
        }
    }
}

/// Build an [`AppError::Provider`] for a request that never reached the server
/// (connection reset, DNS failure, timeout). Always transient.
pub fn network_error(message: impl Into<String>) -> AppError {
    AppError::Provider {
        kind: ProviderErrorKind::Network,
        retry_after: None,
        message: message.into(),
    }
}

// ─── Sub-modules ──────────────────────────────────────────────────────────────

pub mod anthropic;
pub mod openai_compat;

#[cfg(test)]
mod tests;
