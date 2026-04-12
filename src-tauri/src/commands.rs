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

    // Auto-configure context from project root.
    let guard = ContextGuard::auto_configure(&id, Path::new(&session.project_root));
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

#[tauri::command]
pub async fn switch_agent(
    state: State<'_, AppState>,
    session_id: String,
    new_model: String,
) -> AppResult<crate::session::Session> {
    // Update session's agent config in DB.
    let mut session = state
        .db
        .lock()
        .get_session(&session_id)?
        .ok_or_else(|| AppError::SessionNotFound(session_id.clone()))?;

    session.agent.model = new_model;
    session.last_active = chrono::Utc::now();
    state.db.lock().upsert_session(&session)?;

    Ok(session)
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
