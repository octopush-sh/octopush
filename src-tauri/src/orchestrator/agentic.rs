//! Headless agentic tool-loop. Reuses the chat-engine leaf helpers
//! (`build_llm_tools`, `execute_tool`) but, unlike `chat_engine::send_agentic`,
//! it persists nothing and emits no events — it just runs and returns a result.

use crate::chat_engine::{build_llm_tools, execute_tool_cancellable};
use crate::error::{AppResult, ProviderErrorKind};
use crate::orchestrator::types::{BlockedAsk, BlockedQuestion, ToolCallLog};
use crate::providers::{
    complete_with_retry, interruptible_sleep, Effort, LlmContent, LlmMessage, LlmProvider,
    LlmRequest, LlmResponse, LlmRole, LlmStopReason, LlmTool, LlmToolResult, LlmToolUse,
    DEFAULT_MAX_RETRIES,
};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

/// Upper bound on a single proactive rate-limit pause. A window reset is at most
/// ~60s out; the small margin absorbs clock skew without parking a run.
const MAX_THROTTLE_SECS: u64 = 65;

/// Cap (bytes) on a tool result fed back to the model. A single huge read can
/// otherwise inflate every later turn's input tokens for the rest of the stage.
const TOOL_RESULT_CAP_BYTES: usize = 24_000;

/// The `max_tokens` floor for a stage given its effort. High-effort thinking
/// spends its own tokens before the answer, so the output cap must clear that
/// or a deep-thinking stage truncates mid-answer. (The `output-128k` beta is
/// already sent, so 64k is safe.) `None`/low/medium keep the historical 32768.
pub fn max_tokens_for(effort: Option<Effort>) -> u32 {
    match effort {
        None | Some(Effort::Low) | Some(Effort::Medium) => 32768,
        Some(Effort::High) => 48000,
        Some(Effort::Xhigh) | Some(Effort::Max) => 64000,
    }
}

/// Decide how long, if at all, to pause before the NEXT model call given the
/// rate-limit headroom the provider just reported. Returns `Some(secs)` only
/// when the remaining input-token budget is below what this turn consumed — the
/// context only grows, so the next call would almost certainly 429 — and the
/// window's reset delay is known. Bounded by [`MAX_THROTTLE_SECS`].
fn compute_throttle(resp: &LlmResponse) -> Option<u64> {
    let rl = resp.rate_limit.as_ref()?;
    let remaining = rl.input_tokens_remaining?;
    let reset = rl.reset_after_secs?;
    if resp.input_tokens > 0 && remaining < resp.input_tokens && reset > 0.0 {
        Some((reset.ceil() as u64).clamp(1, MAX_THROTTLE_SECS))
    } else {
        None
    }
}

/// Cap an oversized tool result before it's fed back to the model. The FULL
/// result is still kept in the work journal as evidence — only the copy sent
/// back to the model is trimmed (head + tail), with a marker telling the model
/// how to retrieve the omitted middle if it needs it.
fn cap_tool_result(s: &str) -> String {
    if s.len() <= TOOL_RESULT_CAP_BYTES {
        return s.to_string();
    }
    let head_budget = TOOL_RESULT_CAP_BYTES * 3 / 4;
    let tail_budget = TOOL_RESULT_CAP_BYTES - head_budget;
    let mut head_end = head_budget.min(s.len());
    while !s.is_char_boundary(head_end) {
        head_end -= 1;
    }
    let mut tail_start = s.len() - tail_budget;
    while !s.is_char_boundary(tail_start) {
        tail_start += 1;
    }
    let shown = head_end + (s.len() - tail_start);
    format!(
        "{}\n… [tool output truncated — {shown} of {} bytes shown; re-run with a narrower range or query if you need the omitted middle] …\n{}",
        &s[..head_end],
        s.len(),
        &s[tail_start..],
    )
}

/// Aggregate result of a headless agentic run.
#[derive(Clone, Debug, Default)]
pub struct AgenticResult {
    pub text: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub tool_calls: Vec<ToolCallLog>,
    /// False when the loop exhausted `max_iterations` without a final answer.
    /// Callers must not treat an unfinished result as a successful stage.
    pub finished: bool,
    /// Set when the loop stopped because the model called `ask_director`: the
    /// stage is blocked on a director decision. The caller parks it as a
    /// checkpoint and re-runs it once answered. `finished` stays false.
    pub blocked: Option<BlockedAsk>,
    /// Structured verdict from a `submit_verdict` tool call (auto-loop review
    /// stages only). `None` when the stage didn't call it — the caller may
    /// still fall back to the text sentinel.
    pub verdict: Option<crate::orchestrator::types::ReviewVerdict>,
    /// True when `text` came from the forced close at the iteration cap: the
    /// loop ran out of tool turns and the model was asked to write its final
    /// answer with what it had. `finished` is true, but the caller should
    /// annotate the artifact as possibly incomplete.
    pub closed_at_cap: bool,
    /// Set alongside `blocked`: the full conversation up to (and including)
    /// the `ask_director` turn, so the answered stage can CONTINUE the same
    /// conversation instead of re-running — and re-paying — from scratch.
    pub blocked_transcript: Option<BlockedTranscript>,
    /// Spend from `ask_stage` peer consultations, priced at each PEER model's
    /// rate (the caller must add it to the stage cost rather than re-pricing
    /// these tokens at the stage's own model).
    pub peer_cost_usd: f64,
    /// Peer-consultation token counts (kept out of the main counters so the
    /// stage-model pricing stays correct).
    pub peer_input_tokens: u64,
    pub peer_output_tokens: u64,
}

/// The conversation state persisted while a stage is parked on `ask_director`:
/// every message so far, the assistant turn that asked included (with its raw
/// content blocks, so signed thinking replays), plus the ask's tool_use id —
/// the director's answers come back as that call's tool_result.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct BlockedTranscript {
    pub messages: Vec<LlmMessage>,
    pub ask_tool_use_id: String,
}

/// Build the resume message list for an answered `ask_director` block: the
/// saved transcript plus a tool-result turn answering the ask (and an
/// explicit not-executed error for any sibling tool calls from that turn —
/// the API requires a result for every tool_use). `answer` is the formatted
/// director-decisions text.
pub fn resume_messages_for_answered_block(
    transcript: &BlockedTranscript,
    answer: &str,
) -> Vec<LlmMessage> {
    let mut messages = transcript.messages.clone();
    let mut results: Vec<LlmToolResult> = Vec::new();
    if let Some(LlmMessage { content: LlmContent::AssistantWithTools { tool_uses, .. }, .. }) =
        messages.last()
    {
        for u in tool_uses {
            if u.id == transcript.ask_tool_use_id {
                results.push(LlmToolResult {
                    tool_use_id: u.id.clone(),
                    content: answer.to_string(),
                    is_error: false,
                });
            } else {
                results.push(LlmToolResult {
                    tool_use_id: u.id.clone(),
                    content: "not executed — superseded by ask_director; call it again if still needed"
                        .to_string(),
                    is_error: true,
                });
            }
        }
    }
    if results.is_empty() {
        // Defensive: a transcript whose tail isn't a tool turn can't take
        // tool results — deliver the answer as a plain user turn instead.
        messages.push(LlmMessage { role: LlmRole::User, content: LlmContent::Text(answer.to_string()) });
    } else {
        messages.push(LlmMessage { role: LlmRole::User, content: LlmContent::ToolResults(results) });
    }
    messages
}

/// The DIRECT-only escape-valve tool. Appended to every DIRECT stage's toolset
/// AFTER the per-stage allowlist filter — so it survives a review stage's
/// read-only allowlist — and never added to TALK (which shares
/// `build_llm_tools` but has a human present, making the tool meaningless).
pub const ASK_DIRECTOR_TOOL: &str = "ask_director";

fn ask_director_tool() -> LlmTool {
    LlmTool {
        name: ASK_DIRECTOR_TOOL.to_string(),
        description: "Stop and ask the director a blocking question ONLY when you cannot proceed \
            without a decision that only they can make — a genuine ambiguity, a missing spec or \
            credential, or contradictory requirements. Give your recommended default for each \
            question so they can accept quickly. Do NOT use it for choices you can reasonably make \
            yourself. Calling this ends your work on this stage until the director answers; prefer \
            to ask before making expensive or irreversible changes."
            .to_string(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "summary": {
                    "type": "string",
                    "description": "One sentence: what you are blocked on."
                },
                "questions": {
                    "type": "array",
                    "description": "The specific decisions you need from the director.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "question": { "type": "string", "description": "The decision you need." },
                            "whyBlocked": { "type": "string", "description": "Why you cannot proceed without it." },
                            "recommendedDefault": { "type": "string", "description": "Your best answer if the director does not specify." }
                        },
                        "required": ["question", "recommendedDefault"]
                    }
                }
            },
            "required": ["summary", "questions"]
        }),
    }
}

/// The structured verdict channel for auto-loop review stages (API substrate).
/// A tool call parses identically across providers, where the `VERDICT:` text
/// sentinel depended on model compliance and silently gated the run when a
/// model phrased it differently.
pub const SUBMIT_VERDICT_TOOL: &str = "submit_verdict";

fn submit_verdict_tool() -> LlmTool {
    LlmTool {
        name: SUBMIT_VERDICT_TOOL.to_string(),
        description: "Deliver your review verdict. Call this EXACTLY ONCE, when your findings are \
            complete: verdict `pass` if the work is acceptable, `changes_requested` if it must be \
            revised. Put your full findings in `findings` — that text is handed to the next stage \
            (and, on `changes_requested`, to the stage being sent back), so include every finding \
            with its severity, location, and the concrete fix."
            .to_string(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "verdict": {
                    "type": "string",
                    "enum": ["pass", "changes_requested"],
                    "description": "The review outcome."
                },
                "findings": {
                    "type": "string",
                    "description": "The complete findings backing the verdict."
                }
            },
            "required": ["verdict", "findings"]
        }),
    }
}

/// Parse a `submit_verdict` tool input. Tolerant on the verdict token (case,
/// hyphens); `None` for an unrecognized value — the caller falls back to the
/// text sentinel and, failing that, the human gate.
fn parse_submit_verdict(u: &LlmToolUse) -> (Option<crate::orchestrator::types::ReviewVerdict>, String) {
    use crate::orchestrator::types::ReviewVerdict;
    let verdict = u
        .input
        .get("verdict")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_ascii_lowercase().replace('-', "_"))
        .and_then(|s| match s.as_str() {
            "pass" => Some(ReviewVerdict::Pass),
            "changes_requested" => Some(ReviewVerdict::ChangesRequested),
            _ => None,
        });
    let findings = u
        .input
        .get("findings")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    (verdict, findings)
}

/// One plain user message — the seed conversation for a fresh stage.
pub fn user_messages(text: &str) -> Vec<LlmMessage> {
    vec![LlmMessage { role: LlmRole::User, content: LlmContent::Text(text.to_string()) }]
}

/// A completed earlier stage a running stage may consult via `ask_stage`:
/// its archived artifact + journal narration, and the model that produced
/// them (the answer comes from THAT model — the point is to ask the mind
/// that did the work, not to re-read its paper).
#[derive(Clone, Debug)]
pub struct PeerStage {
    /// 0-based pipeline position (surfaced to the model as 1-based `step`).
    pub position: i64,
    pub role: String,
    pub model: String,
    /// The stage's artifact text, pre-capped by the builder.
    pub artifact_text: String,
    /// Digest of the stage's journal narration, pre-capped by the builder.
    pub journal_digest: String,
}

/// The inter-stage query channel: lets a stage ask a completed earlier stage
/// a question instead of guessing at its intent. Only offered when peers
/// exist.
pub const ASK_STAGE_TOOL: &str = "ask_stage";

fn ask_stage_tool(peers: &[PeerStage]) -> LlmTool {
    let roster = peers
        .iter()
        .map(|p| format!("step {}: {} ({})", p.position + 1, p.role.replace('_', " "), p.model))
        .collect::<Vec<_>>()
        .join("; ");
    LlmTool {
        name: ASK_STAGE_TOOL.to_string(),
        description: format!(
            "Ask a completed earlier pipeline stage a SPECIFIC question about its work — its \
             intent, a decision it made, or a detail its summary omits. The answer comes from \
             that stage's own model with its archived work as context. Available stages: {roster}. \
             Use sparingly (each question costs a model call); prefer reading the workspace for \
             anything a file can answer."
        ),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "step": {
                    "type": "integer",
                    "description": "The 1-based step number of the stage to ask."
                },
                "question": {
                    "type": "string",
                    "description": "The specific question."
                }
            },
            "required": ["step", "question"]
        }),
    }
}

/// Answer an `ask_stage` call: a one-shot, tool-less completion against the
/// PEER's model, seeded with the peer's archived artifact + journal. Returns
/// `(answer_text, cost_usd, input_tokens, output_tokens)`; errors come back
/// as tool-result error strings so the asking stage can carry on without the
/// answer.
async fn answer_ask_stage(
    peers: &[PeerStage],
    u: &LlmToolUse,
    client: &reqwest::Client,
    cancel: &AtomicBool,
    emitter: &crate::orchestrator::live::LiveEmitter<'_>,
) -> (String, bool, f64, u64, u64) {
    let step = u.input.get("step").and_then(|v| v.as_i64()).unwrap_or(0);
    let question = u.input.get("question").and_then(|v| v.as_str()).unwrap_or("").trim();
    let Some(peer) = peers.iter().find(|p| p.position + 1 == step) else {
        let roster = peers.iter().map(|p| (p.position + 1).to_string()).collect::<Vec<_>>().join(", ");
        return (
            format!("ERROR: no completed stage at step {step} — available steps: {roster}"),
            false,
            0.0,
            0,
            0,
        );
    };
    if question.is_empty() {
        return ("ERROR: ask_stage needs a non-empty question".into(), false, 0.0, 0, 0);
    }
    let (provider, api_base, api_key) = match crate::chat_engine::resolve_provider(&peer.model) {
        Ok(t) => t,
        Err(e) => return (format!("ERROR: could not reach that stage's model: {e}"), false, 0.0, 0, 0),
    };
    let system = format!(
        "You are the {} stage of an automated development pipeline. You already completed your \
         work; below is your archived output. A later stage is asking you a question about it. \
         Answer concisely and concretely, grounded in your archived work — say so plainly if the \
         archive doesn't contain the answer.",
        peer.role.replace('_', " "),
    );
    let mut context = String::new();
    if !peer.artifact_text.trim().is_empty() {
        context.push_str(&format!("Your final output was:\n{}\n\n", peer.artifact_text));
    }
    if !peer.journal_digest.trim().is_empty() {
        context.push_str(&format!("Your working notes were:\n{}\n\n", peer.journal_digest));
    }
    context.push_str(&format!("The question from the later stage:\n{question}"));
    let req = LlmRequest {
        model: peer.model.clone(),
        max_tokens: 2048,
        system,
        messages: user_messages(&context),
        tools: vec![],
        tool_choice: None,
        effort: None,
        cache: false,
    };
    let mut on_retry = |attempt: u32, delay: u64, kind: crate::error::ProviderErrorKind| {
        emitter.notice(&format!(
            "{} — retrying in {delay}s (attempt {attempt} of {DEFAULT_MAX_RETRIES})",
            kind.label()
        ));
    };
    match complete_with_retry(
        provider.as_ref(),
        &api_base,
        api_key.as_deref(),
        &req,
        client,
        cancel,
        DEFAULT_MAX_RETRIES,
        &mut on_retry,
    )
    .await
    {
        Ok(resp) => {
            let cost = crate::orchestrator::cost::stage_cost(
                &peer.model,
                resp.input_tokens,
                resp.output_tokens,
                resp.cache_read_tokens,
                resp.cache_creation_tokens,
            );
            let text = resp.text.trim().to_string();
            let answer = if text.is_empty() { "(the stage had no answer)".to_string() } else { text };
            (answer, true, cost, resp.input_tokens, resp.output_tokens)
        }
        Err(e) => (format!("ERROR: the stage could not answer: {e}"), false, 0.0, 0, 0),
    }
}

/// Fraction of the model's context window the request may fill before old
/// tool results start being compacted.
const CONTEXT_FILL_RATIO_PCT: usize = 70;
/// Context-window guess (tokens) for models the catalog doesn't know. Small
/// local models are exactly the ones that die on an overgrown history, so the
/// guess is deliberately conservative.
const DEFAULT_CONTEXT_TOKENS: usize = 100_000;
/// What a compacted tool result is truncated to.
const COMPACTED_RESULT_CHARS: usize = 500;
/// The newest messages are never compacted — the model needs its recent
/// working set intact.
const COMPACTION_KEEP_TAIL: usize = 4;

/// Rough size (chars) of one message's model-visible content.
fn message_chars(m: &LlmMessage) -> usize {
    match &m.content {
        LlmContent::Text(t) => t.len(),
        LlmContent::Multimodal(blocks) => blocks
            .iter()
            .map(|b| match b {
                crate::providers::LlmBlock::Text(t) => t.len(),
                crate::providers::LlmBlock::Image { data, .. } => data.len() / 2,
            })
            .sum(),
        LlmContent::AssistantWithTools { text, tool_uses, .. } => {
            text.len() + tool_uses.iter().map(|u| u.input.to_string().len()).sum::<usize>()
        }
        LlmContent::ToolResults(rs) => rs.iter().map(|r| r.content.len()).sum(),
    }
}

/// Compact the OLDEST tool results (never the last [`COMPACTION_KEEP_TAIL`]
/// messages) until the history estimate fits `target_chars`. Returns how many
/// results were compacted. Old tool output is the safest thing to shrink: the
/// model has already acted on it, and the marker says how to get it back.
fn compact_history(messages: &mut [LlmMessage], system_chars: usize, target_chars: usize) -> usize {
    let mut total: usize = system_chars + messages.iter().map(message_chars).sum::<usize>();
    if total <= target_chars {
        return 0;
    }
    let mut compacted = 0usize;
    let end = messages.len().saturating_sub(COMPACTION_KEEP_TAIL);
    for m in messages[..end].iter_mut() {
        if total <= target_chars {
            break;
        }
        if let LlmContent::ToolResults(results) = &mut m.content {
            for r in results.iter_mut() {
                if r.content.len() > COMPACTED_RESULT_CHARS + 200 {
                    let keep = crate::chat_engine::truncate_char_safe(&r.content, COMPACTED_RESULT_CHARS);
                    let new = format!(
                        "{keep}\n… [older tool output compacted to keep the conversation inside the model's context window — re-run the tool if you need it again]"
                    );
                    total -= r.content.len().saturating_sub(new.len());
                    r.content = new;
                    compacted += 1;
                    if total <= target_chars {
                        break;
                    }
                }
            }
        }
    }
    compacted
}

/// Test-only re-export of [`compact_history`] (the fn itself stays private).
#[cfg(test)]
pub fn compact_history_for_tests(
    messages: &mut [LlmMessage],
    system_chars: usize,
    target_chars: usize,
) -> usize {
    compact_history(messages, system_chars, target_chars)
}

/// The model's context window (tokens) from the provider catalog, or the
/// conservative default when unknown.
fn model_context_tokens(model: &str) -> usize {
    crate::provider_router::ProviderRouter::load()
        .ok()
        .and_then(|r| r.find_model(model).map(|(_, mi)| mi.max_context as usize))
        .filter(|c| *c > 0)
        .unwrap_or(DEFAULT_CONTEXT_TOKENS)
}

/// The last-resort question text when a block carries no usable summary either.
const BLOCK_FALLBACK_QUESTION: &str = "The stage needs a decision to proceed.";

/// Normalize a parsed/salvaged [`BlockedAsk`] so the director ALWAYS sees usable
/// context — never a blank question label. For each question: an empty/whitespace
/// `question` is backfilled (from its `why_blocked`, else the ask's `summary`,
/// else the fallback); a question with NO text at all (no question/why/default)
/// is dropped. If that leaves no questions, one is synthesized from the summary.
/// The summary itself is backfilled to the fallback when blank so the UI header
/// is never empty either.
fn normalize_blocked_ask(ask: BlockedAsk) -> BlockedAsk {
    let summary_text = |s: &str| -> String {
        if s.trim().is_empty() {
            BLOCK_FALLBACK_QUESTION.to_string()
        } else {
            s.trim().to_string()
        }
    };
    let mut out: Vec<BlockedQuestion> = Vec::new();
    for mut q in ask.questions {
        let has_q = !q.question.trim().is_empty();
        let has_why = !q.why_blocked.trim().is_empty();
        let has_def = !q.recommended_default.trim().is_empty();
        if !has_q && !has_why && !has_def {
            continue; // entirely empty — nothing to show; drop it.
        }
        if !has_q {
            q.question = if has_why {
                q.why_blocked.trim().to_string()
            } else {
                summary_text(&ask.summary)
            };
        }
        out.push(q);
    }
    if out.is_empty() {
        out.push(BlockedQuestion {
            question: summary_text(&ask.summary),
            why_blocked: String::new(),
            recommended_default: String::new(),
        });
    }
    BlockedAsk { summary: summary_text(&ask.summary), questions: out }
}

/// Parse an `ask_director` tool call's input into a [`BlockedAsk`]. With
/// [`BlockedAsk`]/[`BlockedQuestion`] tolerant of missing/aliased fields, the
/// strict parse succeeds for ANY array-of-objects payload — so a well-formed
/// multi-question ask keeps every question. The result is [`normalize_blocked_ask`]d
/// so no question ever renders blank; a strict parse is accepted only if that
/// leaves at least one question with real text, otherwise (or on a hard parse
/// failure) we salvage from the raw JSON — mapping over ALL elements (bare-string
/// or object, either field casing), then normalizing the same way. Never crashes.
pub(crate) fn parse_ask_director(u: &LlmToolUse) -> BlockedAsk {
    if let Ok(ask) = serde_json::from_value::<BlockedAsk>(u.input.clone()) {
        let normalized = normalize_blocked_ask(ask);
        if normalized.questions.iter().any(|q| !q.question.trim().is_empty()) {
            return normalized;
        }
    }
    // Salvage path: pull whatever is present out of the raw JSON, tolerating a
    // bare-string question, either field casing, and any number of questions.
    let summary = u
        .input
        .get("summary")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_default();
    let field = |q: &serde_json::Value, camel: &str, snake: &str| -> String {
        q.get(camel)
            .or_else(|| q.get(snake))
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_default()
    };
    let questions: Vec<BlockedQuestion> = u
        .input
        .get("questions")
        .and_then(|q| q.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|q| {
                    if let Some(s) = q.as_str() {
                        return Some(BlockedQuestion {
                            question: s.to_string(),
                            why_blocked: String::new(),
                            recommended_default: String::new(),
                        });
                    }
                    if q.is_object() {
                        return Some(BlockedQuestion {
                            question: field(q, "question", "question"),
                            why_blocked: field(q, "whyBlocked", "why_blocked"),
                            recommended_default: field(q, "recommendedDefault", "recommended_default"),
                        });
                    }
                    None
                })
                .collect()
        })
        .unwrap_or_default();
    // Normalization backfills blank question text and synthesizes one from the
    // summary when the array yields nothing usable — so both paths guarantee it.
    normalize_blocked_ask(BlockedAsk { summary, questions })
}

/// Run the tool-use loop against `provider` until it returns a final answer
/// (or `max_iterations` is hit, or `cancel` is set). Tools execute in
/// `workspace_path`. The cancel flag is checked at the top of each iteration:
/// when set, the loop stops before the next model turn, closes the journal
/// with a notice, and returns an UNFINISHED result (the caller maps it to a
/// failed stage that lands in the normal halt-recovery flow).
#[allow(clippy::too_many_arguments)]
pub async fn run_agentic_loop(
    provider: &dyn LlmProvider,
    api_base: &str,
    api_key: Option<&str>,
    client: &reqwest::Client,
    model: &str,
    system: &str,
    // The seed conversation: a fresh stage passes one user message
    // (`initial_user_messages`); an answered `ask_director` block passes its
    // saved transcript + the answer turn (see `resume_messages_for_answered_block`).
    initial_messages: Vec<LlmMessage>,
    workspace_path: &Path,
    max_iterations: usize,
    cancel: &std::sync::Arc<AtomicBool>,
    emitter: &crate::orchestrator::live::LiveEmitter<'_>,
    // Per-stage tool allowlist. `None` grants the full workspace tool set;
    // `Some(list)` restricts the agent to exactly those tools (a review stage
    // runs read-only, an implementer gets write/run, etc.).
    allowed_tools: Option<&[String]>,
    // How hard the model thinks per turn. `None` ⇒ no thinking (today's
    // behavior). Also raises the `max_tokens` floor so deep thinking doesn't
    // truncate the answer.
    effort: Option<Effort>,
    // Sandbox write roots when the mission is sandboxed (`Some` ⇒ in-process
    // `run_command` runs under seatbelt and `write_file` is confined).
    sandbox_roots: Option<&[String]>,
    // Auto-loop review stage: expose `submit_verdict` so the verdict arrives
    // as a structured tool call instead of a fragile text sentinel.
    verdict_tool: bool,
    // Remaining run-budget headroom (USD) when the stage started. The old
    // budget gate only checked BETWEEN stages, so one 100-turn stage could
    // blow through the whole budget unchecked; with a limit set, the loop
    // stops opening new tool turns once the stage's own spend crosses it and
    // closes with what it has (same forced-close path as the iteration cap).
    spend_limit: Option<f64>,
    // Completed earlier stages this stage may consult via `ask_stage`.
    // Empty ⇒ the tool is not offered.
    peers: &[PeerStage],
) -> AppResult<AgenticResult> {
    let mut tools = build_llm_tools();
    if let Some(allowed) = allowed_tools {
        // Implied grants keep allowlists saved before a tool existed working:
        // read access (read_file/list_files) implies the read-only search
        // tools (grep/glob), and write_file implies the safer edit_file. An
        // explicit grant of the new names works too.
        let has = |name: &str| allowed.iter().any(|a| a == name);
        tools.retain(|t| match t.name.as_str() {
            "grep" | "glob" => {
                has(&t.name) || has("read_file") || has("list_files")
            }
            "edit_file" => has(&t.name) || has("write_file"),
            other => has(other),
        });
    }
    // The escape valve is appended AFTER the allowlist filter so it is always
    // available to a DIRECT stage — even a review stage whose allowlist is
    // read-only. It is deliberately NOT part of `build_llm_tools` (shared with
    // TALK), which has a human present and no use for a director-ask tool.
    tools.push(ask_director_tool());
    // Same placement rationale for the auto-loop verdict channel: it must
    // survive a review stage's read-only allowlist.
    if verdict_tool {
        tools.push(submit_verdict_tool());
    }
    // Inter-stage query channel — also allowlist-independent (asking an
    // earlier stage is not a workspace mutation).
    if !peers.is_empty() {
        tools.push(ask_stage_tool(peers));
    }
    let mut messages: Vec<LlmMessage> = initial_messages;
    let mut out = AgenticResult::default();
    // Why the loop left its turn budget: the iteration cap (default) or a
    // mid-stage budget stop. Drives the forced-close notice below.
    let mut budget_stopped = false;
    // Context-window guard: chars ≈ 4×tokens; compaction starts at 70% fill.
    // Small-window models (locals, some OpenAI-compat) used to die mid-stage
    // with a context 400 the retry could never fix.
    let context_char_budget =
        model_context_tokens(model) * 4 * CONTEXT_FILL_RATIO_PCT / 100;
    // How long to pace before the next call, set from the previous response's
    // reported rate-limit headroom (see `compute_throttle`). Applied at the top
    // of the loop so it covers every path that issues another call.
    let mut pending_throttle: Option<u64> = None;

    for _ in 0..max_iterations {
        if cancel.load(Ordering::Relaxed) {
            emitter.notice("stopped by the director");
            out.text = "(stopped by the director)".to_string();
            return Ok(out);
        }

        // Proactive throttle: ride out a nearly-spent input-token window instead
        // of charging into a guaranteed 429. Interruptible by a director stop.
        if let Some(wait) = pending_throttle.take() {
            emitter.notice(&format!(
                "input-token budget low — pausing {wait}s for the rate-limit window to reset"
            ));
            if !interruptible_sleep(wait, cancel).await {
                emitter.notice("stopped by the director");
                out.text = "(stopped by the director)".to_string();
                return Ok(out);
            }
        }

        // Keep the request inside the model's window: compact the oldest tool
        // results once the estimate crosses the fill threshold. (This breaks
        // the prompt-cache prefix for the turn it fires on — acceptable, it
        // only happens when the alternative is a hard context 400.)
        let n = compact_history(&mut messages, system.len(), context_char_budget);
        if n > 0 {
            emitter.notice(&format!(
                "context window filling — compacted {n} older tool result(s) to stay under the model's limit"
            ));
        }

        let req = LlmRequest {
            model: model.to_string(),
            max_tokens: max_tokens_for(effort),
            system: system.to_string(),
            messages: messages.clone(),
            tools: tools.clone(),
            tool_choice: None,
            effort,
            // Agentic stage loop: system prompt, tool schemas and accumulated
            // history are re-sent every iteration — cache the stable prefix.
            cache: true,
        };
        // Transient failures (rate limit, overload, 5xx, dropped connection) are
        // retried in place with backoff — the accumulated message history is
        // preserved, so a momentary blip never costs the stage its work or forces
        // a halt. Each wait is narrated into the journal.
        let mut on_retry = |attempt: u32, delay: u64, kind: ProviderErrorKind| {
            emitter.notice(&format!(
                "{} — retrying in {delay}s (attempt {attempt} of {DEFAULT_MAX_RETRIES})",
                kind.label()
            ));
        };
        let resp = complete_with_retry(
            provider,
            api_base,
            api_key,
            &req,
            client,
            cancel,
            DEFAULT_MAX_RETRIES,
            &mut on_retry,
        )
        .await?;
        out.input_tokens += resp.input_tokens;
        out.output_tokens += resp.output_tokens;
        out.cache_read_tokens += resp.cache_read_tokens;
        out.cache_creation_tokens += resp.cache_creation_tokens;
        // Pace the next call if this response says the window is nearly spent.
        pending_throttle = compute_throttle(&resp);

        // Escape valve: if the model called `ask_director`, asking supersedes
        // acting. Stop the loop immediately — do NOT execute this turn's tools
        // (including any other tool_uses, which are discarded), do NOT push more
        // messages, and do NOT continue. The result is unfinished (it's a block,
        // not a completed answer); the caller parks the stage and re-runs it
        // once the director answers.
        if let Some(u) = resp.tool_uses.iter().find(|u| u.name == ASK_DIRECTOR_TOOL) {
            let ask = parse_ask_director(u);
            emitter.notice(&format!("paused to ask the director: {}", ask.summary));
            // Persist the conversation INCLUDING the asking turn, so the
            // answered stage continues right here instead of re-running (and
            // re-paying for) everything that led to the question.
            let mut tmsgs = messages.clone();
            tmsgs.push(LlmMessage {
                role: LlmRole::Assistant,
                content: LlmContent::AssistantWithTools {
                    raw: resp.raw_content.clone(),
                    text: resp.text.clone(),
                    tool_uses: resp.tool_uses.clone(),
                },
            });
            out.blocked_transcript =
                Some(BlockedTranscript { messages: tmsgs, ask_tool_use_id: u.id.clone() });
            out.blocked = Some(ask);
            return Ok(out);
        }

        // Structured verdict: a well-formed `submit_verdict` call ends the
        // stage — the findings ARE the artifact. Sibling tool calls in the
        // same turn are discarded (the verdict supersedes further acting). A
        // malformed verdict value falls through to the execution loop, which
        // feeds an error result back so the model retries with a valid token.
        if let Some(u) = resp.tool_uses.iter().find(|u| u.name == SUBMIT_VERDICT_TOOL) {
            let (verdict, findings) = parse_submit_verdict(u);
            if let Some(v) = verdict {
                out.verdict = Some(v);
                out.text = if findings.is_empty() { resp.text.trim().to_string() } else { findings };
                out.finished = true;
                return Ok(out);
            }
        }

        let is_final =
            resp.stop_reason != LlmStopReason::ToolUse || resp.tool_uses.is_empty();

        // Truncation during tool use: feed back errors and retry (mirrors send_agentic).
        if matches!(resp.stop_reason, LlmStopReason::MaxTokens) && !resp.tool_uses.is_empty() {
            // Truncation path: do NOT replay raw_content verbatim. A turn cut off
            // at max_tokens can carry an unsigned/partial trailing thinking block,
            // and replaying it 400s the next request. Empty raw makes the
            // serializer rebuild from text + tool_uses instead (per the design).
            messages.push(LlmMessage {
                role: LlmRole::Assistant,
                content: LlmContent::AssistantWithTools {
                    raw: vec![],
                    text: resp.text.clone(),
                    tool_uses: resp.tool_uses.clone(),
                },
            });
            let errs: Vec<LlmToolResult> = resp
                .tool_uses
                .iter()
                .map(|u| LlmToolResult {
                    tool_use_id: u.id.clone(),
                    content: "ERROR: response truncated at max_tokens; retry with smaller output."
                        .into(),
                    is_error: true,
                })
                .collect();
            messages.push(LlmMessage {
                role: LlmRole::User,
                content: LlmContent::ToolResults(errs),
            });
            continue;
        }

        if is_final {
            out.text = resp.text.trim().to_string();
            out.finished = true;
            return Ok(out);
        }

        // Emit narration text before processing tool calls.
        emitter.text(&resp.text);

        // Record the assistant tool-use turn — the full content array verbatim,
        // so the next turn's replay preserves signed thinking and the exact
        // block order (required when thinking is on).
        messages.push(LlmMessage {
            role: LlmRole::Assistant,
            content: LlmContent::AssistantWithTools {
                raw: resp.raw_content.clone(),
                text: resp.text.clone(),
                tool_uses: resp.tool_uses.clone(),
            },
        });

        // Mid-stage budget stop: the stage's own spend crossed the remaining
        // run-budget headroom. Void this turn's tool calls (a result per
        // tool_use is required) and fall through to the forced close — the
        // stage ends with a real summary instead of ploughing further past
        // the cap. Final answers and blocks above are never disturbed.
        if let Some(limit) = spend_limit {
            let spent = crate::orchestrator::cost::stage_cost(
                model,
                out.input_tokens,
                out.output_tokens,
                out.cache_read_tokens,
                out.cache_creation_tokens,
            );
            let spent = spent + out.peer_cost_usd;
            if spent >= limit {
                emitter.notice(&format!(
                    "run budget reached mid-stage (${spent:.2} spent by this stage) — closing with what it has"
                ));
                let voided: Vec<LlmToolResult> = resp
                    .tool_uses
                    .iter()
                    .map(|u| LlmToolResult {
                        tool_use_id: u.id.clone(),
                        content: "not executed — the run's budget was reached; write your final answer now"
                            .into(),
                        is_error: true,
                    })
                    .collect();
                messages.push(LlmMessage { role: LlmRole::User, content: LlmContent::ToolResults(voided) });
                budget_stopped = true;
                break;
            }
        }

        // Execute each tool, collect results + log.
        let mut results: Vec<LlmToolResult> = Vec::new();
        for u in &resp.tool_uses {
            // Inter-stage consultation: answered by the PEER stage's model in
            // a one-shot completion (async — handled here, not in
            // execute_tool). Errors come back as error results so the asking
            // stage carries on.
            if u.name == ASK_STAGE_TOOL {
                emitter.tool(&u.name, &crate::orchestrator::live::tool_hint(&u.input));
                let (answer, ok, cost, itok, otok) =
                    answer_ask_stage(peers, u, client, cancel, emitter).await;
                emitter.tool_result(ok, &crate::orchestrator::live::summarize(&answer));
                out.peer_cost_usd += cost;
                out.peer_input_tokens += itok;
                out.peer_output_tokens += otok;
                out.tool_calls.push(ToolCallLog {
                    name: u.name.clone(),
                    input: u.input.clone(),
                    result: answer.clone(),
                });
                results.push(LlmToolResult {
                    tool_use_id: u.id.clone(),
                    content: cap_tool_result(&answer),
                    is_error: !ok,
                });
                continue;
            }
            // A malformed `submit_verdict` (unrecognized verdict token) gets an
            // error result instead of executing — the model retries with a
            // valid value; sibling tools in the turn still run normally.
            if u.name == SUBMIT_VERDICT_TOOL {
                results.push(LlmToolResult {
                    tool_use_id: u.id.clone(),
                    content: "ERROR: unrecognized verdict — call submit_verdict again with verdict \
                              set to exactly `pass` or `changes_requested`."
                        .into(),
                    is_error: true,
                });
                continue;
            }
            emitter.tool(&u.name, &crate::orchestrator::live::tool_hint(&u.input));
            // The chat engine consumes execute_tool's structural `ok`; the
            // orchestrator keeps its own text-based classifier for journal
            // continuity, so it deliberately ignores the bool here.
            //
            // Off-thread (`spawn_blocking`): tool execution is synchronous
            // (process spawns, filesystem) and would otherwise pin a tokio
            // worker for its whole duration — one hung stage could starve
            // every other run in the process. The cancel flag rides along so
            // a director stop interrupts a long `run_command` mid-flight.
            let (result, _) = {
                let wp = workspace_path.to_path_buf();
                let name = u.name.clone();
                let input = u.input.clone();
                let roots = sandbox_roots.map(|r| r.to_vec());
                let cancel_flag = std::sync::Arc::clone(cancel);
                tokio::task::spawn_blocking(move || {
                    execute_tool_cancellable(&wp, &name, &input, roots.as_deref(), Some(&cancel_flag))
                })
                .await
                .unwrap_or_else(|e| (format!("tool execution task failed: {e}"), false))
            };
            emitter.tool_result(!crate::orchestrator::live::looks_like_error(&result), &crate::orchestrator::live::summarize(&result));
            // The journal keeps the FULL result as evidence; only the copy fed
            // back to the model is capped, to bound input-token growth.
            out.tool_calls.push(ToolCallLog {
                name: u.name.clone(),
                input: u.input.clone(),
                result: result.clone(),
            });
            results.push(LlmToolResult {
                tool_use_id: u.id.clone(),
                content: cap_tool_result(&result),
                is_error: false,
            });
        }
        messages.push(LlmMessage {
            role: LlmRole::User,
            content: LlmContent::ToolResults(results),
        });
    }

    // Exhaustion (or a mid-stage budget stop): the limit landed mid-work.
    // Before declaring the stage lost, force a close — ONE more request with
    // NO tools ("write your final answer with what you have"). 24 turns of
    // good work used to be thrown away because the model never got to write
    // its closing summary; a possibly-incomplete but real handoff beats an
    // empty failure, and the caller annotates it so a downstream review
    // judges it accordingly.
    if !budget_stopped {
        emitter.notice(&format!(
            "iteration cap reached — {max_iterations} of {max_iterations} tool turns used; asking the model to close with what it has"
        ));
    }
    if !cancel.load(Ordering::Relaxed) {
        // The budget-stop path already closed with a user turn (the voided
        // tool results carry the close instruction); pushing another user
        // message would break role alternation on strict providers.
        if !budget_stopped {
            messages.push(LlmMessage {
                role: LlmRole::User,
                content: LlmContent::Text(
                    "Your tool budget for this stage is exhausted — you cannot call any more tools. \
                     Write your final answer NOW with what you already know: what you accomplished, \
                     what remains undone, and anything the next stage must know to continue. \
                     If you were reviewing, state your findings so far."
                        .to_string(),
                ),
            });
        }
        let req = LlmRequest {
            model: model.to_string(),
            max_tokens: max_tokens_for(effort),
            system: system.to_string(),
            messages: messages.clone(),
            tools: vec![],
            tool_choice: None,
            effort,
            cache: true,
        };
        let mut on_retry = |attempt: u32, delay: u64, kind: ProviderErrorKind| {
            emitter.notice(&format!(
                "{} — retrying in {delay}s (attempt {attempt} of {DEFAULT_MAX_RETRIES})",
                kind.label()
            ));
        };
        match complete_with_retry(
            provider,
            api_base,
            api_key,
            &req,
            client,
            cancel,
            DEFAULT_MAX_RETRIES,
            &mut on_retry,
        )
        .await
        {
            Ok(resp) => {
                out.input_tokens += resp.input_tokens;
                out.output_tokens += resp.output_tokens;
                out.cache_read_tokens += resp.cache_read_tokens;
                out.cache_creation_tokens += resp.cache_creation_tokens;
                let text = resp.text.trim().to_string();
                if !text.is_empty() {
                    out.text = text;
                    out.finished = true;
                    out.closed_at_cap = true;
                    return Ok(out);
                }
            }
            Err(e) => {
                emitter.notice(&format!("forced close failed — {e}"));
            }
        }
    }
    out.text = format!("(agentic loop hit {max_iterations} iterations without finishing)");
    Ok(out)
}
