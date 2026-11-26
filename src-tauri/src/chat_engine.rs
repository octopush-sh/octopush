//! Agentic chat engine — tool-use loop dispatched via the `LlmProvider` trait.
//!
//! The engine defines tools (run_command, read_file, write_file, list_files)
//! and runs an agentic loop: send messages → provider responds with tool_use →
//! execute tool → send result back → repeat until provider gives a final text answer.
//! The loop is provider-agnostic: AnthropicProvider or OpenAICompatibleProvider
//! is selected at runtime via `resolve_provider()`.

use crate::chat_agents::{
    agent_tool_definitions, director_doctrine, director_model_for_auto, is_agent_tool, parse_agent_call,
    run_subagents, unmapped_subagent_tiers, AgentOutcome, AUTO_MODEL,
    SubagentSpec, SubagentPlan, plan_subagent, run_one_subagent, discover_thread_mcp_tools, model_catalog, mcp_turnstiles,
    mcp_off_refusal, thread_mcp_off,
};
use crate::chat_history::{
    build_history, effective_subagent_max_iterations, effective_talk_max_iterations, subagent_iterations, window_text, HistoryRole, HistoryRow,
};
use crate::context::budget;
use crate::db::Db;
use crate::error::{AppError, AppResult, ProviderErrorKind};
use crate::providers::{
    anthropic::AnthropicProvider,
    complete_cancellable, final_failure_text, interruptible_sleep,
    openai_compat::OpenAICompatibleProvider,
    retry_notice, Completion, Effort, LlmBlock, LlmContent, LlmMessage, LlmProvider, LlmRequest, LlmResponse,
    LlmRole, LlmStopReason, LlmTool, LlmToolResult, DEFAULT_MAX_RETRIES,
};
use crate::provider_router::ProviderRouter;
use crate::orchestrator::agentic::{
    compute_throttle, resume_messages_for_answered_block, resume_messages_for_continuation, throttle_notice, BlockedTranscript,
};
use crate::token_engine;
use parking_lot::Mutex;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use chrono;

/// TALK-only tool that pulls a stored tool output back into context. Earlier
/// turns' tool results are re-sent abridged (see `chat_history`); this is the
/// model's way to read the omitted part instead of re-running the tool.
const RECALL_TOOL_NAME: &str = "recall_tool_output";
/// Chars a single `recall_tool_output` call returns when no `limit` is given.
const RECALL_DEFAULT_LIMIT: usize = 40_000;
/// Hard ceiling on one `recall_tool_output` window.
const RECALL_MAX_LIMIT: usize = 100_000;

/// Talk's system prompt when the request brings none.
fn default_talk_system_prompt(workspace_path: &str) -> String {
    format!(
        "You are a helpful coding assistant working in the project at {workspace_path}. \
         You have tools to run commands, read/write files, and list directories. \
         run_command executes in a persistent shell SHARED with the user — a \
         `cd` or env export (yours or theirs) carries over to later commands. It \
         is NON-interactive: don't run REPLs or commands that wait for stdin \
         (pass input via flags or a heredoc instead). read_file/write_file/\
         list_files paths are ALWAYS relative to the project root, regardless of \
         the shell's current directory — pass a path relative to the root. Tool \
         outputs from earlier turns appear abridged as `[Tool #id: …]`; when you \
         need an omitted part, call recall_tool_output with that id rather than \
         re-running the tool. You can delegate independent, self-contained tasks \
         to sub-agents with the Agent tool — call it several times in ONE response \
         to run them in parallel; when a skill asks for parallel sub-agents, use \
         Agent, never emulate them one after another yourself. Your `mcp__` tools \
         come from MCP servers that Octopush runs and the user manages in Settings › \
         Integrations (where one can be reconnected), so never point the user to \
         Claude Code's `/mcp` or `claude mcp` commands for them. Use the tools to \
         help the user; be concise and take action rather than just explaining \
         what to do."
    )
}

/// The director's system prompt before any per-turn addition: the request's
/// own prompt (or Talk's), then the project's instructions
/// (`project_instructions`), then the Auto doctrine. None of the three
/// changes from one turn to the next, so the cached system block holds; an
/// invoked skill is appended after them, for its turn only.
pub(crate) fn director_system_prompt(
    system: Option<String>,
    workspace_path: &str,
    instructions: &str,
    doctrine: Option<&str>,
) -> String {
    let mut prompt = system.unwrap_or_else(|| default_talk_system_prompt(workspace_path));
    prompt.push_str(instructions);
    if let Some(doctrine) = doctrine {
        prompt.push_str(doctrine);
    }
    prompt
}

/// One request of a Talk turn: every round and the forced close carry the
/// same model, output cap and reasoning effort (`ChatRequest::effort`), so
/// the thinking config holds across the turn's tool loop (Anthropic requires
/// one per loop) and the cached prefix with it.
fn director_request(request: &ChatRequest, system: &str, messages: &[LlmMessage], tools: &[LlmTool]) -> LlmRequest {
    LlmRequest {
        model: request.model.clone(),
        // Honor the caller's requested budget (the EffortSelector sets it)
        // with a sane floor; the old code force-clamped to 32768, silently
        // ignoring the request.
        // FOLLOW-UP: some providers cap output below the Deep preset (e.g.
        // gpt-4o at 16384) and will 400 on a larger value. A proper per-model
        // ceiling needs a `max_output_tokens` field on ModelInfo; until then
        // the budget is forwarded as-is (this was already the case
        // pre-change, which force-sent 32768).
        max_tokens: request.max_tokens.max(4096),
        system: system.to_string(),
        messages: messages.to_vec(),
        tools: tools.to_vec(),
        tool_choice: None,
        // Swift's `low` runs as `Effort::Least`, so it never reasons more than
        // Standard on any model; Standard sends nothing; Deep's `max` is
        // clamped per model. A model without effort control gets nothing.
        effort: request.effort.map(|e| if e == Effort::Low { Effort::Least } else { e }),
        // Agentic loop + multi-turn chat: the system prompt, tool schemas and
        // prior turns are re-sent every iteration, so cache them.
        cache: true,
    }
}

/// What the forced close tells the model once a configured tool-turn limit
/// is spent.
const CLOSE_INSTRUCTION: &str = "Your tool budget for this turn is exhausted — you cannot call any more tools. \
     Write your final answer NOW with what you already know: what you found or \
     accomplished, what remains undone, and what the user should do next. If you \
     were reviewing, state your findings so far.";

/// The forced close's one more request: [`CLOSE_INSTRUCTION`] appended to the
/// last tool result (the loop always ends right after pushing tool results,
/// and a separate consecutive user turn breaks role alternation on strict
/// providers), with the turn's own settings, its effort included. The tool
/// list rides along unchanged: a history with tool_use blocks and an empty
/// `tools` array is a hard 400 on Anthropic, and keeping it preserves the
/// prompt-cache prefix.
fn forced_close_request(
    request: &ChatRequest,
    system: &str,
    messages: &mut Vec<LlmMessage>,
    tools: &[LlmTool],
) -> LlmRequest {
    match messages.last_mut() {
        Some(LlmMessage { content: LlmContent::ToolResults(results), .. }) if !results.is_empty() => {
            if let Some(last) = results.last_mut() {
                last.content.push_str("\n\n[system] ");
                last.content.push_str(CLOSE_INSTRUCTION);
            }
        }
        _ => messages.push(LlmMessage {
            role: LlmRole::User,
            content: LlmContent::Text(CLOSE_INSTRUCTION.to_string()),
        }),
    }
    director_request(request, system, messages, tools)
}

/// The assistant turn a tool round leaves in the loop: the response's content
/// blocks verbatim (as `run_agentic_loop` does), so a thinking block the
/// round produced is replayed signed and in order on the next round, which
/// the API requires while thinking is on.
fn tool_round_turn(response: &LlmResponse) -> LlmMessage {
    LlmMessage {
        role: LlmRole::Assistant,
        content: LlmContent::AssistantWithTools {
            raw: response.raw_content.clone(),
            text: response.text.clone(),
            tool_uses: response.tool_uses.clone(),
        },
    }
}

/// The leading complete thinking blocks of a response's content: signed
/// `thinking` and `redacted_thinking` blocks, up to the first other block.
/// Empty for an OpenAI Responses turn or a response without thinking.
fn leading_signed_thinking(raw: &[serde_json::Value]) -> Vec<serde_json::Value> {
    if crate::providers::openai_compat::is_responses_raw(raw) {
        return Vec::new();
    }
    let nonempty = |v: &serde_json::Value| v.as_str().is_some_and(|s| !s.is_empty());
    raw.iter()
        .take_while(|b| match b["type"].as_str() {
            Some("thinking") => nonempty(&b["signature"]),
            Some("redacted_thinking") => nonempty(&b["data"]),
            _ => false,
        })
        .cloned()
        .collect()
}

/// The assistant turn of a round cut off at `max_tokens` mid-tool-use. It is
/// rebuilt from its text and tool calls, since a cut-off turn can end in a
/// partial block, but its leading signed thinking blocks are kept in front:
/// with a thinking budget on, the API rejects a final assistant turn that
/// doesn't start with one.
fn truncated_round_turn(response: &LlmResponse) -> LlmMessage {
    let mut raw = leading_signed_thinking(&response.raw_content);
    if !raw.is_empty() {
        if !response.text.is_empty() {
            raw.push(serde_json::json!({ "type": "text", "text": response.text }));
        }
        for u in &response.tool_uses {
            raw.push(serde_json::json!({ "type": "tool_use", "id": u.id, "name": u.name, "input": u.input }));
        }
    }
    LlmMessage {
        role: LlmRole::Assistant,
        content: LlmContent::AssistantWithTools {
            raw,
            text: response.text.clone(),
            tool_uses: response.tool_uses.clone(),
        },
    }
}

fn recall_tool_definition() -> LlmTool {
    LlmTool {
        name: RECALL_TOOL_NAME.to_string(),
        description: "Fetch the full stored output of an earlier tool call in this \
             conversation. Tool results from previous turns appear abridged in your \
             context as `[Tool #<message_id>: …]`; when one says chars were omitted \
             and you need that part, call this with its message_id instead of \
             re-running the tool. Pass offset/limit (in characters) to page through \
             a very long output. An `@` context block of an earlier user message \
             that says chars were omitted comes back the same way: its message_id \
             and block number."
            .to_string(),
        input_schema: serde_json::json!({
            "type": "object",
            "properties": {
                "message_id": {
                    "type": "integer",
                    "description": "The #id shown on the abridged tool summary"
                },
                "block": {
                    "type": "integer",
                    "description": "For an abridged @ context block: its block number"
                },
                "offset": {
                    "type": "integer",
                    "description": "Optional 0-based character offset to start from"
                },
                "limit": {
                    "type": "integer",
                    "description": "Optional maximum characters to return (default 40000, max 100000)"
                }
            },
            "required": ["message_id"]
        }),
    }
}

/// What an `Agent` call's card and persisted row show as the input: the
/// short description, the role hint and the model override — never the raw
/// multi-KB prompt (the model's own words, already in the assistant row).
fn agent_input_for_display(call: &crate::chat_agents::AgentCall, plan: Option<&SubagentPlan>) -> serde_json::Value {
    let mut v = serde_json::json!({
        "description": call.description,
        "promptChars": call.prompt.len(),
    });
    if let Some(t) = &call.subagent_type {
        v["subagentType"] = serde_json::json!(t);
    }
    match plan {
        // What the run USES — the resolved model id, its tier, the effort —
        // and, when the director asked for something else, that ask and
        // whether it was honored. The card reads these live.
        Some(p) => {
            v["model"] = serde_json::json!(p.model);
            if let Some(t) = &p.tier {
                v["tier"] = serde_json::json!(t);
            }
            if let Some(e) = p.effort {
                v["effort"] = serde_json::json!(e.as_str());
            }
            if let Some(a) = &p.asked_model {
                v["askedModel"] = serde_json::json!(a);
                v["askedHonored"] = serde_json::json!(p.asked_honored);
            }
        }
        None => {
            if let Some(m) = &call.model {
                v["model"] = serde_json::json!(m);
            }
        }
    }
    v
}

/// Decides whether `send_agentic`'s per-iteration budget gate should stop the
/// turn. Split out as a free function so the exact boundary is unit-tested
/// without a mock provider: iteration 0 is owned by the entry gate in
/// `send_chat_message` (never re-blocked here), a conscious per-turn override
/// bypasses the gate entirely, and only a `Block` verdict stops the loop.
pub(crate) fn should_stop_for_budget(
    iteration: usize,
    override_budget: bool,
    verdict: &crate::db::BudgetVerdict,
) -> bool {
    iteration > 0
        && !override_budget
        && matches!(verdict, crate::db::BudgetVerdict::Block { .. })
}

// ─── Public types ─────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChatMsg {
    pub role: String,
    pub content: serde_json::Value, // String for simple text, or array for tool results
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub workspace_id: String,
    pub thread_id: String, // The conversation this turn belongs to
    pub workspace_path: String, // The directory where tools execute
    pub model: String,
    pub user_message: String,
    pub system: Option<String>,
    pub max_tokens: u32,
    /// The reasoning effort of every request the turn makes. The composer's
    /// Swift sends `low`, which the turn runs as `Effort::Least`: the least
    /// the model takes, never more than Standard (effort lowered, thinking
    /// never turned on; `none` on GPT-6 Sol, Luna and 6.1 Terra). Standard
    /// sends none (`None`: no thinking params, so every model keeps its own
    /// default, as before presets set effort). Deep sends `max`, which the
    /// provider adapters (`anthropic::thinking_json`,
    /// `openai_compat::build_request`) turn into the most the model takes
    /// (`max`, `high`, or a thinking budget). A model without effort control
    /// gets nothing.
    #[serde(default)]
    pub effort: Option<Effort>,
    /// Legacy: a skill name pinned to the conversation. The composer no
    /// longer sends one — skills are invoked per message as `/name` tokens in
    /// the text, resolved against the worktree's skills when the turn runs.
    /// A pinned name is still honored as if the message had named it: its
    /// SKILL.md body joins the system prompt and its `allowed-tools` the
    /// turn's tool filter.
    #[serde(default)]
    pub skill: Option<String>,
    /// Inline image attachments for THIS turn (base64). Sent as multimodal
    /// content blocks alongside the user text. Not persisted in history.
    #[serde(default)]
    pub attachments: Vec<Attachment>,
    /// Regenerate: the prior turn was already truncated and history ends with the
    /// user message, so DON'T insert a new user row — just re-run the loop.
    #[serde(default)]
    pub regenerate: bool,
    /// Per-turn budget override: when true, the backend budget gate is skipped
    /// for this send (the user consciously chose "Override for this turn").
    #[serde(default)]
    pub override_budget: bool,
    /// Where the `@` context blocks sit in `user_message` (#1150), saved on
    /// the user row: the thread shows the ask as typed, and later turns
    /// re-send the blocks abridged.
    #[serde(default)]
    pub context_blocks: Option<String>,
}

/// A base64 image attachment sent with a user turn.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub media_type: String,
    pub data: String,
}

/// Request to run a `$`-direct command in a thread's TALK shell — bypasses the
/// LLM entirely (zero tokens), but the command + output are persisted into the
/// conversation so the agent sees them as context on its next turn.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ShellRequest {
    pub workspace_id: String,
    pub thread_id: String,
    pub workspace_path: String,
    pub command: String,
    /// The secret guard's override (#819): the fingerprint of exactly the
    /// findings the confirm showed, for this one run of the command.
    #[serde(default)]
    pub allow_findings: Option<String>,
}

/// Monotonic counter for `$`-direct call ids (correlates the resolved card to
/// its live "running" card). Distinct from provider tool_use ids.
static SHELL_SEQ: AtomicU64 = AtomicU64::new(1);

/// Format captured shell output for the tool card / model context, mirroring
/// `execute_tool`'s conventions: annotate a non-zero exit, and show an explicit
/// exit code when there's no output. Shared by the quick and live paths.
fn format_command_output(output: &str, exit_code: i32) -> String {
    let mut s = output.to_string();
    if exit_code != 0 {
        if !s.is_empty() {
            s.push('\n');
        }
        s.push_str(&format!("(exit code {exit_code})"));
    } else if s.trim().is_empty() {
        s = "(exit code 0)".to_string();
    }
    if exit_code == NOT_FOUND_EXIT {
        s.push('\n');
        s.push_str(&not_found_note(output));
    }
    s
}

/// How a call ended, as the engine knows it, for its row (`stamp_outcome`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct RowVerdict {
    ok: bool,
    /// Not run: the user denied its approval card or the secret guard's, or
    /// the conversation has the tool's MCP server turned off.
    denied: bool,
    /// A shell's exit status, when it reported one.
    exit_code: Option<i32>,
    /// The engine itself stopped it: Stop on the turn interrupted the agent's
    /// command, or the user stopped a `$` process.
    stopped: bool,
}

/// Stamp how a call ended on its persisted `role="tool"` row, so the resolved
/// ledger row can read as failed or denied instead of looking like a pass:
/// `ok`, `outcome` (`ok` · `failed` · `denied`), `exitCode` when a shell
/// reported one, and `reason: "stopped"` when the engine stopped it (so a
/// stopped command reads as stopped, not as its SIGINT exit). Additive keys:
/// rows written before them carry none, and the frontend reads their verdict
/// from the result text instead (`lib/toolVerdict.ts`). A shell's `-1` is its
/// "no status" sentinel (an interrupt, a busy shell), never an exit code, so
/// it isn't recorded.
fn stamp_outcome(record: &mut serde_json::Value, v: RowVerdict) {
    let outcome = if v.denied {
        "denied"
    } else if v.ok {
        "ok"
    } else {
        "failed"
    };
    record["ok"] = serde_json::json!(v.ok && !v.denied);
    record["outcome"] = serde_json::json!(outcome);
    if let Some(code) = v.exit_code.filter(|c| *c >= 0) {
        record["exitCode"] = serde_json::json!(code);
    }
    if v.stopped && outcome == "failed" {
        record["reason"] = serde_json::json!("stopped");
    }
}

/// The persisted `role="tool"` row every call site writes: the call, what it
/// returned, and how it ended. One builder, so what a row records is tested
/// where it is made.
fn tool_row(call_id: &str, tool_name: &str, tool_input: serde_json::Value, result: &str, v: RowVerdict) -> serde_json::Value {
    let mut record = serde_json::json!({
        "callId": call_id,
        "toolName": tool_name,
        "toolInput": tool_input,
        "result": result,
    });
    stamp_outcome(&mut record, v);
    record
}

/// The exit status bash gives a command it couldn't find.
const NOT_FOUND_EXIT: i32 = 127;

/// The line a command's result gains when it exits 127, so the model reads a
/// PATH miss as one instead of concluding the tool isn't installed. Names the
/// program from bash's last `<name>: command not found` (or, for a path such
/// as `./x`, `<name>: No such file or directory`) line in `output`. A path
/// wasn't looked up on the PATH, so its line doesn't mention the PATH. Pure.
fn not_found_note(output: &str) -> String {
    let program = output
        .lines()
        .rev()
        .find_map(|l| {
            let l = l.trim_end();
            l.strip_suffix(": command not found").or_else(|| l.strip_suffix(": No such file or directory"))
        })
        .and_then(|head| head.rsplit(": ").next())
        .map(str::trim)
        .filter(|p| !p.is_empty() && !p.contains(char::is_whitespace));
    match program {
        Some(p) if p.contains('/') => format!("`{p}` wasn't found."),
        Some(p) => format!("`{p}` wasn't found (the command ran with your login shell's PATH)."),
        None => "A program in this command wasn't found (the command ran with your login shell's PATH).".to_string(),
    }
}

/// Flag a command the agent wants to run as destructive (returns a short reason
/// for the approval card). Conservative + high-confidence: a safety net before
/// the agent does something irreversible, not a sandbox. User-typed `$` commands
/// are never passed here (only the secret guard checks them, #819).
/// Case-insensitive, matches anywhere in the command.
pub(crate) fn dangerous_command(command: &str) -> Option<&'static str> {
    // Normalize runs of whitespace so spacing tricks (`rm  -rf`) don't slip past.
    let normalized = command.split_whitespace().collect::<Vec<_>>().join(" ");
    let c = normalized.to_lowercase();

    // Per-COMMAND checks run on each shell segment independently, so a flag from
    // one chained command can't be attributed to another (`rm -r a && rm -f b`
    // is two non-destructive deletes, not one force-delete).
    for seg in c.split([';', '|', '&', '\n']) {
        let tokens: Vec<&str> = seg.split_whitespace().collect();
        // Any short-flag token after `from` carrying `ch` (`-rf`/`-fr`/`-f`), or
        // the long flag, within THIS segment only.
        let flag_after = |from: usize, ch: char, long: &str| {
            tokens[from + 1..].iter().any(|t| {
                *t == long || (t.starts_with('-') && !t.starts_with("--") && t.contains(ch))
            })
        };
        let has_tok = |t: &str| tokens.iter().any(|x| *x == t);

        if let Some(ri) = tokens.iter().position(|t| *t == "rm") {
            if flag_after(ri, 'r', "--recursive") && flag_after(ri, 'f', "--force") {
                return Some("recursive force delete (rm)");
            }
        }
        if let Some(pi) = tokens.iter().position(|t| *t == "push") {
            if flag_after(pi, 'f', "--force")
                || tokens[pi + 1..].iter().any(|t| *t == "--force-with-lease")
            {
                return Some("force-push rewrites remote history");
            }
        }
        if let Some(ci) = tokens.iter().position(|t| *t == "clean") {
            // `git clean -f` deletes untracked files; `-n` (dry run) has no `f`.
            if flag_after(ci, 'f', "--force") {
                return Some("deletes untracked files (git clean)");
            }
        }
        if has_tok("find") && has_tok("-delete") {
            return Some("find -delete removes matched files");
        }
    }

    // Regex rules run on the full line — several (pipe-to-shell `… | sh`, the
    // fork bomb) intentionally span shell separators, and the device-write /
    // pipe-to-shell regexes already use word boundaries to avoid the `> /dev/null`
    // and `… | shuf` false positives. A destructive `dd` writes to a device
    // (`of=/dev/sd…`), caught by the device-write regex — so the old bare
    // `dd if=` substring (which mis-fired on `git add if=…`) is gone.
    for (re, reason) in danger_regexes() {
        if re.is_match(&c) {
            return Some(reason);
        }
    }
    // Plain high-confidence substrings. NOTE: this is a heuristic net, not a
    // sandbox — a benign command that merely *contains* a flagged string (e.g.
    // `echo 'git reset --hard'`) may prompt for approval; the user can deny. A
    // quote-aware parser would be needed to eliminate that, which isn't worth the
    // complexity for a confirm-prompt safety net.
    const RULES: &[(&str, &str)] = &[
        ("sudo ", "runs with elevated privileges (sudo)"),
        ("mkfs", "formats a filesystem (mkfs)"),
        (":(){:|:&};:", "fork bomb"),
        ("git reset --hard", "discards uncommitted changes (git reset --hard)"),
        ("chmod -r", "recursive permission change (chmod -R)"),
        ("chown -r", "recursive ownership change (chown -R)"),
    ];
    RULES.iter().find(|(n, _)| c.contains(*n)).map(|(_, r)| *r)
}

/// Regexes for danger rules that need word boundaries (so `> /dev/null` and
/// `… | shuf` aren't mistaken for raw-disk writes or pipe-to-shell).
fn danger_regexes() -> &'static [(regex::Regex, &'static str)] {
    static RES: std::sync::OnceLock<Vec<(regex::Regex, &'static str)>> = std::sync::OnceLock::new();
    RES.get_or_init(|| {
        vec![
            (
                regex::Regex::new(r"\|\s*(sh|bash|zsh|fish)\b").unwrap(),
                "pipes content into a shell",
            ),
            (
                regex::Regex::new(r"(>|of=)\s*/dev/(sd|disk|nvme|rdisk|hd)").unwrap(),
                "writes to a raw disk device",
            ),
        ]
    })
}

/// A command's cwd relative to the workspace root, for display on its card.
/// Empty at the root/unknown; the path relative to root when inside the tree;
/// and a consistent `…/tail` (up to the last two segments) when outside it —
/// never the bare absolute path, so a deep filesystem location isn't leaked.
fn relativize_cwd(abs: &str, root: &str) -> String {
    if abs.is_empty() || abs == root {
        return String::new();
    }
    if let Some(rest) = abs.strip_prefix(&format!("{root}/")) {
        return rest.to_string();
    }
    let parts: Vec<&str> = abs.split('/').filter(|s| !s.is_empty()).collect();
    let tail = if parts.len() >= 2 {
        parts[parts.len() - 2..].join("/")
    } else {
        parts.join("/")
    };
    format!("…/{tail}")
}

/// Clone a `run_command` tool-input, adding a `cwd` field (relative to `root`)
/// when the command ran somewhere other than the workspace root.
fn tool_input_with_cwd(input: &serde_json::Value, abs_cwd: &str, root: &str) -> serde_json::Value {
    let rel = relativize_cwd(abs_cwd, root);
    if rel.is_empty() {
        return input.clone();
    }
    let mut v = input.clone();
    if let Some(obj) = v.as_object_mut() {
        obj.insert("cwd".to_string(), serde_json::Value::String(rel));
    }
    v
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChatStreamEvent {
    pub workspace_id: String,
    pub thread_id: String,
    pub delta: String,
    pub done: bool,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

/// The director's live status line while it waits on the provider: a retry
/// after a transient failure, or a pause for the rate-limit window. Not
/// persisted; the Player shows `text` for `delay_secs`, or until the turn
/// moves on (a stream delta, a row, a tool start).
pub const TURN_NOTICE_EVENT: &str = "chat://notice";
/// How long the Player shows a context-budget line (stubs, a retry after a
/// too-long prompt).
const CONTEXT_NOTICE_SECS: u64 = 8;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TurnNoticeEvent {
    pub workspace_id: String,
    pub thread_id: String,
    pub text: String,
    pub delay_secs: u64,
}

/// A journal line ("model overloaded — retrying in 8s …") as the Player's
/// label: the same words, starting with a capital.
fn notice_label(line: &str) -> String {
    let mut chars = line.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

/// Emitted the moment a tool BEGINS executing — before the (potentially slow)
/// `execute_tool` call returns. Lets the frontend show a live "running" card
/// with an elapsed timer instead of a silent gap. Reconciled to the resolved
/// `ToolCallCard` when the matching `chat://message-added` (role=tool) arrives,
/// correlated by `call_id` (the provider's `tool_use.id`).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ToolStartEvent {
    pub workspace_id: String,
    pub thread_id: String,
    pub call_id: String,
    pub tool_name: String,
    pub tool_input: serde_json::Value,
    pub started_at: String,
}

/// Emitted the moment a tool FINISHES executing. Carries timing + a best-effort
/// success flag so the live card can show a duration and flip to a failed
/// (rouge) state before the resolved card takes over.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ToolEndEvent {
    pub workspace_id: String,
    pub thread_id: String,
    pub call_id: String,
    pub ok: bool,
    pub duration_ms: u64,
}


/// Emitted when a `$`-direct command is promoted to a live process — the
/// frontend opens a pinned mini-terminal keyed by `call_id`; output then
/// arrives as `chat://shell-output` chunks.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ShellLiveStartEvent {
    pub workspace_id: String,
    pub thread_id: String,
    pub call_id: String,
    pub command: String,
}

/// A chunk of raw output from a live process (markers stripped, ANSI kept for
/// xterm).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ShellOutputEvent {
    pub thread_id: String,
    pub call_id: String,
    pub chunk: String,
}

/// Emitted when the shared shell's cwd changes via the AGENT's run_command
/// (the `$`-direct path updates the badge from its returned result instead).
/// Keeps the composer's cwd badge accurate after the assistant `cd`s.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ShellCwdEvent {
    pub thread_id: String,
    pub cwd: String,
    pub cwd_label: String,
}

/// Emitted when a live process exits — closes the pinned panel and updates cwd.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ShellExitEvent {
    pub thread_id: String,
    pub call_id: String,
    pub exit_code: i32,
    pub cwd: String,
    /// Relativized cwd for the badge (single backend source; rendered verbatim).
    pub cwd_label: String,
}

/// The user's decision on a dangerous-command approval request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovalDecision {
    Deny,
    Approve,
    /// Approve and stop asking for this conversation (auto-approve the thread).
    ApproveAlways,
}

impl ApprovalDecision {
    /// Parse the frontend's string ("deny" | "approve" | "always").
    pub fn parse(s: &str) -> Self {
        match s {
            "approve" => ApprovalDecision::Approve,
            "always" => ApprovalDecision::ApproveAlways,
            _ => ApprovalDecision::Deny,
        }
    }
}

/// Emitted when the agent wants to run a command flagged as destructive — the
/// frontend shows an inline Approve/Deny card; the turn waits for the decision.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequestEvent {
    pub workspace_id: String,
    pub thread_id: String,
    pub call_id: String,
    pub command: String,
    pub reason: String,
    /// The secret guard asks (#819): the card offers no "don't ask again",
    /// and a thread's grant never answers it.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub secret: bool,
    /// The command also stages, so the scan read uncommitted changes.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub covers_uncommitted: bool,
}

/// A Talk approval card waiting on the user, as the Dock badge and the menu
/// bar Octo count it (`fleet_status::refresh`). Never the command: what
/// leaves the window says what kind of thing waits, not its arguments.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApprovalWait {
    pub workspace_id: String,
    pub thread_id: String,
    /// The secret guard's card (a commit or push), not a flagged command.
    pub secret: bool,
    /// When the card was raised (ms): the FIFO key.
    pub since_ms: i64,
}

/// One card in flight: what it asked, when, and who answers it.
struct ParkedApproval {
    request: ApprovalRequestEvent,
    since_ms: i64,
    tx: tokio::sync::oneshot::Sender<ApprovalDecision>,
}

/// The one approval channel for dangerous agent commands in TALK: the parent
/// loop and every sub-agent of the turn ask through it, the frontend answers
/// by call id (`respond`), Stop denies a whole thread (`deny_thread`), and a
/// "don't ask again" grant is per thread so a crew inherits it.
///
/// A card waits until it is answered: there is no timeout. Stop, deleting the
/// conversation and deleting the workspace deny it (a deleted workspace is
/// retired, so a turn still winding down there can never park a new card);
/// a reloaded webview shows it again (`pending_for_thread`); and while it
/// waits it counts as needs-you on the Dock badge and the menu bar Octo
/// (`waiting`).
#[derive(Default)]
pub(crate) struct ApprovalBroker {
    /// In-flight requests keyed by the tool call id: the request as the card
    /// showed it (its thread, so a thread's pending approvals can be resolved
    /// together), when it was raised, and the responder.
    approvals: Mutex<HashMap<String, ParkedApproval>>,
    /// Threads where the user chose "don't ask again" — dangerous agent commands
    /// run without prompting (in-memory; resets on restart, by design).
    auto_approve: Mutex<std::collections::HashSet<String>>,
    /// Deleted workspaces: nobody can answer a card there any more, so a
    /// request from one is denied at once instead of parked.
    retired: Mutex<std::collections::HashSet<String>>,
}

impl ApprovalBroker {
    pub fn respond(&self, call_id: &str, decision: ApprovalDecision) {
        if let Some(parked) = self.approvals.lock().remove(call_id) {
            let _ = parked.tx.send(decision);
        }
    }

    pub fn deny_thread(&self, thread_id: &str) {
        self.deny_where(|r| r.thread_id == thread_id);
    }

    /// A workspace is going away: deny every card it holds, and every card it
    /// would raise from now on, so none can wait for an answer that can no
    /// longer come (or outlive it on the Dock badge and the menu bar).
    pub fn retire_workspace(&self, workspace_id: &str) {
        self.retired.lock().insert(workspace_id.to_string());
        self.deny_where(|r| r.workspace_id == workspace_id);
    }

    /// The workspace's deletion failed, so it stays: its conversations may
    /// ask again.
    pub fn reinstate_workspace(&self, workspace_id: &str) {
        self.retired.lock().remove(workspace_id);
    }

    /// Whether a card from `workspace_id` may wait for an answer.
    fn admits(&self, workspace_id: &str) -> bool {
        !self.retired.lock().contains(workspace_id)
    }

    fn deny_where(&self, matches: impl Fn(&ApprovalRequestEvent) -> bool) {
        let mut approvals = self.approvals.lock();
        let to_deny: Vec<String> = approvals
            .iter()
            .filter(|(_, p)| matches(&p.request))
            .map(|(cid, _)| cid.clone())
            .collect();
        for cid in to_deny {
            if let Some(parked) = approvals.remove(&cid) {
                let _ = parked.tx.send(ApprovalDecision::Deny);
            }
        }
    }

    /// The cards still waiting on a thread, oldest first — what a reloaded
    /// webview needs to show again (its in-memory list is gone, the parked
    /// turn is not).
    pub fn pending_for_thread(&self, thread_id: &str) -> Vec<ApprovalRequestEvent> {
        let approvals = self.approvals.lock();
        let mut mine: Vec<&ParkedApproval> =
            approvals.values().filter(|p| p.request.thread_id == thread_id).collect();
        mine.sort_by(|a, b| a.since_ms.cmp(&b.since_ms).then_with(|| a.request.call_id.cmp(&b.request.call_id)));
        mine.into_iter().map(|p| p.request.clone()).collect()
    }

    /// Every card waiting on the user, oldest first.
    pub(crate) fn waiting(&self) -> Vec<ApprovalWait> {
        let approvals = self.approvals.lock();
        let mut all: Vec<(&String, ApprovalWait)> = approvals
            .iter()
            .map(|(cid, p)| {
                (
                    cid,
                    ApprovalWait {
                        workspace_id: p.request.workspace_id.clone(),
                        thread_id: p.request.thread_id.clone(),
                        secret: p.request.secret,
                        since_ms: p.since_ms,
                    },
                )
            })
            .collect();
        all.sort_by(|(ca, a), (cb, b)| a.since_ms.cmp(&b.since_ms).then_with(|| ca.cmp(cb)));
        all.into_iter().map(|(_, w)| w).collect()
    }

    /// Park a card (no event, no wait): what `ask` does before it waits.
    fn park(
        &self,
        request: ApprovalRequestEvent,
        since_ms: i64,
    ) -> tokio::sync::oneshot::Receiver<ApprovalDecision> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.approvals.lock().insert(request.call_id.clone(), ParkedApproval { request, since_ms, tx });
        rx
    }

    /// Ask the user to approve a dangerous agent command and wait for the answer.
    /// Auto-approved conversations skip the prompt. The card waits as long as
    /// it takes (see the type's doc): never a silent denial.
    pub async fn await_approval(
        &self,
        app: &AppHandle,
        workspace_id: &str,
        thread_id: &str,
        call_id: &str,
        command: &str,
        reason: &str,
    ) -> ApprovalDecision {
        if self.auto_approve.lock().contains(thread_id) {
            return ApprovalDecision::Approve;
        }
        let decision = self.ask(app, workspace_id, thread_id, call_id, command, reason, None).await;
        self.record(thread_id, decision, false);
        decision
    }

    /// Ask about a command the secret guard stopped (#819). Unlike
    /// [`Self::await_approval`], a thread's "don't ask again" never answers it,
    /// and an approval grants nothing beyond this one call.
    #[allow(clippy::too_many_arguments)]
    pub async fn await_secret_approval(
        &self,
        app: &AppHandle,
        workspace_id: &str,
        thread_id: &str,
        call_id: &str,
        command: &str,
        reason: &str,
        covers_uncommitted: bool,
    ) -> ApprovalDecision {
        let decision = self
            .ask(app, workspace_id, thread_id, call_id, command, reason, Some(covers_uncommitted))
            .await;
        self.record(thread_id, decision, true)
    }

    /// Keep a "don't ask again" grant, except from a secret card, whose
    /// approval reads as a plain one. Returns the decision to act on.
    pub(crate) fn record(&self, thread_id: &str, decision: ApprovalDecision, secret: bool) -> ApprovalDecision {
        match decision {
            ApprovalDecision::ApproveAlways if secret => ApprovalDecision::Approve,
            ApprovalDecision::ApproveAlways => {
                self.auto_approve.lock().insert(thread_id.to_string());
                decision
            }
            d => d,
        }
    }

    /// Whether the thread's "don't ask again" grant skips a dangerous-command
    /// prompt (never a secret one).
    #[cfg(test)]
    pub(crate) fn auto_approves(&self, thread_id: &str) -> bool {
        self.auto_approve.lock().contains(thread_id)
    }

    /// Emit the card and wait for its answer. `secret` is `Some(covers
    /// uncommitted)` for the secret guard's card.
    #[allow(clippy::too_many_arguments)]
    async fn ask(
        &self,
        app: &AppHandle,
        workspace_id: &str,
        thread_id: &str,
        call_id: &str,
        command: &str,
        reason: &str,
        secret: Option<bool>,
    ) -> ApprovalDecision {
        if !self.admits(workspace_id) {
            return ApprovalDecision::Deny;
        }
        let request = ApprovalRequestEvent {
            workspace_id: workspace_id.to_string(),
            thread_id: thread_id.to_string(),
            call_id: call_id.to_string(),
            command: command.to_string(),
            reason: reason.to_string(),
            secret: secret.is_some(),
            covers_uncommitted: secret.unwrap_or(false),
        };
        let rx = self.park(request.clone(), chrono::Utc::now().timestamp_millis());
        let _ = app.emit("chat://approval-request", &request);
        // The Dock badge and the menu bar Octo count it while it waits.
        crate::fleet_status::refresh_later(app);
        // No timeout: a card left alone used to be denied after five minutes
        // without a word. It now waits for its answer, Stop, or the
        // conversation's (or workspace's) deletion, which all answer it. Only
        // a responder dropped unanswered would end here, as a denial.
        let decision = rx.await.unwrap_or(ApprovalDecision::Deny);
        let _ = app.emit("chat://approval-resolved", &ApprovalResolvedEvent {
            workspace_id: workspace_id.to_string(),
            thread_id: thread_id.to_string(),
            call_id: call_id.to_string(),
        });
        crate::fleet_status::refresh_later(app);
        decision
    }
}

/// The secret card's reason and the denial fed back to the model (#819):
/// kinds and `file:line` only, never a value. `label` names the sub-agent.
/// Pure, so the wording is tested.
pub(crate) fn secret_gate_texts(label: Option<&str>, summary: &str) -> (String, String) {
    let card = match label {
        Some(l) => format!("Sub-agent \u{201c}{l}\u{201d}: possible secret \u{b7} {summary}"),
        None => format!("possible secret \u{b7} {summary}"),
    };
    let denial = format!(
        "Command not run — the secret guard found {summary} in what it would commit or push, \
         and the user declined. Take it out of the change or ask the user how to proceed; \
         do not retry the same command."
    );
    (card, denial)
}

/// The secret guard on an agent's `run_command` in Talk (#819): a command
/// that commits, pushes or opens a pull request is scanned first, and a
/// finding (or a partial scan) parks it on the secret card. The approval is
/// bound to the scan's fingerprint: the command runs only if a rescan still
/// finds exactly what the card showed, else the card asks again. `Some` is
/// the denial for the model. Guard off, or nothing found: `None`.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn guard_agent_command(
    broker: &ApprovalBroker,
    app: &AppHandle,
    workspace_id: &str,
    thread_id: &str,
    call_id: &str,
    command: &str,
    workspace_path: &str,
    label: Option<&str>,
) -> Option<String> {
    let plan = crate::secret_scan::shell_plan(command)?;
    let mut approved: Option<String> = None;
    loop {
        let (path, p) = (workspace_path.to_string(), plan.clone());
        let report = crate::secret_scan::guarded_scan(move || {
            crate::secret_scan::shell_files(std::path::Path::new(&path), &p)
        })
        .await?;
        if !report.needs_confirmation() || approved.as_deref() == Some(report.fingerprint.as_str()) {
            return None;
        }
        let summary = crate::secret_scan::refusal_summary(&report.findings, report.total, report.partial);
        let (card, denial) = secret_gate_texts(label, &summary);
        match broker
            .await_secret_approval(app, workspace_id, thread_id, call_id, command, &card, plan.covers_uncommitted())
            .await
        {
            ApprovalDecision::Deny => return Some(denial),
            _ => approved = Some(report.fingerprint),
        }
    }
}

/// Emitted when a sub-agent that WRITES (implementer, pr-maintainer, any
/// definition with write/edit/shell tools) ran out of turns mid-work: the
/// director's turn pauses on an inline card until the user gives it more
/// turns or accepts the partial report. A half-done implementation must never
/// reach the director as if it were a result.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SubagentCapEvent {
    pub workspace_id: String,
    pub thread_id: String,
    pub call_id: String,
    pub description: String,
    pub subagent_type: Option<String>,
    /// Turns the run has taken so far (every extension included).
    pub turns_used: usize,
}

/// Emitted when a turn-limit card is answered (or Stop resolved it) so the
/// frontend retires it.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SubagentCapResolvedEvent {
    pub workspace_id: String,
    pub thread_id: String,
    pub call_id: String,
}

/// How long a turn-limit card may wait for an answer before the run is
/// accepted as partial. Long: the user may have stepped away, and the
/// alternative is a director building on half-done work.
pub const CAP_GATE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/// How a turn-limit card was answered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CapAnswer {
    /// Resume the run with this many more turns.
    More(usize),
    /// The user accepts the partial report; the director goes on with it.
    Accept,
    /// Stop on the thread resolved the card; the turn is ending anyway.
    Stopped,
    /// Nobody answered within `CAP_GATE_TIMEOUT`; treated as accept.
    Timeout,
}

/// The turn-limit gate: a writing sub-agent that hit its cap asks through it,
/// the frontend answers by call id with the extra turns to grant (or none to
/// accept the partial report), Stop resolves a whole thread as `Stopped`.
/// Pending cards are listable so a reloaded webview can show them again.
#[derive(Default)]
pub struct CapGate {
    pending: Mutex<HashMap<String, (SubagentCapEvent, tokio::sync::oneshot::Sender<CapAnswer>)>>,
}

impl CapGate {
    pub fn respond(&self, call_id: &str, extra_turns: Option<usize>) {
        if let Some((_ev, tx)) = self.pending.lock().remove(call_id) {
            let _ = tx.send(match extra_turns {
                Some(n) => CapAnswer::More(n.max(1)),
                None => CapAnswer::Accept,
            });
        }
    }

    pub fn deny_thread(&self, thread_id: &str) {
        let mut pending = self.pending.lock();
        let ids: Vec<String> = pending
            .iter()
            .filter(|(_, (ev, _))| ev.thread_id == thread_id)
            .map(|(cid, _)| cid.clone())
            .collect();
        for cid in ids {
            if let Some((_, tx)) = pending.remove(&cid) {
                let _ = tx.send(CapAnswer::Stopped);
            }
        }
    }

    /// The cards still waiting on a thread — what a reloaded webview needs
    /// to show again (its in-memory list is gone, the parked turn is not).
    pub fn pending_for_thread(&self, thread_id: &str) -> Vec<SubagentCapEvent> {
        self.pending
            .lock()
            .values()
            .filter(|(ev, _)| ev.thread_id == thread_id)
            .map(|(ev, _)| ev.clone())
            .collect()
    }

    /// Ask the user what to do with a capped writing sub-agent and wait.
    #[allow(clippy::too_many_arguments)]
    pub async fn ask(
        &self,
        app: &AppHandle,
        workspace_id: &str,
        thread_id: &str,
        call_id: &str,
        description: &str,
        subagent_type: Option<&str>,
        turns_used: usize,
    ) -> CapAnswer {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let ev = SubagentCapEvent {
            workspace_id: workspace_id.to_string(),
            thread_id: thread_id.to_string(),
            call_id: call_id.to_string(),
            description: description.to_string(),
            subagent_type: subagent_type.map(str::to_string),
            turns_used,
        };
        self.pending.lock().insert(call_id.to_string(), (ev.clone(), tx));
        let _ = app.emit("chat://subagent-cap", &ev);
        let answer = match tokio::time::timeout(CAP_GATE_TIMEOUT, rx).await {
            Ok(Ok(a)) => a,
            Ok(Err(_)) => CapAnswer::Stopped,
            Err(_) => {
                self.pending.lock().remove(call_id);
                CapAnswer::Timeout
            }
        };
        let _ = app.emit("chat://subagent-cap-resolved", &SubagentCapResolvedEvent {
            workspace_id: workspace_id.to_string(),
            thread_id: thread_id.to_string(),
            call_id: call_id.to_string(),
        });
        answer
    }
}

/// Emitted when an approval request is resolved (any decision) so the frontend
/// can retire the inline card.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalResolvedEvent {
    pub workspace_id: String,
    pub thread_id: String,
    pub call_id: String,
}

/// Emitted whenever a chat message is persisted to the DB.
/// Carries the DB rowid + the full message row so the frontend can append
/// to its local state using a stable ID. Replaces the prior `chat://tool-use`
/// event, and replaces the done-with-final-text shortcut.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MessageAddedEvent {
    pub workspace_id: String,
    pub thread_id: String,
    pub id: i64,
    pub role: String,
    pub content: String,
    pub model: Option<String>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cost_usd: Option<f64>,
    pub created_at: String,
    /// Cache-aware usage for assistant rows: tokens served from the prompt
    /// cache, tokens written to it, and the size of the LAST prompt of the
    /// turn (uncached + cached + written) — the honest context figure.
    pub cache_read_tokens: Option<i64>,
    pub cache_creation_tokens: Option<i64>,
    pub context_tokens: Option<i64>,
}

/// Emitted when a persisted message's content changes in place — a
/// sub-agent's tool row after a continuation rewrote its report and meta.
/// The frontend replaces the row by id; nothing is appended.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MessageUpdatedEvent {
    pub workspace_id: String,
    pub thread_id: String,
    pub id: i64,
    pub content: String,
}

/// One turn's token accounting across its rounds, cache-aware. `cost` sums
/// every round priced with its own cache split (a round's cached input is
/// ~10× cheaper than uncached, so pricing the totals as uncached input — the
/// old way — overstated some turns and understated the cache-write ones);
/// `last_context` is the last prompt's full size, what the context meter
/// should show (the uncached `input` alone is the small tail of the prompt
/// the cache did not cover).
#[derive(Clone, Copy, Debug, Default)]
pub struct TurnUsage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_creation: u64,
    pub cost: f64,
    pub last_context: u64,
}

impl TurnUsage {
    pub fn add(&mut self, model: &str, r: &crate::providers::LlmResponse) {
        self.input += r.input_tokens;
        self.output += r.output_tokens;
        self.cache_read += r.cache_read_tokens;
        self.cache_creation += r.cache_creation_tokens;
        // One provider response = one request: per-request price tiers apply.
        self.cost += token_engine::request_cost_for(
            model,
            r.input_tokens,
            r.output_tokens,
            r.cache_read_tokens,
            r.cache_creation_tokens,
        );
        let ctx = r.input_tokens + r.cache_read_tokens + r.cache_creation_tokens;
        if ctx > 0 {
            self.last_context = ctx;
        }
    }
}

// ─── Tools definition ─────────────────────────────────────────────

fn tool_definitions() -> serde_json::Value {
    serde_json::json!([
        {
            "name": "run_command",
            "description": "Run a shell command in the workspace directory. Use this for git operations, running tests, installing packages, or any shell task. The command runs with bash. Commands are killed after a timeout (default 600s) — never start servers, watchers, or other non-exiting processes; pass timeout_secs for a genuinely long build.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The shell command to execute"
                    },
                    "timeout_secs": {
                        "type": "integer",
                        "description": "Optional wall-clock limit for this command in seconds (default 600, max 3600)"
                    }
                },
                "required": ["command"]
            }
        },
        {
            "name": "read_file",
            "description": "Read the contents of a file in the workspace. For large files, pass offset/limit to read a window of lines instead of the whole file.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Relative path from workspace root"
                    },
                    "offset": {
                        "type": "integer",
                        "description": "Optional 1-based line number to start reading from"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Optional maximum number of lines to read"
                    }
                },
                "required": ["path"]
            }
        },
        {
            "name": "write_file",
            "description": "Write content to a file in the workspace. Creates the file and parent directories if they don't exist. Overwrites existing content.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Relative path from workspace root"
                    },
                    "content": {
                        "type": "string",
                        "description": "The full content to write"
                    }
                },
                "required": ["path", "content"]
            }
        },
        {
            "name": "list_files",
            "description": "List files and directories in a workspace path.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Relative directory path from workspace root. Use '.' for root."
                    }
                },
                "required": ["path"]
            }
        },
        {
            "name": "grep",
            "description": "Search file contents with a regex, recursively, respecting .gitignore. Returns path:line:text matches. Far cheaper than reading files one by one — use this to locate code before reading.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "Regular expression to search for"
                    },
                    "path": {
                        "type": "string",
                        "description": "Relative directory (or file) to search under. Defaults to the workspace root."
                    },
                    "glob": {
                        "type": "string",
                        "description": "Optional filename filter, e.g. '*.rs' or 'src/**/*.ts'"
                    },
                    "case_insensitive": {
                        "type": "boolean",
                        "description": "Case-insensitive matching (default false)"
                    },
                    "max_results": {
                        "type": "integer",
                        "description": "Maximum matches to return (default 200, max 1000)"
                    }
                },
                "required": ["pattern"]
            }
        },
        {
            "name": "glob",
            "description": "Find files by glob pattern (e.g. 'src/**/*.ts', '**/Cargo.toml'), recursively, respecting .gitignore. Returns matching paths.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "Glob pattern relative to the workspace root"
                    }
                },
                "required": ["pattern"]
            }
        },
        {
            "name": "edit_file",
            "description": "Replace an exact string in a file. The old_string must match exactly (including whitespace) and be unique in the file unless replace_all is true. Prefer this over write_file for changes to existing files — it cannot accidentally drop the rest of the file.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Relative path from workspace root"
                    },
                    "old_string": {
                        "type": "string",
                        "description": "The exact text to replace"
                    },
                    "new_string": {
                        "type": "string",
                        "description": "The replacement text"
                    },
                    "replace_all": {
                        "type": "boolean",
                        "description": "Replace every occurrence instead of requiring uniqueness (default false)"
                    }
                },
                "required": ["path", "old_string", "new_string"]
            }
        }
    ])
}

// ─── Tool execution ───────────────────────────────────────────────

/// Execute a tool and return `(result_text, ok)`. `ok` is a STRUCTURAL success
/// signal — `run_command` reports the process exit status, file ops report
/// whether the syscall succeeded — never a sniff of the result text. Callers
/// that only want the text can ignore the bool (`let (result, _) = …`).
/// Kernel-enforced `write_file` for a sandboxed mission: `mkdir -p` + write run
/// under a seatbelt-wrapped shell, so the KERNEL resolves symlinks and blocks a
/// target that escapes the workspace (a lexical check can't see through a
/// symlink). The target is passed as a positional arg (`$1`), never interpolated
/// into the script. Fail-closed: if the sandbox can't be set up, nothing is
/// written.
fn sandboxed_write(roots: &[String], full: &Path, content: &str, path: &str) -> (String, bool) {
    use std::io::Write;
    // `$0` is a label; `$1` is the (untrusted) absolute target path.
    let script = r#"mkdir -p "$(dirname "$1")" && cat > "$1""#;
    let args = vec![
        "-c".to_string(),
        script.to_string(),
        "octopush-write".to_string(),
        full.to_string_lossy().into_owned(),
    ];
    let prepared =
        match crate::orchestrator::sandbox::prepare(roots, None, std::ffi::OsStr::new(crate::talk_shell::TALK_BASH), &args) {
            Ok(p) => p,
            Err(e) => {
                return (
                    format!("Sandbox unavailable — refusing to write unconfined: {e}"),
                    false,
                );
            }
        };
    let mut child = match std::process::Command::new(&prepared.program)
        .args(&prepared.args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return (format!("Sandboxed write failed to start: {e}"), false),
    };
    if let Some(mut si) = child.stdin.take() {
        let _ = si.write_all(content.as_bytes());
        // Dropping `si` closes stdin so `cat` sees EOF and finishes.
    }
    match child.wait_with_output() {
        Ok(out) if out.status.success() => (format!("Wrote {} bytes to {path}", content.len()), true),
        Ok(out) => {
            let err = String::from_utf8_lossy(&out.stderr);
            (
                format!("Sandboxed: could not write {path} (blocked or failed): {}", err.trim()),
                false,
            )
        }
        Err(e) => (format!("Sandboxed write failed: {e}"), false),
    }
}

/// Default wall-clock bound on one `run_command` invocation. Before this
/// existed, a command that never exits (`npm run dev`, a REPL) hung the agent
/// turn forever — and, in DIRECT, an entire stage with no way to stop it. The
/// model can raise it per call via `timeout_secs` (capped at [`RUN_COMMAND_TIMEOUT_MAX`])
/// for a genuinely long build.
const RUN_COMMAND_TIMEOUT_SECS: u64 = 600;
/// Upper bound a per-call `timeout_secs` override may request.
const RUN_COMMAND_TIMEOUT_MAX: u64 = 3600;

/// Truncate `s` to at most `max` BYTES on a char boundary (a plain byte slice
/// panics mid-codepoint on multibyte text).
pub(crate) fn truncate_char_safe(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Kill `child` and everything in its process group (the child is spawned with
/// `process_group(0)`, so grandchildren die too), then reap it.
fn kill_process_group(child: &mut std::process::Child) {
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Spawn `command` and wait for it, bounded by `timeout_secs` and (when given)
/// the caller's cancel flag — polled every ~100ms so a director stop lands
/// promptly instead of waiting on a process that may never exit. stdout/stderr
/// are drained on threads (a full pipe buffer would deadlock the child).
/// On timeout/cancel the whole process GROUP is killed and whatever output was
/// captured so far is returned as evidence.
fn wait_command_bounded(
    mut command: std::process::Command,
    timeout_secs: u64,
    cancel: Option<&std::sync::Arc<std::sync::atomic::AtomicBool>>,
) -> (String, bool) {
    use std::sync::atomic::Ordering;
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(e) => return (format!("Failed to execute command: {e}"), false),
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    // Drain into SHARED buffers (not thread return values): if a killed
    // command's grandchild escaped the process group and still holds a pipe
    // write-end, `read_to_end` never returns — a blocking `join()` would then
    // hang this function forever. With shared buffers we can snapshot what
    // arrived and DETACH a stuck drain thread after a bounded wait.
    let out_buf: std::sync::Arc<std::sync::Mutex<Vec<u8>>> = Default::default();
    let err_buf: std::sync::Arc<std::sync::Mutex<Vec<u8>>> = Default::default();
    let drain_into = |buf: std::sync::Arc<std::sync::Mutex<Vec<u8>>>,
                      mut pipe: Option<Box<dyn std::io::Read + Send>>| {
        std::thread::spawn(move || {
            use std::io::Read;
            if let Some(p) = pipe.as_mut() {
                let mut chunk = [0u8; 8192];
                loop {
                    match p.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => buf.lock().unwrap().extend_from_slice(&chunk[..n]),
                    }
                }
            }
        })
    };
    let out_task = drain_into(
        std::sync::Arc::clone(&out_buf),
        stdout.map(|p| Box::new(p) as Box<dyn std::io::Read + Send>),
    );
    let err_task = drain_into(
        std::sync::Arc::clone(&err_buf),
        stderr.map(|p| Box::new(p) as Box<dyn std::io::Read + Send>),
    );
    let started = std::time::Instant::now();
    let ended = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => {}
            Err(e) => {
                kill_process_group(&mut child);
                break Err(format!("Failed waiting for command: {e}"));
            }
        }
        if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
            kill_process_group(&mut child);
            break Err("Command stopped by the director.".to_string());
        }
        if started.elapsed().as_secs() >= timeout_secs {
            kill_process_group(&mut child);
            break Err(format!(
                "Command timed out after {timeout_secs}s and was killed. If it was a long build, \
                 re-run with a larger `timeout_secs`; never start servers or other non-exiting \
                 processes with this tool."
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    };
    // Bounded join: give the drain threads a moment to see EOF, then take the
    // buffer snapshots regardless — a stuck thread (escaped grandchild holding
    // the pipe) is detached, never waited on.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    for task in [&out_task, &err_task] {
        while !task.is_finished() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
    let stdout_buf = out_buf.lock().unwrap().clone();
    let stderr_buf = err_buf.lock().unwrap().clone();
    let stdout = String::from_utf8_lossy(&stdout_buf);
    let stderr = String::from_utf8_lossy(&stderr_buf);
    drop((out_task, err_task)); // detach — a live thread only appends to buffers we've copied
    let mut result = String::new();
    if !stdout.is_empty() {
        result.push_str(&stdout);
    }
    if !stderr.is_empty() {
        if !result.is_empty() {
            result.push('\n');
        }
        result.push_str("[stderr] ");
        result.push_str(&stderr);
    }
    match ended {
        Ok(status) => {
            if result.is_empty() {
                result = format!("(exit code {})", status.code().unwrap_or(-1));
            }
            let note = (status.code() == Some(NOT_FOUND_EXIT)).then(|| not_found_note(&result));
            if result.len() > 50_000 {
                let cut = truncate_char_safe(&result, 50_000).len();
                result.truncate(cut);
                result.push_str("\n... (truncated)");
            }
            if let Some(note) = note {
                if !result.ends_with('\n') {
                    result.push('\n');
                }
                result.push_str(&note);
            }
            (result, status.success())
        }
        Err(msg) => {
            // Timeout / stop / wait error: surface the reason first, then any
            // captured output as evidence of what the command was doing.
            let mut s = msg;
            if !result.is_empty() {
                s.push_str("\n— output before the stop —\n");
                let capped = truncate_char_safe(&result, 20_000);
                s.push_str(capped);
            }
            (s, false)
        }
    }
}

/// Execute a built-in workspace tool. When `sandbox_roots` is `Some`, the
/// mission is sandboxed: `run_command` runs its shell under seatbelt (fail-closed
/// — no wrapper, no run) and `write_file` writes through a seatbelt wrap so the
/// kernel enforces the workspace boundary. Reads stay open (the profile allows
/// reads too).
pub(crate) fn execute_tool(
    workspace_path: &Path,
    name: &str,
    input: &serde_json::Value,
    sandbox_roots: Option<&[String]>,
) -> (String, bool) {
    execute_tool_cancellable(workspace_path, name, input, sandbox_roots, None)
}

/// [`execute_tool`] with a director cancel flag: a long `run_command` polls it
/// and kills the process group when set, so a DIRECT stage stop interrupts
/// in-flight tool work instead of waiting for a process that may never exit.
pub(crate) fn execute_tool_cancellable(
    workspace_path: &Path,
    name: &str,
    input: &serde_json::Value,
    sandbox_roots: Option<&[String]>,
    cancel: Option<&std::sync::Arc<std::sync::atomic::AtomicBool>>,
) -> (String, bool) {
    match name {
        "run_command" => {
            let cmd = input.get("command").and_then(|c| c.as_str()).unwrap_or("");
            let timeout_secs = input
                .get("timeout_secs")
                .and_then(|v| v.as_u64())
                .unwrap_or(RUN_COMMAND_TIMEOUT_SECS)
                .clamp(1, RUN_COMMAND_TIMEOUT_MAX);
            // The PATH CLI stages spawn with (the login shell's, the app's and
            // the common bin dirs), and no other login-shell variable: an app
            // opened from the Dock has launchd's minimal PATH, where Homebrew,
            // nvm and similar tools aren't found.
            let path = crate::orchestrator::cli_runner::resolved_cli_path();
            let mut command = if let Some(roots) = sandbox_roots {
                let scope = workspace_path.to_string_lossy();
                match crate::orchestrator::sandbox::prepare(
                    roots,
                    Some(&*scope),
                    std::ffi::OsStr::new(crate::talk_shell::TALK_BASH),
                    &["-c".to_string(), cmd.to_string()],
                ) {
                    Ok(p) => {
                        let mut c = std::process::Command::new(&p.program);
                        c.args(&p.args);
                        // Redirect build-tool caches into the workspace's own
                        // cache root, not the user's real ~/.cargo etc. (which
                        // the profile doesn't expose). PATH is set after
                        // them, so it is the login PATH whatever they carry.
                        c.envs(p.env);
                        c.env("PATH", &path);
                        c
                    }
                    Err(e) => {
                        return (
                            format!("Sandbox unavailable — refusing to run the command unconfined: {e}"),
                            false,
                        );
                    }
                }
            } else {
                let mut c = std::process::Command::new(crate::talk_shell::TALK_BASH);
                c.arg("-c").arg(cmd).env("PATH", &path);
                c
            };
            command.current_dir(workspace_path);
            wait_command_bounded(command, timeout_secs, cancel)
        }
        "read_file" => {
            let path = input.get("path").and_then(|p| p.as_str()).unwrap_or("");
            let full = workspace_path.join(path);
            match std::fs::read_to_string(&full) {
                Ok(content) => {
                    // Optional line-window: `offset` (1-based first line) and/or
                    // `limit` (line count) let the model page through a large
                    // file instead of re-reading (and re-paying for) all of it.
                    let offset = input.get("offset").and_then(|v| v.as_u64()).unwrap_or(0);
                    let limit = input.get("limit").and_then(|v| v.as_u64());
                    if offset > 1 || limit.is_some() {
                        let start = offset.max(1) as usize - 1;
                        let total = content.lines().count();
                        let window: Vec<&str> = content
                            .lines()
                            .skip(start)
                            .take(limit.map(|l| l.max(1) as usize).unwrap_or(usize::MAX))
                            .collect();
                        let shown = window.len();
                        let body = window.join("\n");
                        let body = truncate_char_safe(&body, 100_000);
                        return (
                            format!(
                                "(lines {}-{} of {total})\n{body}",
                                start + 1,
                                start + shown,
                            ),
                            true,
                        );
                    }
                    if content.len() > 100_000 {
                        let head = truncate_char_safe(&content, 100_000);
                        (
                            format!(
                                "{head}... (truncated, {} bytes total — re-read with `offset`/`limit` to see the rest)",
                                content.len()
                            ),
                            true,
                        )
                    } else {
                        (content, true)
                    }
                }
                Err(e) => (format!("Error reading {path}: {e}"), false),
            }
        }
        "write_file" => {
            let path = input.get("path").and_then(|p| p.as_str()).unwrap_or("");
            let content = input.get("content").and_then(|c| c.as_str()).unwrap_or("");
            let full = workspace_path.join(path);
            if let Some(roots) = sandbox_roots {
                // Fast lexical pre-check rejects obvious absolute/`..` escapes
                // without spawning; the authoritative guard is the KERNEL-enforced
                // write below, which resolves symlinks a lexical check can't (a
                // hostile repo can commit `link -> $HOME`).
                if !crate::orchestrator::sandbox::is_write_allowed(&full, roots) {
                    return (
                        format!("Sandboxed: refusing to write outside the mission workspace ({path})"),
                        false,
                    );
                }
                return sandboxed_write(roots, &full, content, path);
            }
            if let Some(parent) = full.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            match std::fs::write(&full, content) {
                Ok(()) => (format!("Wrote {} bytes to {path}", content.len()), true),
                Err(e) => (format!("Error writing {path}: {e}"), false),
            }
        }
        "list_files" => {
            let path = input.get("path").and_then(|p| p.as_str()).unwrap_or(".");
            let full = workspace_path.join(path);
            match std::fs::read_dir(&full) {
                Ok(entries) => {
                    let mut lines = Vec::new();
                    for entry in entries.flatten() {
                        let name = entry.file_name().to_string_lossy().to_string();
                        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
                        lines.push(if is_dir {
                            format!("{name}/")
                        } else {
                            name
                        });
                    }
                    lines.sort();
                    if lines.is_empty() {
                        ("(empty directory)".to_string(), true)
                    } else {
                        (lines.join("\n"), true)
                    }
                }
                Err(e) => (format!("Error listing {path}: {e}"), false),
            }
        }
        "grep" => {
            let pattern = input.get("pattern").and_then(|p| p.as_str()).unwrap_or("");
            if pattern.is_empty() {
                return ("grep needs a non-empty `pattern`".to_string(), false);
            }
            let path = input.get("path").and_then(|p| p.as_str()).unwrap_or(".");
            let case_insensitive = input
                .get("case_insensitive")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let max_results = input
                .get("max_results")
                .and_then(|v| v.as_u64())
                .unwrap_or(200)
                .clamp(1, 1000) as usize;
            let re = match regex::RegexBuilder::new(pattern)
                .case_insensitive(case_insensitive)
                .build()
            {
                Ok(r) => r,
                Err(e) => return (format!("Invalid regex: {e}"), false),
            };
            let file_matcher = match input.get("glob").and_then(|g| g.as_str()) {
                Some(g) => match globset::GlobBuilder::new(g).literal_separator(false).build() {
                    Ok(gl) => Some(gl.compile_matcher()),
                    Err(e) => return (format!("Invalid glob: {e}"), false),
                },
                None => None,
            };
            let root = workspace_path.join(path);
            let mut out: Vec<String> = Vec::new();
            let mut hit_cap = false;
            let walker = ignore::WalkBuilder::new(&root)
                .hidden(false)
                .git_global(false)
                .require_git(false)
                .build();
            'files: for entry in walker.flatten() {
                let p = entry.path();
                if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                    continue;
                }
                let rel = p.strip_prefix(workspace_path).unwrap_or(p);
                // `.git` internals are never useful matches; gitignored files
                // are already skipped by the walker.
                if rel.components().any(|c| c.as_os_str() == ".git") {
                    continue;
                }
                if let Some(m) = &file_matcher {
                    if !m.is_match(rel) && !m.is_match(p.file_name().map(std::path::Path::new).unwrap_or(rel)) {
                        continue;
                    }
                }
                // Skip huge and binary-looking files — a match inside them is
                // noise the model can't act on anyway.
                let Ok(meta) = entry.metadata() else { continue };
                if meta.len() > 2_000_000 {
                    continue;
                }
                let Ok(bytes) = std::fs::read(p) else { continue };
                if bytes[..bytes.len().min(4096)].contains(&0) {
                    continue;
                }
                let content = String::from_utf8_lossy(&bytes);
                for (i, line) in content.lines().enumerate() {
                    if re.is_match(line) {
                        let shown = truncate_char_safe(line.trim_end(), 400);
                        out.push(format!("{}:{}:{}", rel.display(), i + 1, shown));
                        if out.len() >= max_results {
                            hit_cap = true;
                            break 'files;
                        }
                    }
                }
            }
            if out.is_empty() {
                (format!("No matches for /{pattern}/ under {path}"), true)
            } else {
                let mut s = out.join("\n");
                if hit_cap {
                    s.push_str(&format!(
                        "\n… (stopped at {max_results} matches — narrow the pattern, path, or glob)"
                    ));
                }
                (s, true)
            }
        }
        "glob" => {
            let pattern = input.get("pattern").and_then(|p| p.as_str()).unwrap_or("");
            if pattern.is_empty() {
                return ("glob needs a non-empty `pattern`".to_string(), false);
            }
            let matcher = match globset::GlobBuilder::new(pattern)
                .literal_separator(false)
                .build()
            {
                Ok(g) => g.compile_matcher(),
                Err(e) => return (format!("Invalid glob: {e}"), false),
            };
            let mut out: Vec<String> = Vec::new();
            let mut hit_cap = false;
            let walker = ignore::WalkBuilder::new(workspace_path)
                .hidden(false)
                .git_global(false)
                .require_git(false)
                .build();
            for entry in walker.flatten() {
                if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                    continue;
                }
                let p = entry.path();
                let rel = p.strip_prefix(workspace_path).unwrap_or(p);
                if rel.components().any(|c| c.as_os_str() == ".git") {
                    continue;
                }
                if matcher.is_match(rel) {
                    out.push(rel.display().to_string());
                    if out.len() >= 500 {
                        hit_cap = true;
                        break;
                    }
                }
            }
            out.sort();
            if out.is_empty() {
                (format!("No files match {pattern}"), true)
            } else {
                let mut s = out.join("\n");
                if hit_cap {
                    s.push_str("\n… (stopped at 500 files — narrow the pattern)");
                }
                (s, true)
            }
        }
        "edit_file" => {
            let path = input.get("path").and_then(|p| p.as_str()).unwrap_or("");
            let old_string = input.get("old_string").and_then(|v| v.as_str()).unwrap_or("");
            let new_string = input.get("new_string").and_then(|v| v.as_str()).unwrap_or("");
            let replace_all = input.get("replace_all").and_then(|v| v.as_bool()).unwrap_or(false);
            if old_string.is_empty() {
                return ("edit_file needs a non-empty `old_string`".to_string(), false);
            }
            if old_string == new_string {
                return ("`old_string` and `new_string` are identical — nothing to change".to_string(), false);
            }
            let full = workspace_path.join(path);
            let content = match std::fs::read_to_string(&full) {
                Ok(c) => c,
                Err(e) => return (format!("Error reading {path}: {e}"), false),
            };
            let count = content.matches(old_string).count();
            if count == 0 {
                return (
                    format!(
                        "old_string not found in {path} — re-read the file and match the text exactly, including whitespace and indentation"
                    ),
                    false,
                );
            }
            if count > 1 && !replace_all {
                return (
                    format!(
                        "old_string appears {count} times in {path} — include more surrounding context to make it unique, or pass replace_all: true"
                    ),
                    false,
                );
            }
            let (updated, replaced) = if replace_all {
                (content.replace(old_string, new_string), count)
            } else {
                (content.replacen(old_string, new_string, 1), 1)
            };
            // Same containment story as write_file: lexical pre-check plus the
            // kernel-enforced sandboxed write when the mission is sandboxed.
            if let Some(roots) = sandbox_roots {
                if !crate::orchestrator::sandbox::is_write_allowed(&full, roots) {
                    return (
                        format!("Sandboxed: refusing to edit outside the mission workspace ({path})"),
                        false,
                    );
                }
                let (msg, ok) = sandboxed_write(roots, &full, &updated, path);
                if !ok {
                    return (msg, false);
                }
                return (format!("Edited {path}: replaced {replaced} occurrence(s)"), true);
            }
            match std::fs::write(&full, updated) {
                Ok(()) => (format!("Edited {path}: replaced {replaced} occurrence(s)"), true),
                Err(e) => (format!("Error writing {path}: {e}"), false),
            }
        }
        _ => (format!("Unknown tool: {name}"), false),
    }
}

// ─── Provider helpers ─────────────────────────────────────────────

/// Process-wide pooled HTTP client. `reqwest::Client` holds an internal
/// connection pool behind an `Arc`, so cloning it shares the pool — every
/// LLM caller (ChatEngine, `ai_complete`, orchestrator) should go through
/// this instead of `Client::new()`, which would pay a fresh TLS handshake
/// on every call. Built by `tls::llm_client`, so it carries the
/// compromised-key denylist like every other Octopush client, plus a connect
/// bound, an idle read bound and TCP keep-alive: a dropped connection fails
/// instead of hanging a turn forever. (A model server on this Mac gets the
/// loopback client instead: `providers::client_for`.)
static SHARED_HTTP: std::sync::OnceLock<Client> = std::sync::OnceLock::new();

pub(crate) fn shared_http_client() -> &'static Client {
    SHARED_HTTP.get_or_init(crate::tls::llm_client)
}

/// Build the static tool list as normalized `LlmTool[]`.
pub(crate) fn build_llm_tools() -> Vec<LlmTool> {
    let defs = tool_definitions();
    let arr = defs.as_array().cloned().unwrap_or_default();
    arr.into_iter().map(|t| LlmTool {
        name: t.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        description: t.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        input_schema: t.get("input_schema").cloned().unwrap_or(serde_json::json!({})),
    }).collect()
}

/// Resolve which provider implementation handles this model.
/// Returns `(provider_impl, api_base, optional_api_key)`.
pub(crate) fn resolve_provider(model: &str) -> AppResult<(Box<dyn LlmProvider>, String, Option<String>)> {
    let router = ProviderRouter::load()?;
    let (provider_cfg, _model_info) = router.find_model(model)
        .ok_or_else(|| AppError::Other(format!(
            "Unknown model: {model}. Configure it in Settings · Models & Providers."
        )))?;

    let key = crate::settings::get_provider_key(&provider_cfg.name);
    // Allow base URL override (Ollama, custom self-hosted).
    let api_base = crate::settings::get_provider_base_url(&provider_cfg.name)
        .unwrap_or_else(|| provider_cfg.api_base.clone());

    // Require key for non-local providers.
    if !provider_cfg.local && key.is_none() {
        return Err(AppError::Other(format!(
            "{} API key not configured. Open Settings · Models & Providers.",
            provider_cfg.name
        )));
    }

    let impl_: Box<dyn LlmProvider> = match provider_cfg.protocol.as_str() {
        "anthropic" => Box::new(AnthropicProvider),
        "openai-compatible" => Box::new(OpenAICompatibleProvider { provider: provider_cfg.name.clone() }),
        other => return Err(AppError::Other(format!("Unsupported protocol: {other}"))),
    };

    Ok((impl_, api_base, key))
}

/// Ledger origin of the director's own rounds in a Talk thread.
pub const DIRECTOR_ORIGIN: &str = "director";

/// Ledger origin of one sub-agent's rounds: `subagent:<tool call id>`.
pub fn subagent_origin(call_id: &str) -> String {
    format!("subagent:{call_id}")
}

/// The note that resumes a run cut at its turn cap (or stopped), with or
/// without a word from the user. `extra_turns` `None` = no turn limit on
/// the continuation. Pure so the wording is tested.
pub fn continuation_note(instruction: Option<&str>, extra_turns: Option<usize>) -> String {
    let budget = match extra_turns {
        Some(1) => "You have 1 more tool turn".to_string(),
        Some(n) => format!("You have {n} more tool turns"),
        None => "You have no turn limit — take the tool turns the work needs".to_string(),
    };
    let turns = format!(
        "{budget} — continue exactly where you left off, do \
         not redo work already done, and write your final report when finished."
    );
    match instruction.map(str::trim).filter(|t| !t.is_empty()) {
        Some(text) => format!("A message from the user: {text}\n\n{turns}"),
        None => turns,
    }
}

/// Fold a continuation's outcome into the meta already on the tool row: the
/// new ending and report, spend and duration summed across runs, attempts
/// appended, `continued` set. Pure so the sums are tested.
pub fn merge_continued_meta(old: &serde_json::Value, new: &AgentOutcome) -> serde_json::Value {
    let mut m = serde_json::to_value(new).unwrap_or_default();
    let n = |k: &str| old.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0);
    if let Some(obj) = m.as_object_mut() {
        obj.remove("report");
        for k in ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "toolCalls", "durationMs"] {
            let sum = n(k) + obj.get(k).and_then(|v| v.as_f64()).unwrap_or(0.0);
            obj.insert(k.to_string(), serde_json::json!(sum as u64));
        }
        obj.insert("costUsd".into(), serde_json::json!(n("costUsd") + new.cost_usd));
        obj.insert("continued".into(), serde_json::json!(true));
        if new.escalated_from.is_none() {
            if let Some(from) = old.get("escalatedFrom").filter(|v| !v.is_null()) {
                obj.insert("escalatedFrom".into(), from.clone());
            }
        }
        let mut attempts: Vec<serde_json::Value> = old
            .get("attempts")
            .and_then(|a| a.as_array())
            .cloned()
            .unwrap_or_default();
        if attempts.is_empty() {
            // The first run's figures were the single attempt.
            attempts.push(serde_json::json!({
                "model": old.get("model").cloned().unwrap_or(serde_json::Value::Null),
                "inputTokens": n("inputTokens") as u64,
                "outputTokens": n("outputTokens") as u64,
                "cacheReadTokens": n("cacheReadTokens") as u64,
                "cacheCreationTokens": n("cacheCreationTokens") as u64,
                "costUsd": n("costUsd"),
            }));
        }
        attempts.extend(new.billed_attempts().iter().map(|a| serde_json::to_value(a).unwrap_or_default()));
        obj.insert("attempts".into(), serde_json::Value::Array(attempts));
    }
    m
}

// ─── Engine ───────────────────────────────────────────────────────

/// Removes a cancel flag from the registry when its turn ends, no matter
/// which of `send_agentic`'s many exit paths is taken — and only ITS flag:
/// a later turn that registered under the same key keeps its own.
struct CancelGuard {
    cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    key: String,
    flag: Arc<AtomicBool>,
}

impl Drop for CancelGuard {
    fn drop(&mut self) {
        let mut cancels = self.cancels.lock();
        if cancels.get(&self.key).is_some_and(|f| Arc::ptr_eq(f, &self.flag)) {
            cancels.remove(&self.key);
        }
    }
}

/// What a Talk turn hands back to `send_agentic` to finish after it returns:
/// its cancel registration (dropped last, so the turn counts as running until
/// the end) and the checkpoint whose end state is still to be recorded.
#[derive(Default)]
struct TurnHold {
    /// Dropping it ends the turn; `Some` also says the turn began.
    cancel: Option<CancelGuard>,
    after: Option<crate::talk_checkpoints::AfterTurn>,
}

/// Why a second turn on a conversation is refused (`ChatEngine::begin_turn`).
pub const TURN_BUSY: &str = "A turn is already running in this conversation.";

/// Whether the registry holds a turn, or a sub-agent continuation
/// (`<thread>#continue:<call>`), on `thread_id`.
fn running_in(cancels: &HashMap<String, Arc<AtomicBool>>, thread_id: &str) -> bool {
    let prefix = format!("{thread_id}#");
    cancels.keys().any(|k| k == thread_id || k.starts_with(&prefix))
}

/// Ends a turn's (or a continuation's) claim on its thread, then announces
/// `done`: in that order and once, on every exit path, so a view that reads
/// `list_running_threads` when `done` lands never finds the thread listed
/// (which would show a running turn nobody can stop). Without a claim (the
/// turn was refused) nothing is announced: whatever runs there isn't over.
struct TurnEnd {
    claim: Option<CancelGuard>,
    done: Option<Box<dyn FnOnce() + Send>>,
}

impl Drop for TurnEnd {
    fn drop(&mut self) {
        // Taking the claim drops it here: the thread is released first.
        let began = self.claim.take().is_some();
        if let Some(done) = self.done.take().filter(|_| began) {
            done();
        }
    }
}

/// The `done` stream event for a thread, to fire once its claim is released.
fn done_event(app: &AppHandle, workspace_id: &str, thread_id: &str) -> Box<dyn FnOnce() + Send> {
    let (app, workspace_id, thread_id) = (app.clone(), workspace_id.to_string(), thread_id.to_string());
    Box::new(move || {
        let _ = app.emit("chat://stream", &ChatStreamEvent {
            workspace_id,
            thread_id,
            delta: String::new(),
            done: true,
            input_tokens: None,
            output_tokens: None,
        });
    })
}

/// Marks one sub-agent as being continued for the life of the guard, so
/// two continuations of the same run can never race on its row.
struct ContinuingGuard {
    set: Arc<Mutex<std::collections::HashSet<String>>>,
    call_id: String,
}

impl Drop for ContinuingGuard {
    fn drop(&mut self) {
        self.set.lock().remove(&self.call_id);
    }
}

pub struct ChatEngine {
    client: Client,
    db: Arc<Mutex<Db>>,
    /// Per-workspace cancellation flags. A live `send_agentic` registers its
    /// flag here for the duration of the turn; `cancel` raises it so the
    /// agentic loop stops before its next iteration. Mirrors the orchestrator's
    /// cancel registry.
    cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    /// MCP server registry — connects to configured stdio MCP servers, injects
    /// their tools into the loop, and proxies tool calls. Shared so the
    /// `list_mcp_*` commands can read the same connections.
    pub mcp: Arc<crate::mcp::McpRegistry>,
    /// Per-thread persistent bash PTYs backing `$`-direct execution. Shared so
    /// `run_shell_command` can reach the same sessions across turns.
    pub talk_shell: Arc<crate::talk_shell::TalkShell>,
    /// Approval requests for dangerous AGENT commands — shared with the
    /// sub-agents a turn spawns, so their `run_command`s go through the same
    /// card and the same "don't ask again" grant.
    approvals: Arc<ApprovalBroker>,
    /// Sub-agent call ids with a continuation in flight.
    continuing: Arc<Mutex<std::collections::HashSet<String>>>,
    /// The turn-limit gate for writing sub-agents (see `CapGate`).
    pub cap_gate: Arc<CapGate>,
    /// Threads whose live `$` process the user stopped (`stop_shell`), so its
    /// row reads as stopped when it exits.
    stopped_shells: Arc<Mutex<std::collections::HashSet<String>>>,
}

impl ChatEngine {
    pub fn new(db: Arc<Mutex<Db>>, daemon: Option<Arc<crate::pty_client::DaemonClient>>) -> Self {
        let talk_shell = Arc::new(crate::talk_shell::TalkShell::new());
        talk_shell.set_client(daemon);
        Self {
            // Clone of the process-wide client — shares its connection pool.
            client: shared_http_client().clone(),
            db,
            cancels: Arc::new(Mutex::new(HashMap::new())),
            mcp: Arc::new(crate::mcp::McpRegistry::new()),
            talk_shell,
            approvals: Arc::new(ApprovalBroker::default()),
            continuing: Arc::new(Mutex::new(std::collections::HashSet::new())),
            cap_gate: Arc::new(CapGate::default()),
            stopped_shells: Arc::new(Mutex::new(std::collections::HashSet::new())),
        }
    }

    /// Stop a thread's live `$` process (SIGINT), remembering that the user
    /// did, so its row reads as stopped rather than as exit 130.
    pub fn stop_shell(&self, thread_id: &str) {
        self.stopped_shells.lock().insert(thread_id.to_string());
        self.talk_shell.interrupt(thread_id);
    }

    /// The approval broker, for a sub-agent gate that outlives a `&self` borrow.
    pub(crate) fn approvals(&self) -> Arc<ApprovalBroker> {
        Arc::clone(&self.approvals)
    }

    /// Resolve a pending approval request (called by the `respond_approval`
    /// command when the user clicks the inline card).
    pub fn respond_approval(&self, call_id: &str, decision: ApprovalDecision) {
        self.approvals.respond(call_id, decision);
    }

    /// Ask the user to approve a dangerous agent command and wait for the answer.
    #[allow(clippy::too_many_arguments)]
    async fn await_approval(
        &self,
        app: &AppHandle,
        workspace_id: &str,
        thread_id: &str,
        call_id: &str,
        command: &str,
        reason: &str,
    ) -> ApprovalDecision {
        self.approvals
            .await_approval(app, workspace_id, thread_id, call_id, command, reason)
            .await
    }

    /// Request cancellation of the in-flight turn for `thread_id`, if any.
    /// No-op when nothing is running. The loop checks the flag between
    /// iterations and after each tool, then stops cleanly. Keyed by thread so
    /// two conversations in one workspace can be cancelled independently.
    pub fn cancel(&self, thread_id: &str) {
        // The turn's own flag, and every sub-agent continuation running on
        // the thread (`<thread>#continue:<call>`).
        let prefix = format!("{thread_id}#");
        for (key, flag) in self.cancels.lock().iter() {
            if key == thread_id || key.starts_with(&prefix) {
                flag.store(true, Ordering::Relaxed);
            }
        }
        // Resolve every pending approval for this thread (the turn's own and
        // its sub-agents') as Deny — otherwise Stop leaves a loop parked in
        // await_approval (and a later Approve would run a destructive command
        // on a turn the user already cancelled).
        self.approvals.deny_thread(thread_id);
        // A turn-limit card waiting on the thread resolves as "accept what it
        // has" — the stop ends the turn either way.
        self.cap_gate.deny_thread(thread_id);
    }

    /// A workspace is being deleted: stop every turn of its conversations
    /// (`thread_ids`), as Stop would, and retire it in the approval broker,
    /// so a turn still winding down can't park a card nobody can answer.
    pub fn cancel_workspace(&self, workspace_id: &str, thread_ids: &[String]) {
        for thread_id in thread_ids {
            self.cancel(thread_id);
        }
        self.approvals.retire_workspace(workspace_id);
    }

    /// `delete_workspace` is done with the row: if removing it failed, the
    /// workspace stays, so it is reinstated in the approval broker (its
    /// cards would otherwise be denied, unseen, until a restart). Its turns
    /// stay stopped, as after Stop. Returns `deleted` unchanged.
    pub fn finish_workspace_delete<T>(&self, workspace_id: &str, deleted: AppResult<T>) -> AppResult<T> {
        if deleted.is_err() {
            self.approvals.reinstate_workspace(workspace_id);
        }
        deleted
    }

    /// Whether a turn (or a sub-agent continuation) is running on `thread_id`.
    /// A rewind waits for it: it would race the agent's own writes.
    pub fn is_running(&self, thread_id: &str) -> bool {
        running_in(&self.cancels.lock(), thread_id)
    }

    /// Claim `thread_id` for a turn (`key` = the thread) or a sub-agent
    /// continuation (`<thread>#continue:<call>`): one running turn per
    /// conversation. Checked and registered under one lock, so two sends
    /// can't both pass; the guard releases the claim.
    fn begin_turn(&self, thread_id: &str, key: String) -> AppResult<(Arc<AtomicBool>, CancelGuard)> {
        let mut cancels = self.cancels.lock();
        if running_in(&cancels, thread_id) {
            return Err(AppError::Other(TURN_BUSY.into()));
        }
        let flag = Arc::new(AtomicBool::new(false));
        cancels.insert(key.clone(), Arc::clone(&flag));
        Ok((Arc::clone(&flag), CancelGuard { cancels: Arc::clone(&self.cancels), key, flag }))
    }

    /// Refuse when a turn (or a continuation) runs on `thread_id`: it owns
    /// the thread's rows and shell.
    fn ensure_idle(&self, thread_id: &str) -> AppResult<()> {
        if self.is_running(thread_id) {
            return Err(AppError::Other(TURN_BUSY.into()));
        }
        Ok(())
    }

    /// Delete a message and everything after it (Regenerate, Edit & resend),
    /// unless a turn runs on the thread: the resend would be refused, and the
    /// cut would take rows the turn is still writing.
    pub fn truncate_after(&self, thread_id: &str, message_id: i64) -> AppResult<()> {
        self.ensure_idle(thread_id)?;
        self.db.lock().truncate_chat_after(thread_id, message_id)
    }

    /// Which of `thread_ids` have a turn or a sub-agent continuation
    /// running; each ends with a `done` stream event (`TurnEnd`). A reloaded
    /// view reads it to show those threads as running again.
    pub fn running_turns(&self, thread_ids: &[String]) -> Vec<String> {
        let cancels = self.cancels.lock();
        thread_ids.iter().filter(|t| running_in(&cancels, t)).cloned().collect()
    }

    /// Whether a turn (or a sub-agent continuation) is running on any of
    /// `thread_ids`.
    pub fn any_running(&self, thread_ids: &[String]) -> bool {
        thread_ids.iter().any(|t| self.is_running(t))
    }

    /// Record one provider response's token usage: the canonical spend ledger
    /// (so the Companion CONTEXT card and Settings · Usage see chat turns)
    /// and the mission logbook. Shared by the loop and the forced close.
    fn record_usage(&self, workspace_id: &str, thread_id: &str, model: &str, response: &crate::providers::LlmResponse) {
        if response.input_tokens > 0 || response.output_tokens > 0 {
            let engine = token_engine::TokenEngine::new(std::sync::Arc::clone(&self.db));
            if let Err(e) = engine.record_request_in_thread(token_engine::TokenEvent {
                id: None,
                session_id: workspace_id.to_string(),
                timestamp: String::new(),
                input_tokens: response.input_tokens,
                output_tokens: response.output_tokens,
                cache_read_tokens: response.cache_read_tokens,
                cache_creation_tokens: response.cache_creation_tokens,
                model: model.to_string(),
                cost_usd: 0.0,
            }, "talk", Some(thread_id), Some(DIRECTOR_ORIGIN)) {
                tracing::warn!(error = %e, "failed to record chat token event");
            }
        }
        // Logbook: a completed chat turn is active TALK work on the mission.
        let _ = self.db.lock().record_activity(workspace_id, "talk", "chat");
    }

    /// Sub-agent spend goes to the ledger under ITS model (a `model`
    /// override may differ from the thread's) and under its call id, so the
    /// Companion's conversation cost splits director from crew. An escalated
    /// sub-agent bills every attempt at its own model's price, so each
    /// attempt is its own ledger row. The row takes the attempt's own cost,
    /// priced per request by the agentic loop (Haiku 5.5's long tier); a $0
    /// attempt is priced (or marked unpriced) by the ledger.
    fn record_subagent_spend(&self, workspace_id: &str, thread_id: &str, call_id: &str, o: &AgentOutcome) {
        let origin = subagent_origin(call_id);
        for a in o.billed_attempts() {
            if a.input_tokens == 0 && a.output_tokens == 0 {
                continue;
            }
            let engine = token_engine::TokenEngine::new(std::sync::Arc::clone(&self.db));
            if let Err(e) = engine.record_in_thread(token_engine::TokenEvent {
                id: None,
                session_id: workspace_id.to_string(),
                timestamp: String::new(),
                input_tokens: a.input_tokens,
                output_tokens: a.output_tokens,
                cache_read_tokens: a.cache_read_tokens,
                cache_creation_tokens: a.cache_creation_tokens,
                model: a.model.clone(),
                cost_usd: a.cost_usd,
            }, "talk", Some(thread_id), Some(&origin)) {
                tracing::warn!(error = %e, "failed to record sub-agent token event");
            }
        }
    }

    /// Execute `recall_tool_output`: the full stored result of an earlier
    /// tool row in THIS thread, optionally windowed. Returns `(text, ok)` like
    /// every other tool.
    fn recall_tool_output(&self, thread_id: &str, input: &serde_json::Value) -> (String, bool) {
        let Some(message_id) = input.get("message_id").and_then(|v| v.as_i64()) else {
            return ("recall_tool_output needs an integer `message_id`".to_string(), false);
        };
        let offset = input.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let limit = input
            .get("limit")
            .and_then(|v| v.as_u64())
            .map(|l| l as usize)
            .unwrap_or(RECALL_DEFAULT_LIMIT)
            .clamp(1, RECALL_MAX_LIMIT);
        if let Some(block) = input.get("block").and_then(|v| v.as_u64()) {
            let row = self.db.lock().get_chat_sent_context(thread_id, message_id).ok().flatten();
            let text = row.as_ref().and_then(|(c, ctx)| crate::chat_history::context_block(c, ctx, block as usize));
            return match text {
                Some(t) => (window_text(t, offset, limit), true),
                None => (format!("No context block {block} on message {message_id} in this conversation"), false),
            };
        }
        let stored = match self.db.lock().get_chat_tool_output(thread_id, message_id) {
            Ok(Some(c)) => c,
            Ok(None) => {
                return (
                    format!("No tool output with message_id {message_id} in this conversation"),
                    false,
                )
            }
            Err(e) => return (format!("Failed to load tool output: {e}"), false),
        };
        let original = self.db.lock().get_chat_tool_original(thread_id, message_id).ok().flatten();
        let (result, cut) = crate::chat_history::recall_source(&stored, original);
        if result.is_empty() {
            return (format!("Tool output #{message_id} is empty"), true);
        }
        let window = window_text(&result, offset, limit);
        match cut {
            Some(note) => (format!("{window}\n{note}"), true),
            None => (window, true),
        }
    }

    /// Show `line` (a journal line, e.g. a retry or a rate-limit pause) on
    /// the turn's Player for `delay_secs`. Live only: nothing is persisted.
    fn emit_turn_notice(&self, app: &AppHandle, workspace_id: &str, thread_id: &str, line: &str, delay_secs: u64) {
        let _ = app.emit(TURN_NOTICE_EVENT, &TurnNoticeEvent {
            workspace_id: workspace_id.to_string(),
            thread_id: thread_id.to_string(),
            text: notice_label(line),
            delay_secs,
        });
    }

    /// The context guard at a round boundary (`context::budget`): older tool
    /// results stubbed in the request past the soft threshold, said on the
    /// Player.
    fn guard_context(
        &self,
        app: &AppHandle,
        request: &ChatRequest,
        guard: &budget::ContextGuard,
        messages: &mut [LlmMessage],
        fixed_chars: usize,
        rows: &HashMap<String, i64>,
    ) {
        let Some(stubbed) = guard.before_round(messages, fixed_chars, rows).filter(|s| s.results > 0) else {
            return;
        };
        tracing::info!(
            results = stubbed.results,
            before = stubbed.before,
            after = stubbed.after,
            window = guard.budget().window,
            "context budget: older tool results stubbed in the request"
        );
        self.emit_turn_notice(app, &request.workspace_id, &request.thread_id, &guard.stub_notice(&stubbed), CONTEXT_NOTICE_SECS);
    }

    /// Keep what the context guard learned about `model` in `app_meta`.
    fn save_context_budget(&self, model: &str, learned: &budget::Learned) {
        if let Err(e) = budget::save_learned(&self.db.lock(), model, learned) {
            tracing::warn!(error = %e, "failed to keep the model's context budget");
        }
    }

    /// One director request: transient failures (429, 529, 5xx, a connection
    /// that couldn't be opened) are retried with the sub-agents' backoff and
    /// `retry-after` handling, each wait shown on the Player; a request that
    /// went out and got no answer is never sent again (`request_error`). The
    /// whole call is raced against the turn's cancel flag, so Stop abandons
    /// the request in flight instead of waiting for its answer.
    #[allow(clippy::too_many_arguments)]
    async fn director_call(
        &self,
        app: &AppHandle,
        workspace_id: &str,
        thread_id: &str,
        provider: &dyn LlmProvider,
        api_base: &str,
        api_key: Option<&str>,
        req: &LlmRequest,
        cancel: &AtomicBool,
    ) -> Completion {
        let mut on_retry = |attempt: u32, of: u32, delay: u64, kind: ProviderErrorKind| {
            tracing::warn!(attempt, delay, kind = kind.label(), "Talk director: provider call failed; retrying");
            self.emit_turn_notice(app, workspace_id, thread_id, &retry_notice(attempt, of, delay, kind), delay);
        };
        complete_cancellable(provider, api_base, api_key, req, &self.client, cancel, DEFAULT_MAX_RETRIES, &mut on_retry)
            .await
    }

    /// End a turn on a provider failure: persist it as the turn's `error`
    /// row and hand back the error the command rejects with. Both carry the
    /// same text, so the frontend shows one card. After retries ran out, the
    /// text says so and how to go on (`final_failure_text`); the thread is
    /// untouched and takes the next message as usual.
    fn fail_turn(&self, app: &AppHandle, workspace_id: &str, thread_id: &str, error: AppError, retries: u32) -> AppError {
        let error = match error.transient_retry() {
            Some((kind, retry_after)) if retries > 0 => {
                AppError::Provider { kind, retry_after, message: final_failure_text(&error, retries) }
            }
            _ => error,
        };
        if let Err(persist_err) = self.insert_and_emit_message(
            app,
            workspace_id,
            thread_id,
            "error",
            &error.to_string(),
            None, None, None, None,
        ) {
            tracing::error!(error = %persist_err, "failed to persist error message");
        }
        error
    }

    /// Persist a brief "stopped" marker and emit the done event so the frontend
    /// clears its streaming state when a turn is cancelled mid-flight.
    ///
    /// The marker uses role `"stopped"` — NOT `"assistant"` — for two reasons:
    /// the history builder only replays user/assistant/tool rows, so a stopped
    /// marker never re-enters the model's context as something it "said"; and
    /// the frontend renders it as a quiet system note, not a model bubble.
    #[allow(clippy::too_many_arguments)]
    fn finish_stopped(
        &self,
        app: &AppHandle,
        workspace_id: &str,
        thread_id: &str,
        model: &str,
        usage: &TurnUsage,
    ) -> AppResult<()> {
        self.finish_with_note(
            app, workspace_id, thread_id, model, usage,
            "Generation stopped.",
        )
    }

    /// Like `finish_stopped`, but the quiet note explains that a budget cap —
    /// not the user — ended the turn. Emitted by the per-iteration budget gate
    /// when an agentic loop crosses a configured limit mid-turn. The next send
    /// hits the entry gate in `send_chat_message`, which surfaces the Override
    /// affordance, so the note only needs to say why this turn stopped.
    fn finish_budget_capped(
        &self,
        app: &AppHandle,
        workspace_id: &str,
        thread_id: &str,
        model: &str,
        usage: &TurnUsage,
    ) -> AppResult<()> {
        self.finish_with_note(
            app, workspace_id, thread_id, model, usage,
            "Budget cap reached — turn stopped. Override to continue.",
        )
    }

    /// Shared tail for the graceful turn-enders: persist a quiet `stopped`
    /// marker carrying `note` (never replayed to the model, rendered as a
    /// system note). `send_agentic` sends `done` once the turn's claim is
    /// released.
    #[allow(clippy::too_many_arguments)]
    fn finish_with_note(
        &self,
        app: &AppHandle,
        workspace_id: &str,
        thread_id: &str,
        model: &str,
        usage: &TurnUsage,
        note: &str,
    ) -> AppResult<()> {
        self.insert_and_emit_priced(app, workspace_id, thread_id, "stopped", note, model, usage)?;
        Ok(())
    }

    /// Persist a row that carries a turn's usage (an assistant answer or a
    /// stopped note): tokens + cache-aware cost on the row, the cache split
    /// and the last prompt's size alongside, and one `chat://message-added`
    /// with all of it.
    #[allow(clippy::too_many_arguments)]
    fn insert_and_emit_priced(
        &self,
        app: &AppHandle,
        workspace_id: &str,
        thread_id: &str,
        role: &str,
        content: &str,
        model: &str,
        usage: &TurnUsage,
    ) -> AppResult<i64> {
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, true);
        let id = {
            let db = self.db.lock();
            let id = db.insert_chat_message(
                workspace_id,
                thread_id,
                role,
                content,
                Some(model),
                Some(usage.input as i64),
                Some(usage.output as i64),
                Some(usage.cost),
            )?;
            if let Err(e) = db.set_chat_message_usage(
                id,
                usage.cache_read as i64,
                usage.cache_creation as i64,
                usage.last_context as i64,
            ) {
                tracing::warn!(error = %e, "failed to store cache usage on chat row");
            }
            id
        };
        let _ = app.emit("chat://message-added", &MessageAddedEvent {
            workspace_id: workspace_id.to_string(),
            thread_id: thread_id.to_string(),
            id,
            role: role.to_string(),
            content: content.to_string(),
            model: Some(model.to_string()),
            input_tokens: Some(usage.input as i64),
            output_tokens: Some(usage.output as i64),
            cost_usd: Some(usage.cost),
            created_at: now,
            cache_read_tokens: Some(usage.cache_read as i64),
            cache_creation_tokens: Some(usage.cache_creation as i64),
            context_tokens: Some(usage.last_context as i64),
        });
        Ok(id)
    }

    /// Insert a message into the DB and emit a `chat://message-added` event
    /// carrying the full row (including the DB-assigned id).
    #[allow(clippy::too_many_arguments)]
    fn insert_and_emit_message(
        &self,
        app: &AppHandle,
        workspace_id: &str,
        thread_id: &str,
        role: &str,
        content: &str,
        model: Option<&str>,
        input_tokens: Option<i64>,
        output_tokens: Option<i64>,
        cost_usd: Option<f64>,
    ) -> AppResult<i64> {
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, true);
        let id = self.db.lock().insert_chat_message(
            workspace_id, thread_id, role, content, model, input_tokens, output_tokens, cost_usd,
        )?;
        let _ = app.emit("chat://message-added", &MessageAddedEvent {
            workspace_id: workspace_id.to_string(),
            thread_id: thread_id.to_string(),
            id,
            role: role.to_string(),
            content: content.to_string(),
            model: model.map(|s| s.to_string()),
            input_tokens,
            output_tokens,
            cost_usd,
            created_at: now,
            cache_read_tokens: None,
            cache_creation_tokens: None,
            context_tokens: None,
        });
        Ok(id)
    }

    /// Give a finished sub-agent more turns — and, optionally, a word from
    /// the user — on its saved transcript. A run cut at its cap, stopped, or
    /// blocked on a question is not lost work: it resumes exactly where it
    /// left off (a blocked run receives the message as the answer to its
    /// `ask_director`), on the model that wrote the transcript, with the same
    /// approval gate and MCP grants. The tool row's report and meta are
    /// rewritten in place (`chat://message-updated`) so the director's next
    /// turn reads the continued report from history; a quiet note marks the
    /// continuation in the thread.
    pub async fn continue_subagent(
        &self,
        app: AppHandle,
        call_id: String,
        instruction: Option<String>,
        extra_turns: Option<usize>,
    ) -> AppResult<()> {
        // `None` = no turn limit (the default everywhere for a sub-agent); a
        // number the user picked is honored as is, at least one.
        let extra_turns = extra_turns.map(|n| n.max(1));
        // One continuation per run at a time: a second click while the first
        // runs would race on the row and lose one run's figures.
        if !self.continuing.lock().insert(call_id.clone()) {
            return Err(AppError::Other("This sub-agent is already being continued.".into()));
        }
        let _continuing_guard = ContinuingGuard { set: Arc::clone(&self.continuing), call_id: call_id.clone() };
        let run = self
            .db
            .lock()
            .get_chat_agent_run(&call_id)?
            .ok_or_else(|| AppError::Other("This sub-agent has no saved run to continue (it predates continuations, or never started).".into()))?;
        let message_id = run
            .message_id
            .ok_or_else(|| AppError::Other("This sub-agent's report row is gone — nothing to update.".into()))?;
        // The row must still exist before anything is spent on it: a
        // Regenerate / Edit-and-resend may have truncated it away.
        let row = self
            .db
            .lock()
            .get_chat_message(message_id)?
            .ok_or_else(|| AppError::Other("This sub-agent's report row is gone — nothing to update.".into()))?;
        let mut spec: SubagentSpec = serde_json::from_str(&run.spec_json)
            .map_err(|e| AppError::Other(format!("saved sub-agent run is unreadable: {e}")))?;
        let transcript: BlockedTranscript = serde_json::from_str(&run.transcript_json)
            .map_err(|e| AppError::Other(format!("saved sub-agent transcript is unreadable: {e}")))?;
        if transcript.messages.is_empty() {
            return Err(AppError::Other("This sub-agent left no transcript to continue from.".into()));
        }
        let thread_alive = self.db.lock().chat_thread_exists(&run.thread_id).unwrap_or(false);
        if !thread_alive {
            return Err(AppError::Other("The conversation this sub-agent belonged to was deleted.".into()));
        }

        // Resume on the model that wrote the transcript, never re-picked —
        // the plan is that model, its tier, and the role's effort.
        spec.call.model = Some(run.model.clone());
        spec.max_iterations = extra_turns;
        {
            let (known_models, tiers) = model_catalog();
            let mut plan = plan_subagent(&SubagentSpec { policy_auto: false, ..spec.clone() }, &known_models, &tiers);
            plan.model = run.model.clone();
            plan.tier = crate::skills::agents::tier_of_model(&run.model, &tiers).map(str::to_string);
            plan.asked_model = None;
            plan.asked_honored = true;
            spec.plan = Some(plan);
        }
        let note = continuation_note(instruction.as_deref(), extra_turns);
        spec.resume = Some(if transcript.ask_tool_use_id.is_empty() {
            resume_messages_for_continuation(&transcript, &note)
        } else {
            resume_messages_for_answered_block(&transcript, &note)
        });

        // Cancellable from the thread's Stop like a turn: `cancel(thread)`
        // flips every `<thread>#continue:<call>` flag too. Refused while
        // anything else runs on the thread.
        let key = format!("{}#continue:{}", run.thread_id, call_id);
        let (cancel, claim) = self.begin_turn(&run.thread_id, key)?;
        let _end = TurnEnd { claim: Some(claim), done: Some(done_event(&app, &run.workspace_id, &run.thread_id)) };

        let _ = app.emit("chat://tool-start", &ToolStartEvent {
            workspace_id: run.workspace_id.clone(),
            thread_id: run.thread_id.clone(),
            call_id: call_id.clone(),
            tool_name: "Agent".to_string(),
            tool_input: agent_input_for_display(&spec.call, spec.plan.as_ref()),
            started_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, true),
        });

        let mcp_tools = discover_thread_mcp_tools(Arc::clone(&self.mcp), &self.db, &spec.workspace_path, &run.thread_id).await;
        let _ = app.emit(crate::mcp::scope::STATUS_CHANGED_EVENT, ());
        let turnstiles = mcp_turnstiles(&mcp_tools);
        let (known_models, tiers) = model_catalog();
        let outcome = run_one_subagent(
            app.clone(),
            Arc::clone(&self.db),
            self.client.clone(),
            self.approvals(),
            Arc::clone(&self.mcp),
            &mcp_tools,
            turnstiles,
            &known_models,
            &tiers,
            &spec,
            &cancel,
            None,
        )
        .await;
        self.record_subagent_spend(&run.workspace_id, &run.thread_id, &call_id, &outcome);

        let _ = app.emit("chat://tool-end", &ToolEndEvent {
            workspace_id: run.workspace_id.clone(),
            thread_id: run.thread_id.clone(),
            call_id: call_id.clone(),
            ok: outcome.ok,
            duration_ms: outcome.duration_ms,
        });

        // Rewrite the row: the continued report replaces the old one, the
        // meta carries both runs.
        let mut record: serde_json::Value = serde_json::from_str(&row.content)
            .unwrap_or_else(|_| serde_json::json!({ "callId": call_id, "toolName": "Agent" }));
        let old_meta = record.get("agent").cloned().unwrap_or_else(|| serde_json::json!({}));
        record["agent"] = merge_continued_meta(&old_meta, &outcome);
        record["result"] = serde_json::Value::String(outcome.report.clone());
        let content = record.to_string();
        self.db.lock().update_chat_message_content(message_id, &content)?;
        let _ = app.emit("chat://message-updated", &MessageUpdatedEvent {
            workspace_id: run.workspace_id.clone(),
            thread_id: run.thread_id.clone(),
            id: message_id,
            content,
        });
        let label = spec.call.description.trim();
        let note = format!(
            "Sub-agent “{}” {} {} — its report was updated.",
            if label.is_empty() { "Agent" } else { label },
            if instruction.as_deref().is_some_and(|t| !t.trim().is_empty()) { "was answered and given" } else { "was given" },
            match extra_turns {
                Some(1) => "1 more turn".to_string(),
                Some(n) => format!("{n} more turns"),
                None => "the turns it needed".to_string(),
            },
        );
        self.insert_and_emit_message(
            &app,
            &run.workspace_id,
            &run.thread_id,
            "stopped",
            &note,
            None,
            None,
            None,
            None,
        )?;
        Ok(())
    }

    /// Run a `$`-direct command in the thread's TALK shell, bypassing the LLM.
    ///
    /// Persists the command as a user turn (`$ cmd`) and the output as a
    /// `role="tool"` row so it renders as a `§ RUN` card and becomes context
    /// for the agent's next turn. Emits the same `tool-start`/`tool-end` events
    /// as the agentic loop so the existing live-card spinner is reused.
    pub async fn run_shell_command(
        &self,
        app: AppHandle,
        request: ShellRequest,
    ) -> AppResult<crate::talk_shell::ShellResult> {
        self.ensure_idle(&request.thread_id)?;
        // Secret guard (#819): a command that commits, pushes or opens a pull
        // request is refused with `SecretsFound` before anything is shown or
        // run, unless `allow_findings` is the fingerprint the confirm showed.
        if let Some(plan) = crate::secret_scan::shell_plan(&request.command) {
            let path = request.workspace_path.clone();
            crate::secret_scan::guard(request.allow_findings.clone(), move || {
                crate::secret_scan::shell_files(std::path::Path::new(&path), &plan)
            })
            .await?;
        }

        // Show the command as the user's turn straight away.
        self.insert_and_emit_message(
            &app,
            &request.workspace_id,
            &request.thread_id,
            "user",
            &format!("$ {}", request.command),
            None, None, None, None,
        )?;

        let seq = SHELL_SEQ.fetch_add(1, Ordering::Relaxed);
        let call_id = format!("shell-{seq}");
        let tool_input = serde_json::json!({ "command": request.command });
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, true);
        let _ = app.emit("chat://tool-start", &ToolStartEvent {
            workspace_id: request.workspace_id.clone(),
            thread_id: request.thread_id.clone(),
            call_id: call_id.clone(),
            tool_name: "run_command".to_string(),
            tool_input: tool_input.clone(),
            started_at: now,
        });

        let started = std::time::Instant::now();
        let shell = Arc::clone(&self.talk_shell);
        let thread_id = request.thread_id.clone();
        let workspace_path = request.workspace_path.clone();
        let command = request.command.clone();
        // Promote to a live process if the command hasn't finished within this
        // window (dev servers / watchers stream instead of blocking the turn).
        let outcome = tokio::task::spawn_blocking(move || {
            shell.run(
                &thread_id,
                &workspace_path,
                &command,
                std::time::Duration::from_millis(1500),
                true, // $-direct promotes long commands to a live process
            )
        })
        .await
        .map_err(|e| AppError::Other(format!("shell task join error: {e}")))?;

        let outcome = match outcome {
            Ok(o) => o,
            Err(e) => {
                // Hard failure (daemon down / spawn failed) — surface as a card.
                self.resolve_shell_card(
                    &app, &request, &call_id, &tool_input, false, started,
                    &format!("Shell error: {e}"), "", None,
                );
                return Err(e);
            }
        };

        use crate::talk_shell::{RunOutcome, ShellResult};
        // Record for recall only when the command actually RAN (Done or promoted
        // to Live) — not Busy / hard errors, which would pollute the palette.
        let record_history = |this: &Self| {
            let _ = this
                .db
                .lock()
                .record_shell_history(&request.workspace_id, &request.command);
        };
        match outcome {
            RunOutcome::Done(mut result) => {
                self.resolve_shell_card(
                    &app, &request, &call_id, &tool_input, result.ok, started,
                    &format_command_output(&result.output, result.exit_code), &result.cwd,
                    Some(result.exit_code),
                );
                // Compute the badge label once here (the single source) so the
                // frontend renders it verbatim instead of re-deriving the rule.
                result.cwd_label = relativize_cwd(&result.cwd, &request.workspace_path);
                record_history(self);
                Ok(result)
            }
            RunOutcome::Busy => {
                let note = "A live process is already running in this conversation — \
                            stop it before running another command.";
                self.resolve_shell_card(
                    &app, &request, &call_id, &tool_input, false, started, note, "", None,
                );
                Ok(ShellResult {
                    output: note.to_string(),
                    exit_code: -1,
                    ok: false,
                    cwd: String::new(),
                    live: false,
                    cwd_label: String::new(),
                })
            }
            RunOutcome::Live(live) => {
                // Open the pinned live panel; the first shell-output chunk fills it.
                let _ = app.emit("chat://shell-live-start", &ShellLiveStartEvent {
                    workspace_id: request.workspace_id.clone(),
                    thread_id: request.thread_id.clone(),
                    call_id: call_id.clone(),
                    command: request.command.clone(),
                });
                record_history(self);
                self.spawn_live_streamer(
                    app.clone(), request.clone(), call_id, tool_input, started, live,
                );
                Ok(ShellResult {
                    output: String::new(),
                    exit_code: 0,
                    ok: true,
                    cwd: String::new(),
                    live: true,
                    cwd_label: String::new(),
                })
            }
        }
    }

    /// Emit `tool-end` + persist the resolved `role="tool"` card for a `$`-direct
    /// command (the quick / busy / error paths share this).
    #[allow(clippy::too_many_arguments)]
    fn resolve_shell_card(
        &self,
        app: &AppHandle,
        request: &ShellRequest,
        call_id: &str,
        tool_input: &serde_json::Value,
        ok: bool,
        started: std::time::Instant,
        result_str: &str,
        abs_cwd: &str,
        exit_code: Option<i32>,
    ) {
        let _ = app.emit("chat://tool-end", &ToolEndEvent {
            workspace_id: request.workspace_id.clone(),
            thread_id: request.thread_id.clone(),
            call_id: call_id.to_string(),
            ok,
            duration_ms: started.elapsed().as_millis() as u64,
        });
        let record = tool_row(
            call_id,
            "run_command",
            tool_input_with_cwd(tool_input, abs_cwd, &request.workspace_path),
            result_str,
            RowVerdict { ok, exit_code, ..RowVerdict::default() },
        );
        let _ = self.insert_and_emit_message(
            app, &request.workspace_id, &request.thread_id,
            "tool", &record.to_string(), None, None, None, None,
        );
    }

    /// Drive a promoted live process on a background thread: stream raw output as
    /// `chat://shell-output`, then on exit emit `tool-end` + `shell-exit` and
    /// persist the resolved card with the full captured output.
    fn spawn_live_streamer(
        &self,
        app: AppHandle,
        request: ShellRequest,
        call_id: String,
        tool_input: serde_json::Value,
        started: std::time::Instant,
        live: crate::talk_shell::LiveRun,
    ) {
        let db = Arc::clone(&self.db);
        let stopped_shells = Arc::clone(&self.stopped_shells);
        // A Stop pressed before this process started isn't this process's.
        stopped_shells.lock().remove(&request.thread_id);
        std::thread::Builder::new()
            .name(format!("talk-live-{call_id}"))
            .spawn(move || {
                let exit = {
                    let app = app.clone();
                    let tid = request.thread_id.clone();
                    let cid = call_id.clone();
                    live.stream(|chunk| {
                        let _ = app.emit("chat://shell-output", &ShellOutputEvent {
                            thread_id: tid.clone(),
                            call_id: cid.clone(),
                            chunk: chunk.to_string(),
                        });
                    })
                };

                let _ = app.emit("chat://tool-end", &ToolEndEvent {
                    workspace_id: request.workspace_id.clone(),
                    thread_id: request.thread_id.clone(),
                    call_id: call_id.clone(),
                    ok: exit.exit_code == 0,
                    duration_ms: started.elapsed().as_millis() as u64,
                });
                let _ = app.emit("chat://shell-exit", &ShellExitEvent {
                    thread_id: request.thread_id.clone(),
                    call_id: call_id.clone(),
                    exit_code: exit.exit_code,
                    cwd: exit.cwd.clone(),
                    cwd_label: relativize_cwd(&exit.cwd, &request.workspace_path),
                });

                // The user stopped it (`stop_shell`): it reads as stopped, not
                // as the exit status SIGINT left it with.
                let stopped = stopped_shells.lock().remove(&request.thread_id);
                let record = tool_row(
                    &call_id,
                    "run_command",
                    tool_input_with_cwd(&tool_input, &exit.cwd, &request.workspace_path),
                    &format_command_output(&exit.full_output, exit.exit_code),
                    RowVerdict { ok: exit.exit_code == 0, exit_code: Some(exit.exit_code), stopped, ..RowVerdict::default() },
                );
                let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, true);
                // The conversation may have been deleted while the process ran;
                // don't leave an orphaned row (no FK from messages → threads).
                let id = {
                    let db = db.lock();
                    match db.chat_thread_exists(&request.thread_id) {
                        // Only skip when the thread was definitively deleted — a
                        // transient DB error must NOT drop the command's card.
                        Ok(false) => return,
                        _ => db.insert_chat_message(
                            &request.workspace_id, &request.thread_id, "tool",
                            &record.to_string(), None, None, None, None,
                        ),
                    }
                };
                if let Ok(id) = id {
                    let _ = app.emit("chat://message-added", &MessageAddedEvent {
                        workspace_id: request.workspace_id.clone(),
                        thread_id: request.thread_id.clone(),
                        id,
                        role: "tool".to_string(),
                        content: record.to_string(),
                        model: None,
                        input_tokens: None,
                        output_tokens: None,
                        cost_usd: None,
                        created_at: now,
                        cache_read_tokens: None,
                        cache_creation_tokens: None,
                        context_tokens: None,
                    });
                }
            })
            .ok();
    }

    /// Run the agentic loop: send messages with tools, execute tool calls,
    /// feed results back, repeat until the provider gives a final text answer.
    /// Dispatches to the right LlmProvider impl via `resolve_provider()`.
    pub async fn send_agentic(
        &self,
        app: AppHandle,
        request: ChatRequest,
    ) -> AppResult<()> {
        let done = done_event(&app, &request.workspace_id, &request.thread_id);
        let mut held = TurnHold::default();
        let result = self.run_agentic_turn(app, request, &mut held).await;
        // Talk checkpoint (#958): record how the turn left the tree, on every
        // exit path, while its cancel registration still marks it running.
        if let Some(after) = held.after.take() {
            after.record_off_runtime().await;
        }
        // Then release the thread and send the one `done`, whatever the
        // outcome (an answer, a Stop, a cap, an error).
        drop(TurnEnd { claim: held.cancel.take(), done: Some(done) });
        result
    }

    async fn run_agentic_turn(
        &self,
        app: AppHandle,
        request: ChatRequest,
        held: &mut TurnHold,
    ) -> AppResult<()> {
        // The Auto policy (economy director): the composer sends `auto`; the
        // turn runs on the strong tier's model under the lean-context
        // doctrine, and sub-agents take their tier by role. Resolved once,
        // here, so everything downstream (pricing, the persisted rows, the
        // stream events) sees a real model id.
        let (request, doctrine) = if request.model == AUTO_MODEL {
            let known: Vec<String> = crate::provider_router::ProviderRouter::load()
                .map(|r| r.list_models().into_iter().map(|m| m.model.id).collect())
                .unwrap_or_default();
            let tiers = crate::settings::load_settings().map(|s| s.model_tiers).unwrap_or_default();
            match director_model_for_auto(&known, &tiers) {
                Some(model) => {
                    tracing::info!(model = %model, "Auto policy: director runs on the strong tier");
                    let unmapped = unmapped_subagent_tiers(&known, &tiers);
                    (ChatRequest { model, ..request }, Some(director_doctrine(&unmapped)))
                }
                None => {
                    return Err(AppError::Other(
                        "Auto needs the strong tier mapped to a configured model — set it in Settings › Models › Model tiers, or pick a model."
                            .into(),
                    ))
                }
            }
        } else {
            (request, None)
        };
        let policy_auto = doctrine.is_some();
        let (provider, api_base, api_key) = resolve_provider(&request.model)?;

        let workspace_path = std::path::PathBuf::from(&request.workspace_path);

        // Sandbox scope for this turn's in-process tools: Some(write_roots) when
        // the mission is confined. When set, run_command routes to the
        // seatbelt-wrapped execute_tool (bypassing the shared shell) and
        // write_file is confined. A `readonly` mission (review/probe) is
        // read-only-by-construction → Some(vec![]) (temp-only, no workspace
        // writes); a `sandbox` mission → Some(vec![workspace]). Resolved once/turn.
        let sandbox_roots: Option<Vec<String>> = self
            .db
            .lock()
            .active_mission_for_workspace(&request.workspace_id)
            .ok()
            .flatten()
            .and_then(|m| {
                crate::orchestrator::sandbox::sandbox_write_roots(
                    &m.git_isolation,
                    &m.exec_isolation,
                    &request.workspace_path,
                )
            });

        // Register a fresh cancellation flag for this turn, keyed by thread,
        // or refuse: a turn already runs there. The guard removes it from the
        // registry on every exit path (Drop), once `send_agentic` has also
        // recorded the turn's checkpoint.
        let (cancel, guard) = self.begin_turn(&request.thread_id, request.thread_id.clone())?;
        held.cancel = Some(guard);

        // Persist user message and emit message-added so the frontend learns the
        // DB id. Skipped on regenerate: history already ends with the user turn
        // (the old assistant turn was truncated), so we just re-run the loop.
        if !request.regenerate {
            let id = self.insert_and_emit_message(
                &app,
                &request.workspace_id,
                &request.thread_id,
                "user",
                &request.user_message,
                None, None, None, None,
            )?;
            // Without the record the ask still runs; it renders and replays
            // as before, with its blocks whole.
            if let Some(ctx) = request.context_blocks.as_deref() {
                if crate::chat_history::context_spans(&request.user_message, ctx).is_none() {
                    tracing::warn!(message_id = id, "the ask's @ context blocks don't fit its text; not saved");
                } else if let Err(e) = self.db.lock().set_chat_message_context(id, ctx) {
                    tracing::warn!(error = %e, message_id = id, "failed to save the ask's @ context blocks");
                }
            }
        }

        // Build conversation history (this thread only) as normalized
        // LlmMessage[]. `chat_history::build_history` owns the shape: the
        // model's pre-tool narration and recency-weighted tool excerpts are
        // folded into the assistant turns, orphans ride on the next user turn,
        // same-role turns merge (Anthropic 400 guard), and `error`/`stopped`
        // rows are never replayed.
        let history = self.db.lock().list_chat_messages(&request.thread_id)?;

        // Talk checkpoint (#958): snapshot the tree before this turn can
        // write, so its files can be rewound later (a regenerate keeps the
        // first attempt's checkpoint). A read-only mission can't write, so it
        // takes none. `send_agentic` records how the turn left the tree. The
        // git work runs on a blocking thread, off the async runtime.
        let can_write = !matches!(sandbox_roots.as_deref(), Some([]));
        let turn_id = history.iter().rev().find(|m| m.role == "user").filter(|_| can_write).map(|m| m.id);
        if let Some(id) = turn_id {
            let (ws, thread) = (workspace_path.clone(), request.thread_id.clone());
            let taken = crate::talk_checkpoints::off_runtime(move || {
                Ok(crate::talk_checkpoints::capture_before(&ws, &thread, id))
            })
            .await
            .unwrap_or(false);
            if taken {
                held.after = Some(crate::talk_checkpoints::AfterTurn::new(&workspace_path, &request.thread_id, id));
            }
        }

        let rows: Vec<HistoryRow<'_>> = history
            .iter()
            .map(|m| HistoryRow { id: m.id, role: m.role.as_str(), content: m.content.as_str(), context: m.context_blocks.as_deref() })
            .collect();
        let mut messages: Vec<LlmMessage> = build_history(&rows)
            .into_iter()
            .map(|t| LlmMessage {
                role: match t.role {
                    HistoryRole::User => LlmRole::User,
                    HistoryRole::Assistant => LlmRole::Assistant,
                },
                content: LlmContent::Text(t.text),
            })
            .collect();

        // Attach this turn's images: replace the current (last) user turn with a
        // multimodal block carrying the text + image blocks. Attachments aren't
        // persisted, so they only ride along on the turn that sent them.
        if !request.attachments.is_empty() {
            // The just-persisted user message is the last entry. Guard on its
            // role; warn (rather than silently drop) if it's somehow not a user
            // turn. The text block is omitted when empty (image-only sends),
            // since providers reject empty text blocks.
            match messages.last_mut() {
                Some(last) if last.role == LlmRole::User => {
                    // Use the turn's already-built text, not request.user_message:
                    // the former includes any merged `$`-direct command context
                    // prepended above, which would otherwise be dropped here.
                    let text = match &last.content {
                        LlmContent::Text(t) => t.clone(),
                        _ => request.user_message.clone(),
                    };
                    let mut blocks: Vec<LlmBlock> = Vec::new();
                    if !text.trim().is_empty() {
                        blocks.push(LlmBlock::Text(text));
                    }
                    for att in &request.attachments {
                        blocks.push(LlmBlock::Image {
                            media_type: att.media_type.clone(),
                            data: att.data.clone(),
                        });
                    }
                    last.content = LlmContent::Multimodal(blocks);
                }
                _ => tracing::warn!(
                    "attachments present but the last message isn't a user turn; images dropped"
                ),
            }
        }

        // The project's CLAUDE.md chain (or AGENTS.md), re-read every turn so
        // an edit applies at once; unchanged files give the same text, so the
        // cached system block holds. Read on a blocking thread.
        let instructions = crate::project_instructions::for_workspace_off_runtime(workspace_path.clone()).await;
        let mut system_prompt = director_system_prompt(
            request.system.clone(),
            &request.workspace_path,
            &instructions.section,
            doctrine.as_deref(),
        );

        let mut tools = build_llm_tools();

        // ── Skills invoked by this message ───────────────────────
        // A message names the skills it wants as `/name` tokens (several,
        // anywhere in the text); each one's SKILL.md body is appended to the
        // system prompt FOR THIS TURN only — nothing is pinned to the
        // conversation, so a skill never rides on later messages unasked. The
        // tokens are resolved against the worktree's known skills, so prose
        // (`src/lib`, `and/or`) can never invoke one. On a regenerate the
        // message is the last user row, the same as on a fresh send.
        let turn_text: String = history
            .iter()
            .rev()
            .find(|m| m.role == "user")
            .map(|m| m.content.clone())
            .unwrap_or_else(|| request.user_message.clone());
        let mut invoked = crate::skills::referenced_skills(&workspace_path, &turn_text);
        if let Some(pinned) = request.skill.as_deref() {
            if !invoked.iter().any(|s| s.name == pinned) {
                if let Some(skill) = crate::skills::load_skill(&workspace_path, pinned) {
                    invoked.push(skill);
                }
            }
        }
        if !invoked.is_empty() {
            system_prompt.push_str(&crate::skills::skill_prompt_section(&invoked));
            // `allowed-tools`: the union across the invoked skills; a skill
            // that declares none opens the full set for the turn.
            let (allowed, open): (Vec<&Vec<String>>, bool) = invoked.iter().fold((Vec::new(), false), |(mut v, open), s| {
                match &s.allowed_tools {
                    Some(a) => v.push(a),
                    None => return (v, true),
                }
                (v, open)
            });
            if !open && !allowed.is_empty() {
                let filtered: Vec<LlmTool> = tools
                    .iter()
                    .filter(|t| allowed.iter().any(|list| list.iter().any(|a| a == &t.name)))
                    .cloned()
                    .collect();
                // A typo'd / unknown tool name would otherwise empty the set
                // and silently disable the agent — keep all tools + warn.
                if filtered.is_empty() {
                    tracing::warn!(
                        skills = ?invoked.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
                        "skill allowed-tools matched no known tools; keeping the full tool set"
                    );
                } else {
                    tools = filtered;
                }
            }
        }

        // ── Recall tool ───────────────────────────────────────────
        // Always available in TALK, after the skill filter: a skill's
        // allowed-tools list predates this tool, and recalling a stored
        // output is read-only — it can't widen what the skill permits.
        tools.push(recall_tool_definition());

        // ── Sub-agents ────────────────────────────────────────────
        // `Agent` (+ `Task` alias) — the fan-out tool Claude Code skills
        // expect. Same placement rationale as recall: always offered in TALK,
        // after the skill filter (skills written for Claude Code list `Agent`
        // in their allowed-tools, older ones list `Task`; either way the
        // filter must not strip it). Sub-agents themselves never get it. The
        // workspace's `.claude/agents/*.md` definitions are enumerated in the
        // tool description so the model can name them as `subagent_type`.
        let agent_defs = crate::skills::agents::scan_agent_definitions(&workspace_path);
        tools.extend(agent_tool_definitions(&agent_defs));

        // ── MCP tools ─────────────────────────────────────────────
        // Append tools exposed by configured MCP servers (namespaced
        // `mcp__server__tool`). Unreachable servers are skipped inside
        // list_tools. A skill's allowed-tools filter above doesn't touch these
        // (MCP tools are opt-in via the server config, not the skill).
        // Discovery runs off the async runtime thread, bounded by a timeout so
        // a hung server can't freeze the turn (`discover_mcp_tools`). Servers
        // the user switched off in this conversation (Companion "can use")
        // are left out and never started for it; the same path as
        // sub-agents'. What it offers is fixed for the turn.
        {
            let discovered = discover_thread_mcp_tools(
                Arc::clone(&self.mcp),
                &self.db,
                &request.workspace_path,
                &request.thread_id,
            )
            .await;
            // Discovery may have started servers or seen one fail: the
            // Companion's chips re-read their status.
            let _ = app.emit(crate::mcp::scope::STATUS_CHANGED_EVENT, ());
            // In `mcp::sort_tools` order (server, then tool): the same config
            // gives the same tool bytes on every turn, so the provider's
            // prompt cache, which starts at the tool list, survives.
            tools.extend(discovered.iter().map(crate::chat_agents::mcp_llm_tool));
        }

        let mut usage = TurnUsage::default();

        // ── Context budget ────────────────────────────────────────
        // Every request of the turn stays inside the model's window
        // (`context::budget`); system prompt and tools are fixed for the turn.
        let fixed_chars = budget::fixed_chars(&system_prompt, &tools);
        let mut model_budget = budget::ContextBudget::for_model(
            crate::orchestrator::cli_runner::catalog_context_window(&request.model),
            request.max_tokens.max(4096),
            request.effort,
        );
        // An id that names its window (`[1m]`) is never lowered.
        if crate::orchestrator::cli_runner::has_1m_suffix(&request.model) {
            model_budget = model_budget.with_fixed_window();
        }
        let mut context_guard = budget::ContextGuard::new(model_budget, budget::load_learned(&self.db.lock(), &request.model));
        // Each tool call's stored row, which a stub names for recall.
        let mut tool_rows: HashMap<String, i64> = HashMap::new();

        // Snapshot files already modified before this turn started. Anything
        // present here was the user's own change — we won't credit it to the
        // agent even if a later iteration touches the same file.
        let initial_modified = git_status_files(&workspace_path);

        // Track which (file, msg_id) pairs we've already inserted so the
        // git-status fallback doesn't double-up rows the write_file branch
        // already wrote.
        let mut attributed: std::collections::HashSet<(String, i64)> =
            std::collections::HashSet::new();

        // Tool-call rounds this turn may run: the saved "Limit tool turns per
        // message" preference (Settings › General), clamped — or, unset, no
        // limit: the turn runs until the model answers or the user stops it.
        let saved_settings = crate::settings::load_settings().ok();
        let max_iterations = effective_talk_max_iterations(
            saved_settings.as_ref().and_then(|s| s.talk_max_iterations),
        );
        // Sub-agents have no turn limit unless one is configured (Settings ›
        // General › "Limit sub-agent tool turns", or a definition's own
        // `max-turns`, which applies under a set preference).
        let subagent_cap = effective_subagent_max_iterations(
            saved_settings.as_ref().and_then(|s| s.subagent_max_turns),
        );

        // How long to pause before the next request, from the previous
        // response's rate-limit headroom (`compute_throttle`, the sub-agents'
        // rule): riding out a nearly spent input-token window beats charging
        // into a 429.
        let mut pending_throttle: Option<u64> = None;

        // ─── Agentic loop ─────────────────────────────────────────
        for iteration in 0..max_iterations.unwrap_or(usize::MAX) {
            // Stop cleanly if the user cancelled this turn. Checked here and
            // after each tool; a request in flight is abandoned by
            // `director_call` itself.
            if cancel.load(Ordering::Relaxed) {
                self.finish_stopped(&app, &request.workspace_id, &request.thread_id, &request.model, &usage)?;
                return Ok(());
            }

            // Phase 3 — per-iteration budget enforcement. The entry gate in
            // `send_chat_message` authorized this turn's FIRST provider call;
            // this gate stops a runaway agentic loop that keeps accumulating
            // spend across up to `max_iterations` calls and crosses a
            // configured budget mid-turn. The decision lives in the unit-tested
            // `should_stop_for_budget`; the outer guard only avoids the DB query
            // when the answer is trivially no (iteration 0 — owned by the entry
            // gate — or an overridden turn). This runs at the top of the loop
            // where `messages` is consistent (every prior tool_use already has
            // its tool_result). Bind the verdict to a `let` BEFORE acting so the
            // parking_lot guard drops — `finish_budget_capped` re-locks the db
            // and would otherwise re-entrant-deadlock on edition 2021.
            if iteration > 0 && !request.override_budget {
                let verdict = self.db.lock().check_budget(Some(&request.workspace_id))?;
                if should_stop_for_budget(iteration, request.override_budget, &verdict) {
                    self.finish_budget_capped(&app, &request.workspace_id, &request.thread_id, &request.model, &usage)?;
                    return Ok(());
                }
            }

            if let Some(wait) = pending_throttle.take() {
                self.emit_turn_notice(&app, &request.workspace_id, &request.thread_id, &throttle_notice(wait), wait);
                if !interruptible_sleep(wait, &cancel).await {
                    self.finish_stopped(&app, &request.workspace_id, &request.thread_id, &request.model, &usage)?;
                    return Ok(());
                }
            }

            // The round boundary: every tool_use has its result.
            self.guard_context(&app, &request, &context_guard, &mut messages, fixed_chars, &tool_rows);

            let response = loop {
                let llm_req = director_request(&request, &system_prompt, &messages, &tools);
                context_guard.sent(fixed_chars, &messages);
                match self
                    .director_call(
                        &app,
                        &request.workspace_id,
                        &request.thread_id,
                        provider.as_ref(),
                        &api_base,
                        api_key.as_deref(),
                        &llm_req,
                        &cancel,
                    )
                    .await
                {
                    Completion::Done(r) => break r,
                    // Stopped mid-request or mid-backoff: the same quiet ending as
                    // a stop between rounds. Every earlier round's rows are
                    // already persisted; the abandoned request left none.
                    Completion::Cancelled => {
                        self.finish_stopped(&app, &request.workspace_id, &request.thread_id, &request.model, &usage)?;
                        return Ok(());
                    }
                    Completion::Failed { error, retries } => {
                        // A prompt too long for the model is stubbed to fit
                        // and sent once more (`ContextGuard::after_failure`).
                        let next = context_guard.after_failure(&error, &mut messages, fixed_chars, &tool_rows);
                        if next.save {
                            self.save_context_budget(&request.model, context_guard.learned());
                        }
                        if let Some(line) = next.retry {
                            tracing::warn!("Talk director: prompt too long; compacted, retrying once");
                            self.emit_turn_notice(&app, &request.workspace_id, &request.thread_id, &line, CONTEXT_NOTICE_SECS);
                            continue;
                        }
                        return Err(self.fail_turn(&app, &request.workspace_id, &request.thread_id, error, retries));
                    }
                }
            };
            if context_guard.observed(&response) {
                self.save_context_budget(&request.model, context_guard.learned());
            }

            usage.add(&request.model, &response);
            self.record_usage(&request.workspace_id, &request.thread_id, &request.model, &response);
            pending_throttle = compute_throttle(&response);

            tracing::info!(
                iteration = iteration,
                stop_reason = ?response.stop_reason,
                text_len = response.text.len(),
                tool_count = response.tool_uses.len(),
                "agentic loop iteration"
            );

            let is_final = response.stop_reason != LlmStopReason::ToolUse
                || response.tool_uses.is_empty();

            // Only emit text as a stream delta for the FINAL response
            // (when the model is done with tools). Intermediate text (said
            // before tool calls) would concatenate with the final text
            // in the frontend's streamBuffer, creating a garbled message.
            // Tool cards already show what the model is doing.
            if is_final && !response.text.is_empty() {
                let _ = app.emit("chat://stream", &ChatStreamEvent {
                    workspace_id: request.workspace_id.clone(),
                    thread_id: request.thread_id.clone(),
                    delta: response.text.clone(),
                    done: false,
                    input_tokens: None,
                    output_tokens: None,
                });
            }

            // Handle max_tokens truncation during tool use.
            if matches!(response.stop_reason, LlmStopReason::MaxTokens) && !response.tool_uses.is_empty() {
                tracing::warn!("Response truncated at max_tokens during tool_use — providing error tool_results and retrying");
                // Add the truncated assistant message to history, its leading
                // signed thinking kept.
                messages.push(truncated_round_turn(&response));
                // Provide error tool_results for each tool_use (API requires matching pairs).
                let error_results: Vec<LlmToolResult> = response.tool_uses.iter().map(|u| LlmToolResult {
                    tool_use_id: u.id.clone(),
                    content: "ERROR: Your response was truncated because it exceeded the output token limit. The file content was cut off and NOT written. Please retry with smaller files — split into multiple files or keep each under 200 lines. Write one file at a time.".to_string(),
                    is_error: true,
                }).collect();
                messages.push(LlmMessage {
                    role: LlmRole::User,
                    content: LlmContent::ToolResults(error_results),
                });
                continue;
            }

            // If no tool use, we're done — this was the final response.
            if is_final {
                let final_text = response.text.trim().to_string();

                // Persist final assistant message and emit message-added. Order matters:
                // this event must arrive before the done event so the frontend has the
                // final message before it clears the streaming bubble.
                if !final_text.is_empty() {
                    self.insert_and_emit_priced(
                        &app,
                        &request.workspace_id,
                        &request.thread_id,
                        "assistant",
                        &final_text,
                        &request.model,
                        &usage,
                    )?;
                }

                // `send_agentic` sends `done` (pure metadata) once the turn
                // has released its thread; the answer went out above.
                return Ok(());
            }

            // ─── Handle tool use ──────────────────────────────────
            // Persist the assistant message that contains the tool_use blocks,
            // so we can link file edits back to this assistant message.
            let assistant_msg_id = {
                // Build a JSON summary of the tool calls as the persisted content.
                let tool_summary: Vec<serde_json::Value> = response.tool_uses.iter().map(|u| {
                    serde_json::json!({ "toolName": u.name, "toolInput": u.input })
                }).collect();
                let content = if !response.text.is_empty() {
                    format!("{}\n\n[tool_calls: {}]", response.text,
                        serde_json::to_string(&tool_summary).unwrap_or_default())
                } else {
                    format!("[tool_calls: {}]",
                        serde_json::to_string(&tool_summary).unwrap_or_default())
                };
                // Emitted live too: the text the model wrote before its tool
                // calls is its reasoning-in-the-open ("the tests import X, so
                // let me check…"), and a turn of ten silent rounds reads as a
                // black box without it. The frontend renders it as a quiet
                // narration line, never as an answer bubble.
                match self.insert_and_emit_message(
                    &app,
                    &request.workspace_id,
                    &request.thread_id,
                    "assistant_tool_use",
                    &content,
                    Some(&request.model),
                    None, None, None,
                ) {
                    Ok(id) => id,
                    Err(e) => {
                        tracing::warn!(error = %e, "failed to persist assistant_tool_use message");
                        -1_i64
                    }
                }
            };

            // Add assistant message with tool_use content to conversation,
            // its content blocks verbatim (`tool_round_turn`).
            messages.push(tool_round_turn(&response));

            // ── Sub-agents: fan out first ──────────────────────────
            // Every `Agent` call in this response runs CONCURRENTLY (that is
            // how a skill parallelizes: several tool_use blocks in one
            // message). Their live cards open now; the sequential loop below
            // only picks up the finished outcomes so tool_results keep the
            // response's order. A malformed call fails fast with the parse
            // error as its report instead of occupying a slot.
            let mut agent_outcomes: HashMap<String, AgentOutcome> = HashMap::new();
            // Each sub-agent's plan (model · tier · effort), kept for its
            // persisted row after the fan-out consumed the specs.
            let mut agent_plans: HashMap<String, SubagentPlan> = HashMap::new();
            {
                let mut specs: Vec<SubagentSpec> = Vec::new();
                let has_agents = response.tool_uses.iter().any(|u| is_agent_tool(&u.name));
                // The catalog + tier map, read once per fan-out, so every
                // call's plan is decided BEFORE its card opens.
                let (known_models, tiers) = if has_agents { model_catalog() } else { (Vec::new(), HashMap::new()) };
                for u in response.tool_uses.iter().filter(|u| is_agent_tool(&u.name)) {
                    let parsed = parse_agent_call(&u.input);
                    let mut planned: Option<(SubagentSpec, SubagentPlan)> = None;
                    if let Ok(call) = &parsed {
                        let definition = call
                            .subagent_type
                            .as_deref()
                            .and_then(|t| crate::skills::agents::find_agent_definition(&agent_defs, t))
                            .cloned();
                        let mut spec = SubagentSpec {
                            call_id: u.id.clone(),
                            call: call.clone(),
                            workspace_id: request.workspace_id.clone(),
                            thread_id: request.thread_id.clone(),
                            workspace_path: request.workspace_path.clone(),
                            default_model: request.model.clone(),
                            max_iterations: subagent_iterations(
                                definition.as_ref().and_then(|d| d.max_turns),
                                subagent_cap,
                            ),
                            max_tokens: request.max_tokens,
                            sandbox_roots: sandbox_roots.clone(),
                            definition,
                            policy_auto,
                            resume: None,
                            plan: None,
                        };
                        let plan = plan_subagent(&spec, &known_models, &tiers);
                        spec.plan = Some(plan.clone());
                        planned = Some((spec, plan));
                    }
                    // The live card opens for every call, well-formed or not,
                    // so a parse failure flips it to failed instead of leaving
                    // a tool-end with no card to land on. It carries the plan,
                    // so the row says what the run uses from its first second.
                    let _ = app.emit("chat://tool-start", &ToolStartEvent {
                        workspace_id: request.workspace_id.clone(),
                        thread_id: request.thread_id.clone(),
                        call_id: u.id.clone(),
                        tool_name: u.name.clone(),
                        tool_input: match (&parsed, &planned) {
                            (Ok(call), Some((_, plan))) => agent_input_for_display(call, Some(plan)),
                            (Ok(call), None) => agent_input_for_display(call, None),
                            _ => u.input.clone(),
                        },
                        started_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, true),
                    });
                    match (parsed, planned) {
                        (Ok(_), Some((spec, plan))) => {
                            agent_plans.insert(u.id.clone(), plan);
                            specs.push(spec);
                        }
                        (Ok(_), None) => unreachable!("a parsed call is always planned"),
                        (Err(msg), _) => {
                            agent_outcomes.insert(
                                u.id.clone(),
                                AgentOutcome { report: msg, ok: false, ..AgentOutcome::default() },
                            );
                        }
                    }
                }
                if !specs.is_empty() {
                    tracing::info!(agents = specs.len(), "fanning out sub-agents");
                    let done = run_subagents(
                        app.clone(),
                        Arc::clone(&self.db),
                        self.client.clone(),
                        self.approvals(),
                        Arc::clone(&self.mcp),
                        specs,
                        Arc::clone(&cancel),
                        Some(Arc::clone(&self.cap_gate)),
                    )
                    .await;
                    // Sub-agent spend goes to the ledger under ITS model (a
                    // `model` override may differ from the thread's), so the
                    // Companion CONTEXT card and Settings · Usage see the
                    // fan-out. The parent's own totals stay parent-only: its
                    // assistant row is priced at the parent model.
                    // An escalated sub-agent bills every attempt at its own
                    // model's price, so each attempt is its own ledger row.
                    for (call_id, o) in done.iter() {
                        self.record_subagent_spend(&request.workspace_id, &request.thread_id, call_id, o);
                    }
                    agent_outcomes.extend(done);
                }
            }

            // Execute each tool, persist to DB, and collect results.
            let mut tool_results: Vec<LlmToolResult> = Vec::new();
            for u in &response.tool_uses {
                // Honor a cancel that landed between tools — stop before
                // kicking off another (possibly long) tool.
                if cancel.load(Ordering::Relaxed) {
                    self.finish_stopped(&app, &request.workspace_id, &request.thread_id, &request.model, &usage)?;
                    return Ok(());
                }
                tracing::info!(tool = %u.name, "executing tool");

                // Build the display-safe input ONCE, up front: strip large
                // write_file bodies (already destined for disk) so neither the
                // live-card event nor the persisted record carries multi-KB
                // JSON. Reused for tool-start, persistence, and the message.
                let is_agent = is_agent_tool(&u.name);
                let input_for_display = if is_agent {
                    parse_agent_call(&u.input)
                        .map(|c| agent_input_for_display(&c, agent_plans.get(&u.id)))
                        .unwrap_or_else(|_| u.input.clone())
                } else if u.name == "write_file" {
                    let mut display = u.input.clone();
                    if let Some(content) = display.get("content").and_then(|c| c.as_str()) {
                        let len = content.len();
                        display["content"] = serde_json::json!(format!("({len} chars, written to disk)"));
                    }
                    display
                } else {
                    u.input.clone()
                };

                // ── Approval gate (agent run_command only) ────────────
                // A command flagged destructive pauses for the user's OK before
                // it runs. User-typed `$` commands meet only the secret guard.
                // A denial skips execution and tells the model the user
                // declined. The secret guard asks first (#819): a thread's
                // "don't ask again" covers the destructive check, never it.
                let mut denied: Option<String> = None;
                if u.name == "run_command" {
                    let command = u.input.get("command").and_then(|c| c.as_str()).unwrap_or("");
                    denied = guard_agent_command(
                        &self.approvals,
                        &app,
                        &request.workspace_id,
                        &request.thread_id,
                        &u.id,
                        command,
                        &request.workspace_path,
                        None,
                    )
                    .await;
                    if let Some(reason) = dangerous_command(command).filter(|_| denied.is_none()) {
                        match self
                            .await_approval(
                                &app,
                                &request.workspace_id,
                                &request.thread_id,
                                &u.id,
                                command,
                                reason,
                            )
                            .await
                        {
                            ApprovalDecision::Approve | ApprovalDecision::ApproveAlways => {}
                            ApprovalDecision::Deny => {
                                denied = Some(format!(
                                    "Command not run — the user declined to approve it \
                                     (flagged: {reason}). Ask the user how to proceed or try \
                                     a safer alternative."
                                ));
                            }
                        }
                    }
                }

                // ── Live card: announce the tool is starting ──────────
                // (Sub-agent cards opened in the fan-out above.)
                let call_started = std::time::Instant::now();
                if !is_agent {
                    let _ = app.emit("chat://tool-start", &ToolStartEvent {
                        workspace_id: request.workspace_id.clone(),
                        thread_id: request.thread_id.clone(),
                        call_id: u.id.clone(),
                        tool_name: u.name.clone(),
                        tool_input: input_for_display.clone(),
                        started_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, true),
                    });
                }

                // Absolute cwd a run_command executed in (shared shell), captured
                // so its card can show the cwd badge. Empty for other tools.
                let mut run_command_cwd = String::new();
                // The shared shell's exit status, for the row's verdict.
                let mut run_command_exit: Option<i32> = None;
                // Stop interrupted the command: it reads as stopped.
                let mut interrupted = false;
                // Not run: denied at its card, or its MCP server is off here.
                let mut was_denied = denied.is_some();

                // Route MCP tools (`mcp__server__tool`) to their server; all
                // other names are built-in workspace tools. MCP calls run off
                // the runtime thread with a timeout so a slow/hung server
                // surfaces as a tool error instead of freezing the turn.
                // A sub-agent's outcome was collected in the fan-out; its
                // meta rides on the persisted tool row (`agent` key).
                let mut agent_meta: Option<AgentOutcome> = None;
                // An MCP result whose binary payloads the model reads as
                // placeholders: the original, kept on the row for recall.
                let mut mcp_original: Option<String> = None;
                let (result, ok) = if let Some(msg) = denied {
                    (msg, false)
                } else if is_agent {
                    let outcome = agent_outcomes.remove(&u.id).unwrap_or_else(|| AgentOutcome {
                        report: "Sub-agent produced no outcome (internal error)".to_string(),
                        ok: false,
                        ..AgentOutcome::default()
                    });
                    let pair = (outcome.report.clone(), outcome.ok);
                    agent_meta = Some(outcome);
                    pair
                } else if u.name == RECALL_TOOL_NAME {
                    self.recall_tool_output(&request.thread_id, &u.input)
                } else if let Some(refusal) = crate::mcp::is_mcp_tool(&u.name)
                    .then(|| mcp_off_refusal(&u.name, &thread_mcp_off(&self.db, &request.thread_id)))
                    .flatten()
                {
                    // The list as it is now, not at the turn's start: a server
                    // turned off mid-turn stops here, one turned back on runs.
                    // (A call to a server not offered this turn can still be
                    // copied from an earlier turn's history.) The user's own
                    // setting refused it: its row reads as denied.
                    was_denied = true;
                    (refusal, false)
                } else if crate::mcp::is_mcp_tool(&u.name) {
                    // Bounded, and a timeout STOPS the server so the call can
                    // never complete later in the background.
                    match crate::mcp::call_bounded(
                        Arc::clone(&self.mcp),
                        workspace_path.clone(),
                        u.name.clone(),
                        u.input.clone(),
                        crate::mcp::CALL_TIMEOUT,
                    )
                    .await
                    {
                        Ok(out) => {
                            mcp_original = out.original;
                            (out.text, true)
                        }
                        Err(e) => (e, false),
                    }
                } else if u.name == "run_command" && self.talk_shell.available() && sandbox_roots.is_none() {
                    // Unify with `$`-direct: the agent runs commands in the SAME
                    // persistent shell, so it shares the user's cwd/env. Capture
                    // (Sandboxed missions skip the shared shell and fall through to
                    // the seatbelt-wrapped execute_tool below — per-command
                    // isolation over shared-shell state.)
                    // to completion with a timeout (which `execute_tool` lacked).
                    let command = u
                        .input
                        .get("command")
                        .and_then(|c| c.as_str())
                        .unwrap_or("")
                        .to_string();
                    let shell = Arc::clone(&self.talk_shell);
                    let tid = request.thread_id.clone();
                    let wp = request.workspace_path.clone();
                    // Generous cap so legitimate long builds/installs/test suites
                    // (which the old execute_tool path ran un-timed) complete; only
                    // a true hang is interrupted. Cancellable: if Stop is pressed
                    // while it blocks, interrupt the shell so the capture returns
                    // promptly instead of waiting out the full timeout.
                    let jh = tokio::task::spawn_blocking(move || {
                        shell.run_capture(&tid, &wp, &command, std::time::Duration::from_secs(600))
                    });
                    tokio::pin!(jh);
                    let join_result = loop {
                        tokio::select! {
                            r = &mut jh => break r,
                            _ = tokio::time::sleep(std::time::Duration::from_millis(250)) => {
                                if cancel.load(Ordering::Relaxed) {
                                    self.talk_shell.interrupt(&request.thread_id);
                                    interrupted = true;
                                }
                            }
                        }
                    };
                    match join_result {
                        Ok(Ok(crate::talk_shell::CaptureOutcome::Done(r))) => {
                            // Record where it ran (absolute) so the card shows the
                            // cwd badge, matching `$`-direct.
                            run_command_cwd = r.cwd.clone();
                            run_command_exit = Some(r.exit_code);
                            // Keep the composer's cwd badge accurate if the agent
                            // `cd`'d the shared shell.
                            if !r.cwd.is_empty() {
                                let _ = app.emit("chat://shell-cwd", &ShellCwdEvent {
                                    thread_id: request.thread_id.clone(),
                                    cwd: r.cwd.clone(),
                                    cwd_label: relativize_cwd(&r.cwd, &request.workspace_path),
                                });
                            }
                            (format_command_output(&r.output, r.exit_code), r.ok)
                        }
                        // Shared shell unavailable (a live `$` process holds it, or
                        // a transient error). Run THIS command in an isolated shell
                        // so the agent isn't blocked — but say so explicitly, since
                        // it runs at the workspace root, not the shared cwd. The
                        // fallback is itself bounded (off-thread + timeout) so it
                        // can't hang the turn.
                        other => {
                            let reason = match other {
                                Ok(Ok(crate::talk_shell::CaptureOutcome::Busy)) =>
                                    "a live process is using the shared shell".to_string(),
                                Ok(Err(e)) => e.to_string(),
                                _ => "the shared shell task failed".to_string(),
                            };
                            let wp = workspace_path.clone();
                            let name = u.name.clone();
                            let input = u.input.clone();
                            let (out, ok) = match tokio::time::timeout(
                                std::time::Duration::from_secs(600),
                                // This fallback is only reached for a non-sandboxed
                                // mission (the shared-shell branch is gated on
                                // sandbox_roots.is_none()), so it runs unconfined.
                                tokio::task::spawn_blocking(move || execute_tool(&wp, &name, &input, None)),
                            )
                            .await
                            {
                                Ok(Ok((o, k))) => (o, k),
                                _ => ("(isolated fallback timed out or failed)".to_string(), false),
                            };
                            (
                                format!(
                                    "(ran in an isolated shell at the workspace root — {reason})\n{out}"
                                ),
                                ok,
                            )
                        }
                    }
                } else {
                    execute_tool(&workspace_path, &u.name, &u.input, sandbox_roots.as_deref())
                };

                // ── Live card: announce completion (timing + status) ──
                let _ = app.emit("chat://tool-end", &ToolEndEvent {
                    workspace_id: request.workspace_id.clone(),
                    thread_id: request.thread_id.clone(),
                    call_id: u.id.clone(),
                    ok,
                    duration_ms: agent_meta
                        .as_ref()
                        .map(|m| m.duration_ms)
                        .unwrap_or_else(|| call_started.elapsed().as_millis() as u64),
                });

                // If the tool wrote a file, record it in file_edits for the Review canvas.
                if u.name == "write_file" || u.name == "edit_file" {
                    if let Some(path) = u.input.get("path").and_then(|p| p.as_str()) {
                        let msg_id = if assistant_msg_id >= 0 { Some(assistant_msg_id) } else { None };
                        if let Err(e) = self.db.lock().insert_file_edit(
                            &request.workspace_id,
                            path,
                            &u.name,
                            msg_id,
                        ) {
                            tracing::warn!(tool = %u.name, path = path, error = %e, "failed to record file edit");
                        } else if assistant_msg_id >= 0 {
                            attributed.insert((path.to_string(), assistant_msg_id));
                        }
                    }
                }

                // Persist tool execution as role="tool" and emit message-added.
                // `callId` correlates this resolved card back to the live card
                // created by the earlier tool-start event so the frontend can
                // retire the spinner without a flash.
                // For run_command, annotate the card with where it ran (the
                // shared shell's cwd) so the agent's commands show a cwd badge
                // just like `$`-direct ones.
                let display_input = if u.name == "run_command" {
                    tool_input_with_cwd(&input_for_display, &run_command_cwd, &request.workspace_path)
                } else {
                    input_for_display
                };
                let mut tool_record = tool_row(
                    &u.id,
                    &u.name,
                    display_input,
                    &result,
                    RowVerdict { ok, denied: was_denied, exit_code: run_command_exit, stopped: interrupted },
                );
                if let Some(meta) = &agent_meta {
                    // Report already sits in `result`; the meta is what the
                    // card's collapsed summary shows (tokens, cost, ending).
                    let mut m = serde_json::to_value(meta).unwrap_or_default();
                    if let Some(obj) = m.as_object_mut() {
                        obj.remove("report");
                    }
                    tool_record["agent"] = m;
                }
                // The thread may have been deleted while the turn was parked (a
                // tool running, or an approval card awaiting the user). Skip the
                // persist so we don't leave an orphaned tool row.
                let thread_alive = self
                    .db
                    .lock()
                    .chat_thread_exists(&request.thread_id)
                    .unwrap_or(true);
                let mut row_id: Option<i64> = None;
                if thread_alive {
                    match self.insert_and_emit_message(
                        &app,
                        &request.workspace_id,
                        &request.thread_id,
                        "tool",
                        &tool_record.to_string(),
                        None, None, None, None,
                    ) {
                        // The saved run points at its row so a continuation
                        // can rewrite the report in place.
                        Ok(id) if is_agent => {
                            row_id = Some(id);
                            if let Err(e) = self.db.lock().set_chat_agent_run_message(&u.id, id) {
                                tracing::warn!(error = %e, "failed to link sub-agent run to its row");
                            }
                        }
                        Ok(id) => {
                            row_id = Some(id);
                            // The row's `result` is what the model, the card
                            // and later turns read. The original goes to its
                            // own table, capped, for recall only: the webview
                            // never receives it.
                            if let Some(original) = mcp_original.take() {
                                if let Err(e) = self.db.lock().set_chat_tool_original(id, &request.thread_id, &original) {
                                    tracing::warn!(error = %e, "failed to keep the original MCP output for recall");
                                }
                            }
                        }
                        Err(e) => {
                            tracing::error!(tool = %u.name, error = %e, "failed to persist tool execution");
                        }
                    }
                }

                if let Some(id) = row_id {
                    tool_rows.insert(u.id.clone(), id);
                }
                // The row keeps the whole result; an MCP result is capped
                // in the copy the next round carries.
                tool_results.push(LlmToolResult {
                    tool_use_id: u.id.clone(),
                    content: crate::chat_history::tool_result_for_model(&u.name, result, row_id),
                    is_error: false,
                });
            }

            // ── Catch-all file-edit attribution ───────────────────
            // Some tools (most commonly `run_command` with sed/awk/redirects)
            // change files without going through write_file. Snapshot git
            // status now and credit any file that's newly changed (or not
            // already attributed to this assistant message) to the current
            // assistant_msg_id, so the Review canvas can always show the
            // agent message that produced the change.
            if assistant_msg_id >= 0 {
                let current_modified = git_status_files(&workspace_path);
                for path in &current_modified {
                    // Skip files the user had already modified before this
                    // turn started — those are not agent-attributable unless
                    // a tool that ran during this turn changed them again.
                    if initial_modified.contains(path) {
                        // Determine if the file was actually touched this
                        // iteration by checking whether any tool's input
                        // mentions it (best-effort heuristic).
                        let touched = response.tool_uses.iter().any(|u| {
                            serde_json::to_string(&u.input)
                                .map(|s| s.contains(path.as_str()))
                                .unwrap_or(false)
                        });
                        if !touched {
                            continue;
                        }
                    }
                    let key = (path.clone(), assistant_msg_id);
                    if attributed.contains(&key) {
                        continue;
                    }
                    if let Err(e) = self.db.lock().insert_file_edit(
                        &request.workspace_id,
                        path,
                        "agent_edit",
                        Some(assistant_msg_id),
                    ) {
                        tracing::warn!(path = %path, error = %e, "failed to record agent file edit");
                    } else {
                        attributed.insert(key);
                    }
                }
            }

            // Add tool results as user message and continue the loop.
            messages.push(LlmMessage {
                role: LlmRole::User,
                content: LlmContent::ToolResults(tool_results),
            });

            tracing::info!(
                iteration = iteration,
                tools = response.tool_uses.len(),
                "agentic loop: executed {} tool(s), continuing",
                response.tool_uses.len()
            );
        }

        // ─── Cap reached: forced close ────────────────────────────
        // The limit landed mid-work. Before declaring the turn lost, ask for
        // ONE more response with the same tool list but an instruction not to
        // call any tool ("write your final answer with what you have"). The
        // rounds of good work used to be thrown away because the model never
        // got to write its closing summary; a possibly-incomplete but real
        // answer beats an empty failure. (Mirrors `orchestrator::agentic`.)
        if cancel.load(Ordering::Relaxed) {
            self.finish_stopped(&app, &request.workspace_id, &request.thread_id, &request.model, &usage)?;
            return Ok(());
        }
        self.guard_context(&app, &request, &context_guard, &mut messages, fixed_chars, &tool_rows);
        let close_req = forced_close_request(&request, &system_prompt, &mut messages, &tools);
        if let Some(wait) = pending_throttle.take() {
            self.emit_turn_notice(&app, &request.workspace_id, &request.thread_id, &throttle_notice(wait), wait);
            if !interruptible_sleep(wait, &cancel).await {
                self.finish_stopped(&app, &request.workspace_id, &request.thread_id, &request.model, &usage)?;
                return Ok(());
            }
        }
        // Only reachable with a configured limit (an unlimited loop never
        // exhausts); the wording names it.
        let limit = match max_iterations {
            Some(n) => format!("{n}-turn tool limit"),
            None => "tool-turn limit".to_string(),
        };
        tracing::info!(
            max_iterations = ?max_iterations,
            "agentic loop: iteration cap reached — asking the model to close with what it has"
        );
        match self
            .director_call(
                &app,
                &request.workspace_id,
                &request.thread_id,
                provider.as_ref(),
                &api_base,
                api_key.as_deref(),
                &close_req,
                &cancel,
            )
            .await
        {
            Completion::Done(response) => {
                usage.add(&request.model, &response);
                self.record_usage(&request.workspace_id, &request.thread_id, &request.model, &response);
                let final_text = response.text.trim().to_string();
                if !final_text.is_empty() {
                    let _ = app.emit("chat://stream", &ChatStreamEvent {
                        workspace_id: request.workspace_id.clone(),
                        thread_id: request.thread_id.clone(),
                        delta: final_text.clone(),
                        done: false,
                        input_tokens: None,
                        output_tokens: None,
                    });
                    self.insert_and_emit_priced(
                        &app,
                        &request.workspace_id,
                        &request.thread_id,
                        "assistant",
                        &final_text,
                        &request.model,
                        &usage,
                    )?;
                    // The quiet note explains WHY the answer may be partial and
                    // where the limit lives. Tokens/cost already sit on the
                    // assistant row, so the note carries none.
                    self.finish_with_note(
                        &app,
                        &request.workspace_id,
                        &request.thread_id,
                        &request.model,
                        &TurnUsage::default(),
                        &format!(
                            "Reached the {limit} — answered with what it had. \
                             Say \"continue\" to pick up where it left off, or raise or switch off the limit in Settings › General."
                        ),
                    )?;
                    return Ok(());
                }
                tracing::warn!("forced close returned no text; surfacing the cap as an error");
            }
            Completion::Cancelled => {
                self.finish_stopped(&app, &request.workspace_id, &request.thread_id, &request.model, &usage)?;
                return Ok(());
            }
            Completion::Failed { error, .. } => {
                tracing::warn!(error = %error, "forced close failed; surfacing the cap as an error");
            }
        }

        let loop_err = AppError::Other(format!(
            "Stopped at the {limit} before finishing. Say \"continue\" to \
             pick up where it left off, or raise or switch off the limit in Settings › General."
        ));
        // Persist the error so it survives a relaunch.
        let error_text = format!("{loop_err}");
        if let Err(persist_err) = self.insert_and_emit_message(
            &app,
            &request.workspace_id,
            &request.thread_id,
            "error",
            &error_text,
            None, None, None, None,
        ) {
            tracing::error!(error = %persist_err, "failed to persist error message");
        }
        Err(loop_err)
    }
}

/// Return the set of files reported as modified, added, or untracked by
/// `git status --porcelain` inside `workspace_path`. Used to credit file
/// changes to the current agent turn when a tool other than write_file
/// (e.g. run_command with sed) is what actually modified the file.
fn git_status_files(workspace_path: &std::path::Path) -> std::collections::HashSet<String> {
    let mut files = std::collections::HashSet::new();
    let output = std::process::Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(workspace_path)
        .output();
    let Ok(output) = output else { return files };
    if !output.status.success() {
        return files;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        // Format: "XY path" — X = index status, Y = worktree status.
        // Renames look like "R  old -> new"; we keep only the new name.
        if line.len() < 4 {
            continue;
        }
        let rest = &line[3..];
        let path = if let Some(idx) = rest.find(" -> ") {
            &rest[idx + 4..]
        } else {
            rest
        };
        files.insert(path.trim().to_string());
    }
    files
}

#[cfg(test)]
mod continuation_tests {
    use super::*;
    use crate::chat_agents::AgentAttempt;

    #[test]
    fn continuation_note_carries_the_turn_budget_and_the_users_words() {
        let plain = continuation_note(None, Some(15));
        assert!(plain.starts_with("You have 15 more tool turns"), "{plain}");
        assert!(plain.contains("do not redo work already done"));
        let one = continuation_note(Some("  "), Some(1));
        assert!(one.starts_with("You have 1 more tool turn —"), "{one}");
        let answered = continuation_note(Some("Use the staging DB."), Some(5));
        assert!(answered.starts_with("A message from the user: Use the staging DB.\n\n"), "{answered}");
        assert!(answered.contains("You have 5 more tool turns"));
        let open = continuation_note(None, None);
        assert!(open.starts_with("You have no turn limit"), "{open}");
        assert!(open.contains("continue exactly where you left off"));
    }

    #[test]
    fn merge_continued_meta_sums_both_runs_and_keeps_the_new_ending() {
        let old = serde_json::json!({
            "ok": false, "finished": false, "closedAtCap": true, "blocked": false,
            "model": "haiku", "tier": "fast", "escalatedFrom": null,
            "inputTokens": 1000, "outputTokens": 200, "cacheReadTokens": 500, "cacheCreationTokens": 0,
            "costUsd": 0.10, "durationMs": 4000, "toolCalls": 15, "attempts": []
        });
        let new = AgentOutcome {
            report: "done now".into(),
            ok: true,
            finished: true,
            closed_at_cap: false,
            model: "haiku".into(),
            tier: Some("fast".into()),
            input_tokens: 300,
            output_tokens: 100,
            cache_read_tokens: 700,
            cost_usd: 0.04,
            duration_ms: 1500,
            tool_calls: 4,
            continued: true,
            ..AgentOutcome::default()
        };
        let m = merge_continued_meta(&old, &new);
        assert_eq!(m["ok"], true);
        assert_eq!(m["closedAtCap"], false);
        assert_eq!(m["continued"], true);
        assert!(m.get("report").is_none(), "the report rides on `result`, never the meta");
        assert_eq!(m["inputTokens"], 1300);
        assert_eq!(m["outputTokens"], 300);
        assert_eq!(m["cacheReadTokens"], 1200);
        assert_eq!(m["toolCalls"], 19);
        assert_eq!(m["durationMs"], 5500);
        assert!((m["costUsd"].as_f64().unwrap() - 0.14).abs() < 1e-9);
        // The first run becomes attempt #1, the continuation attempt #2.
        let attempts = m["attempts"].as_array().unwrap();
        assert_eq!(attempts.len(), 2);
        assert_eq!(attempts[0]["inputTokens"], 1000);
        assert_eq!(attempts[1], serde_json::to_value(AgentAttempt::from_outcome(&new)).unwrap());
    }

    #[test]
    fn merge_continued_meta_keeps_an_earlier_escalation() {
        let old = serde_json::json!({ "model": "sonnet", "escalatedFrom": "haiku", "inputTokens": 10, "outputTokens": 1, "costUsd": 0.0,
            "attempts": [{"model":"haiku","inputTokens":5,"outputTokens":1,"cacheReadTokens":0,"cacheCreationTokens":0,"costUsd":0.0},
                         {"model":"sonnet","inputTokens":5,"outputTokens":0,"cacheReadTokens":0,"cacheCreationTokens":0,"costUsd":0.0}] });
        let new = AgentOutcome { model: "sonnet".into(), ok: true, input_tokens: 2, ..AgentOutcome::default() };
        let m = merge_continued_meta(&old, &new);
        assert_eq!(m["escalatedFrom"], "haiku");
        assert_eq!(m["attempts"].as_array().unwrap().len(), 3);
        assert_eq!(m["inputTokens"], 12);
    }

    #[test]
    fn turn_usage_prices_each_round_with_its_cache_split_and_keeps_the_last_prompt_size() {
        let r = |input: u64, output: u64, read: u64, write: u64| crate::providers::LlmResponse {
            text: String::new(),
            tool_uses: vec![],
            stop_reason: crate::providers::LlmStopReason::EndTurn,
            input_tokens: input,
            output_tokens: output,
            cache_read_tokens: read,
            cache_creation_tokens: write,
            rate_limit: None,
            raw_content: vec![],
        };
        let mut u = TurnUsage::default();
        u.add("claude-opus-4-6", &r(100, 50, 0, 2000));
        u.add("claude-opus-4-6", &r(50, 30, 2100, 0));
        assert_eq!((u.input, u.output, u.cache_read, u.cache_creation), (150, 80, 2100, 2000));
        assert_eq!(u.last_context, 2150, "the last prompt: uncached + cached + written");
        let expected = token_engine::cost_for("claude-opus-4-6", 100, 50, 0, 2000)
            + token_engine::cost_for("claude-opus-4-6", 50, 30, 2100, 0);
        assert!((u.cost - expected).abs() < 1e-12);
        assert!(u.cost < token_engine::cost_for("claude-opus-4-6", 4250, 80, 0, 0), "cached rounds cost less than the same tokens uncached");
        // A round with no usage never zeroes the context figure.
        u.add("claude-opus-4-6", &r(0, 0, 0, 0));
        assert_eq!(u.last_context, 2150);
    }

    #[test]
    fn cap_gate_answers_by_call_id_and_stop_resolves_a_whole_thread() {
        let gate = CapGate::default();
        let ev = |call: &str, thread: &str| SubagentCapEvent {
            workspace_id: "w".into(), thread_id: thread.into(), call_id: call.into(),
            description: "d".into(), subagent_type: Some("implementer".into()), turns_used: 25,
        };
        let (tx1, rx1) = tokio::sync::oneshot::channel();
        let (tx2, rx2) = tokio::sync::oneshot::channel();
        let (tx3, rx3) = tokio::sync::oneshot::channel();
        gate.pending.lock().insert("c1".into(), (ev("c1", "t1"), tx1));
        gate.pending.lock().insert("c2".into(), (ev("c2", "t1"), tx2));
        gate.pending.lock().insert("c3".into(), (ev("c3", "t2"), tx3));
        assert_eq!(gate.pending_for_thread("t1").len(), 2, "a reload can list what waits");
        gate.respond("c1", Some(25));
        assert_eq!(rx1.blocking_recv().unwrap(), CapAnswer::More(25));
        gate.respond("nope", Some(1)); // unknown ids are ignored
        gate.deny_thread("t1");
        assert_eq!(rx2.blocking_recv().unwrap(), CapAnswer::Stopped, "Stop is not an acceptance");
        assert!(gate.pending.lock().contains_key("c3"), "another thread's card survives");
        assert_eq!(gate.pending_for_thread("t1").len(), 0);
        gate.respond("c3", None);
        assert_eq!(rx3.blocking_recv().unwrap(), CapAnswer::Accept);
    }

    #[test]
    fn subagent_origin_is_keyed_by_call_id() {
        assert_eq!(subagent_origin("toolu_01"), "subagent:toolu_01");
        assert_eq!(DIRECTOR_ORIGIN, "director");
    }

    #[test]
    #[serial_test::serial(pricing_catalog)]
    fn a_subagents_ledger_rows_take_each_attempts_per_request_cost() {
        // Isolated catalog: never the owner's ~/.octopush/providers.json.
        let _cfg = crate::provider_router::TestConfigDir::new();
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let db = Arc::new(Mutex::new(Db::open(tmp.path()).unwrap()));
        let engine = ChatEngine::new(Arc::clone(&db), None);
        // A Haiku 5.5 attempt of a 40K and a 140K request, as the agentic
        // loop prices them: 40K at 0.10 / 0.01 / 0.50, 140K at 0.50 / 0.05 / 2.50.
        let short = (10_000.0 * 0.10 + 30_000.0 * 0.01 + 1_000.0 * 0.50) / 1e6;
        let long = (20_000.0 * 0.50 + 120_000.0 * 0.05 + 2_000.0 * 2.50) / 1e6;
        let haiku = AgentAttempt {
            model: "claude-haiku-5-5".into(), input_tokens: 30_000, output_tokens: 3_000,
            cache_read_tokens: 150_000, cache_creation_tokens: 0, cost_usd: short + long,
        };
        // Escalated to a second model; each attempt keeps its own figure.
        let opus = AgentAttempt { model: "opus".into(), input_tokens: 200, output_tokens: 20, cost_usd: 0.20, ..Default::default() };
        let o = AgentOutcome { attempts: vec![haiku, opus], cost_usd: short + long + 0.20, ..Default::default() };
        engine.record_subagent_spend("ws-1", "t-1", "call-1", &o);
        let c = db.lock().thread_cost("t-1", None).unwrap();
        assert_eq!(c.calls, 2);
        assert!((c.subagents_usd - (short + long + 0.20)).abs() < 1e-12, "{}", c.subagents_usd);

        // A $0 attempt on a model with no price still lands unpriced.
        let unknown = AgentOutcome { model: "mystery-model-9".into(), input_tokens: 100, output_tokens: 10, ..Default::default() };
        engine.record_subagent_spend("ws-1", "t-2", "call-2", &unknown);
        let c = db.lock().thread_cost("t-2", None).unwrap();
        assert_eq!((c.unpriced_calls, c.subagents_usd), (1, 0.0));
    }

    #[test]
    fn recall_returns_a_context_block_by_message_and_block() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let db = Arc::new(Mutex::new(Db::open(tmp.path()).unwrap()));
        let engine = ChatEngine::new(Arc::clone(&db), None);
        let (thread, ask) = {
            let d = db.lock();
            d.insert_project("p", "P", "/tmp/p").unwrap();
            d.insert_workspace("ws", "p", "ws", "", "main", None, "", None).unwrap();
            let t = d.create_chat_thread("ws", "T").unwrap();
            let id = d.insert_chat_message("ws", &t.id, "user", "fix @a.ts\n\na.ts\n```\nx\n```", None, None, None, None).unwrap();
            d.set_chat_message_context(id, r#"[{"token":"a.ts","kind":"file","label":"a.ts","tokens":4,"start":9,"end":25}]"#).unwrap();
            (t.id, id)
        };
        let recall = |thread: &str, input: serde_json::Value| engine.recall_tool_output(thread, &input);
        assert_eq!(recall(&thread, serde_json::json!({"message_id": ask, "block": 1})), ("\n\na.ts\n```\nx\n```".to_string(), true));
        assert_eq!(
            recall(&thread, serde_json::json!({"message_id": ask, "block": 1, "offset": 2, "limit": 4})).0,
            "(chars 3-6 of 16)\na.ts"
        );
        let (missing, ok) = recall(&thread, serde_json::json!({"message_id": ask, "block": 2}));
        assert!(!ok && missing.contains("No context block 2"), "{missing}");
        // Another thread can't reach it.
        assert!(!recall("another-thread", serde_json::json!({"message_id": ask, "block": 1})).1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A Talk request as the composer sends it on `model`, with `effort` set
    /// or absent.
    fn chat_request_on(model: &str, effort: Option<&str>) -> ChatRequest {
        let mut v = serde_json::json!({
            "workspaceId": "w", "threadId": "t", "workspacePath": "/w", "model": model,
            "userMessage": "hi", "system": null, "maxTokens": 64000,
        });
        if let Some(e) = effort {
            v["effort"] = serde_json::json!(e);
        }
        serde_json::from_value(v).unwrap()
    }

    /// The composer's presets as it sends them: Swift `low`, Standard nothing,
    /// Deep `max`.
    const SWIFT: Option<&str> = Some("low");
    const STANDARD: Option<&str> = None;
    const DEEP: Option<&str> = Some("max");

    #[test]
    fn swift_standard_and_deep_reach_every_director_request_as_effort() {
        for (sent, asked, runs) in [
            (SWIFT, Some(Effort::Low), Some(Effort::Least)),
            (STANDARD, None, None),
            (DEEP, Some(Effort::Max), Some(Effort::Max)),
        ] {
            let request = chat_request_on("m", sent);
            assert_eq!(request.effort, asked);
            let req = director_request(&request, "sys", &[], &[]);
            assert_eq!((req.effort, req.max_tokens, req.cache), (runs, 64000, true));
        }
        // `least` is internal: a request can't ask for it.
        assert!(serde_json::from_value::<Effort>(serde_json::json!("least")).is_err());
    }

    #[test]
    fn standard_keeps_every_model_s_request_body_and_swift_and_deep_follow_each_model() {
        use crate::providers::{anthropic, openai_compat};
        let anthropic_body = |model: &str, preset: Option<&str>| {
            anthropic::build_request(&director_request(&chat_request_on(model, preset), "sys", &[], &[]))
        };
        let openai_body = |model: &str, preset: Option<&str>| {
            openai_compat::build_request(&director_request(&chat_request_on(model, preset), "sys", &[], &[]))
        };
        let thinks = |b: &serde_json::Value| b.get("thinking").is_some() || b.get("output_config").is_some();
        let models = [
            "claude-sonnet-5-5", "claude-opus-5", "claude-opus-4-6", "claude-opus-4-5", "claude-haiku-4-5-20251001",
            "claude-3-5-sonnet-20241022",
        ];
        // Standard: no effort and no thinking settings on any model.
        for m in models {
            assert!(!thinks(&anthropic_body(m, STANDARD)), "{m}: {}", anthropic_body(m, STANDARD));
        }
        for m in ["o3", "gpt-5", "gpt-4o"] {
            assert!(openai_body(m, STANDARD).get("reasoning_effort").is_none(), "{m}");
        }

        let level = |model: &str, preset: Option<&str>| {
            let b = anthropic_body(model, preset);
            assert_eq!(b["thinking"]["type"], "adaptive", "{model}: {b}");
            b["output_config"]["effort"].as_str().unwrap().to_string()
        };
        // Swift: low effort alone, thinking never turned on, where the model
        // has effort control (the full check is
        // `swift_never_reasons_more_than_standard_on_any_model`).
        for m in ["claude-sonnet-5-5", "claude-opus-4-6"] {
            let b = anthropic_body(m, SWIFT);
            assert!(b.get("thinking").is_none(), "{m}: {b}");
            assert_eq!(b["output_config"], serde_json::json!({ "effort": "low" }), "{m}: {b}");
        }
        for m in ["claude-opus-4-5", "claude-haiku-4-5-20251001", "claude-3-5-sonnet-20241022"] {
            assert!(!thinks(&anthropic_body(m, SWIFT)), "{m}: Swift sends nothing");
        }
        assert_eq!(openai_body("o3", SWIFT)["reasoning_effort"], "low");
        assert_eq!(openai_body("gpt-6-sol", SWIFT)["reasoning_effort"], "none");
        assert!(openai_body("gpt-4o", SWIFT).get("reasoning_effort").is_none());

        // Deep: the highest the model takes.
        assert_eq!(level("claude-sonnet-5-5", DEEP), "max");
        assert_eq!(level("claude-opus-4-6", DEEP), "max");
        // Opus 4.5 and Haiku 4.5 think only with a budget (`adaptive` would 400).
        for m in ["claude-opus-4-5", "claude-opus-4-5-20251101", "claude-haiku-4-5-20251001"] {
            let b = anthropic_body(m, DEEP);
            assert_eq!(b["thinking"], serde_json::json!({ "type": "enabled", "budget_tokens": 24576 }), "{m}: {b}");
            assert!(b.get("output_config").is_none(), "{m}: {b}");
        }
        assert!(!thinks(&anthropic_body("claude-3-5-sonnet-20241022", DEEP)));
        assert_eq!(openai_body("o3", DEEP)["reasoning_effort"], "high", "o-series stops at high");
        assert_eq!(openai_body("gpt-6-sol", DEEP)["reasoning_effort"], "max");
        assert!(openai_body("gpt-4o", DEEP).get("reasoning_effort").is_none());
    }

    /// Where a reasoning level ranks: less reasoning ranks lower.
    fn reasoning_rank(level: &str) -> usize {
        ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
            .iter()
            .position(|l| *l == level)
            .unwrap_or_else(|| panic!("unknown level {level}"))
    }

    /// Swift never reasons more than Standard, on any model in the table:
    /// it never turns thinking on where Standard leaves it to the model, and
    /// its effort is never above the model's own default (which Standard,
    /// sending nothing, keeps).
    #[test]
    fn swift_never_reasons_more_than_standard_on_any_model() {
        use crate::providers::{anthropic, openai_compat};
        let req = |model: &str, preset: Option<&str>| director_request(&chat_request_on(model, preset), "sys", &[], &[]);
        for m in [
            "claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-opus-4-5",
            "claude-sonnet-5-5", "claude-sonnet-5", "claude-sonnet-4-6", "claude-sonnet-4-5", "claude-sonnet-4-0",
            "claude-haiku-5-5", "claude-haiku-4-5", "claude-fable-5-2", "claude-fable-5", "claude-mythos-5-2",
            "claude-mythos-5", "claude-mythos-preview", "claude-3-5-sonnet-20241022", "some-unknown-model",
        ] {
            let standard = anthropic::build_request(&req(m, STANDARD));
            let swift = anthropic::build_request(&req(m, SWIFT));
            assert!(standard.get("thinking").is_none() && standard.get("output_config").is_none(), "{m}: {standard}");
            assert!(swift.get("thinking").is_none(), "{m}: Swift turned thinking on: {swift}");
            if let Some(level) = swift["output_config"]["effort"].as_str() {
                // Every effort model's default is `medium` or `high`.
                assert!(reasoning_rank(level) < reasoning_rank("medium"), "{m}: {swift}");
            }
        }
        // OpenAI: Chat Completions (any gateway) and the Responses API (GPT-6 on OpenAI).
        let openai_models = [
            "gpt-4o", "o1", "o3", "o4-mini", "gpt-5", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-terra", "gpt-6-astra",
            "gpt-6.1-sol",
        ];
        for m in openai_models {
            let standard = openai_compat::build_request(&req(m, STANDARD));
            let swift = openai_compat::build_request(&req(m, SWIFT));
            assert!(standard.get("reasoning_effort").is_none(), "{m}: {standard}");
            if let Some(level) = swift["reasoning_effort"].as_str() {
                // No `reasoning_effort` runs at the API default, `medium`.
                assert!(reasoning_rank(level) < reasoning_rank("medium"), "{m}: {swift}");
            }
        }
        let base = "https://api.openai.com/v1";
        for &m in openai_models.iter().filter(|m| m.starts_with("gpt-6")) {
            let level = |preset| {
                let b = openai_compat::build_responses_request(&req(m, preset), "openai", base);
                b["reasoning"]["effort"].as_str().map(str::to_string)
            };
            let standard = level(STANDARD).unwrap_or_else(|| "medium".into());
            let swift = level(SWIFT).unwrap_or_else(|| "medium".into());
            assert!(reasoning_rank(&swift) <= reasoning_rank(&standard), "{m}: Swift {swift} vs Standard {standard}");
        }
        // Where `none` is the model's lowest, Swift sends it.
        for m in ["gpt-6-sol", "gpt-6-luna", "gpt-6.1-terra"] {
            assert_eq!(openai_compat::build_request(&req(m, SWIFT))["reasoning_effort"], "none", "{m}");
            let b = openai_compat::build_responses_request(&req(m, SWIFT), "openai", base);
            assert_eq!(b["reasoning"]["effort"], "none", "{m}: {b}");
        }
    }

    /// A response that thought, said something, then called a tool.
    fn tool_response(raw: Vec<serde_json::Value>, stop: LlmStopReason) -> LlmResponse {
        LlmResponse {
            text: "Checking.".into(),
            tool_uses: vec![crate::providers::LlmToolUse {
                id: "tu_1".into(),
                name: "read_file".into(),
                input: serde_json::json!({ "path": "a.rs" }),
            }],
            stop_reason: stop,
            input_tokens: 1,
            output_tokens: 1,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            rate_limit: None,
            raw_content: raw,
        }
    }

    /// The assistant turn as the Anthropic adapter sends it on the next round
    /// (its tool results follow, and carry the cache breakpoint).
    fn sent_turn(turn: LlmMessage) -> serde_json::Value {
        let results = LlmMessage {
            role: LlmRole::User,
            content: LlmContent::ToolResults(vec![LlmToolResult { tool_use_id: "tu_1".into(), content: "ok".into(), is_error: false }]),
        };
        let req = director_request(&chat_request_on("claude-sonnet-5-5", DEEP), "sys", &[turn, results], &[]);
        crate::providers::anthropic::build_request(&req)["messages"][0]["content"].clone()
    }

    #[test]
    fn a_tool_round_is_replayed_with_its_signed_thinking_and_block_order() {
        let raw = vec![
            serde_json::json!({ "type": "thinking", "thinking": "plan", "signature": "sig-1" }),
            serde_json::json!({ "type": "text", "text": "Checking." }),
            serde_json::json!({ "type": "tool_use", "id": "tu_1", "name": "read_file", "input": { "path": "a.rs" } }),
        ];
        let turn = tool_round_turn(&tool_response(raw.clone(), LlmStopReason::ToolUse));
        assert_eq!(sent_turn(turn), serde_json::Value::Array(raw));
    }

    #[test]
    fn a_truncated_round_keeps_its_leading_signed_thinking() {
        let raw = vec![
            serde_json::json!({ "type": "thinking", "thinking": "plan", "signature": "sig-1" }),
            serde_json::json!({ "type": "redacted_thinking", "data": "opaque" }),
            serde_json::json!({ "type": "text", "text": "Checking." }),
            serde_json::json!({ "type": "tool_use", "id": "tu_1", "name": "read_file", "input": { "path": "a.rs" } }),
            // A block cut off mid-way is never replayed.
            serde_json::json!({ "type": "thinking", "thinking": "half" }),
        ];
        let sent = sent_turn(truncated_round_turn(&tool_response(raw.clone(), LlmStopReason::MaxTokens)));
        assert_eq!(sent, serde_json::Value::Array(raw[..4].to_vec()), "leading thinking, then text and tool calls");

        // No thinking: rebuilt from the text and tool calls, as before.
        let plain = sent_turn(truncated_round_turn(&tool_response(raw[2..].to_vec(), LlmStopReason::MaxTokens)));
        assert_eq!(plain, serde_json::Value::Array(raw[2..4].to_vec()));
        // An unsigned leading thinking block isn't kept either.
        let unsigned = vec![serde_json::json!({ "type": "thinking", "thinking": "half" }), raw[2].clone()];
        let sent = sent_turn(truncated_round_turn(&tool_response(unsigned, LlmStopReason::MaxTokens)));
        assert_eq!(sent, serde_json::Value::Array(raw[2..4].to_vec()));
    }

    #[test]
    fn the_forced_close_carries_the_turn_s_effort_and_instruction() {
        for (preset, effort) in [(SWIFT, Some(Effort::Least)), (STANDARD, None), (DEEP, Some(Effort::Max))] {
            let request = chat_request_on("claude-sonnet-5-5", preset);
            let mut messages = vec![LlmMessage {
                role: LlmRole::User,
                content: LlmContent::ToolResults(vec![LlmToolResult { tool_use_id: "tu_1".into(), content: "ok".into(), is_error: false }]),
            }];
            let req = forced_close_request(&request, "sys", &mut messages, &[]);
            assert_eq!(req.effort, effort, "{preset:?}");
            match &messages[0].content {
                LlmContent::ToolResults(r) => assert!(r[0].content.ends_with(CLOSE_INSTRUCTION), "{}", r[0].content),
                _ => panic!("the instruction rides on the last tool result"),
            }
            assert_eq!(messages.len(), 1, "no extra user turn");
        }
    }

    #[test]
    fn talks_prompt_sends_mcp_problems_to_settings_not_the_cli() {
        let prompt = default_talk_system_prompt("/w");
        assert!(prompt.starts_with("You are a helpful coding assistant working in the project at /w."));
        assert!(prompt.contains("the user manages in Settings › Integrations"), "{prompt}");
        assert!(prompt.contains("never point the user to Claude Code's `/mcp` or `claude mcp` commands"), "{prompt}");
        // A hint such as "run `which npx` in Terminal" may still reach the user.
        assert!(!prompt.contains("any CLI command"), "{prompt}");
    }

    #[test]
    fn execute_tool_reports_structural_status() {
        let dir = tempfile::tempdir().unwrap();
        let wp = dir.path();

        // run_command: success/failure by EXIT CODE, not output text.
        let (_, ok) = execute_tool(wp, "run_command", &serde_json::json!({"command": "exit 0"}), None);
        assert!(ok, "exit 0 is success");
        let (_, ok) = execute_tool(wp, "run_command", &serde_json::json!({"command": "exit 3"}), None);
        assert!(!ok, "non-zero exit is failure");
        // A successful command whose stdout merely *contains* 'Error' is still ok.
        let (_, ok) = execute_tool(wp, "run_command", &serde_json::json!({"command": "echo 'Error: not really'"}), None);
        assert!(ok, "stdout text must not flip the status");

        // File ops: ok reflects whether the syscall succeeded.
        let (_, ok) = execute_tool(wp, "read_file", &serde_json::json!({"path": "missing.txt"}), None);
        assert!(!ok, "reading a missing file fails");
        let (_, ok) = execute_tool(wp, "write_file", &serde_json::json!({"path": "a.txt", "content": "hi"}), None);
        assert!(ok, "writing succeeds");
        let (_, ok) = execute_tool(wp, "list_files", &serde_json::json!({"path": "."}), None);
        assert!(ok, "listing an existing dir succeeds");

        // Unknown tool → failure.
        let (_, ok) = execute_tool(wp, "frobnicate", &serde_json::json!({}), None);
        assert!(!ok);
    }

    #[test]
    fn grep_finds_matches_and_respects_gitignore() {
        let dir = tempfile::tempdir().unwrap();
        let wp = dir.path();
        std::fs::create_dir_all(wp.join("src")).unwrap();
        std::fs::write(wp.join("src/main.rs"), "fn main() {\n    let needle_alpha = 1;\n}\n").unwrap();
        std::fs::write(wp.join("notes.md"), "needle_alpha in prose\n").unwrap();
        std::fs::write(wp.join(".gitignore"), "ignored/\n").unwrap();
        std::fs::create_dir_all(wp.join("ignored")).unwrap();
        std::fs::write(wp.join("ignored/x.txt"), "needle_alpha hidden\n").unwrap();

        let (out, ok) = execute_tool(wp, "grep", &serde_json::json!({"pattern": "needle_alpha"}), None);
        assert!(ok);
        assert!(out.contains("src/main.rs:2:"), "path:line match: {out}");
        assert!(out.contains("notes.md:1:"), "{out}");
        assert!(!out.contains("ignored/x.txt"), "gitignored files are skipped: {out}");

        // Glob filter narrows to one file.
        let (out, ok) = execute_tool(
            wp,
            "grep",
            &serde_json::json!({"pattern": "needle_alpha", "glob": "*.rs"}),
            None,
        );
        assert!(ok);
        assert!(out.contains("src/main.rs") && !out.contains("notes.md"), "{out}");

        // No matches is a successful (informative) result.
        let (out, ok) = execute_tool(wp, "grep", &serde_json::json!({"pattern": "zzz_none"}), None);
        assert!(ok);
        assert!(out.contains("No matches"), "{out}");

        // A bad regex fails structurally.
        let (_, ok) = execute_tool(wp, "grep", &serde_json::json!({"pattern": "("}), None);
        assert!(!ok);
    }

    #[test]
    fn glob_lists_matching_files() {
        let dir = tempfile::tempdir().unwrap();
        let wp = dir.path();
        std::fs::create_dir_all(wp.join("src/deep")).unwrap();
        std::fs::write(wp.join("src/a.ts"), "x").unwrap();
        std::fs::write(wp.join("src/deep/b.ts"), "x").unwrap();
        std::fs::write(wp.join("src/c.rs"), "x").unwrap();
        let (out, ok) = execute_tool(wp, "glob", &serde_json::json!({"pattern": "src/**/*.ts"}), None);
        assert!(ok);
        assert!(out.contains("src/a.ts") && out.contains("src/deep/b.ts") && !out.contains("c.rs"), "{out}");
    }

    #[test]
    fn edit_file_replaces_exactly_and_guards_ambiguity() {
        let dir = tempfile::tempdir().unwrap();
        let wp = dir.path();
        std::fs::write(wp.join("f.txt"), "alpha beta alpha").unwrap();

        // Ambiguous without replace_all → refused, file untouched.
        let (msg, ok) = execute_tool(
            wp,
            "edit_file",
            &serde_json::json!({"path": "f.txt", "old_string": "alpha", "new_string": "gamma"}),
            None,
        );
        assert!(!ok);
        assert!(msg.contains("2 times"), "{msg}");
        assert_eq!(std::fs::read_to_string(wp.join("f.txt")).unwrap(), "alpha beta alpha");

        // Unique match → replaced.
        let (_, ok) = execute_tool(
            wp,
            "edit_file",
            &serde_json::json!({"path": "f.txt", "old_string": "beta", "new_string": "delta"}),
            None,
        );
        assert!(ok);
        assert_eq!(std::fs::read_to_string(wp.join("f.txt")).unwrap(), "alpha delta alpha");

        // replace_all handles multiplicity.
        let (_, ok) = execute_tool(
            wp,
            "edit_file",
            &serde_json::json!({"path": "f.txt", "old_string": "alpha", "new_string": "omega", "replace_all": true}),
            None,
        );
        assert!(ok);
        assert_eq!(std::fs::read_to_string(wp.join("f.txt")).unwrap(), "omega delta omega");

        // Missing old_string → structural failure with guidance.
        let (msg, ok) = execute_tool(
            wp,
            "edit_file",
            &serde_json::json!({"path": "f.txt", "old_string": "never-there", "new_string": "x"}),
            None,
        );
        assert!(!ok);
        assert!(msg.contains("not found"), "{msg}");
    }

    #[test]
    fn read_file_truncates_multibyte_content_on_a_char_boundary() {
        // Regression: the old `&content[..100_000]` byte slice panicked when
        // byte 100k fell inside a multibyte character.
        let dir = tempfile::tempdir().unwrap();
        let wp = dir.path();
        // 'é' is 2 bytes in UTF-8 — 60k of them straddle every even boundary.
        let content = "é".repeat(60_000);
        std::fs::write(wp.join("acc.txt"), &content).unwrap();
        let (out, ok) = execute_tool(wp, "read_file", &serde_json::json!({"path": "acc.txt"}), None);
        assert!(ok);
        assert!(out.contains("truncated"), "large file is truncated: {}", &out[out.len().saturating_sub(120)..]);
    }

    #[test]
    fn read_file_offset_limit_windows_lines() {
        let dir = tempfile::tempdir().unwrap();
        let wp = dir.path();
        let content = (1..=10).map(|i| format!("line{i}")).collect::<Vec<_>>().join("\n");
        std::fs::write(wp.join("w.txt"), content).unwrap();
        let (out, ok) = execute_tool(
            wp,
            "read_file",
            &serde_json::json!({"path": "w.txt", "offset": 3, "limit": 2}),
            None,
        );
        assert!(ok);
        assert!(out.contains("(lines 3-4 of 10)"), "window header: {out}");
        assert!(out.contains("line3") && out.contains("line4") && !out.contains("line5"), "{out}");
    }

    #[test]
    fn run_command_times_out_and_kills_the_process() {
        let dir = tempfile::tempdir().unwrap();
        let wp = dir.path();
        let started = std::time::Instant::now();
        let (out, ok) = execute_tool(
            wp,
            "run_command",
            &serde_json::json!({"command": "echo MARK_PRE; sleep 60; echo MARK_POST", "timeout_secs": 1}),
            None,
        );
        assert!(!ok, "a timed-out command fails");
        assert!(started.elapsed().as_secs() < 30, "the kill is prompt, not a full wait");
        assert!(out.contains("timed out"), "message names the timeout: {out}");
        assert!(out.contains("MARK_PRE") && !out.contains("MARK_POST"), "partial output survives: {out}");
    }

    #[test]
    fn run_command_cancel_flag_stops_the_command() {
        let dir = tempfile::tempdir().unwrap();
        let wp = dir.path();
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flip = std::sync::Arc::clone(&cancel);
        let h = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(400));
            flip.store(true, std::sync::atomic::Ordering::Relaxed);
        });
        let started = std::time::Instant::now();
        let (out, ok) = execute_tool_cancellable(
            wp,
            "run_command",
            &serde_json::json!({"command": "sleep 60"}),
            None,
            Some(&cancel),
        );
        h.join().unwrap();
        assert!(!ok);
        assert!(started.elapsed().as_secs() < 30, "cancel lands promptly");
        assert!(out.contains("stopped by the director"), "{out}");
    }

    #[test]
    fn sandboxed_write_file_refuses_paths_outside_the_workspace() {
        // M3.1b: in-process write_file is path-contained when the mission is
        // sandboxed (the CLI-substrate wrap doesn't cover TALK / API-stage tools).
        let dir = tempfile::tempdir().unwrap();
        let wp = dir.path();
        let roots = vec![wp.to_string_lossy().into_owned()];

        // Inside the workspace → allowed.
        let (_, ok) = execute_tool(
            wp,
            "write_file",
            &serde_json::json!({"path": "sub/a.txt", "content": "hi"}),
            Some(&roots),
        );
        assert!(ok, "a write inside the workspace is allowed");

        // Absolute-path escape → refused (Path::join discards the base).
        let (msg, ok) = execute_tool(
            wp,
            "write_file",
            &serde_json::json!({"path": "/tmp/octopush-evil.txt", "content": "x"}),
            Some(&roots),
        );
        assert!(!ok, "an absolute path outside the workspace is refused");
        assert!(msg.contains("refusing to write outside"), "message: {msg}");

        // `..` escape → refused.
        let (_, ok) = execute_tool(
            wp,
            "write_file",
            &serde_json::json!({"path": "../octopush-evil.txt", "content": "x"}),
            Some(&roots),
        );
        assert!(!ok, "a `..` escape is refused");
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn sandboxed_write_blocks_symlink_traversal_at_the_kernel() {
        // The exact escape a lexical check can't catch: a pre-existing symlink
        // inside the workspace pointing at a DENIED location (a hostile repo can
        // commit `link -> $HOME`). Lexically `link/…` is under the workspace, so
        // it passes the fast pre-check — the KERNEL-enforced seatbelt write must
        // still block it. ($HOME root is denied; only the ~/.claude state dirs
        // are writable there, and a tempdir would be under the allowed $TMPDIR.)
        let dir = tempfile::tempdir().unwrap();
        let wp = dir.path();
        let roots = vec![wp.to_string_lossy().into_owned()];
        let home = std::env::var("HOME").unwrap();
        let marker = format!("octopush-sandbox-escape-{}.txt", std::process::id());
        std::os::unix::fs::symlink(&home, wp.join("link")).unwrap();

        let (msg, ok) = execute_tool(
            wp,
            "write_file",
            &serde_json::json!({"path": format!("link/{marker}"), "content": "x"}),
            Some(&roots),
        );
        let escaped = std::path::Path::new(&home).join(&marker);
        let existed = escaped.exists();
        let _ = std::fs::remove_file(&escaped); // best-effort cleanup
        assert!(!ok, "symlink traversal must be blocked by the kernel: {msg}");
        assert!(!existed, "nothing may be written outside the workspace ($HOME)");
    }

    #[test]
    fn readonly_mission_empty_roots_refuses_every_write_platform_independently() {
        // A readonly mission (review/probe) resolves to Some(vec![]) write roots.
        // The lexical pre-check must then refuse EVERY write_file — even one
        // inside the workspace — before any macOS-only kernel path, so read-only
        // holds regardless of platform.
        let dir = tempfile::tempdir().unwrap();
        let wp = dir.path();
        let empty: Vec<String> = vec![];
        let (msg, ok) = execute_tool(
            wp,
            "write_file",
            &serde_json::json!({"path": "in_workspace.txt", "content": "x"}),
            Some(&empty),
        );
        assert!(!ok, "a readonly mission refuses even an in-workspace write: {msg}");
        assert!(!wp.join("in_workspace.txt").exists(), "nothing was written");
    }

    #[test]
    fn a_secret_card_never_grants_dont_ask_again() {
        let broker = ApprovalBroker::default();
        // "Always" on a secret card acts as one approval and grants nothing.
        assert_eq!(broker.record("t", ApprovalDecision::ApproveAlways, true), ApprovalDecision::Approve);
        assert!(!broker.auto_approves("t"));
        assert_eq!(broker.record("t", ApprovalDecision::Deny, true), ApprovalDecision::Deny);
        // On a destructive-command card it still grants the thread.
        assert_eq!(broker.record("t", ApprovalDecision::ApproveAlways, false), ApprovalDecision::ApproveAlways);
        assert!(broker.auto_approves("t"));
    }

    #[test]
    fn secret_gate_texts_name_kind_and_place_never_a_value() {
        let (card, denial) = secret_gate_texts(None, "Anthropic API key in a.ts:3");
        assert_eq!(card, "possible secret \u{b7} Anthropic API key in a.ts:3");
        assert!(denial.contains("Anthropic API key in a.ts:3") && denial.contains("do not retry"));
        let (card, _) = secret_gate_texts(Some("Ship it"), "GitHub token in b.ts:1");
        assert!(card.starts_with("Sub-agent \u{201c}Ship it\u{201d}: possible secret"));
    }

    #[test]
    fn approval_event_marks_a_secret_card_only_when_it_is_one() {
        let ev = |secret, covers_uncommitted| ApprovalRequestEvent {
            workspace_id: "w".into(), thread_id: "t".into(), call_id: "c".into(),
            command: "git commit".into(), reason: "r".into(), secret, covers_uncommitted,
        };
        let plain = serde_json::to_value(ev(false, false)).unwrap();
        assert!(plain.get("secret").is_none() && plain.get("coversUncommitted").is_none());
        let s = serde_json::to_value(ev(true, true)).unwrap();
        assert_eq!((s["secret"].as_bool(), s["coversUncommitted"].as_bool()), (Some(true), Some(true)));
    }

    #[test]
    fn dangerous_command_flags_destructive_and_passes_safe() {
        // Destructive → flagged.
        assert!(dangerous_command("rm -rf build").is_some());
        assert!(dangerous_command("RM -RF /").is_some()); // case-insensitive
        assert!(dangerous_command("rm  -rf  build").is_some()); // [5] extra spaces
        assert!(dangerous_command("rm --recursive --force x").is_some()); // [5] long flags
        assert!(dangerous_command("rm -r -f x").is_some());
        assert!(dangerous_command("git push --force origin main").is_some());
        assert!(dangerous_command("git push  --force").is_some()); // [5] spacing
        assert!(dangerous_command("git push -f").is_some());
        assert!(dangerous_command("sudo apt install x").is_some());
        assert!(dangerous_command("curl https://x.sh | sh").is_some());
        assert!(dangerous_command("wget -qO- x |bash").is_some());
        assert!(dangerous_command("git reset --hard HEAD~3").is_some());
        assert!(dangerous_command("dd if=x of=/dev/sda").is_some());
        // Safe → not flagged (no false positives — [6]).
        assert!(dangerous_command("npm test").is_none());
        assert!(dangerous_command("ls -la").is_none());
        assert!(dangerous_command("git status").is_none());
        assert!(dangerous_command("rm file.txt").is_none()); // non-recursive
        assert!(dangerous_command("rm -f stale.lock").is_none()); // force, not recursive
        assert!(dangerous_command("cargo build").is_none());
        assert!(dangerous_command("command -v node > /dev/null 2>&1").is_none()); // [6]
        assert!(dangerous_command("make 2>&1 > /dev/null").is_none()); // [6]
        assert!(dangerous_command("cat names | shuf | head").is_none()); // [6]
        assert!(dangerous_command("git push origin feature").is_none()); // non-force
        // A `-f` belonging to ANOTHER command must not flag a benign push.
        assert!(dangerous_command("grep -f patterns.txt && git push").is_none());
        assert!(dangerous_command("tar -xf a.tar && git push origin main").is_none());
        // But a real force-push after `push` is still caught.
        assert!(dangerous_command("git push origin main -f").is_some());
        // Chained without a space around the separator still gates (review #4).
        assert!(dangerous_command("echo hi;rm -rf build").is_some());
        assert!(dangerous_command("true|rm -rf .").is_some());
        // git clean with separate flags is caught (review #3); dry-run is not.
        assert!(dangerous_command("git clean -f -d").is_some());
        assert!(dangerous_command("git clean -ffd").is_some());
        assert!(dangerous_command("git clean -n").is_none());
        // An unrelated `-f`/`-r` before a benign rm/clean must NOT flag it.
        assert!(dangerous_command("grep -f pats.txt && rm file.txt").is_none());
        assert!(dangerous_command("grep -rf pats.txt && git clean -n").is_none());
        // Flags must not cross command boundaries (review #4): two separate
        // non-destructive rm's are not a force-delete.
        assert!(dangerous_command("rm -r tmpdir && rm -f lock").is_none());
        assert!(dangerous_command("git clean -n && rm -i x").is_none());
        // `add if=` no longer mistaken for `dd if=` (review #9).
        assert!(dangerous_command("git add if-config.ts").is_none());
        assert!(dangerous_command("echo add if=foo").is_none());
        // dd to a real device is still caught (via the device-write regex).
        assert!(dangerous_command("dd if=/dev/zero of=/dev/sda").is_some());
        // New denylist entry: find -delete.
        assert!(dangerous_command("find . -name '*.tmp' -delete").is_some());
    }

    fn approval_request(workspace: &str, thread: &str, call: &str, command: &str) -> ApprovalRequestEvent {
        ApprovalRequestEvent {
            workspace_id: workspace.into(),
            thread_id: thread.into(),
            call_id: call.into(),
            command: command.into(),
            reason: "rewrites published history".into(),
            secret: false,
            covers_uncommitted: false,
        }
    }

    #[test]
    fn a_waiting_card_is_listed_oldest_first_until_it_is_answered() {
        let broker = ApprovalBroker::default();
        let mut push = broker.park(approval_request("w1", "t1", "c2", "git push --force"), 2_000);
        let _reset = broker.park(approval_request("w2", "t2", "c1", "git reset --hard"), 1_000);
        let _clean = broker.park(approval_request("w1", "t1", "c3", "git clean -fd"), 3_000);

        // What the Dock badge and the menu bar count: every card, longest-waiting first.
        let waits = broker.waiting();
        let order: Vec<&str> = waits.iter().map(|w| w.thread_id.as_str()).collect();
        assert_eq!(order, ["t2", "t1", "t1"]);
        assert!(waits.iter().all(|w| !w.secret));
        assert_eq!((waits[0].workspace_id.as_str(), waits[0].thread_id.as_str(), waits[0].since_ms), ("w2", "t2", 1_000));

        // What a reloaded webview shows again for one conversation.
        let shown: Vec<String> = broker.pending_for_thread("t1").into_iter().map(|r| r.call_id).collect();
        assert_eq!(shown, ["c2", "c3"]);
        assert!(broker.pending_for_thread("t9").is_empty());

        // Nothing answers a card on its own: it is still waiting.
        assert!(matches!(push.try_recv(), Err(tokio::sync::oneshot::error::TryRecvError::Empty)));

        broker.respond("c2", ApprovalDecision::Approve);
        assert_eq!(push.try_recv().ok(), Some(ApprovalDecision::Approve));
        assert_eq!(broker.waiting().len(), 2, "an answered card stops counting");
    }

    #[test]
    fn stop_and_a_deleted_workspace_deny_their_cards_and_nothing_else() {
        let broker = ApprovalBroker::default();
        let mut a = broker.park(approval_request("w1", "t1", "a", "rm -rf build"), 1);
        let mut b = broker.park(approval_request("w1", "t2", "b", "git push -f"), 2);
        let mut c = broker.park(approval_request("w2", "t3", "c", "sudo make install"), 3);

        broker.deny_thread("t1");
        assert_eq!(a.try_recv().ok(), Some(ApprovalDecision::Deny));
        assert!(b.try_recv().is_err() && c.try_recv().is_err(), "other conversations still wait");
        assert!(broker.admits("w1"), "Stop is not a deletion: the next turn may ask");

        broker.retire_workspace("w1");
        assert_eq!(b.try_recv().ok(), Some(ApprovalDecision::Deny));
        assert!(c.try_recv().is_err(), "another workspace still waits");
        let left: Vec<String> = broker.waiting().into_iter().map(|w| w.thread_id).collect();
        assert_eq!(left, ["t3"]);
        // A turn still winding down in the deleted workspace can't park a new card.
        assert!(!broker.admits("w1"));
        assert!(broker.admits("w2"));
    }

    #[test]
    fn deleting_a_workspace_stops_its_turns_and_retires_it() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let db = Arc::new(Mutex::new(Db::open(tmp.path()).unwrap()));
        let engine = ChatEngine::new(Arc::clone(&db), None);
        let flag = |key: &str| {
            let f = Arc::new(AtomicBool::new(false));
            engine.cancels.lock().insert(key.to_string(), Arc::clone(&f));
            f
        };
        let turn = flag("t1");
        let continuation = flag("t1#continue:call-1");
        let elsewhere = flag("t9");
        let mut card = engine.approvals.park(approval_request("w1", "t2", "c", "git push -f"), 1);
        let mut other = engine.approvals.park(approval_request("w2", "t9", "d", "rm -rf x"), 2);

        engine.cancel_workspace("w1", &["t1".to_string(), "t2".to_string()]);

        assert!(turn.load(Ordering::Relaxed) && continuation.load(Ordering::Relaxed), "its turns stop, as Stop would");
        assert!(!elsewhere.load(Ordering::Relaxed), "another workspace's turn runs on");
        assert_eq!(card.try_recv().ok(), Some(ApprovalDecision::Deny));
        assert!(other.try_recv().is_err());
        assert!(!engine.approvals.admits("w1"));
    }

    #[test]
    fn second_turn_on_running_thread_is_refused() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let db = Arc::new(Mutex::new(Db::open(tmp.path()).unwrap()));
        let engine = ChatEngine::new(Arc::clone(&db), None);
        let (first, guard) = engine.begin_turn("t1", "t1".into()).unwrap();

        // A second turn, or a continuation, on the running thread is refused,
        // and the first turn keeps its cancel flag, so Stop still reaches it.
        let err = engine.begin_turn("t1", "t1".into()).err().expect("a second turn is refused");
        assert!(err.to_string().contains(TURN_BUSY), "{err}");
        assert!(engine.begin_turn("t1", "t1#continue:c1".into()).is_err());
        engine.cancel("t1");
        assert!(first.load(Ordering::Relaxed), "Stop reaches the turn that runs");

        // Another thread runs its own; a continuation holds its thread too,
        // and is listed like a turn (it ends with `done` as well).
        let (_t2, _g2) = engine.begin_turn("t2", "t2".into()).unwrap();
        let (_c3, _g3) = engine.begin_turn("t3", "t3#continue:c3".into()).unwrap();
        assert!(engine.begin_turn("t3", "t3".into()).is_err());
        let all = ["t1", "t2", "t3", "t4"].map(String::from);
        assert_eq!(engine.running_turns(&all), ["t1", "t2", "t3"]);

        // Once the turn ends the thread takes the next one.
        drop(guard);
        assert!(!engine.is_running("t1"));
        assert!(engine.begin_turn("t1", "t1".into()).is_ok());
    }

    #[test]
    fn done_comes_once_after_the_thread_is_released() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let engine = ChatEngine::new(Arc::new(Mutex::new(Db::open(tmp.path()).unwrap())), None);
        // What a reload asking `list_running_threads` would read at each `done`.
        let seen = Arc::new(Mutex::new(Vec::new()));
        let done = |thread: &'static str| -> Box<dyn FnOnce() + Send> {
            let (cancels, seen) = (Arc::clone(&engine.cancels), Arc::clone(&seen));
            Box::new(move || seen.lock().push((thread, running_in(&cancels.lock(), thread))))
        };

        // A turn that began, whatever its outcome (`send_agentic` ends every
        // one this way): one `done`, and the thread is already free by then,
        // so a reload in between can't list a turn that is over.
        let (_flag, claim) = engine.begin_turn("t1", "t1".into()).unwrap();
        drop(TurnEnd { claim: Some(claim), done: Some(done("t1")) });
        assert_eq!(*seen.lock(), [("t1", false)]);

        // A send refused because a turn runs there sends no `done`: the
        // running turn stays running in every view.
        let (_flag, _running) = engine.begin_turn("t2", "t2".into()).unwrap();
        let refused = engine.begin_turn("t2", "t2".into()).ok().map(|(_, claim)| claim);
        drop(TurnEnd { claim: refused, done: Some(done("t2")) });
        assert_eq!(seen.lock().len(), 1, "no done for a refused send");
        assert!(engine.is_running("t2"));
    }

    #[test]
    fn truncate_and_shell_wait_for_the_running_turn() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let db = Arc::new(Mutex::new(Db::open(tmp.path()).unwrap()));
        let engine = ChatEngine::new(Arc::clone(&db), None);
        let (thread, first) = {
            let d = db.lock();
            d.insert_project("p", "P", "/tmp/p").unwrap();
            d.insert_workspace("ws", "p", "ws", "", "main", None, "", None).unwrap();
            let t = d.create_chat_thread("ws", "T").unwrap();
            let first = d.insert_chat_message("ws", &t.id, "user", "ask", None, None, None, None).unwrap();
            d.insert_chat_message("ws", &t.id, "assistant", "answer", None, None, None, None).unwrap();
            (t.id, first)
        };
        let (_flag, claim) = engine.begin_turn(&thread, thread.clone()).unwrap();

        // Regenerate / Edit & resend can't cut rows the running turn writes,
        // and a `$` command can't take its shell.
        let err = engine.truncate_after(&thread, first).unwrap_err();
        assert!(err.to_string().contains(TURN_BUSY), "{err}");
        assert_eq!(db.lock().list_chat_messages(&thread).unwrap().len(), 2, "nothing was cut");
        assert!(engine.ensure_idle(&thread).is_err(), "run_shell_command refuses the same way");

        drop(claim);
        engine.truncate_after(&thread, first).unwrap();
        assert!(db.lock().list_chat_messages(&thread).unwrap().is_empty());
    }

    #[test]
    fn a_failed_workspace_delete_lets_its_conversations_ask_again() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let db = Arc::new(Mutex::new(Db::open(tmp.path()).unwrap()));
        let engine = ChatEngine::new(Arc::clone(&db), None);

        engine.cancel_workspace("w1", &["t1".to_string()]);
        assert!(!engine.approvals.admits("w1"));
        let failed: AppResult<()> = Err(AppError::Other("database is locked".into()));
        assert!(engine.finish_workspace_delete("w1", failed).is_err(), "the error still reaches the caller");
        assert!(engine.approvals.admits("w1"), "the workspace stays, and so may its cards");

        engine.cancel_workspace("w2", &[]);
        assert!(engine.finish_workspace_delete("w2", Ok(())).is_ok());
        assert!(!engine.approvals.admits("w2"), "a deleted workspace stays retired");
    }

    #[test]
    fn approval_decision_parse() {
        assert_eq!(ApprovalDecision::parse("approve"), ApprovalDecision::Approve);
        assert_eq!(ApprovalDecision::parse("always"), ApprovalDecision::ApproveAlways);
        assert_eq!(ApprovalDecision::parse("deny"), ApprovalDecision::Deny);
        assert_eq!(ApprovalDecision::parse("garbage"), ApprovalDecision::Deny);
    }

    #[test]
    fn relativize_cwd_cases() {
        // At the workspace root → no badge.
        assert_eq!(relativize_cwd("/repo", "/repo"), "");
        assert_eq!(relativize_cwd("", "/repo"), "");
        // Under the root → relative path.
        assert_eq!(relativize_cwd("/repo/packages/api", "/repo"), "packages/api");
        // Outside the worktree → consistent `…/tail` (never a bare absolute path).
        assert_eq!(relativize_cwd("/var/tmp/build", "/repo"), "…/tmp/build");
        assert_eq!(relativize_cwd("/tmp", "/repo"), "…/tmp");
    }

    #[test]
    fn tool_input_with_cwd_only_adds_when_not_root() {
        let input = serde_json::json!({ "command": "ls" });
        // Root → unchanged.
        assert!(tool_input_with_cwd(&input, "/repo", "/repo").get("cwd").is_none());
        // Subdir → cwd added.
        let v = tool_input_with_cwd(&input, "/repo/src", "/repo");
        assert_eq!(v.get("cwd").and_then(|c| c.as_str()), Some("src"));
        assert_eq!(v.get("command").and_then(|c| c.as_str()), Some("ls"));
    }
}

/// Talk's shells get the login shell's PATH the way CLI stages do, and only
/// that (#1087).
#[cfg(test)]
mod login_path_tests {
    use super::*;
    use crate::orchestrator::cli_runner::{resolved_cli_path, with_login_shell_env};
    use serial_test::serial;

    /// A dir holding `octo-1087-tool`, an executable found only through it,
    /// and a `bash` that isn't one, which a bare `bash` would resolve to.
    fn login_bin() -> tempfile::TempDir {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        for (name, body) in [("octo-1087-tool", "echo found-on-login-path"), ("bash", "echo wrong-bash")] {
            let file = dir.path().join(name);
            std::fs::write(&file, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        dir
    }

    /// Runs the tool only the login PATH has, then prints the PATH, a variable
    /// only the login shell sets, `CARGO_HOME` (which the login shell sets too)
    /// and the bash running the command.
    const PROBE: &str = "octo-1087-tool && printf '%s\\n' \"$PATH\" \"${OCTO_1087_LOGIN_ONLY-unset}\" \"${CARGO_HOME-unset}\" \"$BASH\"";

    /// `run_command` with a stubbed login shell: the output lines, the PATH CLI
    /// stages get under the same stub, and the login PATH dir.
    fn run_probe(sandboxed: bool) -> (Vec<String>, String, String) {
        let bin = login_bin();
        let ws = tempfile::tempdir().unwrap();
        let roots = vec![ws.path().to_string_lossy().into_owned()];
        let bin_path = bin.path().to_string_lossy().into_owned();
        let login = [
            ("PATH", bin_path.as_str()),
            ("OCTO_1087_LOGIN_ONLY", "leaked"),
            ("CARGO_HOME", "/login-shell/cargo"),
        ];
        with_login_shell_env(&login, || {
            let input = serde_json::json!({ "command": PROBE });
            let (out, ok) = execute_tool(ws.path(), "run_command", &input, sandboxed.then_some(roots.as_slice()));
            if sandboxed {
                let _ = crate::orchestrator::sandbox::remove_workspace_build_caches(&roots[0]);
            }
            assert!(ok, "{out}");
            (out.lines().map(str::to_string).collect(), resolved_cli_path(), bin_path.clone())
        })
    }

    #[test]
    #[serial]
    fn an_unconfined_command_gets_the_login_path_and_nothing_else() {
        let (lines, path, bin) = run_probe(false);
        assert_eq!(lines[0], "found-on-login-path", "{lines:?}");
        assert_eq!(lines[1], path, "the PATH CLI stages spawn with");
        assert!(path.starts_with(&bin), "{path}");
        assert_eq!(lines[2], "unset", "no other login-shell variable");
        assert_ne!(lines[3], "/login-shell/cargo");
        assert_eq!(lines[4], "/bin/bash", "the pinned bash, not the one first on the PATH");
    }

    #[test]
    #[serial]
    #[cfg(target_os = "macos")]
    fn a_sandboxed_command_gets_the_login_path_and_keeps_its_cache_redirect() {
        let (lines, path, bin) = run_probe(true);
        assert_eq!(lines[0], "found-on-login-path", "the profile lets it run tools on the login PATH: {lines:?}");
        assert_eq!(lines[1], path);
        assert!(path.starts_with(&bin), "{path}");
        assert_eq!(lines[2], "unset");
        assert!(lines[3].contains("build-cache") && lines[3].ends_with("/cargo"), "the sandbox's cache wins: {lines:?}");
        assert_eq!(lines[4], "/bin/bash", "the pinned bash, not the one first on the PATH");
    }

    #[test]
    fn a_missing_program_says_which_path_it_ran_with() {
        let ws = tempfile::tempdir().unwrap();
        let input = serde_json::json!({ "command": "octo-1087-missing-tool --version" });
        let (out, ok) = with_login_shell_env(&[], || execute_tool(ws.path(), "run_command", &input, None));
        assert!(!ok);
        assert!(out.contains("octo-1087-missing-tool: command not found"), "{out}");
        assert_eq!(
            out.lines().last(),
            Some("`octo-1087-missing-tool` wasn't found (the command ran with your login shell's PATH)."),
            "{out}"
        );
        // A path isn't looked up on the PATH, so the line doesn't name it.
        let input = serde_json::json!({ "command": "./octo-1087-missing.sh" });
        let (out, ok) = with_login_shell_env(&[], || execute_tool(ws.path(), "run_command", &input, None));
        assert!(!ok);
        assert_eq!(out.lines().last(), Some("`./octo-1087-missing.sh` wasn't found."), "{out}");
        // Any other failure reads as before.
        let input = serde_json::json!({ "command": "echo nope >&2; exit 1" });
        let (out, _) = with_login_shell_env(&[], || execute_tool(ws.path(), "run_command", &input, None));
        assert!(!out.contains("wasn't found"), "{out}");
    }

    #[test]
    fn the_not_found_note_names_the_program_bash_reported() {
        let named = |p: &str| format!("`{p}` wasn't found (the command ran with your login shell's PATH).");
        assert_eq!(not_found_note("bash: gh: command not found"), named("gh"));
        assert_eq!(not_found_note("[stderr] bash: line 1: gh: command not found\n"), named("gh"));
        assert_eq!(not_found_note("bash: npx: command not found\r\nbash: line 2: node: command not found\r"), named("node"));
        assert_eq!(not_found_note("./run.sh: line 3: pnpm: command not found"), named("pnpm"));
        assert_eq!(not_found_note("env: uvx: No such file or directory"), named("uvx"));
        // A path wasn't looked up on the PATH.
        assert_eq!(not_found_note("bash: ./missing.sh: No such file or directory"), "`./missing.sh` wasn't found.");
        assert_eq!(not_found_note("bash: line 1: /opt/x/bin/tool: No such file or directory"), "`/opt/x/bin/tool` wasn't found.");
        assert_eq!(not_found_note("bash: scripts/run: No such file or directory"), "`scripts/run` wasn't found.");
        // Nothing to name.
        let unnamed = "A program in this command wasn't found (the command ran with your login shell's PATH).";
        assert_eq!(not_found_note(""), unnamed);
        assert_eq!(not_found_note("bash: ./run.sh: /usr/bin/missing: bad interpreter: No such file or directory"), unnamed);
    }

    #[test]
    fn shell_output_on_127_gains_the_note() {
        assert_eq!(
            format_command_output("bash: gh: command not found", 127),
            "bash: gh: command not found\n(exit code 127)\n`gh` wasn't found (the command ran with your login shell's PATH)."
        );
        assert_eq!(format_command_output("nope", 1), "nope\n(exit code 1)");
        assert_eq!(format_command_output("", 0), "(exit code 0)");
    }

    #[test]
    fn a_tool_row_records_how_the_call_ended() {
        let row = || serde_json::json!({ "callId": "c1", "toolName": "run_command", "result": "x" });
        let v = |ok, denied, exit_code, stopped| RowVerdict { ok, denied, exit_code, stopped };

        let mut passed = row();
        stamp_outcome(&mut passed, v(true, false, Some(0), false));
        assert_eq!(passed["ok"], true);
        assert_eq!(passed["outcome"], "ok");
        assert_eq!(passed["exitCode"], 0);
        assert!(passed.get("reason").is_none());

        let mut failed = row();
        stamp_outcome(&mut failed, v(false, false, Some(101), false));
        assert_eq!(failed["ok"], false);
        assert_eq!(failed["outcome"], "failed");
        assert_eq!(failed["exitCode"], 101);

        // A denial is its own verdict, never a pass, whatever `ok` said.
        let mut denied = row();
        stamp_outcome(&mut denied, v(true, true, None, false));
        assert_eq!(denied["ok"], false);
        assert_eq!(denied["outcome"], "denied");
        assert!(denied.get("exitCode").is_none());

        // The shell's -1 means "no status" (an interrupt, a busy shell).
        let mut interrupted = row();
        stamp_outcome(&mut interrupted, v(false, false, Some(-1), false));
        assert_eq!(interrupted["outcome"], "failed");
        assert!(interrupted.get("exitCode").is_none());

        // The keys are additive: the row keeps everything it had.
        assert_eq!(interrupted["callId"], "c1");
        assert_eq!(interrupted["result"], "x");
    }

    #[test]
    fn what_each_call_site_persists_reads_its_verdict() {
        // `$`-direct, stopped by the user while it ran: the row the live
        // streamer writes reads as stopped, with SIGINT's 130 kept as data.
        let input = serde_json::json!({ "command": "npm run dev", "cwd": "packages/api" });
        let stopped = tool_row(
            "shell-7",
            "run_command",
            input.clone(),
            "ready on :3000\n^C\n(exit code 130)",
            RowVerdict { ok: false, exit_code: Some(130), stopped: true, ..RowVerdict::default() },
        );
        assert_eq!(stopped["callId"], "shell-7");
        assert_eq!(stopped["toolName"], "run_command");
        assert_eq!(stopped["toolInput"], input, "the cwd badge's input is kept as is");
        assert_eq!((stopped["outcome"].as_str(), stopped["reason"].as_str()), (Some("failed"), Some("stopped")));
        assert_eq!(stopped["exitCode"], 130);

        // The agent loop's MCP call to a server turned off in the conversation.
        let refused = tool_row(
            "toolu_1",
            "mcp__docs__search",
            serde_json::json!({ "q": "x" }),
            &crate::chat_agents::mcp_off_refusal("mcp__docs__search", &["docs".to_string()].into_iter().collect()).unwrap(),
            RowVerdict { denied: true, ..RowVerdict::default() },
        );
        assert_eq!(refused["outcome"], "denied");
        assert!(refused.get("reason").is_none() && refused.get("exitCode").is_none());

        // A command that passed carries no reason even if a stop raced it.
        let passed = tool_row(
            "toolu_2",
            "run_command",
            serde_json::json!({ "command": "true" }),
            "(exit code 0)",
            RowVerdict { ok: true, exit_code: Some(0), stopped: true, ..RowVerdict::default() },
        );
        assert_eq!(passed["outcome"], "ok");
        assert!(passed.get("reason").is_none());
    }
}

#[cfg(test)]
mod director_reliability_tests {
    use super::*;

    #[test]
    fn a_journal_line_becomes_a_player_label() {
        assert_eq!(
            notice_label(&retry_notice(2, 5, 4, ProviderErrorKind::RateLimit)),
            "Rate limit reached — retrying in 4s (retry 2 of 5)"
        );
        assert_eq!(
            notice_label(&throttle_notice(20)),
            "Input-token budget low — pausing 20s for the rate-limit window to reset"
        );
        assert_eq!(notice_label(""), "");
    }

    #[test]
    fn the_notice_event_is_camel_case() {
        let v = serde_json::to_value(TurnNoticeEvent {
            workspace_id: "ws".into(),
            thread_id: "t".into(),
            text: "Model overloaded — retrying in 2s (retry 1 of 5)".into(),
            delay_secs: 2,
        })
        .unwrap();
        assert_eq!(v["workspaceId"], "ws");
        assert_eq!(v["threadId"], "t");
        assert_eq!(v["delaySecs"], 2);
        assert_eq!(TURN_NOTICE_EVENT, "chat://notice");
    }
}
