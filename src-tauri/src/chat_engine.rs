//! Agentic chat engine — tool-use loop dispatched via the `LlmProvider` trait.
//!
//! The engine defines tools (run_command, read_file, write_file, list_files)
//! and runs an agentic loop: send messages → provider responds with tool_use →
//! execute tool → send result back → repeat until provider gives a final text answer.
//! The loop is provider-agnostic: AnthropicProvider or OpenAICompatibleProvider
//! is selected at runtime via `resolve_provider()`.

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::providers::{
    anthropic::AnthropicProvider,
    openai_compat::OpenAICompatibleProvider,
    LlmBlock, LlmContent, LlmMessage, LlmProvider, LlmRequest, LlmRole,
    LlmStopReason, LlmTool, LlmToolResult,
};
use crate::provider_router::ProviderRouter;
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

const MAX_TOOL_ITERATIONS: usize = 25;

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
    /// Optional skill name — its SKILL.md body is appended to the system prompt
    /// and, if it declares `allowed-tools`, the turn's tool set is restricted.
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
    s
}

/// Flag a command the agent wants to run as destructive (returns a short reason
/// for the approval card). Conservative + high-confidence: a safety net before
/// the agent does something irreversible, not a sandbox. User-typed `$` commands
/// are never passed here. Case-insensitive, matches anywhere in the command.
fn dangerous_command(command: &str) -> Option<&'static str> {
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
}

// ─── Tools definition ─────────────────────────────────────────────

fn tool_definitions() -> serde_json::Value {
    serde_json::json!([
        {
            "name": "run_command",
            "description": "Run a shell command in the workspace directory. Use this for git operations, running tests, installing packages, or any shell task. The command runs with bash.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The shell command to execute"
                    }
                },
                "required": ["command"]
            }
        },
        {
            "name": "read_file",
            "description": "Read the contents of a file in the workspace.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Relative path from workspace root"
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
        }
    ])
}

// ─── Tool execution ───────────────────────────────────────────────

/// Execute a tool and return `(result_text, ok)`. `ok` is a STRUCTURAL success
/// signal — `run_command` reports the process exit status, file ops report
/// whether the syscall succeeded — never a sniff of the result text. Callers
/// that only want the text can ignore the bool (`let (result, _) = …`).
/// Execute a built-in workspace tool. When `sandbox_roots` is `Some`, the
/// mission is sandboxed: `run_command` runs its shell under seatbelt (fail-closed
/// — no wrapper, no run) and `write_file` is refused outside the write roots.
/// Reads stay open (the seatbelt profile allows reads too).
pub(crate) fn execute_tool(
    workspace_path: &Path,
    name: &str,
    input: &serde_json::Value,
    sandbox_roots: Option<&[String]>,
) -> (String, bool) {
    match name {
        "run_command" => {
            let cmd = input.get("command").and_then(|c| c.as_str()).unwrap_or("");
            let _guard;
            let mut command = if let Some(roots) = sandbox_roots {
                match crate::orchestrator::sandbox::prepare(
                    roots,
                    std::ffi::OsStr::new("bash"),
                    &["-c".to_string(), cmd.to_string()],
                ) {
                    Ok(p) => {
                        let mut c = std::process::Command::new(&p.program);
                        c.args(&p.args);
                        _guard = Some(p.guard);
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
                _guard = None;
                let mut c = std::process::Command::new("bash");
                c.arg("-c").arg(cmd);
                c
            };
            match command
                .current_dir(workspace_path)
                .output()
            {
                Ok(output) => {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    let stderr = String::from_utf8_lossy(&output.stderr);
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
                    if result.is_empty() {
                        result = format!("(exit code {})", output.status.code().unwrap_or(-1));
                    }
                    // Truncate very long outputs
                    if result.len() > 50_000 {
                        result.truncate(50_000);
                        result.push_str("\n... (truncated)");
                    }
                    (result, output.status.success())
                }
                Err(e) => (format!("Failed to execute command: {e}"), false),
            }
        }
        "read_file" => {
            let path = input.get("path").and_then(|p| p.as_str()).unwrap_or("");
            let full = workspace_path.join(path);
            match std::fs::read_to_string(&full) {
                Ok(content) => {
                    if content.len() > 100_000 {
                        (format!("{}... (truncated, {} bytes total)", &content[..100_000], content.len()), true)
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
                if !crate::orchestrator::sandbox::is_write_allowed(&full, roots) {
                    return (
                        format!("Sandboxed: refusing to write outside the mission workspace ({path})"),
                        false,
                    );
                }
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
        _ => (format!("Unknown tool: {name}"), false),
    }
}

// ─── Provider helpers ─────────────────────────────────────────────

/// Process-wide pooled HTTP client. `reqwest::Client` holds an internal
/// connection pool behind an `Arc`, so cloning it shares the pool — every
/// LLM caller (ChatEngine, `ai_complete`, orchestrator) should go through
/// this instead of `Client::new()`, which would pay a fresh TLS handshake
/// on every call.
static SHARED_HTTP: std::sync::OnceLock<Client> = std::sync::OnceLock::new();

pub(crate) fn shared_http_client() -> &'static Client {
    SHARED_HTTP.get_or_init(Client::new)
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
        "openai-compatible" => Box::new(OpenAICompatibleProvider),
        other => return Err(AppError::Other(format!("Unsupported protocol: {other}"))),
    };

    Ok((impl_, api_base, key))
}

// ─── Engine ───────────────────────────────────────────────────────

/// Removes a workspace's cancel flag from the registry when the turn ends,
/// no matter which of `send_agentic`'s many exit paths is taken.
struct CancelGuard {
    cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    key: String,
}

impl Drop for CancelGuard {
    fn drop(&mut self) {
        self.cancels.lock().remove(&self.key);
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
    /// In-flight approval requests for dangerous AGENT commands, keyed by the
    /// tool call id; the value carries the thread id (so `cancel` can resolve a
    /// thread's pending approval) + the responder. `respond_approval` resolves it.
    approvals:
        Arc<Mutex<HashMap<String, (String, tokio::sync::oneshot::Sender<ApprovalDecision>)>>>,
    /// Threads where the user chose "don't ask again" — dangerous agent commands
    /// run without prompting (in-memory; resets on restart, by design).
    auto_approve: Arc<Mutex<std::collections::HashSet<String>>>,
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
            approvals: Arc::new(Mutex::new(HashMap::new())),
            auto_approve: Arc::new(Mutex::new(std::collections::HashSet::new())),
        }
    }

    /// Resolve a pending approval request (called by the `respond_approval`
    /// command when the user clicks the inline card).
    pub fn respond_approval(&self, call_id: &str, decision: ApprovalDecision) {
        if let Some((_thread, tx)) = self.approvals.lock().remove(call_id) {
            let _ = tx.send(decision);
        }
    }

    /// Ask the user to approve a dangerous agent command and wait for the answer.
    /// Auto-approved conversations skip the prompt. A forgotten card times out as
    /// a denial (so a turn can't wedge forever).
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
        if self.auto_approve.lock().contains(thread_id) {
            return ApprovalDecision::Approve;
        }
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.approvals
            .lock()
            .insert(call_id.to_string(), (thread_id.to_string(), tx));
        let _ = app.emit("chat://approval-request", &ApprovalRequestEvent {
            workspace_id: workspace_id.to_string(),
            thread_id: thread_id.to_string(),
            call_id: call_id.to_string(),
            command: command.to_string(),
            reason: reason.to_string(),
        });
        let decision = match tokio::time::timeout(std::time::Duration::from_secs(300), rx).await {
            Ok(Ok(d)) => d,
            _ => {
                self.approvals.lock().remove(call_id);
                ApprovalDecision::Deny
            }
        };
        if decision == ApprovalDecision::ApproveAlways {
            self.auto_approve.lock().insert(thread_id.to_string());
        }
        let _ = app.emit("chat://approval-resolved", &ApprovalResolvedEvent {
            workspace_id: workspace_id.to_string(),
            thread_id: thread_id.to_string(),
            call_id: call_id.to_string(),
        });
        decision
    }

    /// Request cancellation of the in-flight turn for `thread_id`, if any.
    /// No-op when nothing is running. The loop checks the flag between
    /// iterations and after each tool, then stops cleanly. Keyed by thread so
    /// two conversations in one workspace can be cancelled independently.
    pub fn cancel(&self, thread_id: &str) {
        if let Some(flag) = self.cancels.lock().get(thread_id) {
            flag.store(true, Ordering::Relaxed);
        }
        // Resolve a pending approval for this thread as Deny — otherwise Stop
        // leaves the turn parked in await_approval (and a later Approve would run
        // a destructive command on a turn the user already cancelled).
        let mut approvals = self.approvals.lock();
        let to_deny: Vec<String> = approvals
            .iter()
            .filter(|(_, (tid, _))| tid == thread_id)
            .map(|(cid, _)| cid.clone())
            .collect();
        for cid in to_deny {
            if let Some((_, tx)) = approvals.remove(&cid) {
                let _ = tx.send(ApprovalDecision::Deny);
            }
        }
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
        total_input: u64,
        total_output: u64,
    ) -> AppResult<()> {
        let cost = token_engine::cost_for(model, total_input, total_output, 0, 0);
        self.insert_and_emit_message(
            app,
            workspace_id,
            thread_id,
            "stopped",
            "Generation stopped.",
            Some(model),
            Some(total_input as i64),
            Some(total_output as i64),
            Some(cost),
        )?;
        let _ = app.emit("chat://stream", &ChatStreamEvent {
            workspace_id: workspace_id.to_string(),
            thread_id: thread_id.to_string(),
            delta: String::new(),
            done: true,
            input_tokens: Some(total_input),
            output_tokens: Some(total_output),
        });
        Ok(())
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
        });
        Ok(id)
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
                    &format!("Shell error: {e}"), "",
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
                    &app, &request, &call_id, &tool_input, false, started, note, "",
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
    ) {
        let _ = app.emit("chat://tool-end", &ToolEndEvent {
            workspace_id: request.workspace_id.clone(),
            thread_id: request.thread_id.clone(),
            call_id: call_id.to_string(),
            ok,
            duration_ms: started.elapsed().as_millis() as u64,
        });
        let record = serde_json::json!({
            "callId": call_id,
            "toolName": "run_command",
            "toolInput": tool_input_with_cwd(tool_input, abs_cwd, &request.workspace_path),
            "result": result_str,
        });
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

                let record = serde_json::json!({
                    "callId": call_id,
                    "toolName": "run_command",
                    "toolInput": tool_input_with_cwd(&tool_input, &exit.cwd, &request.workspace_path),
                    "result": format_command_output(&exit.full_output, exit.exit_code),
                });
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
        let (provider, api_base, api_key) = resolve_provider(&request.model)?;

        let workspace_path = std::path::PathBuf::from(&request.workspace_path);

        // Sandbox scope for this turn's in-process tools: Some(write_roots) when
        // the mission is sandboxed. When set, run_command routes to the
        // seatbelt-wrapped execute_tool (bypassing the shared shell) and
        // write_file is confined to the workspace. Resolved once per turn.
        let sandbox_roots: Option<Vec<String>> = self
            .db
            .lock()
            .active_mission_for_workspace(&request.workspace_id)
            .ok()
            .flatten()
            .filter(|m| m.exec_isolation == "sandbox")
            .map(|_| vec![request.workspace_path.clone()]);

        // Register a fresh cancellation flag for this turn, keyed by thread. The
        // guard removes it from the registry on every exit path (Drop).
        let cancel = Arc::new(AtomicBool::new(false));
        self.cancels
            .lock()
            .insert(request.thread_id.clone(), Arc::clone(&cancel));
        let _cancel_guard = CancelGuard {
            cancels: Arc::clone(&self.cancels),
            key: request.thread_id.clone(),
        };

        // Persist user message and emit message-added so the frontend learns the
        // DB id. Skipped on regenerate: history already ends with the user turn
        // (the old assistant turn was truncated), so we just re-run the loop.
        if !request.regenerate {
            self.insert_and_emit_message(
                &app,
                &request.workspace_id,
                &request.thread_id,
                "user",
                &request.user_message,
                None, None, None, None,
            )?;
        }

        // Build conversation history (this thread only) as normalized
        // LlmMessage[]. Tool summaries are injected into assistant messages so
        // the model remembers what it did.
        let history = self.db.lock().list_chat_messages(&request.thread_id)?;
        let mut messages: Vec<LlmMessage> = Vec::new();
        let mut pending_tool_summary = Vec::new();

        for msg in &history {
            if msg.role == "tool" {
                // Accumulate tool summaries to inject into the next assistant message.
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&msg.content) {
                    let name = parsed.get("toolName").and_then(|n| n.as_str()).unwrap_or("tool");
                    let empty_obj = serde_json::json!({});
                    let input = parsed.get("toolInput").unwrap_or(&empty_obj);
                    let result = parsed.get("result").and_then(|r| r.as_str()).unwrap_or("");
                    // Truncate long results for context efficiency, on a UTF-8
                    // char boundary (shell output via `$`-direct is arbitrary
                    // bytes, so a naive `&result[..500]` byte slice can panic).
                    let short_result = if result.len() > 500 {
                        let mut end = 500;
                        while end > 0 && !result.is_char_boundary(end) {
                            end -= 1;
                        }
                        format!("{}...(truncated)", &result[..end])
                    } else {
                        result.to_string()
                    };
                    pending_tool_summary.push(format!(
                        "[Tool: {} | Input: {} | Result: {}]",
                        name,
                        serde_json::to_string(input).unwrap_or_default(),
                        short_result,
                    ));
                }
            } else if msg.role == "assistant" {
                // Prepend any accumulated tool summaries to the assistant message
                // so the model knows what actions it took.
                let mut content = String::new();
                if !pending_tool_summary.is_empty() {
                    content.push_str(&pending_tool_summary.join("\n"));
                    content.push_str("\n\n");
                    pending_tool_summary.clear();
                }
                content.push_str(&msg.content);
                messages.push(LlmMessage {
                    role: LlmRole::Assistant,
                    content: LlmContent::Text(content),
                });
            } else if msg.role == "user" {
                // Prepend any orphaned tool summaries to the user turn. This is
                // the path a `$`-direct command takes: its output (role="tool")
                // isn't followed by an assistant message, so without this the
                // command's output would be dropped from the model's context.
                let mut content = String::new();
                if !pending_tool_summary.is_empty() {
                    content.push_str(&pending_tool_summary.join("\n"));
                    content.push_str("\n\n");
                    pending_tool_summary.clear();
                }
                content.push_str(&msg.content);
                // Merge into a preceding user turn rather than pushing a second
                // one. A `$`-direct command (user row `$ cmd` + tool row) before
                // another user/`$` row would otherwise yield two consecutive
                // User messages, which Anthropic rejects with a 400.
                match messages.last_mut() {
                    Some(last)
                        if last.role == LlmRole::User
                            && matches!(last.content, LlmContent::Text(_)) =>
                    {
                        if let LlmContent::Text(prev) = &mut last.content {
                            prev.push_str("\n\n");
                            prev.push_str(&content);
                        }
                    }
                    _ => messages.push(LlmMessage {
                        role: LlmRole::User,
                        content: LlmContent::Text(content),
                    }),
                }
            }
        }

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

        let mut system_prompt = request.system.unwrap_or_else(|| {
            format!(
                "You are a helpful coding assistant working in the project at {}. \
                 You have tools to run commands, read/write files, and list directories. \
                 run_command executes in a persistent shell SHARED with the user — a \
                 `cd` or env export (yours or theirs) carries over to later commands. It \
                 is NON-interactive: don't run REPLs or commands that wait for stdin \
                 (pass input via flags or a heredoc instead). read_file/write_file/\
                 list_files paths are ALWAYS relative to the project root, regardless of \
                 the shell's current directory — pass a path relative to the root. Use the \
                 tools to help the user; be concise and take action rather than just \
                 explaining what to do.",
                request.workspace_path
            )
        });

        let mut tools = build_llm_tools();

        // ── Active skill ──────────────────────────────────────────
        // A selected skill appends its SKILL.md body to the system prompt and,
        // if it declares `allowed-tools`, restricts this turn's tool set.
        if let Some(skill_name) = request.skill.as_deref() {
            if let Some(skill) = crate::skills::load_skill(&workspace_path, skill_name) {
                system_prompt.push_str(&format!(
                    "\n\n# Active skill: {}\n{}",
                    skill.name, skill.body
                ));
                if let Some(allowed) = &skill.allowed_tools {
                    let filtered: Vec<LlmTool> = tools
                        .iter()
                        .filter(|t| allowed.iter().any(|a| a == &t.name))
                        .cloned()
                        .collect();
                    // A typo'd / unknown tool name would otherwise empty the set
                    // and silently disable the agent — keep all tools + warn.
                    if filtered.is_empty() {
                        tracing::warn!(
                            skill = %skill.name,
                            "skill allowed-tools matched no known tools; keeping the full tool set"
                        );
                    } else {
                        tools = filtered;
                    }
                }
            }
        }

        // ── MCP tools ─────────────────────────────────────────────
        // Append tools exposed by configured MCP servers (namespaced
        // `mcp__server__tool`). Unreachable servers are skipped inside
        // list_tools. A skill's allowed-tools filter above doesn't touch these
        // (MCP tools are opt-in via the server config, not the skill).
        // Run the (blocking) MCP discovery off the async runtime thread, bounded
        // by a timeout so a hung server can't freeze the turn.
        {
            let mcp = Arc::clone(&self.mcp);
            let wp = workspace_path.clone();
            let discovered = tokio::time::timeout(
                std::time::Duration::from_secs(20),
                tokio::task::spawn_blocking(move || mcp.list_tools(&wp)),
            )
            .await
            .ok()
            .and_then(|r| r.ok())
            .unwrap_or_default();
            for t in discovered {
                tools.push(LlmTool {
                    name: t.namespaced,
                    description: t.description,
                    input_schema: t.input_schema,
                });
            }
        }

        let mut total_input: u64 = 0;
        let mut total_output: u64 = 0;

        // Snapshot files already modified before this turn started. Anything
        // present here was the user's own change — we won't credit it to the
        // agent even if a later iteration touches the same file.
        let initial_modified = git_status_files(&workspace_path);

        // Track which (file, msg_id) pairs we've already inserted so the
        // git-status fallback doesn't double-up rows the write_file branch
        // already wrote.
        let mut attributed: std::collections::HashSet<(String, i64)> =
            std::collections::HashSet::new();

        // ─── Agentic loop ─────────────────────────────────────────
        for iteration in 0..MAX_TOOL_ITERATIONS {
            // Stop cleanly if the user cancelled this turn (checked here and
            // after each tool — the in-flight request itself isn't aborted).
            if cancel.load(Ordering::Relaxed) {
                self.finish_stopped(&app, &request.workspace_id, &request.thread_id, &request.model, total_input, total_output)?;
                return Ok(());
            }

            let llm_req = LlmRequest {
                model: request.model.clone(),
                // Honor the caller's requested budget (the EffortSelector sets
                // it) with a sane floor; the old code force-clamped to 32768,
                // silently ignoring the request.
                // FOLLOW-UP: some providers cap output below the Deep preset
                // (e.g. gpt-4o at 16384) and will 400 on a larger value. A
                // proper per-model ceiling needs a `max_output_tokens` field on
                // ModelInfo; until then the budget is forwarded as-is (this was
                // already the case pre-change, which force-sent 32768).
                max_tokens: request.max_tokens.max(4096),
                system: system_prompt.clone(),
                messages: messages.clone(),
                tools: tools.clone(),
                tool_choice: None,
                // TALK doesn't drive per-request reasoning effort — behavior unchanged.
                effort: None,
            };

            let response = match provider
                .complete(&api_base, api_key.as_deref(), &llm_req, &self.client)
                .await
            {
                Ok(r) => r,
                Err(e) => {
                    let error_text = format!("{e}");
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
                    return Err(e);
                }
            };

            total_input += response.input_tokens;
            total_output += response.output_tokens;

            // Record a token usage event so the Companion CONTEXT card and
            // Settings · Usage stats can read aggregate counts. Without this
            // the `token_events` table never sees chat turns and the
            // dashboards stay frozen at zero.
            if response.input_tokens > 0 || response.output_tokens > 0 {
                let engine = token_engine::TokenEngine::new(std::sync::Arc::clone(&self.db));
                if let Err(e) = engine.record(token_engine::TokenEvent {
                    id: None,
                    session_id: request.workspace_id.clone(),
                    timestamp: String::new(),
                    input_tokens: response.input_tokens,
                    output_tokens: response.output_tokens,
                    cache_read_tokens: response.cache_read_tokens,
                    cache_creation_tokens: response.cache_creation_tokens,
                    model: request.model.clone(),
                    cost_usd: 0.0,
                }, "talk") {
                    tracing::warn!(error = %e, "failed to record chat token event");
                }
            }
            // Logbook: a completed chat turn is active TALK work on the mission.
            let _ = self.db.lock().record_activity(&request.workspace_id, "talk", "chat");

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
                // Add the truncated assistant message to history.
                messages.push(LlmMessage {
                    role: LlmRole::Assistant,
                    content: LlmContent::AssistantWithTools {
                        raw: vec![],
                        text: response.text.clone(),
                        tool_uses: response.tool_uses.clone(),
                    },
                });
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
                    let cost = token_engine::cost_for(&request.model, total_input, total_output, 0, 0);
                    self.insert_and_emit_message(
                        &app,
                        &request.workspace_id,
                        &request.thread_id,
                        "assistant",
                        &final_text,
                        Some(&request.model),
                        Some(total_input as i64),
                        Some(total_output as i64),
                        Some(cost),
                    )?;
                }

                // Emit done — pure metadata. The final assistant content was delivered
                // via the chat://message-added event above.
                let _ = app.emit("chat://stream", &ChatStreamEvent {
                    workspace_id: request.workspace_id.clone(),
                    thread_id: request.thread_id.clone(),
                    delta: String::new(),
                    done: true,
                    input_tokens: Some(total_input),
                    output_tokens: Some(total_output),
                });

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
                match self.db.lock().insert_chat_message(
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

            // Add assistant message with tool_use content to conversation.
            messages.push(LlmMessage {
                role: LlmRole::Assistant,
                content: LlmContent::AssistantWithTools {
                    raw: vec![],
                    text: response.text.clone(),
                    tool_uses: response.tool_uses.clone(),
                },
            });

            // Execute each tool, persist to DB, and collect results.
            let mut tool_results: Vec<LlmToolResult> = Vec::new();
            for u in &response.tool_uses {
                // Honor a cancel that landed between tools — stop before
                // kicking off another (possibly long) tool.
                if cancel.load(Ordering::Relaxed) {
                    self.finish_stopped(&app, &request.workspace_id, &request.thread_id, &request.model, total_input, total_output)?;
                    return Ok(());
                }
                tracing::info!(tool = %u.name, "executing tool");

                // Build the display-safe input ONCE, up front: strip large
                // write_file bodies (already destined for disk) so neither the
                // live-card event nor the persisted record carries multi-KB
                // JSON. Reused for tool-start, persistence, and the message.
                let input_for_display = if u.name == "write_file" {
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
                // it runs. User-typed `$` commands are never gated. A denial
                // skips execution and tells the model the user declined.
                let mut denied: Option<String> = None;
                if u.name == "run_command" {
                    let command = u.input.get("command").and_then(|c| c.as_str()).unwrap_or("");
                    if let Some(reason) = dangerous_command(command) {
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
                let call_started = std::time::Instant::now();
                let _ = app.emit("chat://tool-start", &ToolStartEvent {
                    workspace_id: request.workspace_id.clone(),
                    thread_id: request.thread_id.clone(),
                    call_id: u.id.clone(),
                    tool_name: u.name.clone(),
                    tool_input: input_for_display.clone(),
                    started_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Micros, true),
                });

                // Absolute cwd a run_command executed in (shared shell), captured
                // so its card can show the cwd badge. Empty for other tools.
                let mut run_command_cwd = String::new();

                // Route MCP tools (`mcp__server__tool`) to their server; all
                // other names are built-in workspace tools. MCP calls run off
                // the runtime thread with a timeout so a slow/hung server
                // surfaces as a tool error instead of freezing the turn.
                let (result, ok) = if let Some(msg) = denied {
                    (msg, false)
                } else if crate::mcp::is_mcp_tool(&u.name) {
                    let mcp = Arc::clone(&self.mcp);
                    let wp = workspace_path.clone();
                    let name = u.name.clone();
                    let input = u.input.clone();
                    match tokio::time::timeout(
                        std::time::Duration::from_secs(60),
                        tokio::task::spawn_blocking(move || mcp.call(&wp, &name, &input)),
                    )
                    .await
                    {
                        Ok(Ok(Ok(out))) => (out, true),
                        Ok(Ok(Err(e))) => (format!("MCP error: {e}"), false),
                        _ => ("MCP error: tool call timed out".to_string(), false),
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
                                }
                            }
                        }
                    };
                    match join_result {
                        Ok(Ok(crate::talk_shell::CaptureOutcome::Done(r))) => {
                            // Record where it ran (absolute) so the card shows the
                            // cwd badge, matching `$`-direct.
                            run_command_cwd = r.cwd.clone();
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
                    duration_ms: call_started.elapsed().as_millis() as u64,
                });

                // If the tool wrote a file, record it in file_edits for the Review canvas.
                if u.name == "write_file" {
                    if let Some(path) = u.input.get("path").and_then(|p| p.as_str()) {
                        let msg_id = if assistant_msg_id >= 0 { Some(assistant_msg_id) } else { None };
                        if let Err(e) = self.db.lock().insert_file_edit(
                            &request.workspace_id,
                            path,
                            "write_file",
                            msg_id,
                        ) {
                            tracing::warn!(tool = "write_file", path = path, error = %e, "failed to record file edit");
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
                let tool_record = serde_json::json!({
                    "callId": u.id,
                    "toolName": u.name,
                    "toolInput": display_input,
                    "result": result,
                });
                // The thread may have been deleted while the turn was parked (a
                // tool running, or an approval card awaiting the user). Skip the
                // persist so we don't leave an orphaned tool row.
                let thread_alive = self
                    .db
                    .lock()
                    .chat_thread_exists(&request.thread_id)
                    .unwrap_or(true);
                if thread_alive {
                    if let Err(e) = self.insert_and_emit_message(
                        &app,
                        &request.workspace_id,
                        &request.thread_id,
                        "tool",
                        &tool_record.to_string(),
                        None, None, None, None,
                    ) {
                        tracing::error!(tool = %u.name, error = %e, "failed to persist tool execution");
                    }
                }

                tool_results.push(LlmToolResult {
                    tool_use_id: u.id.clone(),
                    content: result,
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

        let loop_err = AppError::Other(format!(
            "Agentic loop exceeded max iterations ({MAX_TOOL_ITERATIONS})"
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
mod tests {
    use super::*;

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
