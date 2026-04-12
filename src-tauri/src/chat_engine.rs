//! Agentic chat engine — tool-use loop with the Anthropic Messages API.
//!
//! The engine defines tools (run_command, read_file, write_file, list_files)
//! and runs an agentic loop: send messages → Claude responds with tool_use →
//! execute tool → send result back → repeat until Claude responds with text only.

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::token_engine;
use parking_lot::Mutex;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

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
    pub workspace_path: String, // The directory where tools execute
    pub model: String,
    pub user_message: String,
    pub system: Option<String>,
    pub max_tokens: u32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChatStreamEvent {
    pub workspace_id: String,
    pub delta: String,
    pub done: bool,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

/// Emitted when Claude calls a tool — the frontend shows this inline.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ToolUseEvent {
    pub workspace_id: String,
    pub tool_name: String,
    pub tool_input: serde_json::Value,
    pub result: String,
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

fn execute_tool(workspace_path: &Path, name: &str, input: &serde_json::Value) -> String {
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
                    result
                }
                Err(e) => format!("Failed to execute command: {e}"),
            }
        }
        "read_file" => {
            let path = input.get("path").and_then(|p| p.as_str()).unwrap_or("");
            let full = workspace_path.join(path);
            match std::fs::read_to_string(&full) {
                Ok(content) => {
                    if content.len() > 100_000 {
                        format!("{}... (truncated, {} bytes total)", &content[..100_000], content.len())
                    } else {
                        content
                    }
                }
                Err(e) => format!("Error reading {path}: {e}"),
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
                Ok(()) => format!("Wrote {} bytes to {path}", content.len()),
                Err(e) => format!("Error writing {path}: {e}"),
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
                        "(empty directory)".to_string()
                    } else {
                        lines.join("\n")
                    }
                }
                Err(e) => format!("Error listing {path}: {e}"),
            }
        }
        _ => format!("Unknown tool: {name}"),
    }
}

// ─── Engine ───────────────────────────────────────────────────────

pub struct ChatEngine {
    client: Client,
    db: Arc<Mutex<Db>>,
}

impl ChatEngine {
    pub fn new(db: Arc<Mutex<Db>>) -> Self {
        Self {
            client: Client::new(),
            db,
        }
    }

    /// Run the agentic loop: send messages with tools, execute tool calls,
    /// feed results back, repeat until Claude gives a final text answer.
    pub async fn send_agentic(
        &self,
        app: AppHandle,
        request: ChatRequest,
    ) -> AppResult<()> {
        let api_key = crate::settings::get_anthropic_key().ok_or_else(|| {
            AppError::Other(
                "Anthropic API key not configured. Go to Settings to add your key.".to_string(),
            )
        })?;

        let workspace_path = std::path::PathBuf::from(&request.workspace_path);

        // Persist user message.
        self.db.lock().insert_chat_message(
            &request.workspace_id,
            "user",
            &request.user_message,
            None, None, None, None,
        )?;

        // Build conversation history from DB.
        // We include user + assistant messages for the API, and inject tool
        // summaries into assistant messages so Claude remembers what it did.
        let history = self.db.lock().list_chat_messages(&request.workspace_id)?;
        let mut messages: Vec<serde_json::Value> = Vec::new();
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
                // so Claude knows what actions it took.
                let mut content = String::new();
                if !pending_tool_summary.is_empty() {
                    content.push_str(&pending_tool_summary.join("\n"));
                    content.push_str("\n\n");
                    pending_tool_summary.clear();
                }
                content.push_str(&msg.content);
                messages.push(serde_json::json!({
                    "role": "assistant",
                    "content": content,
                }));
            } else if msg.role == "user" {
                // Flush any orphaned tool summaries as a user context note.
                if !pending_tool_summary.is_empty() {
                    // This shouldn't happen normally, but safety net.
                    pending_tool_summary.clear();
                }
                messages.push(serde_json::json!({
                    "role": "user",
                    "content": msg.content,
                }));
            }
        }

        let system_prompt = request.system.unwrap_or_else(|| {
            format!(
                "You are a helpful coding assistant working in the project at {}. \
                 You have tools to run commands, read/write files, and list directories. \
                 Use them to help the user with their tasks. Be concise and take action \
                 rather than just explaining what to do.",
                request.workspace_path
            )
        });

        let mut total_input: u64 = 0;
        let mut total_output: u64 = 0;

        // ─── Agentic loop ─────────────────────────────────────────
        for iteration in 0..MAX_TOOL_ITERATIONS {
            let body = serde_json::json!({
                "model": &request.model,
                "max_tokens": 32768_u32.max(request.max_tokens),
                "system": &system_prompt,
                "tools": tool_definitions(),
                "messages": &messages,
            });

            let resp = self.client
                .post("https://api.anthropic.com/v1/messages")
                .header("x-api-key", &api_key)
                .header("anthropic-version", "2023-06-01")
                .header("anthropic-beta", "output-128k-2025-02-19")
                .header("content-type", "application/json")
                .json(&body)
                .send()
                .await
                .map_err(|e| AppError::Other(format!("Anthropic request failed: {e}")))?;

            if !resp.status().is_success() {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                return Err(AppError::Other(format!("Anthropic API error {status}: {text}")));
            }

            let response: serde_json::Value = resp.json().await
                .map_err(|e| AppError::Other(format!("JSON parse error: {e}")))?;

            // Track tokens.
            if let Some(usage) = response.get("usage") {
                total_input += usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                total_output += usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
            }

            let content = response.get("content").and_then(|c| c.as_array()).cloned().unwrap_or_default();
            let stop_reason = response.get("stop_reason").and_then(|s| s.as_str()).unwrap_or("");

            // Extract text and tool_use blocks.
            let mut text_parts = String::new();
            let mut tool_uses: Vec<(String, String, serde_json::Value)> = Vec::new(); // (id, name, input)

            for block in &content {
                match block.get("type").and_then(|t| t.as_str()) {
                    Some("text") => {
                        if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                            text_parts.push_str(text);
                        }
                    }
                    Some("tool_use") => {
                        let id = block.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string();
                        let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
                        let input = block.get("input").cloned().unwrap_or(serde_json::json!({}));
                        tool_uses.push((id, name, input));
                    }
                    _ => {}
                }
            }

            tracing::info!(
                iteration = iteration,
                stop_reason = stop_reason,
                text_len = text_parts.len(),
                tool_count = tool_uses.len(),
                "agentic loop iteration"
            );

            // Only emit text as a stream delta for the FINAL response
            // (when Claude is done with tools). Intermediate text (said
            // before tool calls) would concatenate with the final text
            // in the frontend's streamBuffer, creating a garbled message.
            // Tool cards already show what Claude is doing.
            let is_final = stop_reason != "tool_use" || tool_uses.is_empty();
            if is_final && !text_parts.is_empty() {
                let _ = app.emit("chat://stream", &ChatStreamEvent {
                    workspace_id: request.workspace_id.clone(),
                    delta: text_parts.clone(),
                    done: false,
                    input_tokens: None,
                    output_tokens: None,
                });
            }

            // Handle max_tokens truncation during tool use.
            if stop_reason == "max_tokens" && !tool_uses.is_empty() {
                tracing::warn!("Response truncated at max_tokens during tool_use — providing error tool_results and retrying");
                // Add the truncated assistant message to history.
                messages.push(serde_json::json!({
                    "role": "assistant",
                    "content": content,
                }));
                // Provide error tool_results for each tool_use (API requires matching pairs).
                let error_results: Vec<serde_json::Value> = tool_uses.iter().map(|(id, _, _)| {
                    serde_json::json!({
                        "type": "tool_result",
                        "tool_use_id": id,
                        "is_error": true,
                        "content": "ERROR: Your response was truncated because it exceeded the output token limit. The file content was cut off and NOT written. Please retry with smaller files — split into multiple files or keep each under 200 lines. Write one file at a time.",
                    })
                }).collect();
                messages.push(serde_json::json!({
                    "role": "user",
                    "content": error_results,
                }));
                continue;
            }

            // If no tool use, we're done — this was the final response.
            if stop_reason != "tool_use" || tool_uses.is_empty() {
                let final_text = text_parts.trim().to_string();

                // Emit done — include the final text so the frontend can
                // decide whether to show a message bubble.
                let _ = app.emit("chat://stream", &ChatStreamEvent {
                    workspace_id: request.workspace_id.clone(),
                    delta: String::new(),
                    done: true,
                    input_tokens: Some(total_input),
                    output_tokens: Some(total_output),
                });

                // Only persist if there's actual text.
                if !final_text.is_empty() {
                    let cost = token_engine::compute_cost(&request.model, total_input, total_output, 0, 0);
                    self.db.lock().insert_chat_message(
                        &request.workspace_id, "assistant", &final_text,
                        Some(&request.model), Some(total_input as i64),
                        Some(total_output as i64), Some(cost),
                    )?;
                }

                return Ok(());
            }

            // ─── Handle tool use ──────────────────────────────────
            // Add assistant message with content blocks to conversation.
            messages.push(serde_json::json!({
                "role": "assistant",
                "content": content,
            }));

            // Execute each tool, persist to DB, and collect results.
            let mut tool_results: Vec<serde_json::Value> = Vec::new();
            for (tool_id, tool_name, tool_input) in &tool_uses {
                tracing::info!(tool = %tool_name, "executing tool");
                let result = execute_tool(&workspace_path, tool_name, tool_input);

                // For persistence and events, strip large file contents from
                // the input (the file is already on disk). This prevents
                // multi-KB JSON payloads that slow down events and DB.
                let input_for_display = if tool_name == "write_file" {
                    let mut display = tool_input.clone();
                    if let Some(content) = display.get("content").and_then(|c| c.as_str()) {
                        let len = content.len();
                        display["content"] = serde_json::json!(format!("({len} chars, written to disk)"));
                    }
                    display
                } else {
                    tool_input.clone()
                };

                // Persist tool execution to DB as role="tool" message.
                let tool_record = serde_json::json!({
                    "toolName": tool_name,
                    "toolInput": input_for_display,
                    "result": result,
                });
                if let Err(e) = self.db.lock().insert_chat_message(
                    &request.workspace_id,
                    "tool",
                    &tool_record.to_string(),
                    None, None, None, None,
                ) {
                    tracing::error!(tool = %tool_name, error = %e, "failed to persist tool execution");
                }

                // Emit tool use event for the frontend.
                if let Err(e) = app.emit("chat://tool-use", &ToolUseEvent {
                    workspace_id: request.workspace_id.clone(),
                    tool_name: tool_name.clone(),
                    tool_input: input_for_display,
                    result: result.clone(),
                }) {
                    tracing::error!(tool = %tool_name, error = %e, "failed to emit tool-use event");
                }

                tool_results.push(serde_json::json!({
                    "type": "tool_result",
                    "tool_use_id": tool_id,
                    "content": result,
                }));
            }

            // Add tool results as user message and continue the loop.
            messages.push(serde_json::json!({
                "role": "user",
                "content": tool_results,
            }));

            tracing::info!(
                iteration = iteration,
                tools = tool_uses.len(),
                "agentic loop: executed {} tool(s), continuing",
                tool_uses.len()
            );
        }

        Err(AppError::Other(format!(
            "Agentic loop exceeded max iterations ({MAX_TOOL_ITERATIONS})"
        )))
    }
}
