//! Tauri IPC commands bridging the JS frontend to the Rust core.

use crate::error::{AppError, AppResult};
use crate::pty_manager::SpawnOptions;
use crate::session::{CreateSessionArgs, Session, SessionStatus};
use crate::state::AppState;
use std::collections::HashMap;
use tauri::{AppHandle, State};
use uuid::Uuid;

#[tauri::command]
pub async fn create_session(
    app: AppHandle,
    state: State<'_, AppState>,
    args: CreateSessionArgs,
) -> AppResult<Session> {
    let id = Uuid::new_v4().to_string();
    let session = Session::from_args(id.clone(), args);

    // Persist first so the UI has a stable record even if spawn fails later.
    state.db.lock().upsert_session(&session)?;

    // Spawn PTY
    state.pty.lock().spawn(
        app,
        SpawnOptions {
            id: id.clone(),
            session_name: session.name.clone(),
            cwd: session.project_root.clone(),
            env: HashMap::new(),
            rows: 24,
            cols: 80,
            shell: None,
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
    // Best-effort: kill the PTY if still running, then mark completed.
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
