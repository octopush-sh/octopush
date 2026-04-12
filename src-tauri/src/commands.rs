//! Tauri IPC commands bridging the JS frontend to the Rust core.

use crate::context_guard::ContextGuard;
use crate::error::{AppError, AppResult};
use crate::pty_manager::SpawnOptions;
use crate::session::{CreateSessionArgs, Session, SessionStatus};
use crate::state::AppState;
use crate::token_engine::{BudgetStatus, TokenEvent, TokenReport};
use chrono::Utc;
use std::collections::HashMap;
use std::path::Path;
use tauri::{AppHandle, State};
use uuid::Uuid;

// ─── Session commands ─────────────────────────────────────────────

#[tauri::command]
pub async fn create_session(
    app: AppHandle,
    state: State<'_, AppState>,
    args: CreateSessionArgs,
) -> AppResult<Session> {
    let id = Uuid::new_v4().to_string();
    let mut session = Session::from_args(id.clone(), args);

    // Expand ~/... paths to absolute before spawning.
    session.project_root = expand_tilde(&session.project_root);

    // Ensure the project root directory exists.
    let root_path = Path::new(&session.project_root);
    if !root_path.exists() {
        std::fs::create_dir_all(root_path).map_err(|e| {
            AppError::Other(format!(
                "Cannot create project root '{}': {e}",
                session.project_root
            ))
        })?;
    } else if !root_path.is_dir() {
        return Err(AppError::Other(format!(
            "'{}' exists but is not a directory",
            session.project_root
        )));
    }

    // Auto-configure context from project root.
    let guard = ContextGuard::auto_configure(&id, root_path);
    // Store detected context files in the session record.
    session.context_files = guard
        .context_files
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();

    // Persist first so the UI has a stable record even if spawn fails later.
    state.db.lock().upsert_session(&session)?;

    // Build a token scanner hook wired to the shared TokenEngine.
    let db_for_hook = std::sync::Arc::clone(&state.db);
    let scanner_hook: crate::pty_manager::OutputHook = Box::new(move |sid, bytes| {
        if let Some(ev) = crate::token_engine::scan_pty_output(sid, bytes) {
            let engine = crate::token_engine::TokenEngine::new(std::sync::Arc::clone(&db_for_hook));
            if let Err(e) = engine.record(ev) {
                tracing::warn!(session_id = %sid, error = %e, "token scan record failed");
            }
        }
    });

    // Merge guard env into PTY env (isolated HISTFILE, project type, git branch).
    let mut env = HashMap::new();
    guard.apply_env(&mut env);

    // Inject the selected model so CLI agents can read it.
    env.insert("OCTOPUS_MODEL".into(), session.agent.model.clone());

    // Spawn PTY
    state.pty.lock().spawn(
        app,
        SpawnOptions {
            id: id.clone(),
            session_name: session.name.clone(),
            cwd: session.project_root.clone(),
            env,
            rows: 24,
            cols: 80,
            shell: None,
            on_output: Some(scanner_hook),
        },
    )?;

    // Mark active now that PTY is running.
    state.db.lock().update_status(&id, SessionStatus::Active)?;
    let refreshed = state
        .db
        .lock()
        .get_session(&id)?
        .ok_or_else(|| AppError::SessionNotFound(id.clone()))?;
    Ok(refreshed)
}

#[tauri::command]
pub async fn list_sessions(state: State<'_, AppState>) -> AppResult<Vec<Session>> {
    state.db.lock().list_sessions()
}

#[tauri::command]
pub async fn write_to_session(
    state: State<'_, AppState>,
    session_id: String,
    data: Vec<u8>,
) -> AppResult<()> {
    state.pty.lock().write(&session_id, &data)
}

#[tauri::command]
pub async fn write_text_to_session(
    state: State<'_, AppState>,
    session_id: String,
    text: String,
) -> AppResult<()> {
    state.pty.lock().write(&session_id, text.as_bytes())
}

#[tauri::command]
pub async fn resize_session(
    state: State<'_, AppState>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> AppResult<()> {
    state.pty.lock().resize(&session_id, rows, cols)
}

#[tauri::command]
pub async fn kill_session(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<()> {
    let _ = state.pty.lock().kill(&session_id);
    state.db.lock().update_status(&session_id, SessionStatus::Completed)?;
    Ok(())
}

#[tauri::command]
pub async fn delete_session(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<()> {
    let _ = state.pty.lock().kill(&session_id);
    state.db.lock().delete_session(&session_id)?;
    Ok(())
}

// ─── Token commands ───────────────────────────────────────────────

#[tauri::command]
pub async fn get_token_report(
    state: State<'_, AppState>,
    session_id: Option<String>,
) -> AppResult<TokenReport> {
    state.tokens.report(session_id.as_deref())
}

#[tauri::command]
pub async fn record_token_event(
    state: State<'_, AppState>,
    event: TokenEvent,
) -> AppResult<()> {
    state.tokens.record(event)
}

#[tauri::command]
pub async fn get_budget_status(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<BudgetStatus> {
    state.tokens.budget_status(&session_id)
}

#[tauri::command]
pub async fn set_token_budget(
    state: State<'_, AppState>,
    session_id: String,
    budget: Option<u64>,
) -> AppResult<()> {
    state.tokens.set_budget(&session_id, budget)
}

// ─── Template commands ────────────────────────────────────────────

#[tauri::command]
pub async fn list_templates() -> AppResult<Vec<crate::template::SessionTemplate>> {
    crate::template::list_templates()
}

#[tauri::command]
pub async fn save_template(
    template: crate::template::SessionTemplate,
) -> AppResult<()> {
    crate::template::save_template(&template)
}

#[tauri::command]
pub async fn delete_template(name: String) -> AppResult<()> {
    crate::template::delete_template(&name)
}

// ─── Provider / Agent commands ────────────────────────────────────

#[tauri::command]
pub async fn list_providers(
    state: State<'_, AppState>,
) -> AppResult<Vec<crate::provider_router::ProviderConfig>> {
    Ok(state.router.lock().list_providers().into_iter().cloned().collect())
}

#[tauri::command]
pub async fn list_models(
    state: State<'_, AppState>,
) -> AppResult<Vec<crate::provider_router::ModelWithProvider>> {
    Ok(state.router.lock().list_models())
}

#[tauri::command]
pub async fn suggest_model(
    state: State<'_, AppState>,
    task_type: crate::provider_router::TaskType,
) -> AppResult<crate::provider_router::ModelSuggestion> {
    Ok(state.router.lock().suggest_model(&task_type))
}

#[tauri::command]
pub async fn list_adapters() -> AppResult<Vec<crate::agent_adapter::AdapterInfo>> {
    Ok(crate::agent_adapter::adapter_info_list())
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SwitchResult {
    pub session: crate::session::Session,
    /// Whether the model change was applied to the running PTY.
    pub applied_to_pty: bool,
    /// Human-readable message about what happened.
    pub message: String,
}

#[tauri::command]
pub async fn switch_agent(
    state: State<'_, AppState>,
    session_id: String,
    new_model: String,
) -> AppResult<SwitchResult> {
    let old_model;

    // Update session's agent config in DB.
    let mut session = state
        .db
        .lock()
        .get_session(&session_id)?
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;

    old_model = session.agent.model.clone();
    session.agent.model = new_model.clone();
    session.last_active = Utc::now();
    state.db.lock().upsert_session(&session)?;

    // Try to apply the model change to the running PTY.
    // For agents that support hot-swap (e.g. aider), write the
    // switch command directly. Otherwise, just record the change.
    let mut applied = false;
    let message;

    if old_model == new_model {
        message = format!("Already using {new_model}");
    } else if state.pty.lock().has(&session_id) {
        // Try writing an aider-style /model command.
        // This is a best-effort: if the agent doesn't understand it,
        // it'll just appear as text in the terminal (harmless).
        // In the future, we'll detect which agent is running and
        // send the right command.
        //
        // For now: update the OCTOPUS_MODEL env var hint for
        // reference. The actual switch depends on the agent:
        // - aider: /model <name> works mid-session
        // - claude: no mid-session switch, applies on next launch
        message = format!(
            "Model changed to {new_model}. Active PTY keeps running with {old_model}. \
             New sessions or agent restarts will use {new_model}."
        );
    } else {
        applied = true;
        message = format!("Model set to {new_model} (no active PTY).");
    }

    Ok(SwitchResult {
        session,
        applied_to_pty: applied,
        message,
    })
}

// ─── Session Recap ────────────────────────────────────────────────

#[tauri::command]
pub async fn get_session_recap(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<crate::session_recap::SessionRecap> {
    crate::session_recap::generate_recap(&state.db, &session_id)
}

// ─── Theme ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_theme() -> AppResult<crate::theme::ThemeConfig> {
    crate::theme::load_theme()
}

#[tauri::command]
pub async fn set_theme(theme: crate::theme::ThemeConfig) -> AppResult<()> {
    crate::theme::save_theme(&theme)
}

#[tauri::command]
pub async fn list_themes() -> AppResult<Vec<crate::theme::ThemeConfig>> {
    Ok(crate::theme::builtin_themes())
}

// ─── Export ───────────────────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportData {
    pub session: crate::session::Session,
    pub events: Vec<crate::token_engine::TokenEvent>,
    pub recap: crate::session_recap::SessionRecap,
}

#[tauri::command]
pub async fn export_session_json(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<String> {
    let session = state
        .db
        .lock()
        .get_session(&session_id)?
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;
    let events = state.db.lock().list_token_events(&session_id)?;
    let recap = crate::session_recap::generate_recap(&state.db, &session_id)?;
    let data = ExportData { session, events, recap };
    Ok(serde_json::to_string_pretty(&data)?)
}

#[tauri::command]
pub async fn export_session_csv(
    state: State<'_, AppState>,
    session_id: String,
) -> AppResult<String> {
    let events = state.db.lock().list_token_events(&session_id)?;
    let mut csv = String::from("timestamp,model,input_tokens,output_tokens,cache_read,cache_create,cost_usd\n");
    for e in &events {
        csv.push_str(&format!(
            "{},{},{},{},{},{},{:.6}\n",
            e.timestamp, e.model, e.input_tokens, e.output_tokens,
            e.cache_read_tokens, e.cache_creation_tokens, e.cost_usd,
        ));
    }
    Ok(csv)
}

// ─── Project commands ─────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[tauri::command]
pub async fn open_project(state: State<'_, AppState>, path: String) -> AppResult<ProjectInfo> {
    let path = expand_tilde(&path);
    if !crate::git_ops::is_git_repo(std::path::Path::new(&path)) {
        return Err(AppError::Other(format!("'{}' is not a git repository", path)));
    }
    let db = state.db.lock();
    if let Some((id, name, p)) = db.get_project_by_path(&path)? {
        db.touch_project(&id)?;
        Ok(ProjectInfo { id, name, path: p })
    } else {
        let id = uuid::Uuid::new_v4().to_string();
        let name = std::path::Path::new(&path).file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());
        db.insert_project(&id, &name, &path)?;
        Ok(ProjectInfo { id, name, path })
    }
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

// ─── Workspace commands ───────────────────────────────────────────

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
    let project_path_expanded = expand_tilde(&project_path);
    let project_path = std::path::Path::new(&project_path_expanded);

    // Ensure the repo has at least one commit (empty repos can't branch).
    crate::git_ops::ensure_initial_commit(project_path)?;

    // Detect the actual default branch instead of assuming "main".
    let base = crate::git_ops::default_branch(project_path)?
        .unwrap_or_else(|| from_branch.clone());

    crate::git_ops::create_branch(project_path, &branch, &base)?;
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
    let path = expand_tilde(&path);
    crate::git_ops::get_status(std::path::Path::new(&path))
}

#[tauri::command]
pub async fn get_git_diff(path: String) -> AppResult<String> {
    let path = expand_tilde(&path);
    crate::git_ops::get_diff_text(std::path::Path::new(&path))
}

// ─── Chat commands ────────────────────────────────────────────────

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

// ─── Helpers ──────────────────────────────────────────────────────

/// Expand `~/...` to the user's home directory.
fn expand_tilde(path: &str) -> String {
    if path == "~" {
        dirs::home_dir()
            .map(|h| h.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string())
    } else if let Some(rest) = path.strip_prefix("~/") {
        dirs::home_dir()
            .map(|h| h.join(rest).to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string())
    } else {
        path.to_string()
    }
}
