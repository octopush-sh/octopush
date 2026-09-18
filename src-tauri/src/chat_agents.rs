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
use crate::orchestrator::agentic::{run_agentic_loop, user_messages, AgenticResult, ToolGate};
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
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cost_usd: f64,
    pub duration_ms: u64,
    pub tool_calls: usize,
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
        if let Some(resolved) = resolve_model_with_tiers(wanted, known_models, tiers) {
            return resolved.to_string();
        }
        tracing::warn!(
            origin,
            model = wanted,
            "sub-agent model matches no configured model or tier; inheriting the conversation's"
        );
    }
    spec.default_model.clone()
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
            seq: AtomicU64::new(1),
        }
    }
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
        if name != "run_command" {
            return None;
        }
        let command = input.get("command").and_then(|c| c.as_str()).unwrap_or("");
        let reason = dangerous_command(command)?;
        let (card_reason, denial) = gate_texts(&self.label, reason);
        let id = format!("{}:{}", self.call_id, self.seq.fetch_add(1, Ordering::Relaxed));
        match self
            .broker
            .await_approval(&self.app, &self.workspace_id, &self.thread_id, &id, command, &card_reason)
            .await
        {
            ApprovalDecision::Approve | ApprovalDecision::ApproveAlways => None,
            ApprovalDecision::Deny => Some(denial),
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
    specs: Vec<SubagentSpec>,
    cancel: Arc<AtomicBool>,
) -> HashMap<String, AgentOutcome> {
    let gate = Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_AGENTS));
    let mut set = tokio::task::JoinSet::new();
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
        set.spawn(async move {
            let _permit = gate.acquire_owned().await;
            let started = std::time::Instant::now();
            let model = pick_subagent_model(&spec, &known_models, &tiers);
            let approval_gate = SubagentGate::new(approvals, app.clone(), &spec);
            let sink = ChatAgentSink {
                app,
                db,
                workspace_id: spec.workspace_id.clone(),
                thread_id: spec.thread_id.clone(),
                call_id: spec.call_id.clone(),
            };
            let outcome = match crate::chat_engine::resolve_provider(&model) {
                Ok((provider, api_base, api_key)) => {
                    match run_subagent_core(
                        provider.as_ref(),
                        &api_base,
                        api_key.as_deref(),
                        &client,
                        &model,
                        &spec,
                        &cancel,
                        &sink,
                        Some(&approval_gate),
                    )
                    .await
                    {
                        Ok(o) => o,
                        Err(e) => failed_outcome(&model, started, format!("Sub-agent failed: {e}")),
                    }
                }
                Err(e) => failed_outcome(&model, started, format!("Sub-agent could not start: {e}")),
            };
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
            model: model.map(String::from),
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
        };
        let rec = Recorder { entries: Mutex::new(vec![]) };
        let out = run_subagent_core(&provider, "http://x", None, &reqwest::Client::new(), "m", &spec,
            &Arc::new(AtomicBool::new(false)), &rec, None).await.unwrap();
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
        };
        let gate = DenyRuns { seen: Mutex::new(vec![]) };
        let rec = Recorder { entries: Mutex::new(vec![]) };
        let out = run_subagent_core(&provider, "http://x", None, &reqwest::Client::new(), "m", &spec,
            &Arc::new(AtomicBool::new(false)), &rec, Some(&gate)).await.unwrap();
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
        };
        let rec = Recorder { entries: Mutex::new(vec![]) };
        let client = reqwest::Client::new();
        let cancel = Arc::new(AtomicBool::new(false));
        let out = run_subagent_core(&provider, "http://x", None, &client, "m", &spec, &cancel, &rec, None)
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
