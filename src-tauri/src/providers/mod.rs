// src-tauri/src/providers/mod.rs
//! Normalized LLM request/response types + the `LlmProvider` trait.
//!
//! All providers (Anthropic, OpenAI-compatible, etc.) speak this common
//! language.  `chat_engine.rs` builds an `LlmRequest`, calls the right
//! `LlmProvider::complete()`, and gets back an `LlmResponse` — no
//! provider-specific code leaks into the engine.

use crate::error::AppResult;
use serde::{Deserialize, Serialize};

// ─── Reasoning effort ─────────────────────────────────────────────────────────

/// Per-request reasoning-effort knob — the author-facing "how hard the model
/// thinks" lever. Provider-portable: Anthropic maps it to `output_config.effort`
/// (or a `budget_tokens` thinking budget on the models that predate effort),
/// OpenAI-compat maps it to `reasoning_effort`. `None` (represented as "off" in
/// the UI) means no thinking params at all.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    Low,
    Medium,
    High,
    Xhigh,
    Max,
    /// Talk's Swift: the least reasoning the model takes, never more than its
    /// own default. The adapters lower the effort without turning thinking on
    /// (`low` effort alone on an Anthropic effort model, `none` on an OpenAI
    /// model that accepts it, otherwise `low`) and send nothing to a model
    /// without effort control. Internal: never stored, never read from a
    /// request (`skip_deserializing`).
    #[serde(skip_deserializing)]
    Least,
}

impl Effort {
    /// Canonical lowercase token — the DB storage form and the API level string.
    pub fn as_str(&self) -> &'static str {
        match self {
            Effort::Low => "low",
            Effort::Medium => "medium",
            Effort::High => "high",
            Effort::Xhigh => "xhigh",
            Effort::Max => "max",
            // As a level string it is the lowest common one.
            Effort::Least => "low",
        }
    }
    /// Parse the DB/token form back into an `Effort`. `None` for an unknown or
    /// absent value (so a NULL column round-trips to "off").
    pub fn from_str(s: &str) -> Option<Effort> {
        match s.trim().to_ascii_lowercase().as_str() {
            "low" => Some(Effort::Low),
            "medium" => Some(Effort::Medium),
            "high" => Some(Effort::High),
            "xhigh" => Some(Effort::Xhigh),
            "max" => Some(Effort::Max),
            _ => None,
        }
    }
}

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
    /// How hard the model should think for this request. `None` ⇒ no thinking
    /// params (the provider omits them). The provider maps it per the
    /// model-capability matrix (see `anthropic::thinking_json`).
    pub effort: Option<Effort>,
    /// Whether to mark stable prefixes (tools, system, conversation head) with
    /// Anthropic prompt-cache breakpoints. Set `true` only for **repeated-prefix**
    /// contexts — agentic loops and multi-turn chat (TALK, DIRECT), where the
    /// same tokens are re-sent within the cache TTL so the ~0.1× read repays the
    /// 1.25× write. Leave `false` for one-shot calls (REVIEW / structured
    /// `tool_choice`), where a cache write would just be a wasted 25% surcharge.
    /// Anthropic-only: the OpenAI-compatible provider caches automatically and
    /// ignores this (see `openai_compat::build_request`).
    pub cache: bool,
    /// A stable key for the conversation this request continues (a Talk
    /// thread's `prompt_cache_key`, [`prompt_cache_key`]), so OpenAI routes
    /// its requests together and their shared prefix hits the cache. Sent
    /// only to OpenAI's own API (`openai_compat`); `None` for one-shot calls.
    pub cache_key: Option<String>,
}

/// The `prompt_cache_key` of a Talk thread: a hash of its id, so the key is
/// stable for the thread's life and says nothing about it (never its title).
pub fn prompt_cache_key(thread_id: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(format!("octopush-talk:{thread_id}").as_bytes());
    let hex: String = digest.iter().take(16).map(|b| format!("{b:02x}")).collect();
    format!("talk-{hex}")
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LlmMessage {
    pub role: LlmRole,
    pub content: LlmContent,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub enum LlmRole {
    User,
    Assistant,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub enum LlmContent {
    /// Plain text (most common — user prompts, simple assistant replies).
    Text(String),
    /// A user turn carrying text plus one or more inline image blocks
    /// (attachments). Text-only providers degrade to the text part.
    Multimodal(Vec<LlmBlock>),
    /// Assistant turn that called one or more tools.
    /// Also carries any text the assistant emitted alongside the tool calls.
    AssistantWithTools {
        /// The assistant turn's FULL content-block array, VERBATIM and in the
        /// original order (thinking, redacted_thinking, text, tool_use — however
        /// they were interleaved). When thinking is on, the API requires each
        /// block replayed unchanged and in order (a signed thinking block can't
        /// be dropped, and reordering interleaved thinking/tool_use 400s the next
        /// request). On an OpenAI Responses turn with reasoning, its output items
        /// behind an origin item instead (`openai_compat::parse_responses_response`).
        /// Empty for Chat Completions and for turns built without a captured
        /// response (TALK, the truncation path) — the serializer then rebuilds
        /// from `text` + `tool_uses`.
        raw: Vec<serde_json::Value>,
        text: String,
        tool_uses: Vec<LlmToolUse>,
    },
    /// User-role turn carrying the results of previously-called tools.
    ToolResults(Vec<LlmToolResult>),
}

/// A single block within a multimodal message.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub enum LlmBlock {
    Text(String),
    /// A base64-encoded image with its IANA media type (e.g. `image/png`).
    Image { media_type: String, data: String },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct LlmToolUse {
    /// Provider-assigned id used to correlate tool_result back to tool_use.
    pub id: String,
    pub name: String,
    pub input: serde_json::Value,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
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

/// `Default` is an empty answer that ended its turn, for fixtures: a literal
/// ending in `..Default::default()` keeps compiling when a field is added.
#[derive(Debug, Default)]
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
    /// The response's FULL content-block array, kept VERBATIM and in order
    /// (thinking/redacted_thinking with `signature`/`data`, text, tool_use).
    /// Replayed unchanged as the next assistant turn so signed thinking survives
    /// and interleaved thinking/tool_use ordering is preserved (reordering 400s).
    /// For an OpenAI Responses turn with reasoning: an origin item naming the
    /// model, then its reasoning / message / `function_call` output items in
    /// order (replayed only to that same model). Empty for Chat Completions.
    pub raw_content: Vec<serde_json::Value>,
    /// The provider sent no usage for this answer (a stream that ended
    /// without its usage chunk), so the token counts are 0 because they are
    /// unknown, not because it was free. Callers record it on the existing
    /// usage-not-reported path (the `usage_unreported` stage flag, `unpriced`
    /// in the ledger), never as $0.
    pub usage_unreported: bool,
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

#[derive(Debug, PartialEq, Clone, Default)]
pub enum LlmStopReason {
    #[default]
    EndTurn,
    ToolUse,
    MaxTokens,
    Other(String),
}

/// One piece of a streamed answer, the same shape for every provider. Tool
/// events carry the content-block `index`, which ties a tool's input pieces
/// and its end to its start.
#[derive(Debug, Clone, PartialEq)]
pub enum StreamEvent {
    /// More answer text.
    Text(String),
    /// A tool call opened; its input follows in pieces.
    ToolStart { index: usize, id: String, name: String },
    /// A piece of a tool call's input JSON, as sent (not valid JSON alone).
    ToolInput { index: usize, partial: String },
    /// A tool call's input is complete.
    ToolEnd { index: usize },
    /// The attempt failed and is being sent again: drop everything streamed
    /// since the call began.
    Reset,
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

    /// Like `complete`, handing `sink` each piece of the answer as it is
    /// generated, and returning the same assembled response (usage,
    /// `raw_content`), so pricing and replay don't change. This default
    /// doesn't stream: it calls `complete` and hands over the whole text as
    /// one `Text`, so a provider without streaming of its own works as is.
    async fn stream(
        &self,
        api_base: &str,
        api_key: Option<&str>,
        req: &LlmRequest,
        client: &reqwest::Client,
        sink: &mut (dyn FnMut(StreamEvent) + Send),
    ) -> AppResult<LlmResponse> {
        let resp = self.complete(api_base, api_key, req, client).await?;
        if !resp.text.is_empty() {
            sink(StreamEvent::Text(resp.text.clone()));
        }
        Ok(resp)
    }
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

/// Retries for a model server on this Mac (a loopback base: Ollama, LM
/// Studio, a local gateway) that refuses the connection. One, because a
/// server that isn't running won't start in the next minute, and waiting out
/// the full backoff (about a minute) only delays the message that says so.
pub const LOCAL_CONNECT_RETRIES: u32 = 1;

/// Whether `api_base` points at this Mac: `localhost` (or a `*.localhost`
/// name), `127.0.0.0/8` or `::1`. Decided on the URL alone, never by DNS.
pub fn is_loopback_base(api_base: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(api_base.trim()) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    // An IPv6 host comes bracketed ("[::1]").
    let host = host.trim_start_matches('[').trim_end_matches(']');
    match host.parse::<std::net::IpAddr>() {
        Ok(ip) => ip.is_loopback(),
        Err(_) => {
            let name = host.trim_end_matches('.').to_ascii_lowercase();
            name == "localhost" || name.ends_with(".localhost")
        }
    }
}

/// The client a request to `api_base` goes out on: `given` for a remote
/// provider, the pooled loopback client (`tls::local_llm_client`: no read
/// bound, no proxy) for a model server on this Mac, so a slow local model
/// that takes an hour to answer is never cut off.
pub fn client_for<'a>(api_base: &str, given: &'a reqwest::Client) -> &'a reqwest::Client {
    if is_loopback_base(api_base) {
        crate::tls::local_llm_client()
    } else {
        given
    }
}

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

/// Call `provider.complete`, automatically retrying *transient* failures (429,
/// 529, 5xx, a connection that couldn't be opened or dropped mid-body) with
/// capped exponential backoff that honors a server `retry-after`. Everything
/// else returns at once: auth and bad requests, which retrying can't fix; a
/// spend-cap 429 and any status the provider marks `x-should-retry: false`
/// ([`classify_status`]); and a connection lost or timed out after the
/// request was sent ([`request_error`]), which the provider may still be
/// working on. A model server on this Mac that refuses
/// the connection gets [`LOCAL_CONNECT_RETRIES`] retry, then fails with the
/// message that it isn't reachable. The backoff is interruptible:
/// a raised `cancel` aborts the wait and surfaces the last error so the stage
/// lands in the normal halt/abort flow. `on_retry(attempt, of, delay_secs,
/// kind)` is invoked before each wait so callers can narrate it into the run
/// journal; `of` is this failure's retry budget (`max_retries`, or
/// [`LOCAL_CONNECT_RETRIES`] for a local server that refuses).
#[allow(clippy::too_many_arguments)]
pub async fn complete_with_retry(
    provider: &dyn LlmProvider,
    api_base: &str,
    api_key: Option<&str>,
    req: &LlmRequest,
    client: &reqwest::Client,
    cancel: &AtomicBool,
    max_retries: u32,
    on_retry: &mut (dyn FnMut(u32, u32, u64, ProviderErrorKind) + Send),
) -> AppResult<LlmResponse> {
    let mut attempt: u32 = 0;
    let local = is_loopback_base(api_base);
    loop {
        match provider.complete(api_base, api_key, req, client).await {
            Ok(resp) => return Ok(resp),
            Err(e) => {
                // Only transient failures are worth waiting on.
                let Some((kind, retry_after)) = e.transient_retry() else {
                    return Err(e);
                };
                attempt += 1;
                let local_unreachable = local && kind == ProviderErrorKind::Network;
                let budget = if local_unreachable { max_retries.min(LOCAL_CONNECT_RETRIES) } else { max_retries };
                if attempt > budget {
                    // A local server that still refuses is a standing fault
                    // now: the message already says it isn't reachable.
                    return Err(if local_unreachable { into_final(e) } else { e });
                }
                // Prefer the server's advice; fall back to exponential backoff.
                // Either way, never wait longer than the cap.
                let delay = retry_after
                    .unwrap_or_else(|| backoff_secs(attempt))
                    .min(RETRY_MAX_DELAY_SECS);
                on_retry(attempt, budget, delay, kind);
                if !interruptible_sleep(delay, cancel).await {
                    // A stop landed mid-backoff — don't keep retrying.
                    return Err(e);
                }
            }
        }
    }
}

/// The journal/turn line for retry `attempt` of `of` (the budget
/// `complete_with_retry` reports): the same words wherever a provider call
/// is retried (sub-agents, Direct stages, the Talk director).
pub fn retry_notice(attempt: u32, of: u32, delay_secs: u64, kind: ProviderErrorKind) -> String {
    format!("{} — retrying in {delay_secs}s (retry {attempt} of {of})", kind.label())
}

/// How often a request raced against a cancel flag looks at the flag: short
/// enough that Stop reads as instant, long enough to cost nothing.
const CANCEL_POLL_MS: u64 = 100;

/// Resolve once `cancel` is raised. It polls because a turn's cancel is a
/// plain `AtomicBool` shared with the tool loop, `run_command` and the
/// sub-agents; a Stop is never more than [`CANCEL_POLL_MS`] late.
pub async fn until_cancelled(cancel: &AtomicBool) {
    while !cancel.load(Ordering::Relaxed) {
        tokio::time::sleep(Duration::from_millis(CANCEL_POLL_MS)).await;
    }
}

/// Run `fut` unless `cancel` is raised first. `None` means the cancel won:
/// `fut` is dropped where it stands, which for a provider call closes the
/// HTTP connection, so the request in flight is abandoned instead of waited
/// out (a backoff sleep inside it ends too).
pub async fn or_cancelled<F: std::future::Future>(fut: F, cancel: &AtomicBool) -> Option<F::Output> {
    if cancel.load(Ordering::Relaxed) {
        return None;
    }
    tokio::select! {
        out = fut => Some(out),
        _ = until_cancelled(cancel) => None,
    }
}

/// How a cancellable, retried provider call ended.
#[derive(Debug)]
pub enum Completion {
    Done(LlmResponse),
    /// The cancel flag was raised during the request (abandoned), during a
    /// backoff wait, or as the last attempt failed. A stop, not a failure.
    Cancelled,
    /// The call failed for good. `retries` is how many retries ran first:
    /// the full bound for a transient error that never cleared, 0 for one no
    /// retry can fix.
    Failed { error: AppError, retries: u32 },
}

/// [`complete_with_retry`] raced against `cancel` with [`or_cancelled`]: the
/// same backoff, `retry-after` handling and `on_retry` narration, plus a Stop
/// that ends the request in flight instead of waiting for its answer.
#[allow(clippy::too_many_arguments)]
pub async fn complete_cancellable(
    provider: &dyn LlmProvider,
    api_base: &str,
    api_key: Option<&str>,
    req: &LlmRequest,
    client: &reqwest::Client,
    cancel: &AtomicBool,
    max_retries: u32,
    on_retry: &mut (dyn FnMut(u32, u32, u64, ProviderErrorKind) + Send),
) -> Completion {
    let mut retries = 0u32;
    let outcome = {
        let mut counting = |attempt: u32, of: u32, delay: u64, kind: ProviderErrorKind| {
            retries = attempt;
            on_retry(attempt, of, delay, kind);
        };
        or_cancelled(
            complete_with_retry(provider, api_base, api_key, req, client, cancel, max_retries, &mut counting),
            cancel,
        )
        .await
    };
    match outcome {
        Some(Ok(resp)) => Completion::Done(resp),
        // A stop that interrupts a backoff surfaces the last error: it is
        // still the user's stop.
        Some(Err(error)) if !cancel.load(Ordering::Relaxed) => Completion::Failed { error, retries },
        _ => Completion::Cancelled,
    }
}

/// How long a streamed answer from `api_base` may send nothing at all before
/// the turn gives up on it: the adapter's own `bound` (`anthropic::STREAM_IDLE`,
/// `openai_compat::STREAM_IDLE`, as only some servers ping while they work).
/// Final, never retried ([`silent_stream_error`]): the request was answered
/// with a 200, so the provider may still be generating. A model server on
/// this Mac has no bound (`None`), as it has no read bound (`client_for`).
pub fn stream_idle(api_base: &str, bound: Duration) -> Option<Duration> {
    (!is_loopback_base(api_base)).then_some(bound)
}

/// The streamed counterpart of [`complete_cancellable`]: `provider.stream`
/// with the same backoff, `retry-after` handling, `on_retry` narration and
/// local-server rule, each attempt raced against `cancel`. When an attempt
/// that already streamed something fails and is sent again, `sink` gets
/// [`StreamEvent::Reset`] first, so the partial answer is dropped.
#[allow(clippy::too_many_arguments)]
pub async fn stream_with_retry(
    provider: &dyn LlmProvider,
    api_base: &str,
    api_key: Option<&str>,
    req: &LlmRequest,
    client: &reqwest::Client,
    cancel: &AtomicBool,
    max_retries: u32,
    on_retry: &mut (dyn FnMut(u32, u64, ProviderErrorKind) + Send),
    sink: &mut (dyn FnMut(StreamEvent) + Send),
) -> Completion {
    let local = is_loopback_base(api_base);
    let mut attempt: u32 = 0;
    loop {
        let mut streamed = false;
        let outcome = {
            let mut counted = |ev: StreamEvent| {
                streamed = true;
                sink(ev);
            };
            or_cancelled(provider.stream(api_base, api_key, req, client, &mut counted), cancel).await
        };
        let error = match outcome {
            None => return Completion::Cancelled,
            Some(Ok(resp)) => return Completion::Done(resp),
            Some(Err(_)) if cancel.load(Ordering::Relaxed) => return Completion::Cancelled,
            Some(Err(error)) => error,
        };
        let Some((kind, retry_after)) = error.transient_retry() else {
            return Completion::Failed { error, retries: attempt };
        };
        attempt += 1;
        let local_unreachable = local && kind == ProviderErrorKind::Network;
        let budget = if local_unreachable { max_retries.min(LOCAL_CONNECT_RETRIES) } else { max_retries };
        if attempt > budget {
            let error = if local_unreachable { into_final(error) } else { error };
            return Completion::Failed { error, retries: attempt - 1 };
        }
        if streamed {
            sink(StreamEvent::Reset);
        }
        let delay = retry_after.unwrap_or_else(|| backoff_secs(attempt)).min(RETRY_MAX_DELAY_SECS);
        on_retry(attempt, delay, kind);
        if !interruptible_sleep(delay, cancel).await {
            return Completion::Cancelled;
        }
    }
}

/// What the user reads when a provider call failed for good after `retries`
/// retries: what happened, that nothing is lost and how to go on, then the
/// provider's own message. An error that wasn't retried keeps the provider's
/// message as it is (an auth error still names the API key).
pub fn final_failure_text(error: &AppError, retries: u32) -> String {
    match error.transient_retry() {
        Some((kind, _)) if retries > 0 => {
            let label = kind.label();
            let (first, rest) = label.split_at(1);
            format!(
                "{}{rest}, still failing after {retries} {}. The conversation is saved: send \
                 your message again, or say \"continue\", to pick up where it left off. ({error})",
                first.to_ascii_uppercase(),
                if retries == 1 { "retry" } else { "retries" },
            )
        }
        _ => error.to_string(),
    }
}

/// Why a request that was sent but not answered isn't sent again: the
/// provider may already be generating the answer (and counting its tokens),
/// so a retry could run the whole request a second time.
const NOT_RETRIED: &str = "It was not retried: the provider may still be working on the request, and sending it again could run it twice. Send your message again to retry.";

/// Build an [`AppError::Provider`] for a `reqwest` send error to `api_base`,
/// prefixed with `what`:
/// - a connection that couldn't be opened (refused, DNS, connect timeout,
///   proxy): the request never reached the provider, so it is
///   [`network_error`] (transient; the retry layer sends it again). For a
///   model server on this Mac the message says it isn't reachable;
/// - a TLS failure no retry can fix (a compromised-CA denylist refusal, a TLS
///   version/suite mismatch): `ProviderErrorKind::Other`, with the reason;
/// - anything after the request went out (the read timeout, a connection
///   reset or closed while waiting): final, `ProviderErrorKind::Other`, and
///   the message says why it wasn't retried ([`NOT_RETRIED`]).
pub fn request_error(what: &str, api_base: &str, e: &reqwest::Error) -> AppError {
    let detail = crate::tls::describe_request_error(e);
    if crate::tls::is_permanent_tls_failure(e) {
        return final_error(format!("{what}: {detail}"));
    }
    if e.is_connect() {
        return network_error(if is_loopback_base(api_base) {
            format!("The model server on this Mac at {} isn't reachable. Is it running? ({what}: {detail})", api_base.trim())
        } else {
            format!("{what}: {detail}")
        });
    }
    if e.is_timeout() {
        return final_error(format!("{what}: the provider sent no answer before the read timeout ({detail}). {NOT_RETRIED}"));
    }
    final_error(format!("{what}: the connection was lost after the request was sent ({detail}). {NOT_RETRIED}"))
}

/// Build the error for an answer whose body couldn't be read in full, never
/// reported as a JSON error. A connection that dropped after the 200 (a
/// reset mid-body) is [`network_error`], transient: the answer it carried
/// is gone, so the retry layer sends the request again. One that went
/// silent hit the read bound and is final, like a send that timed out.
pub fn body_error(what: &str, e: &reqwest::Error) -> AppError {
    let detail = crate::tls::describe_request_error(e);
    if e.is_timeout() {
        return final_error(format!("{what}: the connection went silent while the answer was arriving ({detail}). {NOT_RETRIED}"));
    }
    network_error(format!("{what}: the connection was lost while the answer was arriving ({detail})"))
}

/// Parse a `retry-after` header (delta-seconds form, per RFC 9110) into a
/// whole-second delay, as Anthropic and OpenAI send it on a 429.
pub(crate) fn parse_retry_after(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.trim().parse::<u64>().ok())
}

/// The provider's `x-should-retry` header, when it sends one (`true` or
/// `false`): its own word on whether the same request can succeed.
pub(crate) fn parse_should_retry(headers: &reqwest::header::HeaderMap) -> Option<bool> {
    let value = headers.get("x-should-retry")?.to_str().ok()?.trim().to_ascii_lowercase();
    match value.as_str() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

/// What a 429's body says when the limit is one the account set or ran out
/// of, rather than a per-minute rate (Anthropic's usage limit, OpenAI's
/// quota), lowercased.
const SPEND_CAP_MARKERS: [&str; 6] = [
    "usage limit",
    "spend limit",
    "spending limit",
    "insufficient_quota",
    "exceeded your current quota",
    "credit balance",
];

/// Classify a non-success answer: its status, then what the provider says
/// about retrying it. A transient status marked `x-should-retry: false` is
/// final (`Other`). A 429 with no `retry-after` whose body names a spend or
/// usage limit is [`ProviderErrorKind::SpendCap`]: it keeps failing however
/// long the backoff waits.
pub(crate) fn classify_status(status: u16, retry_after: Option<u64>, should_retry: Option<bool>, body: &str) -> ProviderErrorKind {
    let kind = ProviderErrorKind::from_http_status(status);
    if kind == ProviderErrorKind::RateLimit && retry_after.is_none() {
        let body = body.to_ascii_lowercase();
        if SPEND_CAP_MARKERS.iter().any(|m| body.contains(m)) {
            return ProviderErrorKind::SpendCap;
        }
    }
    if kind.is_transient() && should_retry == Some(false) {
        return ProviderErrorKind::Other;
    }
    kind
}

/// The error for a non-success answer: `label` (how the provider's errors
/// open), the status and the body as sent, classified by [`classify_status`].
pub(crate) async fn status_error(label: &str, resp: reqwest::Response) -> AppError {
    let status = resp.status();
    // Read the headers BEFORE the body consumes the response.
    let retry_after = parse_retry_after(resp.headers());
    let should_retry = parse_should_retry(resp.headers());
    let text = resp.text().await.unwrap_or_default();
    AppError::Provider {
        kind: classify_status(status.as_u16(), retry_after, should_retry, &text),
        retry_after,
        // Keep the historical message shape — the UI and journals already
        // key off the embedded status + body text.
        message: format!("{label} {status}: {text}"),
    }
}

/// The error for a stream that sent nothing for `idle` after its 200. Final,
/// like a body that dropped: the provider may still be generating, and
/// sending the request again could run (and bill) it twice.
pub fn silent_stream_error(what: &str, idle: Duration) -> AppError {
    final_error(format!("{what}: the stream sent nothing for {idle:?} while the answer was arriving. {NOT_RETRIED}"))
}

/// The error for a stream that ended before the provider said the answer
/// was complete. Final, like a body cut off mid-answer.
pub fn cut_off_error(what: &str) -> AppError {
    final_error(format!("{what}: the stream ended before the answer was complete. {NOT_RETRIED}"))
}

/// A provider failure no retry is attempted for.
fn final_error(message: String) -> AppError {
    AppError::Provider { kind: ProviderErrorKind::Other, retry_after: None, message }
}

/// `e` as a final error with the same text, for a failure the retry layer
/// has given up on early (a model server on this Mac that isn't running).
fn into_final(e: AppError) -> AppError {
    match e {
        AppError::Provider { message, .. } => final_error(message),
        other => other,
    }
}

/// Build an [`AppError::Provider`] for a request that never reached the
/// server (the connection couldn't be opened). Always transient: sending it
/// again is safe.
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
pub mod sse;

#[cfg(test)]
mod tests;
