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
use crate::chat_engine::{continuation_note, dangerous_command, guard_agent_command, ApprovalBroker, ApprovalDecision, CapAnswer, CapGate};
use crate::orchestrator::agentic::resume_messages_for_continuation;
use crate::orchestrator::agentic::{run_agentic_loop_billed, user_messages, AgenticResult, BlockedTranscript, ExternalTools, LoopFailure, ToolGate};
use crate::orchestrator::events::EventSink;
use crate::orchestrator::live::LiveEmitter;
use crate::providers::{Effort, LlmMessage, LlmProvider, LlmTool};
use crate::skills::agents::{resolve_model_with_tiers, AgentDefinition};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
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
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
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
/// report the parent can act on without reading its journal. The project's
/// instructions (`instructions`, the `project_instructions` section the
/// director carries too) follow it, and a matched `.claude/agents`
/// definition appends its body last as the agent's own instructions (the
/// same way an active skill rides on the Talk prompt).
pub fn subagent_system_prompt(
    workspace_path: &str,
    call: &AgentCall,
    definition: Option<&AgentDefinition>,
    instructions: &str,
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
    prompt.push_str(instructions);
    if let Some(d) = definition {
        if !d.body.is_empty() {
            prompt.push_str(&format!("\n\n# Agent: {}\n{}", d.name, d.body));
        }
    }
    // Last (#1147): after the project's instructions and the definition,
    // which can be the repository's text.
    prompt.push_str(crate::chat_history::UNTRUSTED_OUTPUT_NOTE);
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
    /// The loop errored (retries exhausted, a context 400…) after the
    /// rounds this outcome bills. Not a turn cap: more turns are not asked
    /// for at the cap gate, though the run can be continued from its journal.
    #[serde(skip)]
    pub errored: bool,
    /// The run closed because its spend reached its limit (its share of the
    /// budget, or its definition's `max-cost`), not because turns ran out.
    #[serde(skip)]
    pub spend_stopped: bool,
    pub model: String,
    /// The tier `model` is mapped to in Settings › Models (`fast` /
    /// `balanced` / `strong`), when it is one — the crew card's tier mix.
    pub tier: Option<String>,
    /// The effort the FINAL attempt ran at (an escalation changes it).
    #[serde(default)]
    pub effort: Option<Effort>,
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
    /// The run was given more turns (or an answer) from the crew journal
    /// after its first ending; the report is the continuation's.
    #[serde(default)]
    pub continued: bool,
    /// Stop on the turn ended the run before it reported ([`mark_stopped`]).
    #[serde(default)]
    pub stopped: bool,
    /// The conversation as the loop left it — what a continuation resumes
    /// from (for a blocked run, INCLUDING the asking turn). Persisted in
    /// `chat_agent_runs`, never on the tool row.
    #[serde(skip)]
    pub transcript: Vec<LlmMessage>,
    /// The `ask_director` call a blocked run is waiting on — a continuation
    /// answers it as that call's tool_result. Empty otherwise.
    #[serde(skip)]
    pub ask_tool_use_id: String,
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

/// Whether Stop ended `o` (`cancelled`: the turn's flag as the run ended):
/// it neither answered nor stopped on a question. A run that finished
/// before Stop keeps its report.
pub fn was_stopped(o: &AgentOutcome, cancelled: bool) -> bool {
    cancelled && !o.finished && !o.blocked
}

/// Mark a run Stop ended (#1148): it failed, reads as stopped, and its
/// report says so instead of a turn limit it never hit. Its transcript stays,
/// so it can be continued.
pub fn mark_stopped(o: &mut AgentOutcome) {
    o.stopped = true;
    o.ok = false;
    let calls = match o.tool_calls {
        1 => "1 tool call".to_string(),
        n => format!("{n} tool calls"),
    };
    o.report = format!(
        "Sub-agent stopped: the user stopped the turn after {calls}, before it reported. \
         Nothing it found is in this report; delegate again if the work is still needed."
    );
}

/// Map a finished loop to the report the parent receives. Pure, so the exact
/// wording of every ending is tested: a clean answer passes through; a
/// forced close is flagged as possibly incomplete; an `ask_director` block
/// (the loop's escape valve — meaningless here, nobody answers) becomes the
/// question itself so the parent can decide or re-delegate; an unfinished
/// loop is a failure.
pub fn report_from_result(out: &AgenticResult, max_iterations: Option<usize>) -> (String, bool) {
    // A cap ending only exists when a limit was configured; the wording
    // names it when it can.
    let limit = match max_iterations {
        _ if out.spend_stopped => "spend limit".to_string(),
        Some(n) => format!("{n}-turn tool limit"),
        None => "turn limit".to_string(),
    };
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
                    "{text}\n\n[sub-agent reached its {limit} before finishing — this report may be incomplete]"
                ),
                true,
            );
        }
        return (text.to_string(), true);
    }
    (
        format!("Sub-agent hit its {limit} without producing a report."),
        false,
    )
}

/// The most one run may spend (USD): the lower of its share of the budget
/// headroom and its definition's `max-cost`. `None` when neither is set.
pub fn subagent_spend_limit(share: Option<f64>, max_cost: Option<f64>) -> Option<f64> {
    match (share, max_cost) {
        (Some(s), Some(c)) => Some(s.min(c)),
        (s, c) => s.or(c),
    }
}

/// What is left of `spec`'s spend limit once its attempts so far spent
/// `spent`: the limit is a total for the run, so an escalation retry or a
/// continuation the user granted gets only the rest, never a fresh share.
/// `None` when the run has no limit.
pub fn spend_left(spec: &SubagentSpec, spent: f64) -> Option<f64> {
    subagent_spend_limit(spec.spend_limit, spec.definition.as_ref().and_then(|d| d.max_cost))
        .map(|limit| (limit - spent).max(0.0))
}

/// Whether another attempt of `spec` may start: a run with nothing left of
/// its limit would still spend a round before its close.
pub fn has_spend_left(spec: &SubagentSpec, spent: f64) -> bool {
    !matches!(spend_left(spec, spent), Some(left) if left <= 0.0)
}

/// Each sub-agent's share of the budget headroom when `n_agents` run at
/// once, so together they cannot spend past it before the director's next
/// budget check. `None` (no budget set, or the turn overrode it) is
/// unbounded; a spent budget gives each a zero share (one round, then the
/// close).
pub fn budget_share(headroom: Option<f64>, n_agents: usize) -> Option<f64> {
    headroom.map(|h| h.max(0.0) / n_agents.max(1) as f64)
}

/// Everything a sub-agent needs from the parent turn, owned so the run can
/// move into its own task.
#[derive(Clone, Serialize, Deserialize)]
pub struct SubagentSpec {
    pub call_id: String,
    pub call: AgentCall,
    pub workspace_id: String,
    pub thread_id: String,
    pub workspace_path: String,
    /// The conversation's model; `call.model` overrides it.
    pub default_model: String,
    /// Tool rounds this run may take; `None` = no limit (the default: a
    /// sub-agent runs until it finishes or is stopped). A limit exists only
    /// when configured — the Settings preference, a definition's
    /// `max-turns`, or the turns a user granted a continuation.
    #[serde(default)]
    pub max_iterations: Option<usize>,
    pub max_tokens: u32,
    pub sandbox_roots: Option<Vec<String>>,
    /// The `.claude/agents` definition `subagent_type` matched, if any.
    pub definition: Option<AgentDefinition>,
    /// The turn runs under the Auto policy (economy director): a sub-agent
    /// that names no model runs on the fast tier, not the director's
    /// strong model.
    pub policy_auto: bool,
    /// A continuation: the saved transcript (plus the note or answer that
    /// resumes it) replaces the fresh `prompt` as the loop's opening
    /// messages. `None` for a first run.
    #[serde(default)]
    pub resume: Option<Vec<LlmMessage>>,
    /// What the run will use, decided before it starts (`plan_subagent`) so
    /// the live card can say it: the model, its tier, the effort, and what
    /// the director asked for when that was not honored.
    #[serde(default)]
    pub plan: Option<SubagentPlan>,
    /// This run's share of the budget headroom (USD), set at the fan-out
    /// (`budget_share`); the definition's `max-cost` caps it further as the
    /// run starts. Not saved: a later continuation takes its share anew.
    #[serde(skip)]
    pub spend_limit: Option<f64>,
}

/// The resolved shape of one sub-agent run — model, tier and effort — plus
/// the director's `model` ask when it differed. Computed once, before the
/// run, so the crew card and journal can show it while the sub-agent works.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentPlan {
    pub model: String,
    pub tier: Option<String>,
    pub effort: Option<Effort>,
    /// The `model` the director put on the call, when it was not what the
    /// run uses (either ignored under Auto, or resolved to a different id).
    pub asked_model: Option<String>,
    /// Whether the director's ask was honored (`false` = ignored: under Auto
    /// a typed role keeps its tier).
    pub asked_honored: bool,
}

/// The rank of a tier for the "never above the role's tier" rule.
fn tier_rank(tier: &str) -> u8 {
    match tier {
        "fast" => 0,
        "balanced" => 1,
        "strong" => 2,
        _ => 1,
    }
}

/// The effort a tier runs at when the definition says nothing: the cheap
/// tier thinks little (a read, a test run), the middle tier moderately, the
/// strong tier hard (a review, an escalated implementation).
pub fn default_effort_for_tier(tier: Option<&str>) -> Option<Effort> {
    match tier {
        Some("fast") => Some(Effort::Low),
        Some("balanced") => Some(Effort::Medium),
        Some("strong") => Some(Effort::High),
        _ => None,
    }
}

/// Decide a run's model, tier and effort. Under Auto, a call's `model` may
/// not lift a typed role above its definition's tier — the escalation
/// exists for when the cheap attempt fails, not for caution up front — so
/// `implementer` + `model: "strong"` still runs balanced and the plan
/// records the ask as not honored. Outside Auto (the user picked the
/// model), the call's `model` is honored as before. Effort: the
/// definition's `effort`, else the tier's default.
pub fn plan_subagent(spec: &SubagentSpec, known_models: &[String], tiers: &HashMap<String, String>) -> SubagentPlan {
    let asked = spec.call.model.as_deref().map(str::trim).filter(|m| !m.is_empty()).map(str::to_string);
    // The role's tier: the definition's alias (`balanced`), or the tier its
    // model id is mapped to.
    let def_tier = spec.definition.as_ref().and_then(|d| d.model.as_deref()).and_then(|m| {
        crate::skills::agents::tier_for_alias(m)
            .or_else(|| resolve_model_with_tiers(m, known_models, tiers).and_then(|id| crate::skills::agents::tier_of_model(id, tiers)))
    });
    let mut effective = spec.clone();
    let mut honored = true;
    let mut model = pick_subagent_model(&effective, known_models, tiers);
    // The ceiling is judged on the OUTCOME, not the wording of the ask, so
    // `strong`, the strong model's id and `inherit` (the director's model)
    // all land the same way: a typed role never runs above its tier under
    // Auto. Under Auto the director IS the strong tier, so an outcome that
    // is the conversation's model counts as strong even when unmapped.
    if let (true, Some(_), Some(def_tier)) = (spec.policy_auto, asked.as_deref(), def_tier) {
        let outcome_tier = crate::skills::agents::tier_of_model(&model, tiers)
            .or_else(|| (model == spec.default_model).then_some("strong"));
        if outcome_tier.is_some_and(|t| tier_rank(t) > tier_rank(def_tier)) {
            effective.call.model = None;
            honored = false;
            model = pick_subagent_model(&effective, known_models, tiers);
        }
    }
    let tier = tier_for_outcome(&effective, &model, tiers);
    let effort = spec.definition.as_ref().and_then(|d| d.effort).or_else(|| default_effort_for_tier(tier.as_deref()));
    let asked_model = asked.filter(|a| !honored || !a.eq_ignore_ascii_case(&model));
    SubagentPlan { model, tier, effort, asked_model, asked_honored: honored }
}

/// One line for the journal and the card: `claude-sonnet-4-6 · balanced · effort medium`.
pub fn plan_line(plan: &SubagentPlan) -> String {
    let mut parts = vec![plan.model.clone()];
    if let Some(t) = &plan.tier {
        parts.push(t.clone());
    }
    match plan.effort {
        Some(e) => parts.push(format!("effort {}", e.as_str())),
        None => parts.push("effort default".into()),
    }
    parts.join(" · ")
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
    // is legwork and runs on the fast tier when that tier is mapped.
    if spec.policy_auto {
        if let Some(fast) = resolve_model_with_tiers(AUTO_SUBAGENT_TIER, known_models, tiers) {
            return fast.to_string();
        }
    }
    spec.default_model.clone()
}

/// The model id the composer sends to mean "the economy director decides":
/// the strong tier runs the conversation under the lean-context doctrine.
pub const AUTO_MODEL: &str = "auto";
/// The tier the director itself runs on under Auto.
pub const AUTO_DIRECTOR_TIER: &str = "strong";
/// The tier an unspecified sub-agent runs on under Auto. Fast, not
/// balanced: an untyped sub-agent is nearly always a read (the doctrine
/// says to type anything that writes), and a mid-tier model given a vague
/// task runs long — the loop length, not the per-token price, is what a
/// sub-agent costs.
pub const AUTO_SUBAGENT_TIER: &str = "fast";

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
     tool call re-sends your whole context at that price — though with prompt caching a \
     round of yours is cheap; what costs money is a sub-agent that runs long. So: keep your \
     context lean and spend it on judgment, and keep every sub-agent SHORT. One sub-agent, \
     one question, always typed. Delegate every broad read with the Agent tool — mapping \
     code, reading many files, running test suites, reading a ticket, reviewing a diff — \
     several in ONE response when the questions are independent, each with a narrow, \
     answerable question and a compact report asked for (findings first, `path:line` \
     evidence, a few hundred words). Pick the type by role: `explorer`, `test-runner`, \
     `ticket-reader` and `pr-author` run on the fast tier and run until they finish — if a \
     task would take them long, it was two questions; split it, never widen it. `implementer` \
     and `pr-maintainer` run balanced and escalate to strong on a failed attempt — the \
     ONLY sub-agents that write. `reviewer` runs strong in a fresh context — the quality \
     gate before any PR, so always run it. Never pass `model` on a typed call — the role \
     carries its tier and its effort, and under Auto a request above the role's tier is \
     ignored; the escalation exists for when the cheap attempt fails, not for caution up \
     front. If the user names a model, say so in the prompt instead. A sub-agent you give \
     no type runs on the fast tier, so type anything that must write. Never paste a long \
     output into your own \
     context, never re-run or re-verify what a sub-agent already reported, and recall \
     stored tool output instead of re-reading. A sub-agent has no turn limit unless the \
     user set one; when one is set, a writing sub-agent that runs out of turns mid-work \
     pauses your turn until the user gives it more turns or accepts its partial report — \
     if you receive a report marked incomplete, the user chose that: do not build on it, \
     say what is done and what is not, and stop. A read cut at a cap is partial, not \
     lost: the user can give that sub-agent more turns from its journal, so say what is \
     still open instead of re-delegating from scratch. Do small, sequential edits \
     yourself; decide architecture, trade-offs and what the user is really asking \
     yourself — that is what your context is for.";

/// Whether a sub-agent's first attempt warrants the definition's `escalate`
/// retry: only a **failure** — no usable report. A report that merely hit
/// the turn cap is still a report (and for a writing role the tree already
/// holds its work); a `blocked` stop is a question for the director, which
/// a stronger model cannot answer either — it goes back up as-is. Nor does a
/// run its spend limit stopped: the money ran out, and the strong tier would
/// spend more of it.
pub fn should_escalate(outcome: &AgentOutcome) -> bool {
    !outcome.ok && !outcome.blocked && !outcome.spend_stopped
}

/// The retry of `spec` on `stronger` after the `model` attempt `first`
/// failed: the task again with what the first attempt said, at the strong
/// tier's effort, with only what is left of the spend limit.
pub fn escalation_retry(
    spec: &SubagentSpec,
    first: &AgentOutcome,
    model: &str,
    stronger: &str,
    tiers: &HashMap<String, String>,
) -> SubagentSpec {
    let mut retry = spec.clone();
    retry.call.prompt = escalation_prompt(&spec.call.prompt, model, &first.report, spec_can_write(spec));
    // The stronger attempt thinks at its own tier's effort (a definition's
    // explicit `effort` still wins).
    let stronger_tier = crate::skills::agents::tier_of_model(stronger, tiers).map(str::to_string);
    retry.plan = Some(SubagentPlan {
        model: stronger.to_string(),
        tier: stronger_tier.clone(),
        effort: spec.definition.as_ref().and_then(|d| d.effort).or_else(|| default_effort_for_tier(stronger_tier.as_deref())),
        asked_model: None,
        asked_honored: true,
    });
    retry.spend_limit = spend_left(spec, first.cost_usd);
    retry
}

/// Whether a sub-agent can change the workspace: its definition grants a
/// write/edit tool or the shell, or it has the full set.
pub fn spec_can_write(spec: &SubagentSpec) -> bool {
    definition_can_write(spec.definition.as_ref())
}

/// [`spec_can_write`] for an agent type: no definition (an untyped call, or
/// a type nobody defined) is the full tool set. Plan only starts only the
/// types this says can't write (#1146).
pub fn definition_can_write(definition: Option<&AgentDefinition>) -> bool {
    match definition.and_then(|d| d.tools.as_deref()) {
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
/// once. A denial is fed back as an error tool_result. A `run_command` that
/// commits or pushes meets the secret guard's card first, which the grant
/// never answers (#819). A file tool reaching outside the workspace asks as
/// in the parent loop (`talk_guard`, #1147), and the grant never answers it
/// either; reads, searches and edits inside the workspace stay ungated.
pub struct SubagentGate {
    pub broker: Arc<ApprovalBroker>,
    pub app: AppHandle,
    pub workspace_id: String,
    pub thread_id: String,
    pub call_id: String,
    /// The sub-agent's description, shown on the approval card.
    pub label: String,
    /// The worktree the secret guard scans before a commit or push (#819).
    pub workspace_path: String,
    /// The MCP tools the fan-out discovered: one that may change external
    /// state (create an issue, post a comment) asks the user first, as the
    /// director's does (#1243): nobody is watching a sub-agent otherwise.
    mcp: SubagentMcp,
    /// Where the file tools may go without asking: the workspace.
    reach: crate::talk_guard::Reach,
    /// The mission's sandbox refuses a write outside the workspace itself.
    writes_confined: bool,
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
            workspace_path: spec.workspace_path.clone(),
            mcp: SubagentMcp::default(),
            reach: crate::talk_guard::Reach::of_workspace(Path::new(&spec.workspace_path), None),
            writes_confined: spec.sandbox_roots.is_some(),
            seq: AtomicU64::new(1),
        }
    }

    /// Let reads into the dependency folders a mission links from its
    /// project (`root`, from the database) run without a card.
    pub fn with_project_root(mut self, root: Option<std::path::PathBuf>) -> Self {
        self.reach = crate::talk_guard::Reach::of_workspace(Path::new(&self.workspace_path), root.as_deref());
        self
    }

    /// Gate the MCP tools among `discovered` that may write, in the thread's
    /// `mode` and with the user's trust as they are at each call.
    pub fn with_mcp(mut self, discovered: &[crate::mcp::McpToolInfo], mode: crate::permissions::ModeSource) -> Self {
        let (broker, worktree) = (Arc::clone(&self.broker), std::path::PathBuf::from(&self.workspace_path));
        self.mcp = SubagentMcp::new(discovered, mode, Arc::new(move || broker.mcp_trust(&worktree)));
        self
    }
}

/// What a sub-agent's MCP call is checked against (#1243): the fan-out's
/// tools (`talk_guard::McpTools`), and the thread's mode and the user's
/// trust, each read at the call.
#[derive(Default)]
pub struct SubagentMcp {
    tools: crate::talk_guard::McpTools,
    mode: Option<crate::permissions::ModeSource>,
    trust: Option<Arc<dyn Fn() -> crate::mcp::trust::TrustView + Send + Sync>>,
}

impl SubagentMcp {
    pub fn new(
        discovered: &[crate::mcp::McpToolInfo],
        mode: crate::permissions::ModeSource,
        trust: Arc<dyn Fn() -> crate::mcp::trust::TrustView + Send + Sync>,
    ) -> Self {
        Self { tools: crate::talk_guard::McpTools::new(discovered), mode: Some(mode), trust: Some(trust) }
    }

    pub fn contains(&self, name: &str) -> bool {
        self.tools.contains(name)
    }

    /// The card a call to `name` must pass now, or `None`.
    pub fn card(&self, label: Option<&str>, name: &str, input: &serde_json::Value) -> Option<crate::talk_guard::ToolCard> {
        let mode = self.mode.as_ref().map_or(crate::permissions::Mode::Plan, |m| m());
        let trust = self.trust.as_ref().map(|t| t()).unwrap_or_default();
        self.tools.card(label, name, input, mode, &trust)
    }
}

/// The reason and denial for an MCP tool the server did not mark read-only
/// (or marked destructive). `label` names the sub-agent that asks; the
/// director's card has none.
pub fn mcp_gate_texts(label: Option<&str>, tool: &str, destructive: bool) -> (String, String) {
    let why = if destructive { "its server marks it destructive" } else { "its server does not mark it read-only" };
    let reason = format!("MCP tool `{tool}` may change external state ({why})");
    (
        match label {
            Some(label) => format!("Sub-agent \u{201c}{label}\u{201d}: {reason}"),
            None => reason,
        },
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
    /// Ask first's card (#1231), on the director's broker with the
    /// sub-agent's name on it, its diff checked again once approved.
    async fn ask_first(&self, name: &str, input: &serde_json::Value) -> Option<String> {
        let label = Some(self.label.as_str());
        let check = || Some(crate::permissions::ask_card(label, name, input, &self.reach));
        let card = check()?;
        let id = format!("{}:{}", self.call_id, self.seq.fetch_add(1, Ordering::Relaxed));
        let ask = |c: crate::talk_guard::ToolCard| self.broker.await_card(&self.app, &self.workspace_id, &self.thread_id, &id, c);
        crate::chat_engine::guard_card(card, &check, ask).await
    }

    async fn check(&self, name: &str, input: &serde_json::Value) -> Option<String> {
        let (shown, card_reason, denial) = if name == "run_command" {
            let command = input.get("command").and_then(|c| c.as_str()).unwrap_or("");
            // The secret guard first (#819); the thread's grant never answers it.
            let id = format!("{}:{}", self.call_id, self.seq.fetch_add(1, Ordering::Relaxed));
            if let Some(denial) = guard_agent_command(
                &self.broker,
                &self.app,
                &self.workspace_id,
                &self.thread_id,
                &id,
                command,
                &self.workspace_path,
                Some(self.label.as_str()),
            )
            .await
            {
                return Some(denial);
            }
            // A path outside the workspace or in a credentials location
            // (#1201); a sub-agent's command runs at the workspace root.
            let check = || self.reach.command_card(Some(self.label.as_str()), command, None, &self.broker.read_dirs(&self.thread_id));
            if let Some(card) = check() {
                let id = format!("{}:{}", self.call_id, self.seq.fetch_add(1, Ordering::Relaxed));
                let ask = |c: crate::talk_guard::ToolCard| self.broker.await_card(&self.app, &self.workspace_id, &self.thread_id, &id, c);
                if let Some(denial) = crate::chat_engine::guard_card(card, &check, ask).await {
                    return Some(denial);
                }
            }
            let reason = dangerous_command(command)?;
            let (card_reason, denial) = gate_texts(&self.label, reason);
            (command.to_string(), card_reason, denial)
        } else {
            // An MCP write, or a file tool reaching outside the workspace,
            // checked again once approved (`guard_card`).
            let label = Some(self.label.as_str());
            let check = || {
                if self.mcp.contains(name) {
                    self.mcp.card(label, name, input)
                } else {
                    self.reach.outside_card(label, name, input, self.writes_confined)
                }
            };
            let card = check()?;
            let id = format!("{}:{}", self.call_id, self.seq.fetch_add(1, Ordering::Relaxed));
            let ask = |c: crate::talk_guard::ToolCard| self.broker.await_card(&self.app, &self.workspace_id, &self.thread_id, &id, c);
            return crate::chat_engine::guard_card(card, &check, ask).await;
        };
        let id = format!("{}:{}", self.call_id, self.seq.fetch_add(1, Ordering::Relaxed));
        match self
            .broker
            .await_approval(&self.app, &self.workspace_id, &self.thread_id, &id, &shown, &card_reason)
            .await
        {
            ApprovalDecision::Deny => Some(denial),
            _ => None,
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
            .map(mcp_llm_tool)
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
        // Bounded on the wire (the turnstile above absorbs the queue), and a
        // timeout STOPS the server so the call can never complete later.
        // A sub-agent reads the rendered text (binary payloads replaced).
        crate::mcp::call_bounded(
            Arc::clone(&self.registry),
            self.worktree.clone(),
            name.to_string(),
            input.clone(),
            crate::mcp::CALL_TIMEOUT,
        )
        .await
        .map(|out| out.text)
    }
}

/// The `Skill` tool as a sub-agent has it (#1135): the worktree's skills,
/// loaded the way the director loads them, so a skill can call skills.
/// Offered before the caller's own tools (`inner`, the MCP grant).
pub struct SkillSubagentTools<'a> {
    pub inner: Option<&'a dyn ExternalTools>,
    pub catalogue: Vec<crate::skills::Skill>,
    pub scope: &'a Mutex<crate::skills::SkillScope>,
}

#[async_trait::async_trait]
impl ExternalTools for SkillSubagentTools<'_> {
    fn definitions(&self) -> Vec<LlmTool> {
        let mut tools = Vec::new();
        if !self.catalogue.is_empty() {
            tools.push(crate::skills::skill_tool_definition());
        }
        if let Some(inner) = self.inner {
            tools.extend(inner.definitions());
        }
        tools
    }
    fn owns(&self, name: &str) -> bool {
        (name == crate::skills::SKILL_TOOL_NAME && !self.catalogue.is_empty())
            || self.inner.is_some_and(|e| e.owns(name))
    }
    async fn call(&self, name: &str, input: &serde_json::Value) -> Result<String, String> {
        if name == crate::skills::SKILL_TOOL_NAME {
            let (text, ok) = {
                let mut scope = self.scope.lock();
                crate::skills::run_skill_tool(&self.catalogue, &[], &mut scope, input)
            };
            return if ok { Ok(text) } else { Err(text) };
        }
        match self.inner {
            Some(inner) => inner.call(name, input).await,
            None => Err(format!("Unknown tool `{name}`")),
        }
    }
}

/// A sub-agent's gate with the loaded skills' `allowed-tools` in front: a
/// tool they don't allow is refused before the user is asked anything.
pub struct SkillSubagentGate<'a> {
    pub inner: Option<&'a dyn ToolGate>,
    pub scope: &'a Mutex<crate::skills::SkillScope>,
    /// The workspace tools a skill can limit (`build_llm_tools`).
    pub workspace_tools: Vec<String>,
}

#[async_trait::async_trait]
impl ToolGate for SkillSubagentGate<'_> {
    async fn check(&self, name: &str, input: &serde_json::Value) -> Option<String> {
        let refusal = self.scope.lock().refusal(name, &self.workspace_tools);
        if refusal.is_some() {
            return refusal;
        }
        match self.inner {
            Some(inner) => inner.check(name, input).await,
            None => None,
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
    let instructions = crate::project_instructions::for_workspace_off_runtime(spec.workspace_path.clone().into()).await;
    // The worktree's skills, listed after the project's instructions and
    // loaded with `Skill`, as the director has them (#1135).
    let catalogue = crate::skills::scan_skills(Path::new(&spec.workspace_path));
    let skill_list = crate::skills::skill_list_section(&catalogue, &[]);
    let system = subagent_system_prompt(
        &spec.workspace_path,
        &spec.call,
        spec.definition.as_ref(),
        &format!("{}{skill_list}", instructions.section),
    );
    let skill_scope = Mutex::new(crate::skills::SkillScope::default());
    let skill_tools = SkillSubagentTools { inner: external, catalogue, scope: &skill_scope };
    let skill_gate = SkillSubagentGate {
        inner: gate,
        scope: &skill_scope,
        workspace_tools: crate::chat_engine::build_llm_tools().into_iter().map(|t| t.name).collect(),
    };
    let allowed_tools = spec.definition.as_ref().and_then(|d| d.tools.as_deref());
    let effort = spec.plan.as_ref().and_then(|p| p.effort);
    let spend_limit = subagent_spend_limit(spec.spend_limit, spec.definition.as_ref().and_then(|d| d.max_cost));
    let result = run_agentic_loop_billed(
        provider,
        api_base,
        api_key,
        client,
        model,
        &system,
        spec.resume.clone().unwrap_or_else(|| user_messages(&spec.call.prompt)),
        Path::new(&spec.workspace_path),
        spec.max_iterations.unwrap_or(usize::MAX),
        cancel,
        &emitter,
        allowed_tools,
        effort,
        spec.sandbox_roots.as_deref(),
        false,
        spend_limit,
        &[],
        Some(&skill_gate as &dyn ToolGate),
        Some(&skill_tools as &dyn ExternalTools),
    )
    .await;
    // A loop that errored after real rounds still spent them: the outcome
    // carries their usage (the ledger and the budget see it) and their
    // transcript (the run can be continued), and fails.
    let (out, report, ok, errored) = match result {
        Ok(out) => {
            let (report, ok) = report_from_result(&out, spec.max_iterations);
            (out, report, ok, false)
        }
        Err(f) => {
            let LoopFailure { error, partial } = *f;
            (partial, format!("Sub-agent failed: {error}"), false, true)
        }
    };
    Ok(AgentOutcome {
        report,
        ok,
        finished: out.finished,
        closed_at_cap: out.closed_at_cap,
        blocked: out.blocked.is_some(),
        errored,
        spend_stopped: out.spend_stopped,
        model: model.to_string(),
        tier: None,
        effort,
        escalated_from: None,
        attempts: Vec::new(),
        input_tokens: out.input_tokens,
        output_tokens: out.output_tokens,
        cache_read_tokens: out.cache_read_tokens,
        cache_creation_tokens: out.cache_creation_tokens,
        cost_usd: out.cost_usd,
        duration_ms: started.elapsed().as_millis() as u64,
        tool_calls: out.tool_calls.len(),
        continued: spec.resume.is_some(),
        stopped: false,
        ask_tool_use_id: out.blocked_transcript.as_ref().map(|b| b.ask_tool_use_id.clone()).unwrap_or_default(),
        transcript: match out.blocked_transcript {
            Some(b) => b.messages,
            None => out.transcript,
        },
    })
}

/// The workspace's MCP tools, discovered once per fan-out (off-thread,
/// bounded — a hung server must not stall the crew); each sub-agent then
/// sees the subset its definition grants. Servers switched off in the
/// parent conversation (`off`, from [`thread_mcp_off`]) are left out, so a
/// sub-agent never gets what its conversation turned off.
pub async fn discover_mcp_tools(
    mcp: Arc<crate::mcp::McpRegistry>,
    workspace_path: &str,
    off: std::collections::HashSet<String>,
) -> Vec<crate::mcp::McpToolInfo> {
    let wp = std::path::PathBuf::from(workspace_path);
    tokio::time::timeout(
        std::time::Duration::from_secs(20),
        tokio::task::spawn_blocking(move || mcp.list_tools_except(&wp, &off)),
    )
    .await
    .ok()
    .and_then(|r| r.ok())
    .unwrap_or_default()
}

/// One discovered MCP tool as the provider sees it. The director and every
/// sub-agent build their MCP tool definitions through this, from a list in
/// `mcp::sort_tools` order, so the same config always gives the same bytes.
pub fn mcp_llm_tool(t: &crate::mcp::McpToolInfo) -> LlmTool {
    LlmTool { name: t.namespaced.clone(), description: t.description.clone(), input_schema: t.input_schema.clone() }
}

/// The MCP servers a conversation switched off (the Companion's "can use"
/// chips). A read error counts as none off: the default is every server.
pub fn thread_mcp_off(db: &Mutex<Db>, thread_id: &str) -> std::collections::HashSet<String> {
    db.lock().thread_mcp_disabled(thread_id).unwrap_or_default().into_iter().collect()
}

/// [`discover_mcp_tools`] for one conversation: its off list is read now.
/// The one path a Talk turn, a sub-agent fan-out and a sub-agent
/// continuation discover through. The list is fixed for what it offers: a
/// running loop keeps the tools it started with.
pub async fn discover_thread_mcp_tools(
    mcp: Arc<crate::mcp::McpRegistry>,
    db: &Mutex<Db>,
    workspace_path: &str,
    thread_id: &str,
) -> Vec<crate::mcp::McpToolInfo> {
    discover_mcp_tools(mcp, workspace_path, thread_mcp_off(db, thread_id)).await
}

/// Why a call to `tool` is refused, when it is an MCP tool whose server is in
/// `off` (the conversation's list as it is at the call, so a server turned
/// off or back on mid-turn counts from its next call). `None` lets it run.
pub fn mcp_off_refusal(tool: &str, off: &std::collections::HashSet<String>) -> Option<String> {
    let server = crate::mcp::server_of(tool).filter(|s| crate::mcp::is_mcp_tool(tool) && off.contains(s))?;
    Some(format!(
        "{server} is turned off in this conversation, so its tools are unavailable here. \
         The user can turn it back on in the Companion's \"can use\" row."
    ))
}

/// The configured model ids and the user's tier map, for definition/call
/// model specs (`haiku`, `fast`, an id…).
pub fn model_catalog() -> (Vec<String>, HashMap<String, String>) {
    let known = crate::provider_router::ProviderRouter::load()
        .map(|r| r.list_models().into_iter().map(|m| m.model.id).collect())
        .unwrap_or_default();
    let tiers = crate::settings::load_settings().map(|s| s.model_tiers).unwrap_or_default();
    (known, tiers)
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
    cap_gate: Option<Arc<CapGate>>,
) -> HashMap<String, AgentOutcome> {
    let gate = Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_AGENTS));
    let mut set = tokio::task::JoinSet::new();
    // The workspace's MCP tools, discovered once per fan-out (off-thread,
    // bounded — a hung server must not stall the crew); each sub-agent then
    // sees the subset its definition grants.
    let mcp_tools: Arc<Vec<crate::mcp::McpToolInfo>> = Arc::new(match specs.first() {
        Some(first) => {
            let found = discover_thread_mcp_tools(Arc::clone(&mcp), &db, &first.workspace_path, &first.thread_id).await;
            let _ = app.emit(crate::mcp::scope::STATUS_CHANGED_EVENT, ());
            found
        }
        None => Vec::new(),
    });
    let turnstiles = mcp_turnstiles(&mcp_tools);
    let (known_models, tiers) = model_catalog();
    let known_models: Arc<Vec<String>> = Arc::new(known_models);
    let tiers: Arc<HashMap<String, String>> = Arc::new(tiers);
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
        let cap_gate = cap_gate.clone();
        set.spawn(async move {
            let _permit = gate.acquire_owned().await;
            let outcome = run_one_subagent(
                app, db, client, approvals, mcp, &mcp_tools, turnstiles, &known_models, &tiers, &spec, &cancel,
                cap_gate.as_deref(),
            )
            .await;
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

/// One sub-agent, start to finish: pick its model, gate its writes, grant
/// its MCP tools, run it (with the definition's one `escalate` retry), tag
/// the tier, and persist the run so it can be continued later. Shared by
/// the fan-out and `ChatEngine::continue_subagent`.
#[allow(clippy::too_many_arguments)]
pub async fn run_one_subagent(
    app: AppHandle,
    db: Arc<Mutex<Db>>,
    client: reqwest::Client,
    approvals: Arc<ApprovalBroker>,
    mcp: Arc<crate::mcp::McpRegistry>,
    mcp_tools: &[crate::mcp::McpToolInfo],
    turnstiles: Arc<HashMap<String, Arc<tokio::sync::Semaphore>>>,
    known_models: &[String],
    tiers: &HashMap<String, String>,
    spec: &SubagentSpec,
    cancel: &Arc<AtomicBool>,
    cap_gate: Option<&CapGate>,
) -> AgentOutcome {
    let started = std::time::Instant::now();
    // The plan was decided at fan-out (so the card could say it); a caller
    // without one (a continuation, a test) gets it decided here.
    let plan = spec.plan.clone().unwrap_or_else(|| plan_subagent(spec, known_models, tiers));
    // What is saved for a continuation keeps the mission's roots; what runs
    // is narrowed by the thread's mode now.
    let planned = SubagentSpec { plan: Some(plan.clone()), ..spec.clone() };
    let spec = &mode_spec(&db, &planned);
    let model = plan.model.clone();
    let mode = crate::permissions::thread_mode_source(Arc::clone(&db), spec.thread_id.clone(), spec.sandbox_roots.clone());
    let approval_gate = SubagentGate::new(approvals, app.clone(), spec)
        .with_mcp(mcp_tools, mode)
        .with_project_root(crate::talk_guard::project_root(&db, &spec.workspace_id));
    let tool_gate = mode_gate(&db, spec, planned.sandbox_roots.as_deref(), mcp_tools, Some(Box::new(approval_gate)));
    let external = McpSubagentTools::granted(
        mcp,
        Path::new(&spec.workspace_path),
        mcp_tools,
        spec.definition.as_ref(),
        turnstiles,
    );
    let external_ref: Option<&dyn ExternalTools> = external.as_ref().map(|e| e as &dyn ExternalTools);
    let sink = ChatAgentSink {
        app,
        db: Arc::clone(&db),
        workspace_id: spec.workspace_id.clone(),
        thread_id: spec.thread_id.clone(),
        call_id: spec.call_id.clone(),
    };
    // Say up front what this run is — the model, its tier, the effort — and
    // whether the director asked for more than the role gets.
    {
        let em = LiveEmitter::new(&sink, &spec.thread_id, &spec.call_id);
        em.notice(&format!("running on {}", plan_line(&plan)));
        if let Some(asked) = &plan.asked_model {
            if !plan.asked_honored {
                em.notice(&format!("the director asked for {asked}; under Auto a typed role keeps its tier"));
            }
        }
    }
    let mut outcome = run_attempt(&model, spec, &client, cancel, &sink, &tool_gate, external_ref, started).await;
    // The definition's `escalate`: one retry on the stronger model when the
    // cheap attempt failed — unless the director stopped the turn. A
    // continuation never escalates: the user chose to give THIS run more
    // turns. Nor does a run with nothing left of its spend limit.
    if spec.resume.is_none()
        && should_escalate(&outcome)
        && has_spend_left(spec, outcome.cost_usd)
        && !cancel.load(Ordering::Relaxed)
    {
        if let Some(stronger) = escalation_model(spec, &model, known_models, tiers) {
            tracing::info!(call = %spec.call_id, from = %model, to = %stronger, "escalating sub-agent");
            LiveEmitter::new(&sink, &spec.thread_id, &spec.call_id).notice(&format!(
                "escalating to {stronger}: the {model} attempt {}",
                if outcome.blocked { "stopped on a question" } else if outcome.closed_at_cap { "hit its turn limit" } else { "failed" }
            ));
            let retry = escalation_retry(spec, &outcome, &model, &stronger, tiers);
            LiveEmitter::new(&sink, &spec.thread_id, &spec.call_id)
                .notice(&format!("running on {}", plan_line(retry.plan.as_ref().unwrap())));
            let second = run_attempt(&stronger, &retry, &client, cancel, &sink, &tool_gate, external_ref, std::time::Instant::now()).await;
            outcome = merge_escalated(outcome, second);
        }
    }
    // A WRITING sub-agent that ran out of turns mid-work never reaches the
    // director as a result on its own: the turn pauses on a card and the
    // user grants more turns (as many rounds as it takes) or accepts the
    // partial report knowingly. Reads are different — a partial map is
    // information, not a half-done tree — so they return as before.
    if let Some(gate) = cap_gate {
        // Turns spent so far: every billed attempt (an escalated run spent
        // up to two budgets) — the card says how much it already took.
        let mut turns_used = spec.max_iterations.unwrap_or(0) * outcome.billed_attempts().len().max(1);
        // The user grants turns, not money: each continuation gets what is
        // left of the run's spend limit, and none starts once it is spent.
        while ran_out_of_turns(&outcome)
            && spec_edits_files(spec)
            && has_spend_left(spec, outcome.cost_usd)
            && !cancel.load(Ordering::Relaxed)
        {
            LiveEmitter::new(&sink, &spec.thread_id, &spec.call_id).notice(&format!(
                "hit its turn limit mid-work after {turns_used} turns — waiting for you: more turns, or accept what it has"
            ));
            let answer = gate
                .ask(
                    &sink.app,
                    &spec.workspace_id,
                    &spec.thread_id,
                    &spec.call_id,
                    &spec.call.description,
                    spec.call.subagent_type.as_deref(),
                    turns_used,
                )
                .await;
            let extra = match answer {
                CapAnswer::More(n) => n,
                CapAnswer::Accept => {
                    LiveEmitter::new(&sink, &spec.thread_id, &spec.call_id)
                        .notice("partial report accepted by the user");
                    break;
                }
                CapAnswer::Stopped => {
                    LiveEmitter::new(&sink, &spec.thread_id, &spec.call_id).notice("stopped by the director");
                    break;
                }
                CapAnswer::Timeout => {
                    LiveEmitter::new(&sink, &spec.thread_id, &spec.call_id)
                        .notice("no answer in 30 minutes — partial report handed to the director");
                    break;
                }
            };
            LiveEmitter::new(&sink, &spec.thread_id, &spec.call_id)
                .notice(&format!("given {extra} more turns — continuing where it left off"));
            let mut more = spec.clone();
            more.call.model = Some(outcome.model.clone());
            more.max_iterations = Some(extra);
            more.spend_limit = spend_left(spec, outcome.cost_usd);
            if let Some(p) = more.plan.as_mut() {
                p.model = outcome.model.clone();
                p.tier = crate::skills::agents::tier_of_model(&outcome.model, tiers).map(str::to_string);
                // An escalated writer continues at the strong tier's effort.
                p.effort = spec.definition.as_ref().and_then(|d| d.effort).or_else(|| default_effort_for_tier(p.tier.as_deref()));
            }
            more.resume = Some(resume_messages_for_continuation(
                &BlockedTranscript { messages: outcome.transcript.clone(), ask_tool_use_id: outcome.ask_tool_use_id.clone() },
                &continuation_note(None, Some(extra)),
            ));
            let second = run_attempt(&outcome.model, &more, &client, cancel, &sink, &tool_gate, external_ref, std::time::Instant::now()).await;
            outcome = merge_continued(outcome, second);
            turns_used += extra;
        }
    }
    outcome.tier = tier_for_outcome(spec, &outcome.model, tiers);
    if was_stopped(&outcome, cancel.load(Ordering::Relaxed)) {
        mark_stopped(&mut outcome);
    }
    persist_run(&db, &planned, &outcome);
    outcome
}

/// `spec` in its thread's permission mode (#1146), as it starts: under Plan
/// only its commands run on the read-only sandbox for the whole run. A
/// continuation started after a switch to Plan only is narrowed the same way.
pub fn mode_spec(db: &Mutex<Db>, spec: &SubagentSpec) -> SubagentSpec {
    let mode = crate::permissions::effective(crate::permissions::thread_mode(db, &spec.thread_id), spec.sandbox_roots.as_deref());
    SubagentSpec { sandbox_roots: crate::permissions::exec_roots(mode, spec.sandbox_roots.as_deref()), ..spec.clone() }
}

/// The gate of a sub-agent `spec` runs (narrowed by [`mode_spec`]): each
/// call is decided in the thread's mode, read at the call, then what the
/// mode allows goes to `inner` (its approval gate). `mission_roots`, the
/// mission's own, say whether a read-only mission forces Plan only; the
/// workspace's active mission, read as the run starts, whether it ships
/// nothing. Its read-only MCP tools are the ones their server marks so.
pub fn mode_gate(
    db: &Arc<Mutex<Db>>,
    spec: &SubagentSpec,
    mission_roots: Option<&[String]>,
    mcp_tools: &[crate::mcp::McpToolInfo],
    inner: Option<Box<dyn ToolGate>>,
) -> crate::permissions::ModeGate {
    let ships_nothing = crate::mission::workspace_ships_nothing(&db.lock(), &spec.workspace_id);
    crate::permissions::ModeGate::new(
        crate::permissions::thread_mode_source(Arc::clone(db), spec.thread_id.clone(), spec.sandbox_roots.clone()),
        spec.sandbox_roots.clone(),
        crate::permissions::forced(mission_roots),
        ships_nothing,
        mcp_tools.iter().filter(|t| t.read_only).map(|t| t.namespaced.clone()).collect(),
        inner,
    )
}

/// What Plan only refuses to start (#1146): a defined agent type whose tools
/// can write. An untyped call, or a type nobody defined, runs: its sub-agent
/// inherits the mode through [`mode_gate`] and the sandbox.
pub fn delegate_writes(definition: Option<&AgentDefinition>) -> bool {
    definition.is_some() && definition_can_write(definition)
}

/// Whether a sub-agent may change files: its definition grants `write_file`
/// or `edit_file`, or it has no definition (the full tool set). Narrower than
/// [`spec_can_write`] (which counts the shell, for the escalation warning):
/// `test-runner`, `ticket-reader`, `pr-author` and `reviewer` keep `bash`
/// for tests, `gh` and git but never edit the tree, so a cap on them is a
/// partial read the director can handle, not half-done work.
pub fn spec_edits_files(spec: &SubagentSpec) -> bool {
    match spec.definition.as_ref().and_then(|d| d.tools.as_deref()) {
        None => true,
        Some(tools) => tools.iter().any(|t| t == "write_file" || t == "edit_file"),
    }
}

/// A run that stopped because its turns ran out — with or without a usable
/// forced close — and left a transcript to continue from. A blocked run
/// (a question), a run that could not start, one that errored and one its
/// spend limit closed are not this: more turns would not fix them.
pub fn ran_out_of_turns(o: &AgentOutcome) -> bool {
    !o.blocked && !o.errored && !o.spend_stopped && !o.transcript.is_empty() && (o.closed_at_cap || !o.finished)
}

/// Fold a continuation (more turns on the same transcript) into one outcome:
/// the continuation's report, ending and transcript; both runs' spend,
/// duration and tool calls; attempts appended; `continued` set. An earlier
/// escalation is remembered.
pub fn merge_continued(first: AgentOutcome, second: AgentOutcome) -> AgentOutcome {
    let mut attempts = first.attempts.clone();
    if attempts.is_empty() {
        attempts.push(AgentAttempt::from_outcome(&first));
    }
    attempts.push(AgentAttempt::from_outcome(&second));
    // A continuation that never got going (provider error, could not start)
    // leaves no transcript: keep the first run's report, ending and resume
    // point — the work is still there to continue — and say what happened.
    if second.transcript.is_empty() {
        return AgentOutcome {
            report: format!("{}\n\n(A continuation did not run: {})", first.report, second.report.trim()),
            input_tokens: first.input_tokens + second.input_tokens,
            output_tokens: first.output_tokens + second.output_tokens,
            cache_read_tokens: first.cache_read_tokens + second.cache_read_tokens,
            cache_creation_tokens: first.cache_creation_tokens + second.cache_creation_tokens,
            cost_usd: first.cost_usd + second.cost_usd,
            duration_ms: first.duration_ms + second.duration_ms,
            tool_calls: first.tool_calls + second.tool_calls,
            attempts,
            continued: true,
            ..first
        };
    }
    AgentOutcome {
        escalated_from: second.escalated_from.clone().or(first.escalated_from.clone()),
        input_tokens: first.input_tokens + second.input_tokens,
        output_tokens: first.output_tokens + second.output_tokens,
        cache_read_tokens: first.cache_read_tokens + second.cache_read_tokens,
        cache_creation_tokens: first.cache_creation_tokens + second.cache_creation_tokens,
        cost_usd: first.cost_usd + second.cost_usd,
        duration_ms: first.duration_ms + second.duration_ms,
        tool_calls: first.tool_calls + second.tool_calls,
        attempts,
        continued: true,
        ..second
    }
}

/// Save what a continuation needs: the spec (minus the transcript it ran
/// from — the saved transcript IS the resume point) and the conversation as
/// the loop left it. A run that produced no transcript (could not start)
/// leaves nothing to continue.
fn persist_run(db: &Arc<Mutex<Db>>, spec: &SubagentSpec, outcome: &AgentOutcome) {
    if outcome.transcript.is_empty() {
        return;
    }
    let mut bare = spec.clone();
    bare.resume = None;
    let transcript = BlockedTranscript {
        messages: outcome.transcript.clone(),
        ask_tool_use_id: outcome.ask_tool_use_id.clone(),
    };
    let (Ok(spec_json), Ok(transcript_json)) =
        (serde_json::to_string(&bare), serde_json::to_string(&transcript))
    else {
        return;
    };
    if let Err(e) = db.lock().upsert_chat_agent_run(
        &spec.call_id,
        &spec.thread_id,
        &spec.workspace_id,
        &spec_json,
        &transcript_json,
        &outcome.model,
    ) {
        tracing::warn!(error = %e, call = %spec.call_id, "failed to persist sub-agent run");
    }
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
    gate: &dyn ToolGate,
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
        let p = subagent_system_prompt("/w", &call, None, "");
        assert!(p.contains("/w"));
        assert!(p.contains("Check security"));
        assert!(p.contains("Your role: security-reviewer."));
        assert!(p.contains("cannot ask questions"));
        assert!(p.contains("ONE complete, self-contained report"));
    }

    #[test]
    fn report_mapping_covers_every_ending() {
        let mut out = AgenticResult { text: "  findings  ".into(), finished: true, ..Default::default() };
        assert_eq!(report_from_result(&out, Some(25)), ("findings".into(), true));

        out.closed_at_cap = true;
        let (r, ok) = report_from_result(&out, Some(25));
        assert!(ok && r.starts_with("findings") && r.contains("25-turn tool limit"), "{r}");

        let unfinished = AgenticResult::default();
        let (r, ok) = report_from_result(&unfinished, Some(25));
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
        let (r, ok) = report_from_result(&blocked, Some(25));
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
            max_turns: None,
            effort: None,
            max_cost: None,
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
        let p = subagent_system_prompt("/w", &call, Some(&d), "");
        assert!(p.contains("Your role: security-reviewer."));
        assert!(p.contains("# Agent: security-reviewer\nYou are the security-reviewer."), "{p}");
        assert!(p.ends_with(crate::chat_history::UNTRUSTED_OUTPUT_NOTE), "the note comes after the repo's text: {p}");
    }

    #[test]
    fn the_project_instructions_sit_between_the_guidance_and_the_definition() {
        let call = AgentCall { description: "Audit".into(), prompt: "…".into(), subagent_type: Some("security-reviewer".into()), model: None };
        let d = def("security-reviewer", None, None);
        let section = "\n\n# Project instructions\n\nContents of CLAUDE.md:\n\nUse tabs.";
        let p = subagent_system_prompt("/w", &call, Some(&d), section);
        let (rules, report, agent) = (
            p.find("Use tabs.").expect("instructions included"),
            p.find("self-contained report").unwrap(),
            p.find("# Agent: security-reviewer").unwrap(),
        );
        assert!(report < rules && rules < agent, "guidance, then the project's rules, then the role: {p}");
    }

    /// Records the system prompt of the one request it answers.
    struct SystemRecorder {
        system: Mutex<String>,
    }
    #[async_trait::async_trait]
    impl LlmProvider for SystemRecorder {
        async fn complete(&self, _b: &str, _k: Option<&str>, req: &LlmRequest, _c: &reqwest::Client) -> AppResult<LlmResponse> {
            *self.system.lock() = req.system.clone();
            Ok(resp("done", vec![], LlmStopReason::EndTurn))
        }
    }

    #[tokio::test]
    async fn a_subagent_runs_under_the_workspace_claude_md() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("CLAUDE.md"), "Run `npm test` before you report.\n").unwrap();
        let provider = SystemRecorder { system: Mutex::new(String::new()) };
        let spec = SubagentSpec {
            call_id: "c".into(),
            call: AgentCall { description: "Check".into(), prompt: "check".into(), subagent_type: None, model: None },
            workspace_id: "w".into(), thread_id: "t".into(),
            workspace_path: dir.path().to_string_lossy().into_owned(),
            default_model: "m".into(), max_iterations: Some(3), max_tokens: 1, sandbox_roots: None,
            definition: None,
            policy_auto: false,
            resume: None,
            plan: None,
            spend_limit: None,
        };
        let rec = Recorder { entries: Mutex::new(vec![]) };
        let out = run_subagent_core(&provider, "http://x", None, &reqwest::Client::new(), "m", &spec,
            &Arc::new(AtomicBool::new(false)), &rec, None, None).await.unwrap();
        assert!(out.ok);
        let system = provider.system.lock().clone();
        assert!(system.contains("# Project instructions"), "{system}");
        assert!(system.contains("Contents of CLAUDE.md:\n\nRun `npm test` before you report."), "{system}");

        // No instruction file in the workspace: the sub-agent still runs.
        let bare = tempfile::tempdir().unwrap();
        let spec = SubagentSpec { workspace_path: bare.path().to_string_lossy().into_owned(), ..spec };
        let out = run_subagent_core(&provider, "http://x", None, &reqwest::Client::new(), "m", &spec,
            &Arc::new(AtomicBool::new(false)), &rec, None, None).await.unwrap();
        assert!(out.ok);
        assert!(!provider.system.lock().contains("Contents of CLAUDE.md"));
    }

    #[test]
    fn model_precedence_is_call_then_definition_then_conversation() {
        let no_tiers: HashMap<String, String> = HashMap::new();
        let known = vec!["claude-haiku-4-5-20251001".to_string(), "gpt-4o".to_string()];
        let base = SubagentSpec {
            call_id: "c".into(),
            call: AgentCall { description: "d".into(), prompt: "p".into(), subagent_type: None, model: None },
            workspace_id: "w".into(), thread_id: "t".into(), workspace_path: "/w".into(),
            default_model: "conv-model".into(), max_iterations: Some(5), max_tokens: 1, sandbox_roots: None,
            definition: None,
            policy_auto: false,
            resume: None,
            plan: None,
            spend_limit: None,
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
    fn a_continuation_folds_into_one_outcome_with_the_new_ending() {
        let first = AgentOutcome {
            report: "partial".into(), ok: true, finished: true, closed_at_cap: true, model: "sonnet".into(),
            escalated_from: Some("haiku".into()), input_tokens: 100, output_tokens: 10, cost_usd: 0.1, duration_ms: 50, tool_calls: 25,
            ..AgentOutcome::default()
        };
        let second = AgentOutcome {
            report: "complete".into(), ok: true, finished: true, closed_at_cap: false, model: "sonnet".into(),
            input_tokens: 40, output_tokens: 5, cost_usd: 0.04, duration_ms: 20, tool_calls: 8,
            transcript: crate::orchestrator::agentic::user_messages("p"),
            ..AgentOutcome::default()
        };
        let m = merge_continued(first, second);
        assert_eq!(m.report, "complete");
        assert!(!m.closed_at_cap && m.continued);
        assert_eq!(m.escalated_from.as_deref(), Some("haiku"), "an earlier escalation is remembered");
        assert_eq!((m.input_tokens, m.output_tokens, m.tool_calls, m.duration_ms), (140, 15, 33, 70));
        assert!((m.cost_usd - 0.14).abs() < 1e-9);
        assert_eq!(m.attempts.len(), 2);
    }

    #[test]
    fn a_continuation_that_never_ran_keeps_the_first_runs_work() {
        let msg = crate::orchestrator::agentic::user_messages("p");
        let first = AgentOutcome { report: "partial".into(), ok: true, finished: true, closed_at_cap: true, model: "m".into(), transcript: msg.clone(), input_tokens: 10, ..AgentOutcome::default() };
        let failed = AgentOutcome { report: "Sub-agent failed: network".into(), ok: false, model: "m".into(), ..AgentOutcome::default() };
        let m = merge_continued(first, failed);
        assert!(m.report.starts_with("partial"), "{}", m.report);
        assert!(m.report.contains("A continuation did not run: Sub-agent failed: network"));
        assert!(m.ok && m.closed_at_cap && m.continued);
        assert_eq!(m.transcript.len(), msg.len(), "the resume point survives");
        assert!(ran_out_of_turns(&m), "and the gate can ask again");
    }

    #[test]
    fn only_file_editing_subagents_are_gated_at_the_cap() {
        let base = SubagentSpec {
            call_id: "c".into(),
            call: AgentCall { description: "d".into(), prompt: "p".into(), subagent_type: None, model: None },
            workspace_id: "w".into(), thread_id: "t".into(), workspace_path: "/w".into(),
            default_model: "m".into(), max_iterations: Some(5), max_tokens: 1, sandbox_roots: None,
            definition: None, policy_auto: false, resume: None,
            plan: None,
            spend_limit: None,
        };
        assert!(spec_edits_files(&base), "no definition → the full tool set");
        let with = |tools: Vec<&str>| SubagentSpec { definition: Some(def("x", Some(tools), None)), ..base.clone() };
        assert!(spec_edits_files(&with(vec!["read_file", "edit_file"])));
        assert!(!spec_edits_files(&with(vec!["read_file", "run_command"])), "bash alone is a reader (test-runner, pr-author)");
        assert!(spec_can_write(&with(vec!["run_command"])), "…though the escalation warning still counts the shell");
        // The built-ins: only the two writing roles are gated.
        for d in crate::skills::builtin_agents::builtin_agent_definitions() {
            let spec = SubagentSpec { definition: Some(d.clone()), ..base.clone() };
            assert_eq!(spec_edits_files(&spec), matches!(d.name.as_str(), "implementer" | "pr-maintainer"), "{}", d.name);
        }
    }

    #[test]
    fn ran_out_of_turns_means_a_cap_ending_with_a_transcript_to_resume() {
        let msg = crate::orchestrator::agentic::user_messages("p");
        let capped = AgentOutcome { closed_at_cap: true, finished: true, transcript: msg.clone(), ..AgentOutcome::default() };
        assert!(ran_out_of_turns(&capped));
        let unfinished = AgentOutcome { finished: false, transcript: msg.clone(), ..AgentOutcome::default() };
        assert!(ran_out_of_turns(&unfinished));
        let blocked = AgentOutcome { blocked: true, transcript: msg.clone(), ..AgentOutcome::default() };
        assert!(!ran_out_of_turns(&blocked), "a question is for the director, not a cap");
        let failed_to_start = AgentOutcome { finished: false, ..AgentOutcome::default() };
        assert!(!ran_out_of_turns(&failed_to_start), "nothing to resume");
        let done = AgentOutcome { finished: true, transcript: msg, ..AgentOutcome::default() };
        assert!(!ran_out_of_turns(&done));
    }

    fn planning_fixture() -> (Vec<String>, HashMap<String, String>, SubagentSpec) {
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
            call: AgentCall { description: "d".into(), prompt: "p".into(), subagent_type: Some("implementer".into()), model: None },
            workspace_id: "w".into(), thread_id: "t".into(), workspace_path: "/w".into(),
            default_model: "opus".into(), max_iterations: Some(5), max_tokens: 1, sandbox_roots: None,
            definition: Some(def("implementer", None, Some("balanced"))),
            policy_auto: true,
            resume: None,
            plan: None,
            spend_limit: None,
        };
        (known, tiers, base)
    }

    #[test]
    fn under_auto_a_typed_role_keeps_its_tier_when_the_director_asks_for_more() {
        let (known, tiers, base) = planning_fixture();
        // No ask: the definition's tier, the tier's effort.
        let p = plan_subagent(&base, &known, &tiers);
        assert_eq!((p.model.as_str(), p.tier.as_deref(), p.effort), ("sonnet", Some("balanced"), Some(Effort::Medium)));
        assert_eq!(p.asked_model, None);
        // `model: "strong"` on an implementer is ignored under Auto, and remembered.
        let asked = SubagentSpec { call: AgentCall { model: Some("strong".into()), ..base.call.clone() }, ..base.clone() };
        let p = plan_subagent(&asked, &known, &tiers);
        assert_eq!(p.model, "sonnet");
        assert_eq!(p.asked_model.as_deref(), Some("strong"));
        assert!(!p.asked_honored);
        // …so is the strong model's id itself, and so is `inherit` (the
        // director's model — under Auto that is the strong tier).
        let asked_id = SubagentSpec { call: AgentCall { model: Some("opus".into()), ..base.call.clone() }, ..base.clone() };
        assert_eq!(plan_subagent(&asked_id, &known, &tiers).model, "sonnet");
        let inherit = SubagentSpec { call: AgentCall { model: Some("inherit".into()), ..base.call.clone() }, ..base.clone() };
        let p = plan_subagent(&inherit, &known, &tiers);
        assert_eq!(p.model, "sonnet");
        assert!(!p.asked_honored);
        // A definition whose `model` is an id (not an alias) has a tier too.
        let by_id = SubagentSpec { definition: Some(def("impl-id", None, Some("sonnet"))), call: AgentCall { model: Some("strong".into()), ..base.call.clone() }, ..base.clone() };
        assert_eq!(plan_subagent(&by_id, &known, &tiers).model, "sonnet");
        // Asking DOWN is honored (a cheaper implementer is the director's call).
        let down = SubagentSpec { call: AgentCall { model: Some("fast".into()), ..base.call.clone() }, ..base.clone() };
        let p = plan_subagent(&down, &known, &tiers);
        assert_eq!((p.model.as_str(), p.effort), ("haiku", Some(Effort::Low)));
        assert_eq!(p.asked_model.as_deref(), Some("fast"), "the ask differs from the id, so it is shown");
        assert!(p.asked_honored);
    }

    #[test]
    fn outside_auto_the_directors_model_is_honored_and_effort_follows_the_definition() {
        let (known, tiers, base) = planning_fixture();
        let manual = SubagentSpec { policy_auto: false, call: AgentCall { model: Some("strong".into()), ..base.call.clone() }, ..base.clone() };
        let p = plan_subagent(&manual, &known, &tiers);
        assert_eq!((p.model.as_str(), p.tier.as_deref(), p.effort), ("opus", Some("strong"), Some(Effort::High)));
        assert!(p.asked_honored);
        // A definition's own `effort` beats the tier default.
        let mut d = def("implementer", None, Some("balanced"));
        d.effort = Some(Effort::Xhigh);
        let explicit = SubagentSpec { definition: Some(d), ..base.clone() };
        assert_eq!(plan_subagent(&explicit, &known, &tiers).effort, Some(Effort::Xhigh));
        // Untyped under Auto: fast tier, low effort; the ceiling never applies (no role).
        let untyped = SubagentSpec { definition: None, call: AgentCall { subagent_type: None, model: Some("strong".into()), ..base.call.clone() }, ..base.clone() };
        let p = plan_subagent(&untyped, &known, &tiers);
        assert_eq!((p.model.as_str(), p.effort), ("opus", Some(Effort::High)));
        assert!(p.asked_honored);
        let untyped_plain = SubagentSpec { definition: None, call: AgentCall { subagent_type: None, model: None, ..base.call.clone() }, ..base.clone() };
        assert_eq!(plan_subagent(&untyped_plain, &known, &tiers).effort, Some(Effort::Low));
        // A model outside every tier: no effort default.
        let odd = SubagentSpec { definition: None, policy_auto: false, default_model: "local-llm".into(), call: AgentCall { subagent_type: None, model: None, ..base.call.clone() }, ..base.clone() };
        let p = plan_subagent(&odd, &known, &tiers);
        assert_eq!((p.model.as_str(), p.tier.as_deref(), p.effort), ("local-llm", None, None));
        assert_eq!(plan_line(&p), "local-llm · effort default");
        assert_eq!(plan_line(&plan_subagent(&base, &known, &tiers)), "sonnet · balanced · effort medium");
    }

    #[test]
    fn the_doctrine_says_one_question_per_typed_subagent_and_that_a_cap_is_not_lost_work() {
        let d = director_doctrine(&[]);
        assert!(d.contains("One sub-agent, one question, always typed"), "{d}");
        assert!(d.contains("run until they finish"), "{d}");
        assert!(!d.contains("15-turn cap"), "no shipped cap is described to the director: {d}");
        assert!(d.contains("no turn limit unless the user set one"), "{d}");
        assert!(d.contains("runs on the fast tier"));
        assert!(d.contains("give that sub-agent more turns from its journal"));
        assert!(d.contains("pauses your turn until the user gives it more turns or accepts its partial"));
        assert!(d.contains("do not build on it"));
        assert!(d.contains("Never pass `model` on a typed call"));
        assert!(d.contains("never re-run or re-verify what a sub-agent already reported"));
        assert_eq!(AUTO_SUBAGENT_TIER, "fast");
    }

    #[test]
    fn under_auto_an_unspecified_subagent_runs_fast_and_the_director_runs_strong() {
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
            default_model: "opus".into(), max_iterations: Some(5), max_tokens: 1, sandbox_roots: None,
            definition: None,
            policy_auto: true,
            resume: None,
            plan: None,
            spend_limit: None,
        };
        assert_eq!(pick_subagent_model(&base, &known, &tiers), "haiku", "no model → fast under Auto");
        // A definition's tier still wins; a call's explicit model still wins.
        let with_def = SubagentSpec { definition: Some(def("implementer", None, Some("balanced"))), ..base.clone() };
        assert_eq!(pick_subagent_model(&with_def, &known, &tiers), "sonnet");
        let explicit = SubagentSpec { call: AgentCall { model: Some("strong".into()), ..base.call.clone() }, ..base.clone() };
        assert_eq!(pick_subagent_model(&explicit, &known, &tiers), "opus");
        // Fast unmapped → inherit the director's model, as before.
        let mut no_fast = tiers.clone();
        no_fast.remove("fast");
        assert_eq!(pick_subagent_model(&base, &known, &no_fast), "opus");
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
        let mut no_balanced = tiers.clone();
        no_balanced.remove("balanced");
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
            default_model: "opus".into(), max_iterations: Some(5), max_tokens: 1, sandbox_roots: None,
            definition: Some(d),
            policy_auto: false,
            resume: None,
            plan: None,
            spend_limit: None,
        };
        let ok = AgentOutcome { ok: true, finished: true, model: "sonnet".into(), ..Default::default() };
        assert!(!should_escalate(&ok));
        assert!(should_escalate(&AgentOutcome { ok: false, model: "sonnet".into(), ..Default::default() }));
        // A report cut off at the cap is still a report (the tree holds its
        // work); a question for the director is not a capability failure.
        assert!(!should_escalate(&AgentOutcome { ok: true, finished: true, closed_at_cap: true, model: "sonnet".into(), ..Default::default() }));
        assert!(!should_escalate(&AgentOutcome { ok: false, blocked: true, model: "sonnet".into(), ..Default::default() }));
        // A spend stop whose close came back empty: the money ran out, a
        // dearer model would only spend more.
        assert!(!should_escalate(&AgentOutcome { ok: false, spend_stopped: true, model: "sonnet".into(), ..Default::default() }));
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
            ..Default::default()
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
            default_model: "m".into(), max_iterations: Some(3), max_tokens: 1, sandbox_roots: None,
            definition: Some(def("ticket-reader", Some(vec!["read_file"]), None)),
            policy_auto: false,
            resume: None,
            plan: None,
            spend_limit: None,
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
            default_model: "m".into(), max_iterations: Some(3), max_tokens: 1, sandbox_roots: None,
            definition: None,
            policy_auto: false,
            resume: None,
            plan: None,
            spend_limit: None,
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
        let (reason, denial) = mcp_gate_texts(Some("Ticket"), "mcp__jira__add_comment", false);
        assert!(reason.starts_with("Sub-agent \u{201c}Ticket\u{201d}: MCP tool"));
        assert!(reason.contains("may change external state") && denial.contains("do not retry"));
    }

    struct PromptRecordingScripted {
        inner: ScriptedProvider,
        system: Mutex<String>,
        tools: Mutex<Vec<String>>,
    }
    #[async_trait::async_trait]
    impl LlmProvider for PromptRecordingScripted {
        async fn complete(&self, b: &str, k: Option<&str>, req: &LlmRequest, c: &reqwest::Client) -> AppResult<LlmResponse> {
            *self.system.lock() = req.system.clone();
            *self.tools.lock() = req.tools.iter().map(|t| t.name.clone()).collect();
            self.inner.complete(b, k, req, c).await
        }
    }

    #[tokio::test]
    async fn a_subagent_loads_a_skill_and_its_allowed_tools_hold() {
        let dir = tempfile::tempdir().unwrap();
        let skill_dir = dir.path().join(".claude/skills/audit");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: audit\ndescription: Audit the code.\nallowed-tools: read_file\n---\nRead, never write.",
        )
        .unwrap();
        let provider = PromptRecordingScripted {
            inner: ScriptedProvider {
                turns: Mutex::new(VecDeque::from(vec![
                    resp("", vec![LlmToolUse { id: "t1".into(), name: "Skill".into(), input: serde_json::json!({"name": "audit"}) }], LlmStopReason::ToolUse),
                    resp("", vec![LlmToolUse { id: "t2".into(), name: "write_file".into(), input: serde_json::json!({"path": "x.txt", "content": "hi"}) }], LlmStopReason::ToolUse),
                    resp("audited", vec![], LlmStopReason::EndTurn),
                ])),
            },
            system: Mutex::new(String::new()),
            tools: Mutex::new(vec![]),
        };
        let spec = SubagentSpec {
            call_id: "c".into(),
            call: AgentCall { description: "Audit".into(), prompt: "p".into(), subagent_type: None, model: None },
            workspace_id: "w".into(), thread_id: "t".into(),
            workspace_path: dir.path().to_string_lossy().into_owned(),
            default_model: "m".into(), max_iterations: Some(4), max_tokens: 1, sandbox_roots: None,
            definition: None,
            policy_auto: false,
            resume: None,
            plan: None,
            spend_limit: None,
        };
        let rec = Recorder { entries: Mutex::new(vec![]) };
        let out = run_subagent_core(&provider, "http://x", None, &reqwest::Client::new(), "m", &spec,
            &Arc::new(AtomicBool::new(false)), &rec, None, None).await.unwrap();
        assert!(out.ok, "{}", out.report);
        assert!(provider.system.lock().contains("- audit: Audit the code."));
        assert!(provider.tools.lock().contains(&"Skill".to_string()));
        // The skill's allowed-tools refused the write; nothing reached disk.
        assert!(!dir.path().join("x.txt").exists());
        let results: Vec<String> = out
            .transcript
            .iter()
            .filter_map(|m| match &m.content {
                crate::providers::LlmContent::ToolResults(r) => Some(r.iter().map(|r| r.content.clone()).collect::<Vec<_>>()),
                _ => None,
            })
            .flatten()
            .collect();
        assert_eq!(results.len(), 2, "{results:?}");
        assert!(results[0].contains("Read, never write.") && !results[0].contains("[untrusted output from"), "{}", results[0]);
        assert!(results[1].contains("`write_file` was not run") && results[1].contains("`audit`"), "{}", results[1]);
    }

    #[test]
    fn mcp_tools_are_filtered_by_the_definition_grant() {
        use crate::mcp::{McpRegistry, McpToolInfo};
        let discovered = vec![
            McpToolInfo { server: "jira".into(), name: "get_issue".into(), namespaced: "mcp__jira__get_issue".into(), read_only: true, ..Default::default() },
            McpToolInfo { server: "github".into(), name: "list_prs".into(), namespaced: "mcp__github__list_prs".into(), ..Default::default() },
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
            default_model: "m".into(), max_iterations: Some(3), max_tokens: 1, sandbox_roots: None,
            definition: Some(def("reader", Some(vec!["read_file", "grep"]), None)),
            policy_auto: false,
            resume: None,
            plan: None,
            spend_limit: None,
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
            default_model: "m".into(), max_iterations: Some(5), max_tokens: 1, sandbox_roots: None, definition: None,
            policy_auto: false,
            resume: None,
            plan: None,
            spend_limit: None,
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
            max_iterations: Some(5),
            max_tokens: 4096,
            sandbox_roots: None,
            definition: None,
            policy_auto: false,
            resume: None,
            plan: None,
            spend_limit: None,
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

    /// Answers its scripted turns, then fails every request with an error
    /// that is not retried (a context 400). Panics past `max_calls`, so a
    /// loop that never stops fails the test instead of hanging it.
    struct FailsAfter {
        turns: Mutex<VecDeque<LlmResponse>>,
        calls: AtomicU64,
        max_calls: u64,
        seen: Mutex<Vec<Vec<LlmMessage>>>,
    }
    impl FailsAfter {
        fn new(turns: Vec<LlmResponse>, max_calls: u64) -> Self {
            Self { turns: Mutex::new(VecDeque::from(turns)), calls: AtomicU64::new(0), max_calls, seen: Mutex::new(vec![]) }
        }
    }
    #[async_trait::async_trait]
    impl LlmProvider for FailsAfter {
        async fn complete(&self, _b: &str, _k: Option<&str>, req: &LlmRequest, _c: &reqwest::Client) -> AppResult<LlmResponse> {
            let n = self.calls.fetch_add(1, Ordering::Relaxed) + 1;
            assert!(n <= self.max_calls, "the loop never stopped ({n} calls)");
            self.seen.lock().push(req.messages.clone());
            self.turns.lock().pop_front().ok_or_else(|| crate::error::AppError::Provider {
                kind: crate::error::ProviderErrorKind::BadRequest,
                retry_after: None,
                message: "prompt is too long".into(),
            })
        }
    }

    fn read_turn(id: &str, input_tokens: u64) -> LlmResponse {
        LlmResponse {
            input_tokens,
            ..resp(
                "reading",
                vec![LlmToolUse { id: id.into(), name: "read_file".into(), input: serde_json::json!({"path": "a.rs"}) }],
                LlmStopReason::ToolUse,
            )
        }
    }

    fn core_spec(dir: &std::path::Path) -> SubagentSpec {
        SubagentSpec {
            call_id: "call-f".into(),
            call: parse_agent_call(&serde_json::json!({"description": "Inspect a.rs", "prompt": "Read a.rs and report."})).unwrap(),
            workspace_id: "ws".into(),
            thread_id: "th".into(),
            workspace_path: dir.to_string_lossy().into_owned(),
            default_model: "m".into(),
            max_iterations: None,
            max_tokens: 4096,
            sandbox_roots: None,
            definition: None,
            policy_auto: false,
            resume: None,
            plan: None,
            spend_limit: None,
        }
    }

    #[tokio::test]
    async fn failed_subagent_is_continuable() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.rs"), "fn main() {}\n").unwrap();
        // Two real rounds, then the provider refuses the third request.
        let provider = FailsAfter::new(vec![read_turn("t1", 10), read_turn("t2", 10)], 3);
        let spec = core_spec(dir.path());
        let rec = Recorder { entries: Mutex::new(vec![]) };
        let cancel = Arc::new(AtomicBool::new(false));
        let out = run_subagent_core(&provider, "http://x", None, &reqwest::Client::new(), "m", &spec, &cancel, &rec, None, None)
            .await
            .expect("a failed loop is a failed outcome, not an error");
        assert!(!out.ok && out.errored && !out.finished, "{}", out.report);
        assert!(out.report.starts_with("Sub-agent failed:") && out.report.contains("prompt is too long"), "{}", out.report);
        // The two rounds' usage, not zero.
        assert_eq!((out.input_tokens, out.output_tokens, out.tool_calls), (20, 10, 2));
        assert_eq!(out.billed_attempts()[0].input_tokens, 20);
        // Their conversation is the resume point: the ask, then two rounds.
        assert_eq!(out.transcript.len(), 5, "{:?}", out.transcript);
        assert!(!ran_out_of_turns(&out), "an error is not a turn cap: the cap gate does not ask");

        // Saved like any other run, so the crew journal can continue it.
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let db = Arc::new(Mutex::new(Db::open(tmp.path()).unwrap()));
        persist_run(&db, &spec, &out);
        let saved = db.lock().get_chat_agent_run("call-f").unwrap().expect("the failed run was saved");
        let transcript: BlockedTranscript = serde_json::from_str(&saved.transcript_json).unwrap();
        assert_eq!(transcript.messages.len(), 5);
        assert!(transcript.ask_tool_use_id.is_empty(), "a continuation, not an answered ask");

        // Continuing resumes on those rounds instead of starting over.
        let more = SubagentSpec {
            resume: Some(resume_messages_for_continuation(&transcript, &continuation_note(None, None))),
            ..spec.clone()
        };
        let provider = FailsAfter::new(vec![resp("Report: a.rs is an empty main.", vec![], LlmStopReason::EndTurn)], 1);
        let done = run_subagent_core(&provider, "http://x", None, &reqwest::Client::new(), "m", &more, &cancel, &rec, None, None)
            .await
            .unwrap();
        assert!(done.ok && done.continued, "{}", done.report);
        let sent = provider.seen.lock()[0].clone();
        assert!(sent.len() >= 5, "the saved rounds were sent again: {sent:?}");

        // A failure before any round completes has nothing to continue.
        let provider = FailsAfter::new(vec![], 1);
        let none = run_subagent_core(&provider, "http://x", None, &reqwest::Client::new(), "m", &spec, &cancel, &rec, None, None)
            .await
            .unwrap();
        assert!(!none.ok && none.errored && none.transcript.is_empty());
        assert_eq!(none.input_tokens + none.output_tokens, 0);
    }

    #[tokio::test]
    #[serial_test::serial(pricing_catalog)]
    async fn subagent_spend_limit_closes_run() {
        let _cfg = crate::provider_router::TestConfigDir::new();
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.rs"), "fn main() {}\n").unwrap();
        let model = "claude-opus-5-5";
        let round = crate::token_engine::request_cost_for(model, 10_000, 5, 0, 0);
        assert!(round > 0.0, "the model is priced");
        // A sub-agent that would read forever: every turn calls a tool.
        let looping = || FailsAfter::new((0..10).map(|i| read_turn(&format!("t{i}"), 10_000)).collect(), 10);

        // Its share of the headroom is 1.5 rounds: round 2 crosses it, its
        // tools are voided and the close answers.
        let spec = SubagentSpec { spend_limit: Some(round * 1.5), ..core_spec(dir.path()) };
        let provider = looping();
        let rec = Recorder { entries: Mutex::new(vec![]) };
        let cancel = Arc::new(AtomicBool::new(false));
        let out = run_subagent_core(&provider, "http://x", None, &reqwest::Client::new(), model, &spec, &cancel, &rec, None, None)
            .await
            .unwrap();
        assert_eq!(provider.calls.load(Ordering::Relaxed), 3, "two rounds and the close");
        assert!(out.spend_stopped && out.finished && out.ok, "{}", out.report);
        assert!(out.report.contains("reached its spend limit"), "{}", out.report);
        assert_eq!(out.tool_calls, 1, "the second round's call was not run");
        assert!((out.cost_usd - round * 3.0).abs() < 1e-9, "every request is billed: {}", out.cost_usd);
        assert!(!ran_out_of_turns(&out), "more turns would not help: the money ran out");

        // A definition's `max-cost` caps it the same way when it is tighter.
        let mut capped = def("explorer", None, None);
        capped.max_cost = Some(round * 0.5);
        let spec = SubagentSpec { definition: Some(capped), spend_limit: Some(10.0), ..core_spec(dir.path()) };
        let provider = looping();
        let out = run_subagent_core(&provider, "http://x", None, &reqwest::Client::new(), model, &spec, &cancel, &rec, None, None)
            .await
            .unwrap();
        assert_eq!(provider.calls.load(Ordering::Relaxed), 2, "one round and the close");
        assert!(out.spend_stopped, "{}", out.report);
    }

    #[tokio::test]
    #[serial_test::serial(pricing_catalog)]
    async fn an_escalation_gets_only_what_is_left_of_the_spend_limit() {
        let _cfg = crate::provider_router::TestConfigDir::new();
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.rs"), "fn main() {}\n").unwrap();
        let model = "claude-opus-5-5";
        let round = crate::token_engine::request_cost_for(model, 10_000, 5, 0, 0);
        let tiers: HashMap<String, String> = [("strong".to_string(), "opus".to_string())].into_iter().collect();
        let mut implementer = def("implementer", None, None);
        implementer.escalate = Some("strong".into());
        let spec = SubagentSpec { definition: Some(implementer), spend_limit: Some(round * 1.5), ..core_spec(dir.path()) };
        let rec = Recorder { entries: Mutex::new(vec![]) };
        let cancel = Arc::new(AtomicBool::new(false));

        // A first attempt that reaches the limit and whose close is empty
        // fails, but does not escalate.
        let mut turns: Vec<LlmResponse> = (0..2).map(|i| read_turn(&format!("t{i}"), 10_000)).collect();
        turns.push(LlmResponse { input_tokens: 10_000, ..resp("", vec![], LlmStopReason::EndTurn) });
        let provider = FailsAfter::new(turns, 3);
        let stopped = run_subagent_core(&provider, "http://x", None, &reqwest::Client::new(), model, &spec, &cancel, &rec, None, None)
            .await
            .unwrap();
        assert!(stopped.spend_stopped && !stopped.ok, "{}", stopped.report);
        assert!(!should_escalate(&stopped), "a spend stop never escalates");
        assert!(!has_spend_left(&spec, stopped.cost_usd), "and nothing is left for one");

        // A first attempt that errored after one round escalates with the
        // other half round only.
        let provider = FailsAfter::new(vec![read_turn("t1", 10_000)], 2);
        let failed = run_subagent_core(&provider, "http://x", None, &reqwest::Client::new(), model, &spec, &cancel, &rec, None, None)
            .await
            .unwrap();
        assert!(failed.errored && should_escalate(&failed), "{}", failed.report);
        assert!((failed.cost_usd - round).abs() < 1e-9, "{}", failed.cost_usd);
        assert!(has_spend_left(&spec, failed.cost_usd));
        let retry = escalation_retry(&spec, &failed, model, "opus", &tiers);
        let left = retry.spend_limit.expect("the retry is limited");
        assert!((left - round * 0.5).abs() < 1e-9, "only what is left: {left}");
        assert_eq!(retry.plan.as_ref().map(|p| p.model.as_str()), Some("opus"));
        let provider = FailsAfter::new((0..10).map(|i| read_turn(&format!("r{i}"), 10_000)).collect(), 10);
        let second = run_subagent_core(&provider, "http://x", None, &reqwest::Client::new(), model, &retry, &cancel, &rec, None, None)
            .await
            .unwrap();
        assert_eq!(provider.calls.load(Ordering::Relaxed), 2, "one round crosses what is left, then the close");
        assert!(second.spend_stopped, "{}", second.report);

        // A definition's `max-cost` is a total for the run the same way.
        let mut capped = def("implementer", None, None);
        capped.max_cost = Some(1.0);
        let spec = SubagentSpec { definition: Some(capped), spend_limit: None, ..core_spec(dir.path()) };
        assert_eq!(spend_left(&spec, 0.25), Some(0.75));
        assert_eq!(spend_left(&spec, 2.0), Some(0.0), "never below zero");
        assert!(!has_spend_left(&spec, 1.0));
        let unbounded = core_spec(dir.path());
        assert_eq!(spend_left(&unbounded, 100.0), None);
        assert!(has_spend_left(&unbounded, 100.0), "no limit, nothing runs out");
    }

    #[test]
    fn a_spend_limit_is_the_tighter_of_the_share_and_the_definitions_cap() {
        assert_eq!(subagent_spend_limit(None, None), None, "no budget, no cap: unbounded");
        assert_eq!(subagent_spend_limit(Some(2.0), None), Some(2.0));
        assert_eq!(subagent_spend_limit(None, Some(0.5)), Some(0.5));
        assert_eq!(subagent_spend_limit(Some(2.0), Some(0.5)), Some(0.5));
        assert_eq!(subagent_spend_limit(Some(0.25), Some(0.5)), Some(0.25));
        assert_eq!(budget_share(None, 3), None);
        assert_eq!(budget_share(Some(3.0), 3), Some(1.0), "the headroom is split across the fan-out");
        assert_eq!(budget_share(Some(-1.0), 2), Some(0.0), "a spent budget leaves nothing");
        assert_eq!(budget_share(Some(1.0), 0), Some(1.0));
    }

    #[tokio::test]
    async fn stopped_subagent_reads_as_stopped_and_keeps_its_transcript() {
        // Stop landed before the sub-agent's next round (#1148).
        let dir = tempfile::tempdir().unwrap();
        let provider = ScriptedProvider { turns: Mutex::new(VecDeque::new()) };
        let spec = SubagentSpec {
            call_id: "call-7".into(),
            call: parse_agent_call(&serde_json::json!({"description": "Explore", "prompt": "Map the crate."})).unwrap(),
            workspace_id: "ws".into(),
            thread_id: "th".into(),
            workspace_path: dir.path().to_string_lossy().into_owned(),
            default_model: "m".into(),
            max_iterations: None,
            max_tokens: 4096,
            sandbox_roots: None,
            definition: None,
            policy_auto: false,
            resume: None,
            plan: None,
            spend_limit: None,
        };
        let rec = Recorder { entries: Mutex::new(vec![]) };
        let cancel = Arc::new(AtomicBool::new(true));
        let mut out = run_subagent_core(&provider, "http://x", None, &reqwest::Client::new(), "m", &spec, &cancel, &rec, None, None)
            .await
            .unwrap();
        assert!(!out.finished && !out.blocked);
        assert!(!out.transcript.is_empty(), "a stopped run leaves a transcript to continue from");
        assert!(was_stopped(&out, true));
        mark_stopped(&mut out);
        assert!(out.stopped && !out.ok);
        assert!(out.report.starts_with("Sub-agent stopped: the user stopped the turn after 0 tool calls"), "{}", out.report);
        assert!(!out.report.contains("turn limit"), "it never hit one");
        let meta = serde_json::to_value(&out).unwrap();
        assert_eq!(meta["stopped"], true);

        // A run that reported, or stopped on a question, before Stop keeps
        // its ending; without Stop nothing is marked.
        let finished = AgentOutcome { ok: true, finished: true, ..AgentOutcome::default() };
        assert!(!was_stopped(&finished, true));
        assert!(!was_stopped(&AgentOutcome { blocked: true, ..AgentOutcome::default() }, true));
        assert!(!was_stopped(&AgentOutcome::default(), false));
        let mut one = AgentOutcome { tool_calls: 1, ..AgentOutcome::default() };
        mark_stopped(&mut one);
        assert!(one.report.contains("after 1 tool call,"), "{}", one.report);
    }

    /// A sub-agent's `run_command` gets the PATH CLI stages spawn with (#1087).
    /// Its commands run on a blocking thread, which the login-env stub doesn't
    /// reach, so this compares with the real login shell's.
    #[test]
    #[serial_test::serial]
    fn a_subagent_command_gets_the_login_path() {
        let dir = tempfile::tempdir().unwrap();
        let provider = ScriptedProvider {
            turns: Mutex::new(VecDeque::from(vec![
                resp(
                    "checking the PATH",
                    vec![LlmToolUse {
                        id: "t1".into(),
                        name: "run_command".into(),
                        input: serde_json::json!({"command": "printf '%s' \"$PATH\" > path.txt"}),
                    }],
                    LlmStopReason::ToolUse,
                ),
                resp("Report: wrote path.txt.", vec![], LlmStopReason::EndTurn),
            ])),
        };
        let spec = SubagentSpec {
            call_id: "c".into(),
            call: AgentCall { description: "PATH".into(), prompt: "Write the PATH.".into(), subagent_type: None, model: None },
            workspace_id: "w".into(), thread_id: "t".into(),
            workspace_path: dir.path().to_string_lossy().into_owned(),
            default_model: "m".into(), max_iterations: Some(5), max_tokens: 1, sandbox_roots: None, definition: None,
            policy_auto: false,
            resume: None,
            plan: None,
            spend_limit: None,
        };
        let rec = Recorder { entries: Mutex::new(vec![]) };
        let client = reqwest::Client::new();
        let cancel = Arc::new(AtomicBool::new(false));
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let out = rt
            .block_on(run_subagent_core(&provider, "http://x", None, &client, "m", &spec, &cancel, &rec, None, None))
            .unwrap();
        assert!(out.ok && out.finished, "{}", out.report);
        let seen = std::fs::read_to_string(dir.path().join("path.txt")).unwrap();
        assert_eq!(seen, crate::orchestrator::cli_runner::resolved_cli_path());
    }

    /// A provider that records each request's tools and messages as sent.
    struct Capturing {
        inner: ScriptedProvider,
        sent: Mutex<Vec<(String, String)>>,
    }
    #[async_trait::async_trait]
    impl LlmProvider for Capturing {
        async fn complete(&self, b: &str, k: Option<&str>, req: &LlmRequest, c: &reqwest::Client) -> AppResult<LlmResponse> {
            let json = |v: serde_json::Result<String>| v.unwrap_or_default();
            self.sent.lock().push((json(serde_json::to_string(&req.tools)), json(serde_json::to_string(&req.messages))));
            self.inner.complete(b, k, req, c).await
        }
    }

    fn capturing(turns: Vec<LlmResponse>) -> Capturing {
        Capturing { inner: ScriptedProvider { turns: Mutex::new(VecDeque::from(turns)) }, sent: Mutex::new(vec![]) }
    }

    fn call(id: &str, name: &str, input: serde_json::Value) -> LlmToolUse {
        LlmToolUse { id: id.into(), name: name.into(), input }
    }

    /// A database with one conversation in `mode`, and an untyped sub-agent
    /// of it working in `dir`.
    fn mode_thread(mode: crate::permissions::Mode, dir: &Path) -> (tempfile::NamedTempFile, Arc<Mutex<Db>>, SubagentSpec) {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let db = Db::open(tmp.path()).unwrap();
        db.insert_project("p-mode", "P", "/tmp/octo-mode-project").unwrap();
        db.insert_workspace("w-mode", "p-mode", "ws", "", "main", None, "", None).unwrap();
        let thread = db.create_chat_thread("w-mode", "Plan it").unwrap().id;
        db.set_thread_permission_mode(&thread, mode).unwrap();
        let spec = SubagentSpec {
            call_id: "c".into(),
            call: AgentCall { description: "Look".into(), prompt: "look".into(), subagent_type: None, model: None },
            workspace_id: "w-mode".into(),
            thread_id: thread,
            workspace_path: dir.to_string_lossy().into_owned(),
            default_model: "m".into(), max_iterations: Some(5), max_tokens: 1, sandbox_roots: None, definition: None,
            policy_auto: false,
            resume: None,
            plan: None,
            spend_limit: None,
        };
        (tmp, Arc::new(Mutex::new(db)), spec)
    }

    fn mcp_info(server: &str, name: &str, read_only: bool) -> crate::mcp::McpToolInfo {
        crate::mcp::McpToolInfo {
            server: server.into(),
            name: name.into(),
            namespaced: format!("mcp__{server}__{name}"),
            description: String::new(),
            input_schema: serde_json::json!({"type": "object"}),
            read_only,
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn subagent_inherits_mode() {
        use crate::permissions::{plan_refusal, Mode, Refused};
        let plan_write = plan_refusal(Refused::Write, false);
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("seed.txt"), "seed").unwrap();
        let (_tmp, db, base) = mode_thread(Mode::Plan, dir.path());
        // The run is narrowed as it starts: its commands go on the read-only sandbox.
        let spec = mode_spec(&db, &base);
        assert_eq!(spec.sandbox_roots, Some(vec![]));
        let gate = mode_gate(&db, &spec, base.sandbox_roots.as_deref(), &[], None);
        let provider = capturing(vec![
            resp("", vec![
                call("t1", "write_file", serde_json::json!({"path": "plan.md", "content": "x"})),
                call("t2", "edit_file", serde_json::json!({"path": "seed.txt", "old_string": "seed", "new_string": "gone"})),
                call("t3", "read_file", serde_json::json!({"path": "seed.txt"})),
            ], LlmStopReason::ToolUse),
            resp("Report: planned.", vec![], LlmStopReason::EndTurn),
        ]);
        let rec = Recorder { entries: Mutex::new(vec![]) };
        let out = run_subagent_core(&provider, "http://x", None, &reqwest::Client::new(), "m", &spec,
            &Arc::new(AtomicBool::new(false)), &rec, Some(&gate), None).await.unwrap();
        assert!(out.ok, "{}", out.report);
        assert!(!dir.path().join("plan.md").exists(), "nothing was written");
        assert_eq!(std::fs::read_to_string(dir.path().join("seed.txt")).unwrap(), "seed", "nothing was edited");
        // Both writes got the mode's fixed result, and the read ran.
        let sent = provider.sent.lock().clone();
        let results = &sent[1].1;
        assert_eq!(results.matches(plan_write.as_str()).count(), 2, "{results}");
        assert!(results.contains("seed"), "{results}");
        // The gate reads the thread's mode at each call; a run that started
        // in Edit freely is not narrowed.
        db.lock().set_thread_permission_mode(&base.thread_id, Mode::Edit).unwrap();
        let edit = mode_spec(&db, &base);
        assert_eq!(edit.sandbox_roots, None);
        let gate = mode_gate(&db, &edit, base.sandbox_roots.as_deref(), &[], None);
        assert_eq!(gate.check("write_file", &serde_json::json!({"path": "a"})).await, None);
        db.lock().set_thread_permission_mode(&base.thread_id, Mode::Plan).unwrap();
        assert_eq!(gate.check("write_file", &serde_json::json!({"path": "a"})).await, Some(plan_write));
    }

    #[tokio::test]
    async fn plan_mode_denies_unhinted_mcp() {
        use crate::permissions::{plan_refusal, Mode, Refused};
        let plan_net = plan_refusal(Refused::Net, false);
        let dir = tempfile::tempdir().unwrap();
        let (_tmp, db, base) = mode_thread(Mode::Plan, dir.path());
        let discovered = vec![mcp_info("jira", "get_issue", true), mcp_info("jira", "add_comment", false)];
        let mcp = FakeMcp { tools: discovered.iter().map(mcp_llm_tool).collect(), calls: Mutex::new(vec![]) };
        let spec = mode_spec(&db, &base);
        let gate = mode_gate(&db, &spec, base.sandbox_roots.as_deref(), &discovered, None);
        let provider = capturing(vec![
            resp("", vec![
                call("t1", "mcp__jira__add_comment", serde_json::json!({"body": "hi"})),
                call("t2", "mcp__jira__get_issue", serde_json::json!({"key": "PROJ-1"})),
            ], LlmStopReason::ToolUse),
            resp("done", vec![], LlmStopReason::EndTurn),
        ]);
        let rec = Recorder { entries: Mutex::new(vec![]) };
        let out = run_subagent_core(&provider, "http://x", None, &reqwest::Client::new(), "m", &spec,
            &Arc::new(AtomicBool::new(false)), &rec, Some(&gate), Some(&mcp)).await.unwrap();
        assert!(out.ok);
        let calls: Vec<String> = mcp.calls.lock().iter().map(|c| c.0.clone()).collect();
        assert_eq!(calls, vec!["mcp__jira__get_issue".to_string()], "the unhinted tool never reached its server");
        assert!(provider.sent.lock()[1].1.contains(plan_net.as_str()));
        // An MCP name nobody discovered is refused too.
        assert_eq!(gate.check("mcp__other__delete", &serde_json::json!({})).await, Some(plan_net));
    }

    /// Stands in for the approval card: records the MCP calls `SubagentMcp`
    /// would ask about, and denies them.
    struct AskRecorder {
        mcp: SubagentMcp,
        asked: Arc<Mutex<Vec<String>>>,
    }
    #[async_trait::async_trait]
    impl ToolGate for AskRecorder {
        async fn check(&self, name: &str, input: &serde_json::Value) -> Option<String> {
            let card = self.mcp.contains(name).then(|| self.mcp.card(None, name, input)).flatten()?;
            self.asked.lock().push(name.to_string());
            Some(format!("asked: {}", card.reason))
        }
    }

    #[tokio::test]
    async fn a_subagent_follows_the_users_trust_and_the_threads_mode() {
        use crate::mcp::trust::{fingerprint, McpTrust, TrustView};
        use crate::permissions::Mode;
        let dir = tempfile::tempdir().unwrap();
        let (_tmp, db, base) = mode_thread(Mode::Edit, dir.path());
        let hinted = |name: &str, destructive: Option<bool>| crate::mcp::McpToolInfo {
            destructive,
            annotated: destructive.is_some(),
            ..mcp_info("s", name, false)
        };
        let discovered = vec![hinted("get_x", None), hinted("post_x", None), hinted("delete_x", None), hinted("wipe_x", Some(true))];
        let users: HashMap<String, crate::mcp::McpServerConfig> =
            [("s".to_string(), crate::mcp::McpServerConfig { command: "s-cmd".into(), ..Default::default() })].into();
        // The user trusts the whole server; the switch stands in for a revoke.
        let trusted = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let source = {
            let (trusted, users) = (Arc::clone(&trusted), users.clone());
            Arc::new(move || {
                let entry = McpTrust { server: "s".into(), config: fingerprint(&users["s"]), all: true, tools: vec![] };
                let entries = if trusted.load(Ordering::Relaxed) { vec![entry] } else { vec![] };
                TrustView::from_configs(entries, &users, &HashMap::new())
            })
        };
        let spec = mode_spec(&db, &base);
        let mode = crate::permissions::thread_mode_source(Arc::clone(&db), spec.thread_id.clone(), spec.sandbox_roots.clone());
        let asked = Arc::new(Mutex::new(Vec::new()));
        let recorder = AskRecorder { mcp: SubagentMcp::new(&discovered, mode, source), asked: Arc::clone(&asked) };
        let gate = mode_gate(&db, &spec, base.sandbox_roots.as_deref(), &discovered, Some(Box::new(recorder)));
        let mcp = FakeMcp { tools: discovered.iter().map(mcp_llm_tool).collect(), calls: Mutex::new(vec![]) };
        let input = serde_json::json!({});
        let provider = capturing(vec![
            resp("", vec![
                call("t1", "mcp__s__get_x", input.clone()),
                call("t2", "mcp__s__post_x", input.clone()),
                call("t3", "mcp__s__wipe_x", input.clone()),
            ], LlmStopReason::ToolUse),
            resp("done", vec![], LlmStopReason::EndTurn),
        ]);
        let rec = Recorder { entries: Mutex::new(vec![]) };
        let out = run_subagent_core(&provider, "http://x", None, &reqwest::Client::new(), "m", &spec,
            &Arc::new(AtomicBool::new(false)), &rec, Some(&gate), Some(&mcp)).await.unwrap();
        assert!(out.ok, "{}", out.report);
        // Edit freely: the read and the trusted write reach the server; the
        // tool its server marks destructive asks although the server is trusted.
        let calls: Vec<String> = mcp.calls.lock().iter().map(|c| c.0.clone()).collect();
        assert_eq!(calls, vec!["mcp__s__get_x".to_string(), "mcp__s__post_x".to_string()]);
        assert_eq!(asked.lock().clone(), vec!["mcp__s__wipe_x".to_string()]);
        // Revoked: the next write asks at once; the read still runs.
        trusted.store(false, Ordering::Relaxed);
        assert!(gate.check("mcp__s__post_x", &input).await.is_some_and(|d| d.starts_with("asked")));
        assert_eq!(gate.check("mcp__s__get_x", &input).await, None);
        // Plan only, read at the call: trust or not, the unhinted tools are refused.
        trusted.store(true, Ordering::Relaxed);
        db.lock().set_thread_permission_mode(&base.thread_id, Mode::Plan).unwrap();
        let plan_net = crate::permissions::plan_refusal(crate::permissions::Refused::Net, false);
        for name in ["mcp__s__get_x", "mcp__s__post_x"] {
            assert_eq!(gate.check(name, &input).await, Some(plan_net.clone()), "{name}");
        }
    }

    #[tokio::test]
    async fn tool_list_identical_across_modes() {
        use crate::permissions::Mode;
        let mut lists: Vec<String> = Vec::new();
        for mode in [Mode::Plan, Mode::Edit] {
            let dir = tempfile::tempdir().unwrap();
            std::fs::write(dir.path().join("a.txt"), "a").unwrap();
            let (_tmp, db, base) = mode_thread(mode, dir.path());
            let discovered = vec![mcp_info("jira", "get_issue", true), mcp_info("jira", "add_comment", false)];
            let mcp = FakeMcp { tools: discovered.iter().map(mcp_llm_tool).collect(), calls: Mutex::new(vec![]) };
            let spec = mode_spec(&db, &base);
            let gate = mode_gate(&db, &spec, base.sandbox_roots.as_deref(), &discovered, None);
            let provider = capturing(vec![
                resp("", vec![call("t1", "write_file", serde_json::json!({"path": "b.txt", "content": "b"}))], LlmStopReason::ToolUse),
                resp("done", vec![], LlmStopReason::EndTurn),
            ]);
            let rec = Recorder { entries: Mutex::new(vec![]) };
            run_subagent_core(&provider, "http://x", None, &reqwest::Client::new(), "m", &spec,
                &Arc::new(AtomicBool::new(false)), &rec, Some(&gate), Some(&mcp)).await.unwrap();
            assert_eq!(dir.path().join("b.txt").exists(), mode == Mode::Edit, "{mode:?}");
            lists.extend(provider.sent.lock().iter().map(|(tools, _)| tools.clone()));
        }
        assert_eq!(lists.len(), 4);
        assert!(lists.iter().all(|l| l == &lists[0]), "the tools sent differ between modes");
        assert!(lists[0].contains("write_file") && lists[0].contains("mcp__jira__add_comment"), "every tool is still offered");
    }

    /// Plan only starts an untyped `Agent` call again; its sub-agent gets the
    /// full tool set, bound by the mode and the read-only sandbox. Forced by
    /// a read-only mission, its refusals name the mission.
    #[tokio::test]
    async fn an_untyped_agent_in_plan_only_cannot_write() {
        use crate::permissions::{decide, plan_refusal, Decision, Mode, PolicyCtx, Refused, ToolCall};
        let (none, sandboxed): (std::collections::HashSet<String>, &[String]) = (Default::default(), &[]);
        assert!(!delegate_writes(None) && delegate_writes(Some(&def("implementer", Some(vec!["edit_file"]), None))));
        assert!(!delegate_writes(Some(&def("explorer", Some(vec!["read_file", "grep"]), None))));
        let ctx = PolicyCtx { exec_roots: Some(sandboxed), mcp_read_only: &none, delegate_writes: delegate_writes(None), forced: false, ships_nothing: false };
        let untyped = serde_json::json!({"prompt": "look around"});
        assert_eq!(decide(Mode::Plan, &ToolCall { name: "Agent", input: &untyped }, &ctx), Decision::Allow);

        let script = || {
            capturing(vec![
                resp("", vec![
                    call("t1", "write_file", serde_json::json!({"path": "plan.md", "content": "x"})),
                    call("t2", "edit_file", serde_json::json!({"path": "seed.txt", "old_string": "seed", "new_string": "gone"})),
                    call("t3", "run_command", serde_json::json!({"command": "echo x > cmd.txt"})),
                    call("t4", "run_command", serde_json::json!({"command": "git push origin main"})),
                ], LlmStopReason::ToolUse),
                resp("Report: looked.", vec![], LlmStopReason::EndTurn),
            ])
        };
        // Chosen by the conversation, and forced by a read-only mission on a
        // conversation left in Edit freely.
        for (mode, mission, forced) in [(Mode::Plan, None, false), (Mode::Edit, Some(vec![]), true)] {
            // Outside `$TMPDIR`, which the read-only profile keeps writable.
            let caches = dirs::cache_dir().unwrap();
            std::fs::create_dir_all(&caches).unwrap();
            let dir = tempfile::Builder::new().prefix("octopush-plan-agent-").tempdir_in(&caches).unwrap();
            std::fs::write(dir.path().join("seed.txt"), "seed").unwrap();
            let (_tmp, db, mut base) = mode_thread(mode, dir.path());
            base.sandbox_roots = mission;
            let spec = mode_spec(&db, &base);
            assert_eq!(spec.sandbox_roots, Some(vec![]), "its commands run on the read-only sandbox");
            let gate = mode_gate(&db, &spec, base.sandbox_roots.as_deref(), &[], None);
            let provider = script();
            let rec = Recorder { entries: Mutex::new(vec![]) };
            let out = run_subagent_core(&provider, "http://x", None, &reqwest::Client::new(), "m", &spec,
                &Arc::new(AtomicBool::new(false)), &rec, Some(&gate), None).await.unwrap();
            assert!(out.ok, "{}", out.report);
            for f in ["plan.md", "cmd.txt"] {
                assert!(!dir.path().join(f).exists(), "{f} was written ({mode:?})");
            }
            assert_eq!(std::fs::read_to_string(dir.path().join("seed.txt")).unwrap(), "seed");
            let results = provider.sent.lock()[1].1.clone();
            assert_eq!(results.matches(plan_refusal(Refused::Write, forced).as_str()).count(), 2, "{results}");
            assert!(results.contains(plan_refusal(Refused::Remote("git push"), forced).as_str()), "{results}");
            assert_eq!(results.contains("mission is read-only"), forced, "{results}");
            assert_eq!(results.contains("Edit freely"), !forced, "{results}");
        }
    }
}
