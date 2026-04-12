# Octopus sh Evolution — Superset Model

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evolve Octopus sh from a terminal wrapper into a native agentic IDE with project-first flow, git worktree workspaces, direct AI chat integration, and the terminal as one tool among many — inspired by Superset IDE.

**Architecture:** The existing DB, PTY, and token tracking layers are preserved as infrastructure. On top, we add: (1) a Project model anchoring everything to a git repo, (2) a Workspace model backed by git worktrees for task isolation, (3) a native Chat UI that talks to Claude/OpenAI APIs via Rust streaming, making the model picker meaningful, (4) a workspace hub view showing actions (Open Terminal, Open Chat, etc.), and (5) a Changes panel showing git diffs. The app flow becomes: Welcome → Open/Create Project → Workspace Hub → Chat / Terminal / Changes.

**Tech Stack:** Existing: Tauri 2, Rust, React 19, TypeScript, Tailwind v4, SQLite, xterm.js, Zustand. New: `reqwest` (HTTP client for API calls), `tokio-stream` (SSE parsing), `git2` (libgit2 bindings for worktree/diff operations).

---

## File Structure

### New Rust modules
- `src-tauri/src/project.rs` — Project model + CRUD (open, create, list recent)
- `src-tauri/src/workspace.rs` — Workspace model + git worktree lifecycle (create branch, create worktree, delete)
- `src-tauri/src/git_ops.rs` — Git operations via `git2`: init, branch, worktree, status, diff, commit
- `src-tauri/src/chat_engine.rs` — Anthropic/OpenAI API client with streaming; message persistence
- `src-tauri/src/chat_models.rs` — ChatMessage, Conversation, ChatRequest/Response models

### New React components
- `src/components/WelcomeScreen.tsx` — "Open Project" dropzone + "New Project" button + recent projects
- `src/components/NewProjectFlow.tsx` — Location picker, Empty/Clone/Template options, repo name
- `src/components/WorkspaceHub.tsx` — Workspace main view: actions grid (Open Terminal, Open Chat, etc.)
- `src/components/WorkspaceCreator.tsx` — Step 1: task + branch. Step 2: setup script. Create button.
- `src/components/ChatView.tsx` — Chat UI: message list, input bar with model selector, streaming response
- `src/components/ChatMessage.tsx` — Single message bubble (user/assistant) with markdown rendering
- `src/components/AgentBar.tsx` — Top bar with agent icons (Claude, Gemini, etc.) for agent switching
- `src/components/ChangesPanel.tsx` — Git status + file diffs for current workspace
- `src/components/ProjectSidebar.tsx` — Replaces SessionSidebar: project tree, workspaces, branches

### New stores
- `src/stores/projectStore.ts` — Current project, recent projects, project CRUD
- `src/stores/workspaceStore.ts` — Workspaces in current project, active workspace, CRUD
- `src/stores/chatStore.ts` — Messages, conversations, streaming state, send/receive

### Modified files
- `src-tauri/src/lib.rs` — Register new IPC commands, add git2/reqwest deps
- `src-tauri/src/commands.rs` — Add project, workspace, chat, git commands
- `src-tauri/src/db.rs` — Add projects, workspaces, chat_messages tables
- `src-tauri/Cargo.toml` — Add git2, reqwest, futures-util
- `src/App.tsx` — New router: Welcome → Project → Workspace views
- `package.json` — Add react-markdown for chat rendering

### Kept as-is
- `src-tauri/src/pty_manager.rs` — Terminal still works, just not the only view
- `src-tauri/src/token_engine.rs` — Tracks API costs from chat + terminal
- `src-tauri/src/theme.rs` — Theme system unchanged
- `src/components/TerminalPane.tsx` — Still used when user clicks "Open Terminal"
- `src/components/Toasts.tsx` — Notification system unchanged
- `src/components/CommandPalette.tsx` — Will be updated in a later task to add new actions

---

## Task 1: DB schema — projects, workspaces, chat_messages tables

**Files:**
- Modify: `src-tauri/src/db.rs`

- [ ] **Step 1: Add new tables to migrate()**

```rust
// Add after the existing token_events table creation in migrate():

CREATE TABLE IF NOT EXISTS projects (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    path            TEXT NOT NULL UNIQUE,
    created_at      TEXT NOT NULL,
    last_opened     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_last_opened
    ON projects(last_opened DESC);

CREATE TABLE IF NOT EXISTS workspaces (
    id              TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL,
    name            TEXT NOT NULL,
    task            TEXT NOT NULL DEFAULT '',
    branch          TEXT NOT NULL,
    worktree_path   TEXT,
    setup_script    TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'active',
    created_at      TEXT NOT NULL,
    last_active     TEXT NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workspaces_project
    ON workspaces(project_id, last_active DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id    TEXT NOT NULL,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    model           TEXT,
    input_tokens    INTEGER,
    output_tokens   INTEGER,
    cost_usd        REAL,
    created_at      TEXT NOT NULL,
    FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_workspace
    ON chat_messages(workspace_id, created_at);
```

- [ ] **Step 2: Add project CRUD methods**

```rust
pub fn insert_project(&self, id: &str, name: &str, path: &str) -> AppResult<()> {
    let now = Utc::now().to_rfc3339();
    self.conn.execute(
        "INSERT INTO projects (id, name, path, created_at, last_opened) VALUES (?1,?2,?3,?4,?5)",
        params![id, name, path, now, now],
    )?;
    Ok(())
}

pub fn list_projects(&self) -> AppResult<Vec<(String, String, String, String)>> {
    let mut stmt = self.conn.prepare(
        "SELECT id, name, path, last_opened FROM projects ORDER BY last_opened DESC LIMIT 20"
    )?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

pub fn touch_project(&self, id: &str) -> AppResult<()> {
    self.conn.execute(
        "UPDATE projects SET last_opened = ?1 WHERE id = ?2",
        params![Utc::now().to_rfc3339(), id],
    )?;
    Ok(())
}

pub fn get_project_by_path(&self, path: &str) -> AppResult<Option<(String, String, String)>> {
    let mut stmt = self.conn.prepare("SELECT id, name, path FROM projects WHERE path = ?1")?;
    stmt.query_row(params![path], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional()
        .map_err(Into::into)
}
```

- [ ] **Step 3: Add workspace CRUD methods**

```rust
pub fn insert_workspace(&self, id: &str, project_id: &str, name: &str, task: &str,
                         branch: &str, worktree_path: Option<&str>, setup_script: &str) -> AppResult<()> {
    let now = Utc::now().to_rfc3339();
    self.conn.execute(
        "INSERT INTO workspaces (id, project_id, name, task, branch, worktree_path, setup_script, status, created_at, last_active)
         VALUES (?1,?2,?3,?4,?5,?6,?7,'active',?8,?9)",
        params![id, project_id, name, task, branch, worktree_path, setup_script, now, now],
    )?;
    Ok(())
}

pub fn list_workspaces(&self, project_id: &str) -> AppResult<Vec<WorkspaceRow>> {
    let mut stmt = self.conn.prepare(
        "SELECT id, project_id, name, task, branch, worktree_path, setup_script, status, created_at, last_active
         FROM workspaces WHERE project_id = ?1 ORDER BY last_active DESC"
    )?;
    let rows = stmt.query_map(params![project_id], |r| Ok(WorkspaceRow {
        id: r.get(0)?, project_id: r.get(1)?, name: r.get(2)?, task: r.get(3)?,
        branch: r.get(4)?, worktree_path: r.get(5)?, setup_script: r.get(6)?,
        status: r.get(7)?, created_at: r.get(8)?, last_active: r.get(9)?,
    }))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}
```

Add the `WorkspaceRow` struct:
```rust
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRow {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub task: String,
    pub branch: String,
    pub worktree_path: Option<String>,
    pub setup_script: String,
    pub status: String,
    pub created_at: String,
    pub last_active: String,
}
```

- [ ] **Step 4: Add chat message CRUD**

```rust
pub fn insert_chat_message(&self, workspace_id: &str, role: &str, content: &str,
                            model: Option<&str>, input_tokens: Option<i64>,
                            output_tokens: Option<i64>, cost: Option<f64>) -> AppResult<i64> {
    self.conn.execute(
        "INSERT INTO chat_messages (workspace_id, role, content, model, input_tokens, output_tokens, cost_usd, created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
        params![workspace_id, role, content, model, input_tokens, output_tokens, cost,
                Utc::now().to_rfc3339()],
    )?;
    Ok(self.conn.last_insert_rowid())
}

pub fn list_chat_messages(&self, workspace_id: &str) -> AppResult<Vec<ChatMessageRow>> {
    let mut stmt = self.conn.prepare(
        "SELECT id, workspace_id, role, content, model, input_tokens, output_tokens, cost_usd, created_at
         FROM chat_messages WHERE workspace_id = ?1 ORDER BY created_at"
    )?;
    let rows = stmt.query_map(params![workspace_id], |r| Ok(ChatMessageRow {
        id: r.get(0)?, workspace_id: r.get(1)?, role: r.get(2)?, content: r.get(3)?,
        model: r.get(4)?, input_tokens: r.get(5)?, output_tokens: r.get(6)?,
        cost_usd: r.get(7)?, created_at: r.get(8)?,
    }))?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}
```

Add the `ChatMessageRow` struct:
```rust
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageRow {
    pub id: i64,
    pub workspace_id: String,
    pub role: String,
    pub content: String,
    pub model: Option<String>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cost_usd: Option<f64>,
    pub created_at: String,
}
```

- [ ] **Step 5: Run cargo check**

Run: `cd src-tauri && cargo check`
Expected: compiles with existing warnings only.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/db.rs
git commit -m "db: add projects, workspaces, chat_messages tables"
```

---

## Task 2: Git operations module (git2)

**Files:**
- Create: `src-tauri/src/git_ops.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add git2 dependency**

In `Cargo.toml` `[dependencies]`:
```toml
git2 = "0.19"
```

- [ ] **Step 2: Write git_ops.rs**

```rust
//! Git operations for project and workspace management.

use crate::error::{AppError, AppResult};
use git2::{Repository, StatusOptions};
use serde::Serialize;
use std::path::Path;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub branch: Option<String>,
    pub changed_files: Vec<FileChange>,
    pub ahead: usize,
    pub behind: usize,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub status: String, // "new", "modified", "deleted", "renamed"
}

pub fn init_repo(path: &Path) -> AppResult<()> {
    Repository::init(path).map_err(|e| AppError::Other(format!("git init: {e}")))?;
    Ok(())
}

pub fn open_repo(path: &Path) -> AppResult<Repository> {
    Repository::open(path).map_err(|e| AppError::Other(format!("git open: {e}")))
}

pub fn current_branch(repo: &Repository) -> Option<String> {
    repo.head().ok()?.shorthand().map(String::from)
}

pub fn get_status(path: &Path) -> AppResult<GitStatus> {
    let repo = open_repo(path)?;
    let branch = current_branch(&repo);

    let mut opts = StatusOptions::new();
    opts.include_untracked(true);
    let statuses = repo.statuses(Some(&mut opts))
        .map_err(|e| AppError::Other(format!("git status: {e}")))?;

    let changed_files: Vec<FileChange> = statuses.iter().map(|entry| {
        let path = entry.path().unwrap_or("").to_string();
        let st = entry.status();
        let status = if st.is_index_new() || st.is_wt_new() { "new" }
            else if st.is_index_modified() || st.is_wt_modified() { "modified" }
            else if st.is_index_deleted() || st.is_wt_deleted() { "deleted" }
            else if st.is_index_renamed() || st.is_wt_renamed() { "renamed" }
            else { "unknown" };
        FileChange { path, status: status.to_string() }
    }).collect();

    Ok(GitStatus { branch, changed_files, ahead: 0, behind: 0 })
}

pub fn create_branch(path: &Path, branch_name: &str, from: &str) -> AppResult<()> {
    let repo = open_repo(path)?;
    let from_ref = repo.find_reference(&format!("refs/heads/{from}"))
        .map_err(|e| AppError::Other(format!("branch '{from}' not found: {e}")))?;
    let commit = from_ref.peel_to_commit()
        .map_err(|e| AppError::Other(format!("peel: {e}")))?;
    repo.branch(branch_name, &commit, false)
        .map_err(|e| AppError::Other(format!("create branch: {e}")))?;
    Ok(())
}

pub fn create_worktree(repo_path: &Path, branch: &str, worktree_path: &Path) -> AppResult<()> {
    let repo = open_repo(repo_path)?;
    let reference = repo.find_reference(&format!("refs/heads/{branch}"))
        .map_err(|e| AppError::Other(format!("branch '{branch}' not found: {e}")))?;
    std::fs::create_dir_all(worktree_path)?;
    repo.worktree(branch, worktree_path, None)
        .map_err(|e| AppError::Other(format!("create worktree: {e}")))?;
    // Checkout the branch in the worktree
    let wt_repo = Repository::open(worktree_path)
        .map_err(|e| AppError::Other(format!("open worktree: {e}")))?;
    wt_repo.set_head(&format!("refs/heads/{branch}"))
        .map_err(|e| AppError::Other(format!("checkout: {e}")))?;
    Ok(())
}

pub fn get_diff_text(path: &Path) -> AppResult<String> {
    let repo = open_repo(path)?;
    let diff = repo.diff_index_to_workdir(None, None)
        .map_err(|e| AppError::Other(format!("diff: {e}")))?;
    let mut buf = Vec::new();
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        buf.extend_from_slice(line.content());
        true
    }).map_err(|e| AppError::Other(format!("diff print: {e}")))?;
    Ok(String::from_utf8_lossy(&buf).to_string())
}

pub fn is_git_repo(path: &Path) -> bool {
    Repository::open(path).is_ok()
}
```

- [ ] **Step 3: Register module in lib.rs**

Add to lib.rs module list:
```rust
pub mod git_ops;
```

- [ ] **Step 4: Run cargo check**

Run: `cd src-tauri && cargo check`
Expected: compiles (git2 download + build may take a minute).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/git_ops.rs src-tauri/src/lib.rs
git commit -m "feat: git operations module via libgit2"
```

---

## Task 3: Chat engine — Anthropic API streaming client

**Files:**
- Create: `src-tauri/src/chat_engine.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add reqwest + futures-util deps**

In `Cargo.toml` `[dependencies]`:
```toml
reqwest = { version = "0.12", features = ["json", "stream"] }
futures-util = "0.3"
```

- [ ] **Step 2: Write chat_engine.rs**

```rust
//! Anthropic Messages API streaming client.
//!
//! Sends messages to Claude via the Messages API and streams the response
//! back to the frontend via Tauri events. Also records token usage.

use crate::db::Db;
use crate::error::{AppError, AppResult};
use crate::token_engine::TokenEngine;
use futures_util::StreamExt;
use parking_lot::Mutex;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChatRequest {
    pub workspace_id: String,
    pub model: String,
    pub messages: Vec<ChatMsg>,
    pub system: Option<String>,
    pub max_tokens: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ChatMsg {
    pub role: String,
    pub content: String,
}

/// Event payload streamed to the frontend as chunks arrive.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatStreamEvent {
    pub workspace_id: String,
    pub delta: String,         // text chunk
    pub done: bool,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
}

pub struct ChatEngine {
    client: Client,
    db: Arc<Mutex<Db>>,
    tokens: Arc<TokenEngine>,
}

impl ChatEngine {
    pub fn new(db: Arc<Mutex<Db>>, tokens: Arc<TokenEngine>) -> Self {
        Self {
            client: Client::new(),
            db,
            tokens,
        }
    }

    /// Send a chat request and stream the response back via Tauri events.
    pub async fn send_streaming(
        &self,
        app: AppHandle,
        request: ChatRequest,
    ) -> AppResult<()> {
        let api_key = std::env::var("ANTHROPIC_API_KEY")
            .map_err(|_| AppError::Other(
                "ANTHROPIC_API_KEY not set. Export it in your shell before launching Octopus sh.".into()
            ))?;

        // Persist user message.
        self.db.lock().insert_chat_message(
            &request.workspace_id, "user",
            &request.messages.last().map(|m| m.content.as_str()).unwrap_or(""),
            None, None, None, None,
        )?;

        // Build API request body.
        let body = serde_json::json!({
            "model": &request.model,
            "max_tokens": request.max_tokens,
            "stream": true,
            "messages": &request.messages,
            "system": request.system.as_deref().unwrap_or("You are a helpful coding assistant."),
        });

        let resp = self.client
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", &api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::Other(format!("API request failed: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(AppError::Other(format!("API error {status}: {text}")));
        }

        // Stream SSE response.
        let mut stream = resp.bytes_stream();
        let mut full_response = String::new();
        let mut input_tokens: u64 = 0;
        let mut output_tokens: u64 = 0;
        let mut buffer = String::new();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| AppError::Other(format!("stream error: {e}")))?;
            buffer.push_str(&String::from_utf8_lossy(&chunk));

            // Parse SSE lines from buffer.
            while let Some(line_end) = buffer.find('\n') {
                let line = buffer[..line_end].trim_end_matches('\r').to_string();
                buffer = buffer[line_end + 1..].to_string();

                if !line.starts_with("data: ") {
                    continue;
                }
                let data = &line[6..];
                if data == "[DONE]" {
                    continue;
                }

                if let Ok(event) = serde_json::from_str::<serde_json::Value>(data) {
                    let event_type = event.get("type").and_then(|t| t.as_str()).unwrap_or("");

                    match event_type {
                        "content_block_delta" => {
                            if let Some(delta) = event.pointer("/delta/text").and_then(|t| t.as_str()) {
                                full_response.push_str(delta);
                                let _ = app.emit("chat://stream", ChatStreamEvent {
                                    workspace_id: request.workspace_id.clone(),
                                    delta: delta.to_string(),
                                    done: false,
                                    input_tokens: None,
                                    output_tokens: None,
                                });
                            }
                        }
                        "message_delta" => {
                            if let Some(usage) = event.get("usage") {
                                output_tokens = usage.get("output_tokens")
                                    .and_then(|v| v.as_u64()).unwrap_or(0);
                            }
                        }
                        "message_start" => {
                            if let Some(usage) = event.pointer("/message/usage") {
                                input_tokens = usage.get("input_tokens")
                                    .and_then(|v| v.as_u64()).unwrap_or(0);
                            }
                        }
                        _ => {}
                    }
                }
            }
        }

        // Emit done event.
        let _ = app.emit("chat://stream", ChatStreamEvent {
            workspace_id: request.workspace_id.clone(),
            delta: String::new(),
            done: true,
            input_tokens: Some(input_tokens),
            output_tokens: Some(output_tokens),
        });

        // Persist assistant message.
        let cost = crate::token_engine::compute_cost(
            &request.model, input_tokens, output_tokens, 0, 0,
        );
        self.db.lock().insert_chat_message(
            &request.workspace_id, "assistant", &full_response,
            Some(&request.model), Some(input_tokens as i64),
            Some(output_tokens as i64), Some(cost),
        )?;

        // Record token event for dashboard tracking.
        let _ = self.tokens.record(crate::token_engine::TokenEvent {
            id: None,
            session_id: request.workspace_id.clone(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            input_tokens,
            output_tokens,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            model: request.model,
            cost_usd: cost,
        });

        Ok(())
    }
}
```

- [ ] **Step 3: Register module in lib.rs**

```rust
pub mod chat_engine;
```

- [ ] **Step 4: Run cargo check**

Run: `cd src-tauri && cargo check`
Expected: compiles.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/chat_engine.rs src-tauri/src/lib.rs
git commit -m "feat: chat engine with Anthropic streaming API"
```

---

## Task 4: IPC commands for projects, workspaces, chat, git

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Update AppState with ChatEngine**

In `state.rs`, add `chat_engine` field:
```rust
use crate::chat_engine::ChatEngine;

pub struct AppState {
    pub db: Arc<Mutex<Db>>,
    pub pty: Mutex<PtyManager>,
    pub tokens: Arc<TokenEngine>,  // change to Arc for sharing with ChatEngine
    pub router: Mutex<ProviderRouter>,
    pub chat: ChatEngine,
}
```

Update `init()` to construct ChatEngine with `Arc::clone(&tokens)`.

- [ ] **Step 2: Add project commands to commands.rs**

```rust
#[tauri::command]
pub async fn open_project(state: State<'_, AppState>, path: String) -> AppResult<ProjectInfo> {
    let path = expand_tilde(&path);
    if !crate::git_ops::is_git_repo(std::path::Path::new(&path)) {
        return Err(AppError::Other(format!("'{}' is not a git repository", path)));
    }
    let db = state.db.lock();
    let project = if let Some((id, name, p)) = db.get_project_by_path(&path)? {
        db.touch_project(&id)?;
        ProjectInfo { id, name, path: p }
    } else {
        let id = uuid::Uuid::new_v4().to_string();
        let name = std::path::Path::new(&path).file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());
        db.insert_project(&id, &name, &path)?;
        ProjectInfo { id, name, path }
    };
    Ok(project)
}

#[tauri::command]
pub async fn list_recent_projects(state: State<'_, AppState>) -> AppResult<Vec<ProjectInfo>> {
    let rows = state.db.lock().list_projects()?;
    Ok(rows.into_iter().map(|(id, name, path, _)| ProjectInfo { id, name, path }).collect())
}

#[tauri::command]
pub async fn create_project(state: State<'_, AppState>, path: String, name: String) -> AppResult<ProjectInfo> {
    let path = expand_tilde(&path);
    let full_path = std::path::Path::new(&path).join(&name);
    std::fs::create_dir_all(&full_path)?;
    crate::git_ops::init_repo(&full_path)?;
    let id = uuid::Uuid::new_v4().to_string();
    state.db.lock().insert_project(&id, &name, &full_path.to_string_lossy())?;
    Ok(ProjectInfo { id, name, path: full_path.to_string_lossy().to_string() })
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    pub path: String,
}
```

- [ ] **Step 3: Add workspace commands**

```rust
#[tauri::command]
pub async fn create_workspace(
    state: State<'_, AppState>,
    project_id: String,
    project_path: String,
    name: String,
    task: String,
    branch: String,
    from_branch: String,
    setup_script: String,
) -> AppResult<crate::db::WorkspaceRow> {
    let project_path = std::path::Path::new(&project_path);
    // Create branch from base
    crate::git_ops::create_branch(project_path, &branch, &from_branch)?;
    // Create worktree
    let wt_path = project_path.parent().unwrap_or(project_path)
        .join(format!(".octopus-worktrees/{}", &branch));
    crate::git_ops::create_worktree(project_path, &branch, &wt_path)?;

    let id = uuid::Uuid::new_v4().to_string();
    state.db.lock().insert_workspace(
        &id, &project_id, &name, &task, &branch,
        Some(&wt_path.to_string_lossy()), &setup_script,
    )?;

    let workspaces = state.db.lock().list_workspaces(&project_id)?;
    Ok(workspaces.into_iter().find(|w| w.id == id).unwrap())
}

#[tauri::command]
pub async fn list_workspaces(state: State<'_, AppState>, project_id: String) -> AppResult<Vec<crate::db::WorkspaceRow>> {
    state.db.lock().list_workspaces(&project_id)
}

#[tauri::command]
pub async fn get_git_status(path: String) -> AppResult<crate::git_ops::GitStatus> {
    crate::git_ops::get_status(std::path::Path::new(&path))
}

#[tauri::command]
pub async fn get_git_diff(path: String) -> AppResult<String> {
    crate::git_ops::get_diff_text(std::path::Path::new(&path))
}
```

- [ ] **Step 4: Add chat commands**

```rust
#[tauri::command]
pub async fn send_chat_message(
    app: AppHandle,
    state: State<'_, AppState>,
    request: crate::chat_engine::ChatRequest,
) -> AppResult<()> {
    state.chat.send_streaming(app, request).await
}

#[tauri::command]
pub async fn list_chat_messages(
    state: State<'_, AppState>,
    workspace_id: String,
) -> AppResult<Vec<crate::db::ChatMessageRow>> {
    state.db.lock().list_chat_messages(&workspace_id)
}
```

- [ ] **Step 5: Register all new commands in lib.rs**

Add to the `invoke_handler` array:
```rust
// Projects
commands::open_project,
commands::list_recent_projects,
commands::create_project,
// Workspaces
commands::create_workspace,
commands::list_workspaces,
commands::get_git_status,
commands::get_git_diff,
// Chat
commands::send_chat_message,
commands::list_chat_messages,
```

- [ ] **Step 6: Run cargo check**

Run: `cd src-tauri && cargo check`
Expected: compiles.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/state.rs src-tauri/src/lib.rs
git commit -m "feat: IPC commands for projects, workspaces, chat, git"
```

---

## Task 5: Frontend types, IPC wrappers, and stores

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/ipc.ts`
- Create: `src/stores/projectStore.ts`
- Create: `src/stores/workspaceStore.ts`
- Create: `src/stores/chatStore.ts`
- Modify: `package.json`

- [ ] **Step 1: Install react-markdown**

```bash
npm install react-markdown
```

- [ ] **Step 2: Add types to types.ts**

```typescript
// ─── Projects ─────────────────────────────────────────────────────

export interface ProjectInfo {
  id: string;
  name: string;
  path: string;
}

// ─── Workspaces ───────────────────────────────────────────────────

export interface Workspace {
  id: string;
  projectId: string;
  name: string;
  task: string;
  branch: string;
  worktreePath: string | null;
  setupScript: string;
  status: string;
  createdAt: string;
  lastActive: string;
}

// ─── Chat ─────────────────────────────────────────────────────────

export interface ChatMessage {
  id: number;
  workspaceId: string;
  role: "user" | "assistant";
  content: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  createdAt: string;
}

export interface ChatStreamEvent {
  workspaceId: string;
  delta: string;
  done: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
}

// ─── Git ──────────────────────────────────────────────────────────

export interface GitStatus {
  branch: string | null;
  changedFiles: FileChange[];
  ahead: number;
  behind: number;
}

export interface FileChange {
  path: string;
  status: "new" | "modified" | "deleted" | "renamed" | "unknown";
}
```

- [ ] **Step 3: Add IPC wrappers**

```typescript
// ─── Projects ───────────────────────────────────────────────────
openProject: (path: string) => invoke<ProjectInfo>("open_project", { path }),
listRecentProjects: () => invoke<ProjectInfo[]>("list_recent_projects"),
createProject: (path: string, name: string) => invoke<ProjectInfo>("create_project", { path, name }),

// ─── Workspaces ─────────────────────────────────────────────────
createWorkspace: (projectId: string, projectPath: string, name: string, task: string,
                  branch: string, fromBranch: string, setupScript: string) =>
  invoke<Workspace>("create_workspace", { projectId, projectPath, name, task, branch, fromBranch, setupScript }),
listWorkspaces: (projectId: string) => invoke<Workspace[]>("list_workspaces", { projectId }),

// ─── Chat ───────────────────────────────────────────────────────
sendChatMessage: (request: { workspaceId: string; model: string; messages: { role: string; content: string }[]; system?: string; maxTokens: number }) =>
  invoke<void>("send_chat_message", { request }),
listChatMessages: (workspaceId: string) => invoke<ChatMessage[]>("list_chat_messages", { workspaceId }),

// ─── Git ────────────────────────────────────────────────────────
getGitStatus: (path: string) => invoke<GitStatus>("get_git_status", { path }),
getGitDiff: (path: string) => invoke<string>("get_git_diff", { path }),
```

- [ ] **Step 4: Create projectStore.ts**

```typescript
import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { ProjectInfo } from "../lib/types";

interface ProjectState {
  current: ProjectInfo | null;
  recent: ProjectInfo[];
  loading: boolean;

  open: (path: string) => Promise<void>;
  create: (path: string, name: string) => Promise<void>;
  loadRecent: () => Promise<void>;
  close: () => void;
}

export const useProjectStore = create<ProjectState>((set) => ({
  current: null,
  recent: [],
  loading: false,

  open: async (path) => {
    set({ loading: true });
    const project = await ipc.openProject(path);
    set({ current: project, loading: false });
  },

  create: async (path, name) => {
    set({ loading: true });
    const project = await ipc.createProject(path, name);
    set({ current: project, loading: false });
  },

  loadRecent: async () => {
    const recent = await ipc.listRecentProjects();
    set({ recent });
  },

  close: () => set({ current: null }),
}));
```

- [ ] **Step 5: Create workspaceStore.ts**

```typescript
import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { Workspace } from "../lib/types";

interface WorkspaceState {
  workspaces: Workspace[];
  activeId: string | null;
  loading: boolean;

  load: (projectId: string) => Promise<void>;
  create: (projectId: string, projectPath: string, name: string, task: string,
           branch: string, fromBranch: string, setupScript: string) => Promise<Workspace>;
  select: (id: string | null) => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  activeId: null,
  loading: false,

  load: async (projectId) => {
    set({ loading: true });
    const workspaces = await ipc.listWorkspaces(projectId);
    set({ workspaces, loading: false });
    if (!get().activeId && workspaces.length > 0) {
      set({ activeId: workspaces[0].id });
    }
  },

  create: async (projectId, projectPath, name, task, branch, fromBranch, setupScript) => {
    const ws = await ipc.createWorkspace(projectId, projectPath, name, task, branch, fromBranch, setupScript);
    set((s) => ({
      workspaces: [ws, ...s.workspaces],
      activeId: ws.id,
    }));
    return ws;
  },

  select: (id) => set({ activeId: id }),
}));
```

- [ ] **Step 6: Create chatStore.ts**

```typescript
import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { ipc } from "../lib/ipc";
import type { ChatMessage, ChatStreamEvent } from "../lib/types";

interface ChatState {
  messages: ChatMessage[];
  streaming: boolean;
  streamBuffer: string;
  model: string;

  loadHistory: (workspaceId: string) => Promise<void>;
  send: (workspaceId: string, content: string, systemPrompt?: string) => Promise<void>;
  setModel: (model: string) => void;
  clear: () => void;
}

export const useChatStore = create<ChatState>((set, get) => {
  // Listen for streaming events.
  listen<ChatStreamEvent>("chat://stream", (ev) => {
    const payload = ev.payload;
    if (payload.done) {
      set((s) => ({
        streaming: false,
        messages: [
          ...s.messages,
          {
            id: Date.now(),
            workspaceId: payload.workspaceId,
            role: "assistant" as const,
            content: s.streamBuffer,
            model: get().model,
            inputTokens: payload.inputTokens,
            outputTokens: payload.outputTokens,
            costUsd: null,
            createdAt: new Date().toISOString(),
          },
        ],
        streamBuffer: "",
      }));
    } else {
      set((s) => ({ streamBuffer: s.streamBuffer + payload.delta }));
    }
  });

  return {
    messages: [],
    streaming: false,
    streamBuffer: "",
    model: "claude-sonnet-4-6",

    loadHistory: async (workspaceId) => {
      const messages = await ipc.listChatMessages(workspaceId);
      set({ messages: messages as ChatMessage[] });
    },

    send: async (workspaceId, content, systemPrompt) => {
      const userMsg: ChatMessage = {
        id: Date.now(),
        workspaceId,
        role: "user",
        content,
        model: null,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        createdAt: new Date().toISOString(),
      };

      const allMessages = [...get().messages, userMsg];
      set({ messages: allMessages, streaming: true, streamBuffer: "" });

      await ipc.sendChatMessage({
        workspaceId,
        model: get().model,
        messages: allMessages.map((m) => ({ role: m.role, content: m.content })),
        system: systemPrompt,
        maxTokens: 8192,
      });
    },

    setModel: (model) => set({ model }),
    clear: () => set({ messages: [], streamBuffer: "" }),
  };
});
```

- [ ] **Step 7: Run typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/lib/types.ts src/lib/ipc.ts src/stores/projectStore.ts src/stores/workspaceStore.ts src/stores/chatStore.ts package.json package-lock.json
git commit -m "feat: frontend types, IPC, and stores for projects/workspaces/chat"
```

---

## Task 6: Welcome Screen + New Project flow

**Files:**
- Create: `src/components/WelcomeScreen.tsx`
- Create: `src/components/NewProjectFlow.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: Write WelcomeScreen.tsx**

Full-screen welcome with: logo, "Open Project" button (calls Tauri file dialog), recent projects list, "New Project" button. Uses `useProjectStore`. When a project is opened, App transitions to workspace view.

- [ ] **Step 2: Write NewProjectFlow.tsx**

Full-screen form: Location input, Empty/Clone options, Repository Name, Create button. On create, calls `projectStore.create()`.

- [ ] **Step 3: Update App.tsx routing**

Replace the current always-terminal layout with a view router:
- No project → WelcomeScreen
- Project loaded, no workspace → WorkspaceHub (Task 7)
- Workspace selected → workspace view with terminal/chat/changes tabs

```typescript
const project = useProjectStore((s) => s.current);

if (!project) return <WelcomeScreen />;
return <ProjectView project={project} />;
```

- [ ] **Step 4: Run dev server and verify welcome screen appears**

Run: `npm run dev` (just Vite, no Tauri needed for UI work)

- [ ] **Step 5: Commit**

```bash
git add src/components/WelcomeScreen.tsx src/components/NewProjectFlow.tsx src/App.tsx
git commit -m "feat: welcome screen and new project flow"
```

---

## Task 7: Workspace Hub + Creator

**Files:**
- Create: `src/components/WorkspaceHub.tsx`
- Create: `src/components/WorkspaceCreator.tsx`
- Create: `src/components/ProjectSidebar.tsx`

- [ ] **Step 1: Write ProjectSidebar.tsx**

Left sidebar showing: project name, "New Workspace" button, list of workspaces (name, branch, status), "Add repository" at bottom. Replaces SessionSidebar when in project view.

- [ ] **Step 2: Write WorkspaceHub.tsx**

Center content when a workspace is selected but no specific tool is open. Shows actions grid: "Open Terminal" (⌘T), "Open Chat" (⌘⇧C), "Search Files" (⌘⇧P). Similar to Superset's workspace hub.

- [ ] **Step 3: Write WorkspaceCreator.tsx**

Two-step wizard:
- Step 1: Task description + branch name (auto-slugified from task) + base branch dropdown
- Step 2: Setup script (detect package manager, "Add commands" / "Skip"), "Create workspace" button

- [ ] **Step 4: Commit**

```bash
git add src/components/WorkspaceHub.tsx src/components/WorkspaceCreator.tsx src/components/ProjectSidebar.tsx
git commit -m "feat: workspace hub, creator wizard, and project sidebar"
```

---

## Task 8: Chat UI

**Files:**
- Create: `src/components/ChatView.tsx`
- Create: `src/components/ChatMessage.tsx`
- Create: `src/components/AgentBar.tsx`

- [ ] **Step 1: Write AgentBar.tsx**

Horizontal bar with agent icons: Claude (active), Gemini, Codex, etc. Clicking one selects it as the active agent/model. The selected model feeds into `chatStore.setModel()`.

- [ ] **Step 2: Write ChatMessage.tsx**

Single message bubble. User messages right-aligned, assistant messages left. Assistant messages rendered with `react-markdown`. Shows model + token count below assistant messages.

- [ ] **Step 3: Write ChatView.tsx**

Full chat interface:
- AgentBar at top
- Message list (scrollable, auto-scroll on new messages)
- Streaming indicator (animated dots while assistant is typing)
- Input bar at bottom: textarea + send button + model selector dropdown
- Sends via `chatStore.send()`, listens to stream events

- [ ] **Step 4: Wire ChatView into workspace routing**

In the workspace view, add tabs/views: Terminal | Chat | Changes. ChatView renders when "Chat" is active.

- [ ] **Step 5: Commit**

```bash
git add src/components/ChatView.tsx src/components/ChatMessage.tsx src/components/AgentBar.tsx
git commit -m "feat: chat UI with streaming and agent bar"
```

---

## Task 9: Changes Panel

**Files:**
- Create: `src/components/ChangesPanel.tsx`

- [ ] **Step 1: Write ChangesPanel.tsx**

Right sidebar (or tab) showing:
- Current branch name
- List of changed files (new/modified/deleted) with status icons
- Diff viewer (pre-formatted text from `get_git_diff`)
- Commit message input + "Commit" button (future — for now, display only)
- "Publish Branch" button (future)
- Auto-refreshes on workspace focus

- [ ] **Step 2: Wire into workspace view**

Add as a collapsible right panel, similar to how TokenDashboard works but showing git info instead of token metrics.

- [ ] **Step 3: Commit**

```bash
git add src/components/ChangesPanel.tsx
git commit -m "feat: changes panel with git status and diffs"
```

---

## Task 10: Integration — wire everything into App.tsx

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Build the full view router**

```
No project → WelcomeScreen
Project, no workspace → ProjectSidebar + WorkspaceHub/Creator
Project + workspace → ProjectSidebar + workspace view
  workspace view: tabs [Terminal | Chat | Changes]
    Terminal → existing TerminalPane
    Chat → ChatView
    Changes → ChangesPanel
```

- [ ] **Step 2: Update keyboard shortcuts**

- ⌘⇧C → Open Chat view
- ⌘⇧G → Open Changes view
- ⌘T → Open Terminal (keep existing)
- ⌘N → New Workspace (replaces ⌘T for new session)

- [ ] **Step 3: Run full verification**

```bash
cd src-tauri && cargo check && cargo test
cd .. && npx tsc --noEmit && npx vite build && npx vitest run
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: full app integration — welcome, workspaces, chat, changes"
```

---

## Summary

| Task | What | New files | Estimated steps |
|------|------|-----------|----------------|
| 1 | DB schema | 0 new, 1 modified | 6 |
| 2 | Git ops (git2) | 1 new | 5 |
| 3 | Chat engine | 1 new | 5 |
| 4 | IPC commands | 0 new, 3 modified | 7 |
| 5 | Frontend stores/types | 3 new, 2 modified | 8 |
| 6 | Welcome + New Project | 2 new, 1 modified | 5 |
| 7 | Workspace Hub + Creator | 3 new | 4 |
| 8 | Chat UI | 3 new | 5 |
| 9 | Changes Panel | 1 new | 3 |
| 10 | Integration | 0 new, 1 modified | 4 |

**Total: 14 new files, 8 modified, ~52 steps.**

Existing modules preserved: pty_manager, token_engine, theme, toasts, command palette (updated later). The terminal becomes one view alongside chat and changes.
