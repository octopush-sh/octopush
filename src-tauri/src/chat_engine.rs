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
    LlmContent, LlmMessage, LlmProvider, LlmRequest, LlmRole,
    LlmStopReason, LlmTool, LlmToolResult,
};
use crate::provider_router::ProviderRouter;
use crate::token_engine;
use parking_lot::Mutex;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
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
pub(crate) fn execute_tool(workspace_path: &Path, name: &str, input: &serde_json::Value) -> (String, bool) {
    match name {
        "run_command" => {
            let cmd = input.get("command").and_then(|c| c.as_str()).unwrap_or("");
            match std::process::Command::new("bash")
                .arg("-c")
                .arg(cmd)
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
}

impl ChatEngine {
    pub fn new(db: Arc<Mutex<Db>>) -> Self {
        Self {
            // Clone of the process-wide client — shares its connection pool.
            client: shared_http_client().clone(),
            db,
            cancels: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Request cancellation of the in-flight turn for `thread_id`, if any.
    /// No-op when nothing is running. The loop checks the flag between
    /// iterations and after each tool, then stops cleanly. Keyed by thread so
    /// two conversations in one workspace can be cancelled independently.
    pub fn cancel(&self, thread_id: &str) {
        if let Some(flag) = self.cancels.lock().get(thread_id) {
            flag.store(true, Ordering::Relaxed);
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
        let cost = token_engine::compute_cost(model, total_input, total_output, 0, 0);
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

        // Persist user message and emit message-added so the frontend learns the DB id.
        self.insert_and_emit_message(
            &app,
            &request.workspace_id,
            &request.thread_id,
            "user",
            &request.user_message,
            None, None, None, None,
        )?;

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
                    // Truncate long results for context efficiency.
                    let short_result = if result.len() > 500 {
                        format!("{}...(truncated)", &result[..500])
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
                // Flush any orphaned tool summaries.
                pending_tool_summary.clear();
                messages.push(LlmMessage {
                    role: LlmRole::User,
                    content: LlmContent::Text(msg.content.clone()),
                });
            }
        }

        let mut system_prompt = request.system.unwrap_or_else(|| {
            format!(
                "You are a helpful coding assistant working in the project at {}. \
                 You have tools to run commands, read/write files, and list directories. \
                 Use them to help the user with their tasks. Be concise and take action \
                 rather than just explaining what to do.",
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
                }) {
                    tracing::warn!(error = %e, "failed to record chat token event");
                }
            }

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
                    let cost = token_engine::compute_cost(&request.model, total_input, total_output, 0, 0);
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

                let (result, ok) = execute_tool(&workspace_path, &u.name, &u.input);

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
                let tool_record = serde_json::json!({
                    "callId": u.id,
                    "toolName": u.name,
                    "toolInput": input_for_display,
                    "result": result,
                });
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
        let (_, ok) = execute_tool(wp, "run_command", &serde_json::json!({"command": "exit 0"}));
        assert!(ok, "exit 0 is success");
        let (_, ok) = execute_tool(wp, "run_command", &serde_json::json!({"command": "exit 3"}));
        assert!(!ok, "non-zero exit is failure");
        // A successful command whose stdout merely *contains* 'Error' is still ok.
        let (_, ok) = execute_tool(wp, "run_command", &serde_json::json!({"command": "echo 'Error: not really'"}));
        assert!(ok, "stdout text must not flip the status");

        // File ops: ok reflects whether the syscall succeeded.
        let (_, ok) = execute_tool(wp, "read_file", &serde_json::json!({"path": "missing.txt"}));
        assert!(!ok, "reading a missing file fails");
        let (_, ok) = execute_tool(wp, "write_file", &serde_json::json!({"path": "a.txt", "content": "hi"}));
        assert!(ok, "writing succeeds");
        let (_, ok) = execute_tool(wp, "list_files", &serde_json::json!({"path": "."}));
        assert!(ok, "listing an existing dir succeeds");

        // Unknown tool → failure.
        let (_, ok) = execute_tool(wp, "frobnicate", &serde_json::json!({}));
        assert!(!ok);
    }
}
