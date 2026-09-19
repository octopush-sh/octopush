//! TALK sub-agents — the `Agent` tool.
//!
//! A skill written for Claude Code says "spawn sub-agents with the Agent
//! tool"; before this module TALK had no such tool, so the model either
//! emulated the fan-out sequentially in its own context (burning its turn
//! budget) or shelled out to an opaque `claude -p`. Now TALK exposes a tool
//! with the same name and shape (`Agent`, alias `Task`: `description`,
//! `prompt`, optional `subagent_type`/`model`), and executes every `Agent`
//! call of one assistant response **concurrently** — which is exactly how
//! Claude Code parallelizes: several tool_use blocks in one message.
//!
//! Each sub-agent is one `orchestrator::agentic::run_agentic_loop` — the same
//! provider-agnostic tool-use loop DIRECT stages run on (any `LlmProvider`),
//! with its own context, the full workspace tool set, the thread's turn
//! budget and the parent turn's cancel flag. The parent only ever sees the
//! sub-agent's final report as the tool result; its journal streams to the
//! chat as `chat://agent-log` entries and is persisted per call id so the
//! card can be rehydrated after a reload.
//!
//! Depth is 1: a sub-agent never receives the `Agent` tool.

use crate::db::Db;
use crate::error::AppResult;
use crate::chat_engine::{dangerous_command, ApprovalBroker, ApprovalDecision};
use crate::orchestrator::agentic::{run_agentic_loop, user_messages, AgenticResult, ExternalTools, ToolGate};
use crate::orchestrator::events::EventSink;
use crate::orchestrator::live::LiveEmitter;
use crate::providers::{LlmProvider, LlmTool};
use crate::skills::agents::{resolve_model_with_tiers, AgentDefinition};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

/// The tool name Claude Code skills expect.
pub const AGENT_TOOL_NAME: &str = "Agent";
/// Older skills still say `Task`; both names run the same code.
pub const TASK_TOOL_ALIAS: &str = "Task";
/// Frontend event name for a sub-agent's live journal entries.
pub const AGENT_LOG_EVENT: &str = "chat://agent-log";
/// How many sub-agents of one response run at the same time; the rest queue.
pub const MAX_CONCURRENT_AGENTS: usize = 8;
/// Longest `prompt` a single `Agent` call may carry.
const PROMPT_MAX: usize = 32_000;

pub fn is_agent_tool(name: &str) -> bool {
    name == AGENT_TOOL_NAME || name == TASK_TOOL_ALIAS
}

fn agent_input_schema(defs: &[AgentDefinition]) -> serde_json::Value {
    let type_hint = if defs.is_empty() {
        "Optional role hint (e.g. \"reviewer\", \"Explore\"); shown on the card and given to the sub-agent as its role".to_string()
    } else {
        format!(
            "Optional. One of the defined agent types — {} — runs the sub-agent under that definition (its instructions, tools and model); any other value is a plain role hint.",
            defs.iter().map(|d| format!("`{}`", d.name)).collect::<Vec<_>>().join(", ")
        )
    };
    serde_json::json!({
        "type": "object",
        "properties": {
            "description": {
                "type": "string",
                "description": "A short (3-5 word) label for the task, shown on the sub-agent's card"
            },
            "prompt": {
                "type": "string",
                "description": "The complete, self-contained task for the sub-agent. It cannot see this conversation, so include every file path, constraint and the exact shape of the report you want back."
            },
            "subagent_type": {
                "type": "string",
                "description": type_hint
            },
            "model": {
                "type": "string",
                "description": "Optional: a configured model id, or a provider-agnostic tier — \"fast\" (cheap, quick), \"balanced\", \"strong\" (deepest reasoning) — to run this sub-agent on instead of the conversation's model. Prefer a tier over an id."
            }
        },
        "required": ["description", "prompt"]
    })
}

/// The `Agent` tool plus its `Task` alias, for the TALK tool list. `defs` are
/// the workspace's `.claude/agents/*.md` definitions: the description
/// enumerates them (name — description) exactly as Claude Code's Agent tool
/// does, so a skill that says "use the security-reviewer agent" finds it.
pub fn agent_tool_definitions(defs: &[AgentDefinition]) -> Vec<LlmTool> {
    let mut description = "Delegate a self-contained task to a sub-agent that works autonomously \
         in this workspace with the same tools you have (run_command, read/write/edit files, \
         grep, glob) and returns only its final report. Call Agent several times in ONE \
         response to run those tasks in parallel — the results come back together. The \
         sub-agent has no access to this conversation and cannot ask the user anything, so \
         put everything it needs in `prompt`. Use it for independent research, reviews or \
         analyses; do the work yourself when it is small or sequential."
        .to_string();
    if !defs.is_empty() {
        description.push_str("\n\nAvailable agent types (pass as subagent_type):");
        for d in defs {
            description.push_str(&format!("\n- {}: {}", d.name, d.description));
        }
    }
    vec![
        LlmTool {
            name: AGENT_TOOL_NAME.to_string(),
            description: description.clone(),
            input_schema: agent_input_schema(defs),
        },
        LlmTool {
            name: TASK_TOOL_ALIAS.to_string(),
            description: format!("Alias of Agent. {description}"),
            input_schema: agent_input_schema(defs),
        },
    ]
}

/// One parsed `Agent` tool call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentCall {
    pub description: String,
    pub prompt: String,
    pub subagent_type: Option<String>,
    pub model: Option<String>,
}

/// Validate an `Agent` tool input. The error text is what the model gets
/// back as an error tool_result, so it says exactly what to fix.
pub fn parse_agent_call(input: &serde_json::Value) -> Result<AgentCall, String> {
    let str_field = |k: &str| input.get(k).and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty());
    let Some(prompt) = str_field("prompt") else {
        return Err("Agent needs a non-empty `prompt` — the complete task for the sub-agent".to_string());
    };
    if prompt.len() > PROMPT_MAX {
        return Err(format!(
            "Agent `prompt` is {} chars; keep it under {PROMPT_MAX} (point the sub-agent at files instead of inlining them)",
            prompt.len()
        ));
    }
    let description = str_field("description")
        .map(str::to_string)
        .unwrap_or_else(|| prompt.lines().next().unwrap_or("Sub-agent").chars().take(60).collect());
    Ok(AgentCall {
        description,
        prompt: prompt.to_string(),
        subagent_type: str_field("subagent_type").map(str::to_string),
        model: str_field("model").map(str::to_string),
    })
}

/// The system prompt a sub-agent runs under: the same workspace/tool
/// guidance as TALK, minus the human — it must decide alone and hand back a
/// report the parent can act on without reading its journal. A matched
/// `.claude/agents` definition appends its body as the agent's own
/// instructions (the same way an active skill rides on the Talk prompt).
pub fn subagent_system_prompt(
    workspace_path: &str,
    call: &AgentCall,
    definition: Option<&AgentDefinition>,
) -> String {
    let role = definition
        .map(|d| d.name.as_str())
        .or(call.subagent_type.as_deref())
        .map(|t| format!(" Your role: {t}."))
        .unwrap_or_default();
    let mut prompt = format!(
        "You are a sub-agent working in the project at {workspace_path}, spawned by the \
         main assistant to carry out one task: {description}.{role} You have tools to run \
         commands, read/write/edit files, list directories and search. run_command is a \
         NON-interactive bash in the project root — never start servers, watchers, REPLs \
         or anything that waits for stdin, and never run destructive commands (rm -rf, \
         git push --force, git reset --hard) unless the task explicitly asks for them. \
         File paths are relative to the project root. Nobody is watching this session: \
         you cannot ask questions, so make reasonable assumptions and state them. Work \
         autonomously, then finish with ONE complete, self-contained report — the main \
         assistant sees only that final message, never your tool calls. Lead with the \
         answer or findings, then the evidence (file paths, line numbers, commands run), \
         then anything left undone.",
        description = call.description,
    );
    if let Some(d) = definition {
        if !d.body.is_empty() {
            prompt.push_str(&format!("\n\n# Agent: {}\n{}", d.name, d.body));
        }
    }
    prompt
}

/// What one sub-agent produced, in the shape the parent turn persists on the
/// tool row (`agent` key) and feeds back as the tool result.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOutcome {
    /// The report handed back to the parent as the tool result.
    pub report: String,
    /// False when the sub-agent failed to produce a usable report.
    pub ok: bool,
    /// The loop reached a final answer (possibly via the forced close).
    pub finished: bool,
    /// The final answer came from the forced close at the turn cap.
    pub closed_at_cap: bool,
    /// The sub-agent stopped to ask a question it could not resolve alone.
    pub blocked: bool,
    pub model: String,
    /// The tier `model` is mapped to in Settings › Models (`fast` /
    /// `balanced` / `strong`), when it is one — the crew card's tier mix.
    pub tier: Option<String>,
    /// The cheaper model a failed first attempt ran on, when the definition's
    /// `escalate` retried this sub-agent on `model`.
    pub escalated_from: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    /// Every billed attempt, in order (empty when there was only one — the
    /// outcome's own figures are that attempt).
    pub attempts: Vec<AgentAttempt>,
    pub cost_usd: f64,
    pub duration_ms: u64,
    pub tool_calls: usize,
}

/// One billed attempt of a sub-agent — the ledger records each at its own
/// model's price.
#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentAttempt {
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cost_usd: f64,
}

impl AgentAttempt {
    pub fn from_outcome(o: &AgentOutcome) -> Self {
        Self {
            model: o.model.clone(),
            input_tokens: o.input_tokens,
            output_tokens: o.output_tokens,
            cache_read_tokens: o.cache_read_tokens,
            cache_creation_tokens: o.cache_creation_tokens,
            cost_usd: o.cost_usd,
        }
    }
}

impl AgentOutcome {
    /// The billed attempts to record: `attempts` when escalated, else the
    /// outcome itself.
    pub fn billed_attempts(&self) -> Vec<AgentAttempt> {
        if self.attempts.is_empty() {
            vec![AgentAttempt::from_outcome(self)]
        } else {
            self.attempts.clone()
        }
    }
}

/// Map a finished loop to the report the parent receives. Pure, so the exact
/// wording of every ending is tested: a clean answer passes through; a
/// forced close is flagged as possibly incomplete; an `ask_director` block
/// (the loop's escape valve — meaningless here, nobody answers) becomes the
/// question itself so the parent can decide or re-delegate; an unfinished
/// loop is a failure.
pub fn report_from_result(out: &AgenticResult, max_iterations: usize) -> (String, bool) {
    if let Some(ask) = &out.blocked {
        let mut s = String::from("Sub-agent stopped: it needed a decision it could not make alone.");
        if !ask.summary.trim().is_empty() {
            s.push_str("\n\n");
            s.push_str(ask.summary.trim());
        }
        for q in &ask.questions {
            s.push_str("\n- ");
            s.push_str(q.question.trim());
        }
        s.push_str("\n\nDecide (or ask the user), then delegate again with the answer in the prompt.");
        return (s, false);
    }
    let text = out.text.trim();
    if out.finished && !text.is_empty() {
        if out.closed_at_cap {
            return (
                format!(
                    "{text}\n\n[sub-agent reached its {max_iterations}-turn tool limit before finishing — this report may be incomplete]"
                ),
                true,
            );
        }
        return (text.to_string(), true);
    }
    (
        format!("Sub-agent hit its {max_iterations}-turn tool limit without producing a report."),
        false,
    )
}

/// Everything a sub-agent needs from the parent turn, owned so the run can
/// move into its own task.
#[derive(Clone)]
pub struct SubagentSpec {
    pub call_id: String,
    pub call: AgentCall,
    pub workspace_id: String,
    pub thread_id: String,
    pub workspace_path: String,
    /// The conversation's model; `call.model` overrides it.
    pub default_model: String,
    pub max_iterations: usize,
    pub max_tokens: u32,
    pub sandbox_roots: Option<Vec<String>>,
    /// The `.claude/agents` definition `subagent_type` matched, if any.
    pub definition: Option<AgentDefinition>,
    /// The turn runs under the Auto policy (economy director): a sub-agent
    /// that names no model runs on the balanced tier, not the director's
    /// strong model.
    pub policy_auto: bool,
}

/// Which model a sub-agent runs on: the call's explicit `model` wins, then
/// the definition's `model`, each resolved against the configured ids and
/// the user's tier map (`resolve_model_with_tiers`: exact id › mapped tier
/// › substring alias); a spec that resolves to nothing is skipped with a
/// warning rather than failing the sub-agent's start, and the conversation's
/// model is the floor. Pure so the precedence is tested.
pub fn pick_subagent_model(
    spec: &SubagentSpec,
    known_models: &[String],
    tiers: &HashMap<String, String>,
) -> String {
    let candidates: [(&str, Option<&str>); 2] = [
        ("call", spec.call.model.as_deref()),
        ("definition", spec.definition.as_ref().and_then(|d| d.model.as_deref())),
    ];
    for (origin, wanted) in candidates {
        let Some(wanted) = wanted else { continue };
        // An explicit `inherit` means the conversation's model — under Auto
        // that is the director, not the balanced fallback.
        if wanted.trim().eq_ignore_ascii_case("inherit") {
            return spec.default_model.clone();
        }
        if let Some(resolved) = resolve_model_with_tiers(wanted, known_models, tiers) {
            return resolved.to_string();
        }
        tracing::warn!(
            origin,
            model = wanted,
            "sub-agent model matches no configured model or tier; inheriting the conversation's"
        );
    }
    // Under Auto the director is the strong tier; an unspecified sub-agent
    // is legwork and runs balanced when that tier is mapped.
    if spec.policy_auto {
        if let Some(balanced) = resolve_model_with_tiers(AUTO_SUBAGENT_TIER, known_models, tiers) {
            return balanced.to_string();
        }
    }
    spec.default_model.clone()
}

/// The model id the composer sends to mean "the economy director decides":
/// the strong tier runs the conversation under the lean-context doctrine.
pub const AUTO_MODEL: &str = "auto";
/// The tier the director itself runs on under Auto.
pub const AUTO_DIRECTOR_TIER: &str = "strong";
/// The tier an unspecified sub-agent runs on under Auto.
pub const AUTO_SUBAGENT_TIER: &str = "balanced";

/// The model a turn sent as [`AUTO_MODEL`] runs on: the strong tier's model
/// when it is mapped to a configured id. `None` means the user has not set
/// the tier up — the caller says so rather than guessing a model.
pub fn director_model_for_auto(known_models: &[String], tiers: &HashMap<String, String>) -> Option<String> {
    resolve_model_with_tiers(AUTO_DIRECTOR_TIER, known_models, tiers)
        .filter(|m| tiers.get(AUTO_DIRECTOR_TIER).is_some_and(|t| t == m))
        .map(str::to_string)
}

/// The tiers (`fast`, `balanced`) that are not mapped to a configured model
/// — the doctrine names them so the director knows those roles will not run
/// cheap until Settings › Models maps them.
pub fn unmapped_subagent_tiers(known_models: &[String], tiers: &HashMap<String, String>) -> Vec<&'static str> {
    ["fast", "balanced"]
        .into_iter()
        .filter(|t| !tiers.get(*t).is_some_and(|m| known_models.iter().any(|k| k == m)))
        .collect()
}

/// The lean-context doctrine appended to the Talk system prompt under Auto.
/// `unmapped` is [`unmapped_subagent_tiers`]: the doctrine promises tiered
/// delegation only where the tiers exist.
pub fn director_doctrine(unmapped: &[&str]) -> String {
    let mut text = DOCTRINE.to_string();
    if !unmapped.is_empty() {
        text.push_str(&format!(
            " Caveat: the {} {} not mapped in Settings › Models yet, so sub-agents asking for \
             {} run on the conversation's model at its price until the user maps {} — say so \
             when it matters.",
            unmapped.join(" and "),
            if unmapped.len() == 1 { "tier is" } else { "tiers are" },
            if unmapped.len() == 1 { "it" } else { "them" },
            if unmapped.len() == 1 { "it" } else { "them" },
        ));
    }
    text
}

const DOCTRINE: &str =
    "\n\n# Economy director\nYou run on the strongest, most expensive model, and every \
     tool call re-sends your whole context at that price. Keep your context lean and spend \
     it on judgment. Delegate every broad read to sub-agents with the Agent tool — mapping \
     code, reading many files, running test suites, reading a ticket, reviewing a diff — \
     several in ONE response when the tasks are independent, and ask each for a compact \
     report (findings first, `path:line` evidence, a few hundred words). Never paste a long \
     output into your own context and never re-run what a sub-agent already reported; \
     recall stored tool output instead of re-reading. Pick the agent type by role: \
     `explorer`, `test-runner` and `ticket-reader` run on the fast tier; `implementer` \
     and `pr-maintainer` run balanced and escalate to strong on a failed attempt; \
     `reviewer` runs strong in a fresh context — that review is the quality gate before \
     any PR, so always run it. A sub-agent you give no type or model runs balanced. Do \
     small, sequential edits yourself; decide architecture, trade-offs and what the user \
     is really asking yourself — that is what your context is for.";

/// Whether a sub-agent's first attempt warrants the definition's `escalate`
/// retry: only a **failure** — no usable report. A report that merely hit
/// the turn cap is still a report (and for a writing role the tree already
/// holds its work); a `blocked` stop is a question for the director, which
/// a stronger model cannot answer either — it goes back up as-is.
pub fn should_escalate(outcome: &AgentOutcome) -> bool {
    !outcome.ok && !outcome.blocked
}

/// Whether a sub-agent can change the workspace: its definition grants a
/// write/edit tool or the shell, or it has the full set.
pub fn spec_can_write(spec: &SubagentSpec) -> bool {
    match spec.definition.as_ref().and_then(|d| d.tools.as_deref()) {
        None => true,
        Some(tools) => tools.iter().any(|t| t == "write_file" || t == "edit_file" || t == "run_command"),
    }
}

/// The model to retry on when [`should_escalate`]: the definition's
/// `escalate` resolved like any model spec, and only when it is a different
/// model than the first attempt ran on (escalating to the same model is a
/// plain retry the user did not ask for).
pub fn escalation_model(
    spec: &SubagentSpec,
    first_model: &str,
    known_models: &[String],
    tiers: &HashMap<String, String>,
) -> Option<String> {
    let wanted = spec.definition.as_ref()?.escalate.as_deref()?;
    let resolved = resolve_model_with_tiers(wanted, known_models, tiers)?;
    (resolved != first_model).then(|| resolved.to_string())
}

/// The prompt the escalated attempt runs with: the original task plus what
/// the cheaper attempt ended with, so the stronger model does not repeat the
/// same dead end. Bounded so a runaway first report cannot bloat the retry.
pub fn escalation_prompt(original: &str, first_model: &str, first_report: &str, can_write: bool) -> String {
    const REPORT_MAX: usize = 4_000;
    let mut excerpt = first_report.trim().to_string();
    if excerpt.len() > REPORT_MAX {
        let mut end = REPORT_MAX;
        while !excerpt.is_char_boundary(end) {
            end -= 1;
        }
        excerpt.truncate(end);
        excerpt.push_str("\n… [truncated]");
    }
    let tree = if can_write {
        " The working tree may already contain that attempt's partial changes: run `git status` \
         and `git diff` first, then build on them or revert them deliberately — never apply the \
         same edit twice."
    } else {
        ""
    };
    format!(
        "{original}\n\n---\nA previous attempt on a cheaper model ({first_model}) did not \
         finish this task. It ended with:\n\n{excerpt}\n\nStart from the task above; do not \
         trust the previous attempt's conclusions without checking them.{tree}"
    )
}

/// The tier an outcome reports: the tier the call or definition asked for
/// when the model is indeed that tier's model (two tiers may map to one id,
/// and the asked-for one is the truthful label), else the reverse lookup.
pub fn tier_for_outcome(spec: &SubagentSpec, model: &str, tiers: &HashMap<String, String>) -> Option<String> {
    let asked = [spec.call.model.as_deref(), spec.definition.as_ref().and_then(|d| d.model.as_deref())];
    for a in asked.into_iter().flatten() {
        if let Some(t) = crate::skills::agents::tier_for_alias(a) {
            if tiers.get(t).is_some_and(|m| m == model) {
                return Some(t.to_string());
            }
        }
    }
    crate::skills::agents::tier_of_model(model, tiers).map(str::to_string)
}

/// Fold an escalated attempt into one outcome: the stronger attempt's
/// report and ending, both attempts' spend (both were billed), and the
/// cheaper model remembered as `escalated_from`.
pub fn merge_escalated(first: AgentOutcome, second: AgentOutcome) -> AgentOutcome {
    let mut attempts = first.attempts.clone();
    if attempts.is_empty() {
        attempts.push(AgentAttempt::from_outcome(&first));
    }
    attempts.push(AgentAttempt::from_outcome(&second));
    AgentOutcome {
        escalated_from: Some(first.model.clone()),
        input_tokens: first.input_tokens + second.input_tokens,
        output_tokens: first.output_tokens + second.output_tokens,
        cache_read_tokens: first.cache_read_tokens + second.cache_read_tokens,
        cache_creation_tokens: first.cache_creation_tokens + second.cache_creation_tokens,
        cost_usd: first.cost_usd + second.cost_usd,
        duration_ms: first.duration_ms + second.duration_ms,
        tool_calls: first.tool_calls + second.tool_calls,
        attempts,
        ..second
    }
}

/// `EventSink` for one sub-agent: re-emits the `LiveEmitter`'s entries as
/// `chat://agent-log` (keyed by the tool call id instead of run/stage) and
/// persists each one so the card survives a reload.
pub struct ChatAgentSink {
    pub app: AppHandle,
    pub db: Arc<Mutex<Db>>,
    pub workspace_id: String,
    pub thread_id: String,
    pub call_id: String,
}

impl EventSink for ChatAgentSink {
    fn emit(&self, _event: &str, payload: serde_json::Value) {
        let entry = payload.get("entry").cloned().unwrap_or(serde_json::Value::Null);
        if entry.is_null() {
            return;
        }
        if let Err(e) = self
            .db
            .lock()
            .append_chat_agent_log(&self.thread_id, &self.call_id, &entry.to_string())
        {
            tracing::warn!(call_id = %self.call_id, error = %e, "failed to persist sub-agent journal entry");
        }
        let _ = self.app.emit(
            AGENT_LOG_EVENT,
            serde_json::json!({
                "workspaceId": self.workspace_id,
                "threadId": self.thread_id,
                "callId": self.call_id,
                "entry": entry,
            }),
        );
    }
}

/// The sub-agent's approval gate: a `run_command` that `dangerous_command`
/// flags parks on the SAME approval card the parent turn uses (same thread,
/// same "don't ask again" grant, same Stop-denies-all), labelled with the
/// sub-agent so the user knows who is asking. Each request gets its own
/// call id (`<agent call id>:<n>`) because one sub-agent may ask more than
/// once. A denial is fed back as an error tool_result; nothing else is
/// gated (reads, searches and edits stay ungated, as in the parent loop).
pub struct SubagentGate {
    pub broker: Arc<ApprovalBroker>,
    pub app: AppHandle,
    pub workspace_id: String,
    pub thread_id: String,
    pub call_id: String,
    /// The sub-agent's description, shown on the approval card.
    pub label: String,
    /// MCP tools (namespaced) the server did not mark read-only: a call
    /// may change external state (create an issue, post a comment), so it
    /// asks the user first — nobody is watching a sub-agent otherwise.
    pub mcp_writes: std::collections::HashSet<String>,
    seq: AtomicU64,
}

impl SubagentGate {
    pub fn new(broker: Arc<ApprovalBroker>, app: AppHandle, spec: &SubagentSpec) -> Self {
        Self {
            broker,
            app,
            workspace_id: spec.workspace_id.clone(),
            thread_id: spec.thread_id.clone(),
            call_id: spec.call_id.clone(),
            label: spec.call.description.clone(),
            mcp_writes: std::collections::HashSet::new(),
            seq: AtomicU64::new(1),
        }
    }

    /// Gate the MCP tools among `discovered` that are not read-only.
    pub fn with_mcp_writes(mut self, discovered: &[crate::mcp::McpToolInfo]) -> Self {
        self.mcp_writes = discovered.iter().filter(|t| !t.read_only).map(|t| t.namespaced.clone()).collect();
        self
    }
}

/// The reason and denial for an MCP tool the server did not mark read-only.
pub fn mcp_gate_texts(label: &str, tool: &str) -> (String, String) {
    (
        format!(
            "Sub-agent \u{201c}{label}\u{201d}: MCP tool `{tool}` may change external state (its server does not mark it read-only)"
        ),
        format!(
            "Tool call not made — the user declined to approve `{tool}`. Continue without it, \
             use a read-only tool instead, or report what you could not do; do not retry it."
        ),
    )
}

/// The reason shown on the card and the denial fed back to the sub-agent —
/// pure, so the wording is tested.
pub fn gate_texts(label: &str, reason: &str) -> (String, String) {
    (
        format!("Sub-agent \u{201c}{label}\u{201d}: {reason}"),
        format!(
            "Command not run — the user declined to approve it (flagged: {reason}). \
             Continue without it or use a safer alternative; do not retry the same command."
        ),
    )
}

#[async_trait::async_trait]
impl ToolGate for SubagentGate {
    async fn check(&self, name: &str, input: &serde_json::Value) -> Option<String> {
        let (shown, card_reason, denial) = if name == "run_command" {
            let command = input.get("command").and_then(|c| c.as_str()).unwrap_or("");
            let reason = dangerous_command(command)?;
            let (card_reason, denial) = gate_texts(&self.label, reason);
            (command.to_string(), card_reason, denial)
        } else if self.mcp_writes.contains(name) {
            let (card_reason, denial) = mcp_gate_texts(&self.label, name);
            let mut args = serde_json::to_string(input).unwrap_or_default();
            if args.len() > 400 {
                let mut end = 400;
                while !args.is_char_boundary(end) {
                    end -= 1;
                }
                args.truncate(end);
                args.push('…');
            }
            (format!("{name} {args}"), card_reason, denial)
        } else {
            return None;
        };
        let id = format!("{}:{}", self.call_id, self.seq.fetch_add(1, Ordering::Relaxed));
        match self
            .broker
            .await_approval(&self.app, &self.workspace_id, &self.thread_id, &id, &shown, &card_reason)
            .await
        {
            ApprovalDecision::Approve | ApprovalDecision::ApproveAlways => None,
            ApprovalDecision::Deny => Some(denial),
        }
    }
}

/// The workspace's MCP tools as a sub-agent sees them: the definition's
/// grant (`McpGrant`) filters the discovered set once per fan-out, and each
/// call runs off-thread with the same 60s bound Talk's own MCP calls have.
pub struct McpSubagentTools {
    pub registry: Arc<crate::mcp::McpRegistry>,
    pub worktree: std::path::PathBuf,
    pub tools: Vec<LlmTool>,
    /// One turnstile per server, shared by every sub-agent of the fan-out:
    /// the registry serialises calls per server anyway, so queueing here
    /// keeps the 60s bound on the wire time, not on the wait for a sibling.
    pub turnstiles: Arc<HashMap<String, Arc<tokio::sync::Semaphore>>>,
}

/// One turnstile per server named in `discovered`.
pub fn mcp_turnstiles(discovered: &[crate::mcp::McpToolInfo]) -> Arc<HashMap<String, Arc<tokio::sync::Semaphore>>> {
    let mut map: HashMap<String, Arc<tokio::sync::Semaphore>> = HashMap::new();
    for t in discovered {
        map.entry(t.server.clone()).or_insert_with(|| Arc::new(tokio::sync::Semaphore::new(1)));
    }
    Arc::new(map)
}

impl McpSubagentTools {
    /// `discovered` is the workspace's full MCP tool list; keep what the
    /// definition grants (everything for an untyped call).
    pub fn granted(
        registry: Arc<crate::mcp::McpRegistry>,
        worktree: &Path,
        discovered: &[crate::mcp::McpToolInfo],
        definition: Option<&AgentDefinition>,
        turnstiles: Arc<HashMap<String, Arc<tokio::sync::Semaphore>>>,
    ) -> Option<Self> {
        let tools: Vec<LlmTool> = discovered
            .iter()
            .filter(|t| definition.map(|d| d.mcp.allows(&t.namespaced)).unwrap_or(true))
            .map(|t| LlmTool {
                name: t.namespaced.clone(),
                description: t.description.clone(),
                input_schema: t.input_schema.clone(),
            })
            .collect();
        (!tools.is_empty()).then(|| Self { registry, worktree: worktree.to_path_buf(), tools, turnstiles })
    }
}

#[async_trait::async_trait]
impl ExternalTools for McpSubagentTools {
    fn definitions(&self) -> Vec<LlmTool> {
        self.tools.clone()
    }
    fn owns(&self, name: &str) -> bool {
        crate::mcp::is_mcp_tool(name) && self.tools.iter().any(|t| t.name == name)
    }
    async fn call(&self, name: &str, input: &serde_json::Value) -> Result<String, String> {
        let server = name.strip_prefix("mcp__").and_then(|r| r.split("__").next()).unwrap_or("").to_string();
        let _turn = match self.turnstiles.get(&server) {
            Some(sem) => Some(Arc::clone(sem).acquire_owned().await.map_err(|_| "MCP error: server turnstile closed".to_string())?),
            None => None,
        };
        let registry = Arc::clone(&self.registry);
        let wp = self.worktree.clone();
        let name = name.to_string();
        let input = input.clone();
        // A timeout drops the join handle, not the call: the server may still
        // execute a write after "timed out" is reported. The registry's
        // per-server mutex frees when the call returns.
        match tokio::time::timeout(
            std::time::Duration::from_secs(60),
            tokio::task::spawn_blocking(move || registry.call(&wp, &name, &input)),
        )
        .await
        {
            Ok(Ok(Ok(out))) => Ok(out),
            Ok(Ok(Err(e))) => Err(format!("MCP error: {e}")),
            _ => Err("MCP error: tool call timed out".to_string()),
        }
    }
}

/// Run one sub-agent to completion on an already-resolved provider. Split
/// from the spawning wrapper so a scripted provider + recording sink can
/// drive it in tests.
#[allow(clippy::too_many_arguments)]
pub async fn run_subagent_core(
    provider: &dyn LlmProvider,
    api_base: &str,
    api_key: Option<&str>,
    client: &reqwest::Client,
    model: &str,
    spec: &SubagentSpec,
    cancel: &Arc<AtomicBool>,
    sink: &dyn EventSink,
    gate: Option<&dyn ToolGate>,
    external: Option<&dyn ExternalTools>,
) -> AppResult<AgentOutcome> {
    let started = std::time::Instant::now();
    let emitter = LiveEmitter::new(sink, &spec.thread_id, &spec.call_id);
    let system = subagent_system_prompt(&spec.workspace_path, &spec.call, spec.definition.as_ref());
    let allowed_tools = spec.definition.as_ref().and_then(|d| d.tools.as_deref());
    let out = run_agentic_loop(
        provider,
        api_base,
        api_key,
        client,
        model,
        &system,
        user_messages(&spec.call.prompt),
        Path::new(&spec.workspace_path),
        spec.max_iterations,
        cancel,
        &emitter,
        allowed_tools,
        None,
        spec.sandbox_roots.as_deref(),
        false,
        None,
        &[],
        gate,
        external,
    )
    .await?;
    let (report, ok) = report_from_result(&out, spec.max_iterations);
    Ok(AgentOutcome {
        report,
        ok,
        finished: out.finished,
        closed_at_cap: out.closed_at_cap,
        blocked: out.blocked.is_some(),
        model: model.to_string(),
        tier: None,
        escalated_from: None,
        attempts: Vec::new(),
        input_tokens: out.input_tokens,
        output_tokens: out.output_tokens,
        cache_read_tokens: out.cache_read_tokens,
        cache_creation_tokens: out.cache_creation_tokens,
        cost_usd: crate::token_engine::cost_for(
            model,
            out.input_tokens,
            out.output_tokens,
            out.cache_read_tokens,
            out.cache_creation_tokens,
        ),
        duration_ms: started.elapsed().as_millis() as u64,
        tool_calls: out.tool_calls.len(),
    })
}

/// Run every `Agent` call of one assistant response concurrently (at most
/// [`MAX_CONCURRENT_AGENTS`] at a time) and collect the outcomes by call id.
/// A sub-agent that fails to start or errors mid-run yields a failed outcome
/// carrying the error as its report, never a panic of the parent turn.
pub async fn run_subagents(
    app: AppHandle,
    db: Arc<Mutex<Db>>,
    client: reqwest::Client,
    approvals: Arc<ApprovalBroker>,
    mcp: Arc<crate::mcp::McpRegistry>,
    specs: Vec<SubagentSpec>,
    cancel: Arc<AtomicBool>,
) -> HashMap<String, AgentOutcome> {
    let gate = Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_AGENTS));
    let mut set = tokio::task::JoinSet::new();
    // The workspace's MCP tools, discovered once per fan-out (off-thread,
    // bounded — a hung server must not stall the crew); each sub-agent then
    // sees the subset its definition grants.
    let mcp_tools: Arc<Vec<crate::mcp::McpToolInfo>> = Arc::new(match specs.first() {
        Some(first) => {
            let reg = Arc::clone(&mcp);
            let wp = std::path::PathBuf::from(&first.workspace_path);
            tokio::time::timeout(
                std::time::Duration::from_secs(20),
                tokio::task::spawn_blocking(move || reg.list_tools(&wp)),
            )
            .await
            .ok()
            .and_then(|r| r.ok())
            .unwrap_or_default()
        }
        None => Vec::new(),
    });
    let turnstiles = mcp_turnstiles(&mcp_tools);
    // Configured model ids + the user's tier map, read once per fan-out, for
    // definition/call model specs (`haiku`, `fast`, an id…).
    let known_models: Arc<Vec<String>> = Arc::new(
        crate::provider_router::ProviderRouter::load()
            .map(|r| r.list_models().into_iter().map(|m| m.model.id).collect())
            .unwrap_or_default(),
    );
    let tiers: Arc<HashMap<String, String>> = Arc::new(
        crate::settings::load_settings().map(|s| s.model_tiers).unwrap_or_default(),
    );
    for spec in specs {
        let app = app.clone();
        let db = Arc::clone(&db);
        let client = client.clone();
        let cancel = Arc::clone(&cancel);
        let gate = Arc::clone(&gate);
        let known_models = Arc::clone(&known_models);
        let tiers = Arc::clone(&tiers);
        let approvals = Arc::clone(&approvals);
        let mcp = Arc::clone(&mcp);
        let mcp_tools = Arc::clone(&mcp_tools);
        let turnstiles = Arc::clone(&turnstiles);
        set.spawn(async move {
            let _permit = gate.acquire_owned().await;
            let started = std::time::Instant::now();
            let model = pick_subagent_model(&spec, &known_models, &tiers);
            let approval_gate = SubagentGate::new(approvals, app.clone(), &spec).with_mcp_writes(&mcp_tools);
            let external = McpSubagentTools::granted(
                mcp,
                Path::new(&spec.workspace_path),
                &mcp_tools,
                spec.definition.as_ref(),
                Arc::clone(&turnstiles),
            );
            let external_ref: Option<&dyn ExternalTools> = external.as_ref().map(|e| e as &dyn ExternalTools);
            let sink = ChatAgentSink {
                app,
                db,
                workspace_id: spec.workspace_id.clone(),
                thread_id: spec.thread_id.clone(),
                call_id: spec.call_id.clone(),
            };
            let mut outcome = run_attempt(&model, &spec, &client, &cancel, &sink, &approval_gate, external_ref, started).await;
            // The definition's `escalate`: one retry on the stronger model
            // when the cheap attempt failed, blocked, or hit its turn cap —
            // unless the director stopped the turn.
            if should_escalate(&outcome) && !cancel.load(Ordering::Relaxed) {
                if let Some(stronger) = escalation_model(&spec, &model, &known_models, &tiers) {
                    tracing::info!(call = %spec.call_id, from = %model, to = %stronger, "escalating sub-agent");
                    LiveEmitter::new(&sink, &spec.thread_id, &spec.call_id).notice(&format!(
                        "escalating to {stronger}: the {model} attempt {}",
                        if outcome.blocked { "stopped on a question" } else if outcome.closed_at_cap { "hit its turn limit" } else { "failed" }
                    ));
                    let mut retry = spec.clone();
                    retry.call.prompt = escalation_prompt(&spec.call.prompt, &model, &outcome.report, spec_can_write(&spec));
                    let second = run_attempt(&stronger, &retry, &client, &cancel, &sink, &approval_gate, external_ref, std::time::Instant::now()).await;
                    outcome = merge_escalated(outcome, second);
                }
            }
            outcome.tier = tier_for_outcome(&spec, &outcome.model, &tiers);
            (spec.call_id, outcome)
        });
    }
    let mut outcomes = HashMap::new();
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok((call_id, outcome)) => {
                outcomes.insert(call_id, outcome);
            }
            Err(e) => tracing::error!(error = %e, "sub-agent task panicked or was cancelled"),
        }
    }
    outcomes
}

/// One attempt of a sub-agent on `model`: resolve the provider, run the
/// loop; any failure becomes a failed outcome carrying the error as its
/// report.
#[allow(clippy::too_many_arguments)]
async fn run_attempt(
    model: &str,
    spec: &SubagentSpec,
    client: &reqwest::Client,
    cancel: &Arc<AtomicBool>,
    sink: &ChatAgentSink,
    gate: &SubagentGate,
    external: Option<&dyn ExternalTools>,
    started: std::time::Instant,
) -> AgentOutcome {
    match crate::chat_engine::resolve_provider(model) {
        Ok((provider, api_base, api_key)) => {
            match run_subagent_core(
                provider.as_ref(),
                &api_base,
                api_key.as_deref(),
                client,
                model,
                spec,
                cancel,
                sink,
                Some(gate),
                external,
            )
            .await
            {
                Ok(o) => o,
                Err(e) => failed_outcome(model, started, format!("Sub-agent failed: {e}")),
            }
        }
        Err(e) => failed_outcome(model, started, format!("Sub-agent could not start: {e}")),
    }
}

fn failed_outcome(model: &str, started: std::time::Instant, report: String) -> AgentOutcome {
    AgentOutcome {
        report,
        ok: false,
        model: model.to_string(),
        duration_ms: started.elapsed().as_millis() as u64,
        ..AgentOutcome::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::types::{BlockedAsk, BlockedQuestion};
    use crate::providers::{LlmRequest, LlmResponse, LlmStopReason, LlmToolUse};
    use std::collections::VecDeque;

    #[test]
    fn agent_and_task_share_one_schema() {
        let defs = agent_tool_definitions(&[]);
        assert_eq!(defs.len(), 2);
        assert_eq!(defs[0].name, "Agent");
        assert_eq!(defs[1].name, "Task");
        assert_eq!(defs[0].input_schema, defs[1].input_schema);
        assert!(is_agent_tool("Agent") && is_agent_tool("Task") && !is_agent_tool("agent"));
    }

    #[test]
    fn parse_requires_a_prompt_and_derives_a_description() {
        assert!(parse_agent_call(&serde_json::json!({"description": "x"})).is_err());
        assert!(parse_agent_call(&serde_json::json!({"prompt": "   "})).is_err());
        let call = parse_agent_call(&serde_json::json!({
            "prompt": "Review the diff for correctness.\nBe thorough.",
            "subagent_type": "reviewer",
        }))
        .unwrap();
        assert_eq!(call.description, "Review the diff for correctness.");
        assert_eq!(call.subagent_type.as_deref(), Some("reviewer"));
        assert_eq!(call.model, None);
        let too_long = "x".repeat(PROMPT_MAX + 1);
        let err = parse_agent_call(&serde_json::json!({"prompt": too_long})).unwrap_err();
        assert!(err.contains("keep it under"), "{err}");
    }

    #[test]
    fn subagent_prompt_names_the_task_and_forbids_asking() {
        let call = AgentCall {
            description: "Check security".into(),
            prompt: "…".into(),
            subagent_type: Some("security-reviewer".into()),
            model: None,
        };
        let p = subagent_system_prompt("/w", &call, None);
        assert!(p.contains("/w"));
        assert!(p.contains("Check security"));
        assert!(p.contains("Your role: security-reviewer."));
        assert!(p.contains("cannot ask questions"));
        assert!(p.contains("ONE complete, self-contained report"));
    }

    #[test]
    fn report_mapping_covers_every_ending() {
        let mut out = AgenticResult { text: "  findings  ".into(), finished: true, ..Default::default() };
        assert_eq!(report_from_result(&out, 25), ("findings".into(), true));

        out.closed_at_cap = true;
        let (r, ok) = report_from_result(&out, 25);
        assert!(ok && r.starts_with("findings") && r.contains("25-turn tool limit"), "{r}");

        let unfinished = AgenticResult::default();
        let (r, ok) = report_from_result(&unfinished, 25);
        assert!(!ok && r.contains("without producing a report"), "{r}");

        let blocked = AgenticResult {
            blocked: Some(BlockedAsk {
                summary: "Which branch?".into(),
                questions: vec![BlockedQuestion {
                    question: "main or develop?".into(),
                    why_blocked: String::new(),
                    recommended_default: String::new(),
                }],
            }),
            ..Default::default()
        };
        let (r, ok) = report_from_result(&blocked, 25);
        assert!(!ok && r.contains("Which branch?") && r.contains("- main or develop?"), "{r}");
    }

    fn def(name: &str, tools: Option<Vec<&str>>, model: Option<&str>) -> AgentDefinition {
        AgentDefinition {
            name: name.into(),
            description: format!("{name} desc"),
            body: format!("You are the {name}."),
            tools: tools.map(|t| t.into_iter().map(String::from).collect()),
            mcp: crate::skills::agents::McpGrant::All,
            model: model.map(String::from),
            escalate: None,
            source: "project".into(),
        }
    }

    #[test]
    fn tool_description_enumerates_defined_agent_types() {
        let defs = agent_tool_definitions(&[def("security-reviewer", None, None), def("explore", None, None)]);
        assert!(defs[0].description.contains("Available agent types"));
        assert!(defs[0].description.contains("- security-reviewer: security-reviewer desc"));
        let hint = defs[0].input_schema["properties"]["subagent_type"]["description"].as_str().unwrap();
        assert!(hint.contains("`security-reviewer`") && hint.contains("`explore`"), "{hint}");
        assert_eq!(defs[0].input_schema, defs[1].input_schema);
    }

    #[test]
    fn a_matched_definition_appends_its_body_and_names_the_role() {
        let call = AgentCall { description: "Audit".into(), prompt: "…".into(), subagent_type: Some("security-reviewer".into()), model: None };
        let d = def("security-reviewer", None, None);
        let p = subagent_system_prompt("/w", &call, Some(&d));
        assert!(p.contains("Your role: security-reviewer."));
        assert!(p.ends_with("# Agent: security-reviewer\nYou are the security-reviewer."), "{p}");
    }

    #[test]
    fn model_precedence_is_call_then_definition_then_conversation() {
        let no_tiers: HashMap<String, String> = HashMap::new();
        let known = vec!["claude-haiku-4-5-20251001".to_string(), "gpt-4o".to_string()];
        let base = SubagentSpec {
            call_id: "c".into(),
            call: AgentCall { description: "d".into(), prompt: "p".into(), subagent_type: None, model: None },
            workspace_id: "w".into(), thread_id: "t".into(), workspace_path: "/w".into(),
            default_model: "conv-model".into(), max_iterations: 5, max_tokens: 1, sandbox_roots: None,
            definition: None,
            policy_auto: false,
        };
        assert_eq!(pick_subagent_model(&base, &known, &no_tiers), "conv-model");
        let with_def = SubagentSpec { definition: Some(def("x", None, Some("haiku"))), ..base.clone() };
        assert_eq!(pick_subagent_model(&with_def, &known, &no_tiers), "claude-haiku-4-5-20251001");
        let unresolvable = SubagentSpec { definition: Some(def("x", None, Some("sonnet"))), ..base.clone() };
        assert_eq!(pick_subagent_model(&unresolvable, &known, &no_tiers), "conv-model");
        let explicit = SubagentSpec {
            call: AgentCall { model: Some("gpt-4o".into()), ..base.call.clone() },
            definition: Some(def("x", None, Some("haiku"))),
            ..base.clone()
        };
        assert_eq!(pick_subagent_model(&explicit, &known, &no_tiers), "gpt-4o");
        // A call asking for a tier resolves through the user's map — on any
        // provider — and an unknown explicit id inherits instead of failing.
        let tiers: HashMap<String, String> = [("fast".to_string(), "gpt-4o".to_string())].into_iter().collect();
        let tiered = SubagentSpec { call: AgentCall { model: Some("fast".into()), ..base.call.clone() }, ..base.clone() };
        assert_eq!(pick_subagent_model(&tiered, &known, &tiers), "gpt-4o");
        let bogus = SubagentSpec { call: AgentCall { model: Some("no-such-model".into()), ..base.call.clone() }, ..base.clone() };
        assert_eq!(pick_subagent_model(&bogus, &known, &tiers), "conv-model");
    }

    #[test]
    fn under_auto_an_unspecified_subagent_runs_balanced_and_the_director_runs_strong() {
        let known = vec!["opus".to_string(), "sonnet".to_string(), "haiku".to_string()];
        let tiers: HashMap<String, String> = [
            ("fast".to_string(), "haiku".to_string()),
            ("balanced".to_string(), "sonnet".to_string()),
            ("strong".to_string(), "opus".to_string()),
        ]
        .into_iter()
        .collect();
        let base = SubagentSpec {
            call_id: "c".into(),
            call: AgentCall { description: "d".into(), prompt: "p".into(), subagent_type: None, model: None },
            workspace_id: "w".into(), thread_id: "t".into(), workspace_path: "/w".into(),
            default_model: "opus".into(), max_iterations: 5, max_tokens: 1, sandbox_roots: None,
            definition: None,
            policy_auto: true,
        };
        assert_eq!(pick_subagent_model(&base, &known, &tiers), "sonnet", "no model → balanced under Auto");
        // A definition's tier still wins; a call's explicit model still wins.
        let with_def = SubagentSpec { definition: Some(def("explorer", None, Some("fast"))), ..base.clone() };
        assert_eq!(pick_subagent_model(&with_def, &known, &tiers), "haiku");
        let explicit = SubagentSpec { call: AgentCall { model: Some("strong".into()), ..base.call.clone() }, ..base.clone() };
        assert_eq!(pick_subagent_model(&explicit, &known, &tiers), "opus");
        // Balanced unmapped → inherit the director's model, as before.
        let mut no_balanced = tiers.clone();
        no_balanced.remove("balanced");
        assert_eq!(pick_subagent_model(&base, &known, &no_balanced), "opus");
        // The director: the strong tier when mapped to a configured id, else
        // nothing (the caller tells the user to map it — never a guess).
        assert_eq!(director_model_for_auto(&known, &tiers).as_deref(), Some("opus"));
        let mut no_strong = tiers.clone();
        no_strong.remove("strong");
        assert_eq!(director_model_for_auto(&known, &no_strong), None);
        let mut stale: HashMap<String, String> = tiers.clone();
        stale.insert("strong".into(), "gone-model".into());
        assert_eq!(director_model_for_auto(&known, &stale), None, "a mapped id that is no longer configured");
        // A definition's explicit `inherit` means the director, not balanced.
        let inherit = SubagentSpec { definition: Some(def("mine", None, Some("inherit"))), ..base.clone() };
        assert_eq!(pick_subagent_model(&inherit, &known, &tiers), "opus");
        // The doctrine promises tiers only where they exist.
        assert!(unmapped_subagent_tiers(&known, &tiers).is_empty());
        let d = director_doctrine(&[]);
        assert!(d.contains("Delegate every broad read") && !d.contains("Caveat"));
        assert_eq!(unmapped_subagent_tiers(&known, &no_balanced), vec!["balanced"]);
        assert!(director_doctrine(&["balanced"]).contains("the balanced tier is not mapped"));
        assert!(director_doctrine(&["fast", "balanced"]).contains("the fast and balanced tiers are not mapped"));
        // The reported tier is the one asked for when two tiers share a model.
        let mut shared = tiers.clone();
        shared.insert("balanced".into(), "opus".into());
        let asked_strong = SubagentSpec { definition: Some(def("reviewer", None, Some("strong"))), ..base.clone() };
        assert_eq!(tier_for_outcome(&asked_strong, "opus", &shared).as_deref(), Some("strong"));
        assert_eq!(tier_for_outcome(&base, "opus", &shared).as_deref(), Some("balanced"), "reverse lookup, first tier wins");
        assert_eq!(tier_for_outcome(&base, "unmapped-model", &shared), None);
    }

    #[test]
    fn escalation_fires_on_failure_block_or_cap_to_a_different_model_only() {
        let known = vec!["opus".to_string(), "sonnet".to_string()];
        let tiers: HashMap<String, String> = [
            ("balanced".to_string(), "sonnet".to_string()),
            ("strong".to_string(), "opus".to_string()),
        ]
        .into_iter()
        .collect();
        let mut d = def("implementer", None, Some("balanced"));
        d.escalate = Some("strong".into());
        let spec = SubagentSpec {
            call_id: "c".into(),
            call: AgentCall { description: "d".into(), prompt: "Implement X".into(), subagent_type: Some("implementer".into()), model: None },
            workspace_id: "w".into(), thread_id: "t".into(), workspace_path: "/w".into(),
            default_model: "opus".into(), max_iterations: 5, max_tokens: 1, sandbox_roots: None,
            definition: Some(d),
            policy_auto: false,
        };
        let ok = AgentOutcome { ok: true, finished: true, model: "sonnet".into(), ..Default::default() };
        assert!(!should_escalate(&ok));
        assert!(should_escalate(&AgentOutcome { ok: false, model: "sonnet".into(), ..Default::default() }));
        // A report cut off at the cap is still a report (the tree holds its
        // work); a question for the director is not a capability failure.
        assert!(!should_escalate(&AgentOutcome { ok: true, finished: true, closed_at_cap: true, model: "sonnet".into(), ..Default::default() }));
        assert!(!should_escalate(&AgentOutcome { ok: false, blocked: true, model: "sonnet".into(), ..Default::default() }));
        // Writing roles are warned about the half-modified tree; read-only ones are not.
        assert!(spec_can_write(&spec), "full tool set");
        let ro = SubagentSpec { definition: Some(def("explorer", Some(vec!["read_file", "grep"]), None)), ..spec.clone() };
        assert!(!spec_can_write(&ro));
        assert!(escalation_prompt("t", "sonnet", "r", true).contains("git status"));
        assert!(!escalation_prompt("t", "sonnet", "r", false).contains("git status"));
        assert_eq!(escalation_model(&spec, "sonnet", &known, &tiers).as_deref(), Some("opus"));
        // Already on the escalation model (an explicit `model: strong` call): no retry.
        assert_eq!(escalation_model(&spec, "opus", &known, &tiers), None);
        // No `escalate` in the definition, or none resolvable: no retry.
        let plain = SubagentSpec { definition: Some(def("x", None, Some("balanced"))), ..spec.clone() };
        assert_eq!(escalation_model(&plain, "sonnet", &known, &tiers), None);
        assert_eq!(escalation_model(&spec, "sonnet", &known, &HashMap::new()), None);

        // The retry prompt carries the task and a bounded excerpt of the ending.
        let p = escalation_prompt("Implement X", "sonnet", &"x".repeat(10_000), false);
        assert!(p.starts_with("Implement X"));
        assert!(p.contains("cheaper model (sonnet)"));
        assert!(p.contains("[truncated]") && p.len() < 4_600, "{}", p.len());

        // Merging: the strong attempt's report/ending, both attempts' spend.
        let first = AgentOutcome { ok: false, report: "gave up".into(), model: "sonnet".into(), input_tokens: 100, output_tokens: 10, cost_usd: 0.01, duration_ms: 5, tool_calls: 2, ..Default::default() };
        let second = AgentOutcome { ok: true, finished: true, report: "done".into(), model: "opus".into(), input_tokens: 200, output_tokens: 20, cost_usd: 0.20, duration_ms: 7, tool_calls: 3, ..Default::default() };
        let merged = merge_escalated(first, second);
        assert!(merged.ok && merged.report == "done" && merged.model == "opus");
        assert_eq!(merged.escalated_from.as_deref(), Some("sonnet"));
        assert_eq!((merged.input_tokens, merged.output_tokens, merged.tool_calls, merged.duration_ms), (300, 30, 5, 12));
        assert!((merged.cost_usd - 0.21).abs() < 1e-9);
        let billed = merged.billed_attempts();
        assert_eq!(billed.len(), 2);
        assert_eq!((billed[0].model.as_str(), billed[0].input_tokens), ("sonnet", 100));
        assert_eq!((billed[1].model.as_str(), billed[1].cost_usd), ("opus", 0.20));
        // A single attempt bills itself.
        assert_eq!(ok.billed_attempts().len(), 1);
    }

    struct ScriptedProvider {
        turns: Mutex<VecDeque<LlmResponse>>,
    }
    #[async_trait::async_trait]
    impl LlmProvider for ScriptedProvider {
        async fn complete(
            &self,
            _b: &str,
            _k: Option<&str>,
            req: &LlmRequest,
            _c: &reqwest::Client,
        ) -> AppResult<LlmResponse> {
            // Depth 1: the sub-agent must never be offered the Agent tool.
            assert!(req.tools.iter().all(|t| !is_agent_tool(&t.name)));
            Ok(self.turns.lock().pop_front().expect("scripted provider ran out of turns"))
        }
    }
    fn resp(text: &str, tools: Vec<LlmToolUse>, stop: LlmStopReason) -> LlmResponse {
        LlmResponse {
            text: text.into(),
            tool_uses: tools,
            stop_reason: stop,
            input_tokens: 10,
            output_tokens: 5,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            rate_limit: None,
            raw_content: vec![],
        }
    }
    struct Recorder {
        entries: Mutex<Vec<serde_json::Value>>,
    }
    impl EventSink for Recorder {
        fn emit(&self, _e: &str, payload: serde_json::Value) {
            self.entries.lock().push(payload);
        }
    }

    struct ToolAssertingProvider {
        allowed: Vec<&'static str>,
        seen: Mutex<Vec<String>>,
    }
    #[async_trait::async_trait]
    impl LlmProvider for ToolAssertingProvider {
        async fn complete(&self, _b: &str, _k: Option<&str>, req: &LlmRequest, _c: &reqwest::Client) -> AppResult<LlmResponse> {
            *self.seen.lock() = req.tools.iter().map(|t| t.name.clone()).collect();
            assert!(req.system.contains("# Agent: reader"), "definition body reaches the system prompt");
            Ok(resp("done reading", vec![], LlmStopReason::EndTurn))
        }
    }

    /// A stand-in for the workspace's MCP servers: records calls, answers
    /// with a canned brief.
    struct FakeMcp {
        tools: Vec<LlmTool>,
        calls: Mutex<Vec<(String, serde_json::Value)>>,
    }
    #[async_trait::async_trait]
    impl ExternalTools for FakeMcp {
        fn definitions(&self) -> Vec<LlmTool> { self.tools.clone() }
        fn owns(&self, name: &str) -> bool { self.tools.iter().any(|t| t.name == name) }
        async fn call(&self, name: &str, input: &serde_json::Value) -> Result<String, String> {
            self.calls.lock().push((name.to_string(), input.clone()));
            if name == "mcp__jira__get_issue" { Ok("PROJ-1: fix the billing rounding".into()) } else { Err("MCP error: boom".into()) }
        }
    }

    #[tokio::test]
    async fn a_subagent_calls_the_mcp_tools_it_is_granted() {
        let dir = tempfile::tempdir().unwrap();
        let mcp = FakeMcp {
            tools: vec![LlmTool {
                name: "mcp__jira__get_issue".into(),
                description: "Read a Jira issue".into(),
                input_schema: serde_json::json!({"type": "object"}),
            }],
            calls: Mutex::new(vec![]),
        };
        let provider = ToolRecordingScripted {
            inner: ScriptedProvider {
                turns: Mutex::new(VecDeque::from(vec![
                    resp("", vec![LlmToolUse { id: "t1".into(), name: "mcp__jira__get_issue".into(), input: serde_json::json!({"key": "PROJ-1"}) }], LlmStopReason::ToolUse),
                    resp("Brief: fix the billing rounding.", vec![], LlmStopReason::EndTurn),
                ])),
            },
            seen: Mutex::new(vec![]),
        };
        let spec = SubagentSpec {
            call_id: "c".into(),
            call: AgentCall { description: "Read ticket".into(), prompt: "PROJ-1".into(), subagent_type: Some("ticket-reader".into()), model: None },
            workspace_id: "w".into(), thread_id: "t".into(),
            workspace_path: dir.path().to_string_lossy().into_owned(),
            default_model: "m".into(), max_iterations: 3, max_tokens: 1, sandbox_roots: None,
            definition: Some(def("ticket-reader", Some(vec!["read_file"]), None)),
            policy_auto: false,
        };
        let rec = Recorder { entries: Mutex::new(vec![]) };
        let out = run_subagent_core(&provider, "http://x", None, &reqwest::Client::new(), "m", &spec,
            &Arc::new(AtomicBool::new(false)), &rec, None, Some(&mcp)).await.unwrap();
        assert!(out.ok, "{}", out.report);
        assert_eq!(out.report, "Brief: fix the billing rounding.");
        assert_eq!(out.tool_calls, 1);
        let calls = mcp.calls.lock().clone();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "mcp__jira__get_issue");
        assert_eq!(calls[0].1["key"], "PROJ-1");
        // The journal carries the MCP call like any tool.
        let entries = rec.entries.lock().clone();
        assert!(entries.iter().any(|e| e.to_string().contains("mcp__jira__get_issue")), "{entries:?}");
        // The MCP tool was OFFERED next to the restricted workspace set —
        // outside the allowlist, which still excludes writes.
        let seen = provider.seen.lock().clone();
        assert!(seen.contains(&"mcp__jira__get_issue".to_string()), "{seen:?}");
        assert!(seen.contains(&"read_file".to_string()) && !seen.contains(&"write_file".to_string()), "{seen:?}");
    }

    struct ToolRecordingScripted {
        inner: ScriptedProvider,
        seen: Mutex<Vec<String>>,
    }
    #[async_trait::async_trait]
    impl LlmProvider for ToolRecordingScripted {
        async fn complete(&self, b: &str, k: Option<&str>, req: &LlmRequest, c: &reqwest::Client) -> AppResult<LlmResponse> {
            *self.seen.lock() = req.tools.iter().map(|t| t.name.clone()).collect();
            self.inner.complete(b, k, req, c).await
        }
    }

    /// A gate that records what it was offered and denies MCP writes.
    struct RecordingGate {
        seen: Mutex<Vec<String>>,
        deny: Vec<&'static str>,
    }
    #[async_trait::async_trait]
    impl ToolGate for RecordingGate {
        async fn check(&self, name: &str, _input: &serde_json::Value) -> Option<String> {
            self.seen.lock().push(name.to_string());
            self.deny.contains(&name).then(|| format!("denied {name}"))
        }
    }

    #[tokio::test]
    async fn an_external_tool_call_is_offered_to_the_gate_and_a_denial_never_reaches_the_server() {
        let dir = tempfile::tempdir().unwrap();
        let mcp = FakeMcp {
            tools: vec![
                LlmTool { name: "mcp__jira__get_issue".into(), description: String::new(), input_schema: serde_json::json!({"type": "object"}) },
                LlmTool { name: "mcp__jira__add_comment".into(), description: String::new(), input_schema: serde_json::json!({"type": "object"}) },
            ],
            calls: Mutex::new(vec![]),
        };
        let provider = ScriptedProvider {
            turns: Mutex::new(VecDeque::from(vec![
                resp("", vec![
                    LlmToolUse { id: "t1".into(), name: "mcp__jira__add_comment".into(), input: serde_json::json!({"body": "hi"}) },
                    LlmToolUse { id: "t2".into(), name: "mcp__jira__get_issue".into(), input: serde_json::json!({"key": "PROJ-1"}) },
                ], LlmStopReason::ToolUse),
                resp("done", vec![], LlmStopReason::EndTurn),
            ])),
        };
        let spec = SubagentSpec {
            call_id: "c".into(),
            call: AgentCall { description: "Ticket".into(), prompt: "p".into(), subagent_type: None, model: None },
            workspace_id: "w".into(), thread_id: "t".into(),
            workspace_path: dir.path().to_string_lossy().into_owned(),
            default_model: "m".into(), max_iterations: 3, max_tokens: 1, sandbox_roots: None,
            definition: None,
            policy_auto: false,
        };
        let gate = RecordingGate { seen: Mutex::new(vec![]), deny: vec!["mcp__jira__add_comment"] };
        let rec = Recorder { entries: Mutex::new(vec![]) };
        let out = run_subagent_core(&provider, "http://x", None, &reqwest::Client::new(), "m", &spec,
            &Arc::new(AtomicBool::new(false)), &rec, Some(&gate), Some(&mcp)).await.unwrap();
        assert!(out.ok);
        let offered = gate.seen.lock().clone();
        assert_eq!(offered, vec!["mcp__jira__add_comment".to_string(), "mcp__jira__get_issue".to_string()]);
        let calls = mcp.calls.lock().clone();
        assert_eq!(calls.len(), 1, "the denied write never reached the server: {calls:?}");
        assert_eq!(calls[0].0, "mcp__jira__get_issue");
        // The gate's write set comes from the servers' read-only annotations.
        let (reason, denial) = mcp_gate_texts("Ticket", "mcp__jira__add_comment");
        assert!(reason.contains("may change external state") && denial.contains("do not retry"));
    }

    #[test]
    fn mcp_tools_are_filtered_by_the_definition_grant() {
        use crate::mcp::{McpRegistry, McpToolInfo};
        let discovered = vec![
            McpToolInfo { server: "jira".into(), name: "get_issue".into(), namespaced: "mcp__jira__get_issue".into(), description: String::new(), input_schema: serde_json::json!({}), read_only: true },
            McpToolInfo { server: "github".into(), name: "list_prs".into(), namespaced: "mcp__github__list_prs".into(), description: String::new(), input_schema: serde_json::json!({}), read_only: false },
        ];
        let reg = Arc::new(McpRegistry::new());
        let names = |d: Option<&AgentDefinition>| -> Vec<String> {
            McpSubagentTools::granted(Arc::clone(&reg), Path::new("/w"), &discovered, d, mcp_turnstiles(&discovered))
                .map(|m| m.definitions().into_iter().map(|t| t.name).collect())
                .unwrap_or_default()
        };
        // Untyped call: everything. A definition with a tools list but no
        // MCP entries: nothing. A server grant: that server's tools.
        assert_eq!(names(None).len(), 2);
        let mut none = def("explorer", Some(vec!["read_file"]), None);
        none.mcp = crate::skills::agents::McpGrant::Only(vec![]);
        assert!(names(Some(&none)).is_empty());
        let mut jira_only = def("ticket-reader", Some(vec!["read_file"]), None);
        jira_only.mcp = crate::skills::agents::McpGrant::Only(vec!["mcp__jira".into()]);
        assert_eq!(names(Some(&jira_only)), vec!["mcp__jira__get_issue".to_string()]);
        let all = McpSubagentTools::granted(Arc::clone(&reg), Path::new("/w"), &discovered, None, mcp_turnstiles(&discovered)).unwrap();
        assert!(all.owns("mcp__github__list_prs") && !all.owns("run_command") && !all.owns("mcp__other__x"));
        assert_eq!(all.turnstiles.len(), 2, "one turnstile per server");
    }

    #[tokio::test]
    async fn a_definition_restricts_the_subagent_to_its_tools() {
        let dir = tempfile::tempdir().unwrap();
        let provider = ToolAssertingProvider { allowed: vec!["read_file", "grep", "glob"], seen: Mutex::new(vec![]) };
        let spec = SubagentSpec {
            call_id: "c".into(),
            call: AgentCall { description: "Read".into(), prompt: "read".into(), subagent_type: Some("reader".into()), model: None },
            workspace_id: "w".into(), thread_id: "t".into(),
            workspace_path: dir.path().to_string_lossy().into_owned(),
            default_model: "m".into(), max_iterations: 3, max_tokens: 1, sandbox_roots: None,
            definition: Some(def("reader", Some(vec!["read_file", "grep"]), None)),
            policy_auto: false,
        };
        let rec = Recorder { entries: Mutex::new(vec![]) };
        let out = run_subagent_core(&provider, "http://x", None, &reqwest::Client::new(), "m", &spec,
            &Arc::new(AtomicBool::new(false)), &rec, None, None).await.unwrap();
        assert!(out.ok);
        let seen = provider.seen.lock().clone();
        // read_file + grep granted; grep/glob are implied by read access; no
        // write/run tool leaks through; the orchestrator's ask_director escape
        // valve rides along (it is not a workspace tool).
        for t in ["read_file", "grep", "glob"] { assert!(seen.contains(&t.to_string()), "{seen:?}"); }
        for t in ["write_file", "edit_file", "run_command", "Agent", "Task"] { assert!(!seen.contains(&t.to_string()), "{seen:?}"); }
        assert!(provider.allowed.iter().all(|a| seen.contains(&a.to_string())));
    }

    #[test]
    fn gate_texts_name_the_agent_and_forbid_a_retry() {
        let (card, denial) = gate_texts("Clean up", "recursive delete");
        assert_eq!(card, "Sub-agent \u{201c}Clean up\u{201d}: recursive delete");
        assert!(denial.contains("declined") && denial.contains("recursive delete") && denial.contains("do not retry"));
    }

    /// A gate that denies every `run_command` and records what it saw.
    struct DenyRuns {
        seen: Mutex<Vec<String>>,
    }
    #[async_trait::async_trait]
    impl ToolGate for DenyRuns {
        async fn check(&self, name: &str, input: &serde_json::Value) -> Option<String> {
            self.seen.lock().push(name.to_string());
            if name != "run_command" {
                return None;
            }
            let cmd = input.get("command").and_then(|c| c.as_str()).unwrap_or("");
            dangerous_command(cmd).map(|r| gate_texts("x", r).1)
        }
    }

    #[tokio::test]
    async fn a_denied_dangerous_command_never_runs_and_reads_as_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let victim = dir.path().join("keep.txt");
        std::fs::write(&victim, "precious").unwrap();
        let cmd = format!("rm -rf {}", victim.display());
        let provider = ScriptedProvider {
            turns: Mutex::new(VecDeque::from(vec![
                resp("cleaning", vec![LlmToolUse { id: "t1".into(), name: "run_command".into(), input: serde_json::json!({"command": cmd}) }], LlmStopReason::ToolUse),
                resp("safe read", vec![LlmToolUse { id: "t2".into(), name: "read_file".into(), input: serde_json::json!({"path": "keep.txt"}) }], LlmStopReason::ToolUse),
                resp("Report: could not delete; file still present.", vec![], LlmStopReason::EndTurn),
            ])),
        };
        let spec = SubagentSpec {
            call_id: "c".into(),
            call: AgentCall { description: "Clean up".into(), prompt: "rm it".into(), subagent_type: None, model: None },
            workspace_id: "w".into(), thread_id: "t".into(),
            workspace_path: dir.path().to_string_lossy().into_owned(),
            default_model: "m".into(), max_iterations: 5, max_tokens: 1, sandbox_roots: None, definition: None,
            policy_auto: false,
        };
        let gate = DenyRuns { seen: Mutex::new(vec![]) };
        let rec = Recorder { entries: Mutex::new(vec![]) };
        let out = run_subagent_core(&provider, "http://x", None, &reqwest::Client::new(), "m", &spec,
            &Arc::new(AtomicBool::new(false)), &rec, Some(&gate), None).await.unwrap();
        assert!(out.ok && out.finished);
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "precious", "the denied rm never ran");
        assert_eq!(*gate.seen.lock(), vec!["run_command", "read_file"], "every tool is offered to the gate");
        // The journal shows the denied call as a failed tool result, and the
        // ungated read as a success.
        let results: Vec<bool> = rec.entries.lock().iter()
            .filter(|p| p["entry"]["kind"] == "tool_result")
            .map(|p| p["entry"]["ok"].as_bool().unwrap()).collect();
        assert_eq!(results, vec![false, true]);
        assert_eq!(out.tool_calls, 2);
    }

    #[tokio::test]
    async fn subagent_core_runs_the_loop_and_reports_the_final_answer() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.rs"), "fn main() {}\n").unwrap();
        let provider = ScriptedProvider {
            turns: Mutex::new(VecDeque::from(vec![
                resp(
                    "reading",
                    vec![LlmToolUse {
                        id: "t1".into(),
                        name: "read_file".into(),
                        input: serde_json::json!({"path": "a.rs"}),
                    }],
                    LlmStopReason::ToolUse,
                ),
                resp("Report: a.rs is an empty main.", vec![], LlmStopReason::EndTurn),
            ])),
        };
        let spec = SubagentSpec {
            call_id: "call-1".into(),
            call: parse_agent_call(&serde_json::json!({"description": "Inspect a.rs", "prompt": "Read a.rs and report."})).unwrap(),
            workspace_id: "ws".into(),
            thread_id: "th".into(),
            workspace_path: dir.path().to_string_lossy().into_owned(),
            default_model: "m".into(),
            max_iterations: 5,
            max_tokens: 4096,
            sandbox_roots: None,
            definition: None,
            policy_auto: false,
        };
        let rec = Recorder { entries: Mutex::new(vec![]) };
        let client = reqwest::Client::new();
        let cancel = Arc::new(AtomicBool::new(false));
        let out = run_subagent_core(&provider, "http://x", None, &client, "m", &spec, &cancel, &rec, None, None)
            .await
            .unwrap();
        assert!(out.ok && out.finished && !out.closed_at_cap && !out.blocked);
        assert_eq!(out.report, "Report: a.rs is an empty main.");
        assert_eq!(out.tool_calls, 1);
        assert_eq!(out.input_tokens, 20);
        // The journal reached the sink keyed by thread + call id.
        let entries = rec.entries.lock();
        assert_eq!(entries[0]["runId"], "th");
        assert_eq!(entries[0]["stageId"], "call-1");
        let kinds: Vec<&str> = entries.iter().map(|p| p["entry"]["kind"].as_str().unwrap()).collect();
        assert_eq!(kinds, vec!["text", "tool", "tool_result"]);
    }
}
