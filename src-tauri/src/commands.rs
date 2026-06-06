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
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;
use serde::{Deserialize, Serialize};

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
    pub jira_project_key: Option<String>,
    pub pinned: bool,
}

#[tauri::command]
pub async fn open_project(state: State<'_, AppState>, path: String) -> AppResult<ProjectInfo> {
    let path = expand_tilde(&path);
    let path_buf = std::path::PathBuf::from(&path);

    if !path_buf.exists() {
        return Err(AppError::Other(format!("'{}' does not exist", path)));
    }
    if !path_buf.is_dir() {
        return Err(AppError::Other(format!("'{}' is not a directory", path)));
    }

    // If the folder isn't a git repo, initialize one — opening an existing
    // codebase that isn't yet versioned is a reasonable starting point.
    if !crate::git_ops::is_git_repo(&path_buf) {
        crate::git_ops::init_repo(&path_buf)?;
    }
    // Make sure `main` actually contains the files on disk. This is a no-op
    // for healthy repos. It (a) creates the first commit when we just
    // init_repo'd, and (b) heals projects opened with a previous Octopush
    // version that left an empty initial commit — those projects' main
    // branch had no tree, so worktrees came out empty.
    crate::git_ops::ensure_initial_commit(&path_buf)?;

    let db = state.db.lock();
    if let Some((id, name, p)) = db.get_project_by_path(&path)? {
        // Opening a project always un-closes it (clears closed_at) and bumps
        // last_opened — this is the welcome-screen path back for a closed
        // sole project, when the rail's "Recently closed" drawer isn't visible.
        db.reopen_project(&id)?;
        // Heal projects opened by older Octopush versions that didn't auto-
        // create a main workspace.
        ensure_main_workspace(&db, &id, &p)?;
        // Carry the saved Jira project key (if any) so the frontend that
        // builds its project map from this return value doesn't silently
        // zero out a previously-configured mapping.
        let existing = db.get_project(&id)?;
        let jira_project_key = existing.as_ref().and_then(|p| p.jira_project_key.clone());
        let pinned = existing.map(|p| p.pinned).unwrap_or(false);
        Ok(ProjectInfo { id, name, path: p, jira_project_key, pinned })
    } else {
        let id = uuid::Uuid::new_v4().to_string();
        let name = std::path::Path::new(&path).file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());
        db.insert_project(&id, &name, &path)?;
        ensure_main_workspace(&db, &id, &path)?;
        Ok(ProjectInfo { id, name, path, jira_project_key: None, pinned: false })
    }
}

#[tauri::command]
pub async fn list_recent_projects(state: State<'_, AppState>) -> AppResult<Vec<ProjectInfo>> {
    let rows = state.db.lock().list_projects()?;
    Ok(rows.into_iter().map(|(id, name, path, _, jira_project_key, pinned)| ProjectInfo { id, name, path, jira_project_key, pinned }).collect())
}

#[tauri::command]
pub async fn list_closed_projects(state: State<'_, AppState>) -> AppResult<Vec<ProjectInfo>> {
    let rows = state.db.lock().list_closed_projects()?;
    Ok(rows
        .into_iter()
        .map(|(id, name, path, _, jira_project_key, pinned)| ProjectInfo {
            id,
            name,
            path,
            jira_project_key,
            pinned,
        })
        .collect())
}

#[tauri::command]
pub async fn reopen_project(
    state: State<'_, AppState>,
    project_id: String,
) -> AppResult<()> {
    state.db.lock().reopen_project(&project_id)
}

/// Auto-creates a workspace pointing at the project's default branch and root
/// path, so every newly opened/created project starts with a usable "main"
/// workspace instead of dropping the user into the empty-project state.
///
/// Idempotent: does nothing if the project already has at least one workspace.
/// The workspace's worktree_path equals the project root — git doesn't allow
/// the default branch to be checked out in two places, so the project root
/// IS the main worktree. Other workspaces get their own paths under
/// `.octopus-worktrees/`.
fn ensure_main_workspace(
    db: &crate::db::Db,
    project_id: &str,
    project_path: &str,
) -> AppResult<()> {
    let existing = db.list_workspaces(project_id)?;
    if !existing.is_empty() {
        return Ok(());
    }
    let branch = crate::git_ops::default_branch(std::path::Path::new(project_path))
        .ok()
        .flatten()
        .unwrap_or_else(|| "main".into());
    let id = uuid::Uuid::new_v4().to_string();
    // name = branch name so the rail shows "main" / "master" / whatever the
    // user's default branch is.
    db.insert_workspace(&id, project_id, &branch, "", &branch, Some(project_path), "")?;
    Ok(())
}

#[tauri::command]
pub async fn create_project(state: State<'_, AppState>, path: String, name: String) -> AppResult<ProjectInfo> {
    let path = expand_tilde(&path);
    let full_path = std::path::Path::new(&path).join(&name);
    std::fs::create_dir_all(&full_path)?;
    crate::git_ops::init_repo(&full_path)?;
    // Commit a baseline so the default branch has a tree (otherwise the main
    // workspace we create below would also be empty).
    crate::git_ops::ensure_initial_commit(&full_path)?;
    let id = uuid::Uuid::new_v4().to_string();
    let full_path_str = full_path.to_string_lossy().to_string();
    let db = state.db.lock();
    db.insert_project(&id, &name, &full_path_str)?;
    ensure_main_workspace(&db, &id, &full_path_str)?;
    Ok(ProjectInfo { id, name, path: full_path_str, jira_project_key: None, pinned: false })
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
pub async fn update_workspace_link(
    state: State<'_, AppState>,
    workspace_id: String,
    linked_issue_key: Option<String>,
    dismissed: bool,
) -> AppResult<()> {
    state.db.lock().update_workspace_link(&workspace_id, linked_issue_key, dismissed)
}

#[tauri::command]
pub async fn update_project_jira_key(
    state: State<'_, AppState>,
    project_id: String,
    jira_project_key: Option<String>,
) -> AppResult<()> {
    state.db.lock().update_project_jira_key(&project_id, jira_project_key)
}

#[tauri::command]
pub async fn get_git_status(path: String) -> AppResult<crate::git_ops::GitStatus> {
    let path = expand_tilde(&path);
    crate::git_ops::get_status(std::path::Path::new(&path))
}

/// Compact per-workspace git signal for the rail (one entry per worktree that
/// exists and is a git repo). Workspaces whose worktree is missing/archived
/// are omitted rather than erroring the whole batch.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceGitSummary {
    pub workspace_id: String,
    pub dirty: bool,
    pub ahead: usize,
    pub behind: usize,
}

#[tauri::command]
pub async fn workspaces_git_summary(
    state: State<'_, AppState>,
    project_id: String,
) -> AppResult<Vec<WorkspaceGitSummary>> {
    let rows = state.db.lock().list_workspaces(&project_id)?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let Some(wt) = row.worktree_path else { continue };
        let path = std::path::Path::new(&wt);
        if !crate::git_ops::is_git_repo(path) {
            continue;
        }
        // A single unreadable worktree shouldn't sink the whole project's
        // summary — default it to clean and keep going.
        let (dirty, ahead, behind) =
            crate::git_ops::dirty_ahead_behind(path).unwrap_or((false, 0, 0));
        out.push(WorkspaceGitSummary {
            workspace_id: row.id,
            dirty,
            ahead,
            behind,
        });
    }
    Ok(out)
}

#[tauri::command]
pub async fn get_git_diff(path: String) -> AppResult<String> {
    let path = expand_tilde(&path);
    crate::git_ops::get_diff_text(std::path::Path::new(&path))
}

// ─── Delete workspace ────────────────────────────────────────────

#[tauri::command]
pub async fn delete_workspace(
    state: State<'_, AppState>,
    workspace_id: String,
    project_path: String,
    branch: String,
    worktree_path: Option<String>,
) -> AppResult<()> {
    let project_path = expand_tilde(&project_path);
    let project_path_abs = std::fs::canonicalize(&project_path)
        .unwrap_or_else(|_| std::path::PathBuf::from(&project_path));

    // The "main" workspace points at the project root itself. Deleting that
    // would `rm -rf` the user's project — refuse to touch the disk or the
    // branch, just remove the DB row. (The user can still recreate the main
    // workspace via ensure_main_workspace on next open_project.)
    let is_main_workspace = worktree_path
        .as_deref()
        .map(|wt| {
            let wt_abs = std::fs::canonicalize(wt)
                .unwrap_or_else(|_| std::path::PathBuf::from(wt));
            wt_abs == project_path_abs
        })
        .unwrap_or(false);

    if !is_main_workspace {
        // Remove worktree directory
        if let Some(wt) = &worktree_path {
            let wt_path = std::path::Path::new(wt);
            if wt_path.exists() {
                let _ = std::fs::remove_dir_all(wt_path);
            }
        }
        // Prune worktree ref and delete branch
        let _ = crate::git_ops::delete_worktree(std::path::Path::new(&project_path), &branch);
        let _ = crate::git_ops::delete_branch(std::path::Path::new(&project_path), &branch);
    }
    // Remove from DB
    state.db.lock().delete_workspace(&workspace_id)?;
    Ok(())
}

// ─── Archive workspace ───────────────────────────────────────────

#[tauri::command]
pub async fn archive_workspace(
    state: State<'_, AppState>,
    workspace_id: String,
    project_path: String,
    branch: String,
    worktree_path: Option<String>,
) -> AppResult<()> {
    let project_path = expand_tilde(&project_path);
    let project_path_abs = std::fs::canonicalize(&project_path)
        .unwrap_or_else(|_| std::path::PathBuf::from(&project_path));

    // The "main" workspace points at the project root itself. Never touch the
    // disk for it — just flip the DB row to archived. (Unlike delete, archive
    // always keeps the branch.)
    let is_main_workspace = worktree_path
        .as_deref()
        .map(|wt| {
            let wt_abs = std::fs::canonicalize(wt)
                .unwrap_or_else(|_| std::path::PathBuf::from(wt));
            wt_abs == project_path_abs
        })
        .unwrap_or(false);

    if !is_main_workspace {
        // Remove worktree directory
        if let Some(wt) = &worktree_path {
            let wt_path = std::path::Path::new(wt);
            if wt_path.exists() {
                let _ = std::fs::remove_dir_all(wt_path);
            }
        }
        // Prune worktree ref — but KEEP the branch (this is the whole point of
        // archive vs delete).
        let _ = crate::git_ops::delete_worktree(std::path::Path::new(&project_path), &branch);
    }
    // Mark archived in DB (row survives, hidden from the rail)
    state.db.lock().archive_workspace(&workspace_id)?;
    Ok(())
}

#[tauri::command]
pub async fn list_archived_workspaces(
    state: State<'_, AppState>,
    project_id: String,
) -> AppResult<Vec<crate::db::WorkspaceRow>> {
    state.db.lock().list_archived_workspaces(&project_id)
}

#[tauri::command]
pub async fn restore_workspace(
    state: State<'_, AppState>,
    workspace_id: String,
    project_path: String,
    branch: String,
    worktree_path: Option<String>,
) -> AppResult<()> {
    let project_path = expand_tilde(&project_path);
    // Recreate the worktree from the kept branch (create_worktree attaches to
    // the existing refs/heads/<branch>; it does NOT create a new branch), then
    // flip status back to active.
    if let Some(wt) = worktree_path {
        let wt = expand_tilde(&wt);
        crate::git_ops::create_worktree(
            std::path::Path::new(&project_path),
            &branch,
            std::path::Path::new(&wt),
        )?;
    }
    state.db.lock().restore_workspace(&workspace_id)
}

// ─── Update workspace customization ──────────────────────────────

#[tauri::command]
pub async fn update_workspace_customization(
    state: State<'_, AppState>,
    workspace_id: String,
    glyph: Option<String>,
    tint: Option<String>,
) -> AppResult<()> {
    state.db.lock().update_workspace_customization(
        &workspace_id,
        glyph.as_deref(),
        tint.as_deref(),
    )
}

#[tauri::command]
pub async fn rename_workspace(
    state: State<'_, AppState>,
    workspace_id: String,
    name: String,
) -> AppResult<()> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::Other("Workspace name cannot be empty".into()));
    }
    state.db.lock().rename_workspace(&workspace_id, &name)
}

// ─── Chat commands ────────────────────────────────────────────────

#[tauri::command]
pub async fn send_chat_message(
    app: AppHandle,
    state: State<'_, AppState>,
    request: crate::chat_engine::ChatRequest,
) -> AppResult<()> {
    state.chat.send_agentic(app, request).await
}

#[tauri::command]
pub async fn list_chat_messages(
    state: State<'_, AppState>,
    workspace_id: String,
) -> AppResult<Vec<crate::db::ChatMessageRow>> {
    state.db.lock().list_chat_messages(&workspace_id)
}

// ─── File operations ──────────────────────────────────────────────

#[tauri::command]
pub async fn open_file_in_system(path: String) -> AppResult<()> {
    let path = expand_tilde(&path);
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| AppError::Other(format!("Failed to open: {e}")))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| AppError::Other(format!("Failed to open: {e}")))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn reveal_in_finder(path: String) -> AppResult<()> {
    let path = expand_tilde(&path);
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| AppError::Other(format!("Failed to reveal: {e}")))?;
    }
    Ok(())
}

// ─── Editor detection + open in editor/terminal ───────────────────

/// One detected editor available on the user's PATH.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorChoice {
    pub id: String,
    pub name: String,
    pub command: String,
}

/// (id, display name, CLI binary) for editors we know how to launch.
const KNOWN_EDITORS: &[(&str, &str, &str)] = &[
    ("vscode", "VS Code", "code"),
    ("cursor", "Cursor", "cursor"),
    ("zed", "Zed", "zed"),
    ("sublime", "Sublime Text", "subl"),
    ("intellij", "IntelliJ IDEA", "idea"),
];

/// True if `bin` is an executable found on PATH.
pub(crate) fn binary_on_path(bin: &str) -> bool {
    let Some(paths) = std::env::var_os("PATH") else {
        return false;
    };
    for dir in std::env::split_paths(&paths) {
        if dir.join(bin).is_file() {
            return true;
        }
        #[cfg(target_os = "windows")]
        for ext in ["exe", "cmd", "bat"] {
            if dir.join(format!("{bin}.{ext}")).is_file() {
                return true;
            }
        }
    }
    false
}

/// Split an editor command string into (program, args). Returns None if empty.
pub(crate) fn split_editor_command(cmd: &str) -> Option<(String, Vec<String>)> {
    let mut parts = cmd.split_whitespace();
    let program = parts.next()?.to_string();
    let args = parts.map(|s| s.to_string()).collect();
    Some((program, args))
}

/// Resolve which editor command to run: the configured override, else the
/// first autodetected editor.
fn resolve_editor_command() -> Option<String> {
    if let Ok(settings) = crate::settings::load_settings() {
        if let Some(cmd) = settings.editor_command {
            let trimmed = cmd.trim().to_string();
            if !trimmed.is_empty() {
                return Some(trimmed);
            }
        }
    }
    KNOWN_EDITORS
        .iter()
        .find(|(_, _, cmd)| binary_on_path(cmd))
        .map(|(_, _, cmd)| cmd.to_string())
}

#[tauri::command]
pub async fn detect_editors() -> AppResult<Vec<EditorChoice>> {
    Ok(KNOWN_EDITORS
        .iter()
        .filter(|(_, _, cmd)| binary_on_path(cmd))
        .map(|(id, name, cmd)| EditorChoice {
            id: id.to_string(),
            name: name.to_string(),
            command: cmd.to_string(),
        })
        .collect())
}

#[tauri::command]
pub async fn open_in_editor(path: String) -> AppResult<()> {
    let path = expand_tilde(&path);
    if let Some(cmd) = resolve_editor_command() {
        if let Some((program, args)) = split_editor_command(&cmd) {
            std::process::Command::new(&program)
                .args(&args)
                .arg(&path)
                .spawn()
                .map_err(|e| AppError::Other(format!("Failed to open editor: {e}")))?;
            return Ok(());
        }
    }
    // No editor configured or detected — fall back to the OS default.
    open_file_in_system(path).await
}

#[tauri::command]
pub async fn open_in_terminal(path: String) -> AppResult<()> {
    let path = expand_tilde(&path);
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-a")
            .arg("Terminal")
            .arg(&path)
            .spawn()
            .map_err(|e| AppError::Other(format!("Failed to open terminal: {e}")))?;
    }
    #[cfg(target_os = "linux")]
    {
        let mut candidates: Vec<String> = Vec::new();
        if let Ok(t) = std::env::var("TERMINAL") {
            if !t.is_empty() {
                candidates.push(t);
            }
        }
        for t in ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"] {
            candidates.push(t.to_string());
        }
        let mut spawned = false;
        for t in candidates {
            if std::process::Command::new(&t)
                .current_dir(&path)
                .spawn()
                .is_ok()
            {
                spawned = true;
                break;
            }
        }
        if !spawned {
            return Err(AppError::Other("No terminal emulator found".into()));
        }
    }
    Ok(())
}

// ─── PTY daemon commands ──────────────────────────────────────────

/// Describes a single PTY session known to the daemon.
///
/// Used by the frontend on startup to reconcile DB-persisted terminal records
/// with live daemon state: records whose id appears here as `running: true`
/// can be reattached; others are shown as Stopped.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySession {
    pub id: String,
    pub running: bool,
    pub started_at: i64,
}

/// Result of calling `spawn_or_attach_terminal`.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "mode")]
pub enum SpawnOrAttachResult {
    /// A fresh shell was started for this terminal id.
    Spawned { pid: u32 },
    /// The terminal was already alive in the daemon; scrollback replayed.
    Reattached,
}

/// Spawn a PTY for the given terminal record id, or reattach if one is already
/// running in the daemon (e.g. from before an Octopush restart).
///
/// The `id` must match the terminal record's id stored in the DB — it is used
/// as the PTY session id end-to-end so the reattach check works across restarts.
#[tauri::command]
pub async fn spawn_or_attach_terminal(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    cwd: String,
    label: String,
) -> AppResult<SpawnOrAttachResult> {
    use crate::pty_manager::{SpawnMode, SpawnOptions};

    let db_for_hook = std::sync::Arc::clone(&state.db);
    let hook_id = id.clone();
    let scanner_hook: crate::pty_manager::OutputHook = Box::new(move |sid, bytes| {
        if let Some(ev) = crate::token_engine::scan_pty_output(sid, bytes) {
            let engine =
                crate::token_engine::TokenEngine::new(std::sync::Arc::clone(&db_for_hook));
            let _ = engine.record(ev);
        }
        let _ = hook_id.as_str(); // suppress unused warning
    });

    let mode = state.pty.lock().spawn_or_attach(
        app,
        SpawnOptions {
            id: id.clone(),
            session_name: label,
            cwd,
            env: std::collections::HashMap::new(),
            rows: 24,
            cols: 80,
            shell: None,
            on_output: Some(scanner_hook),
        },
    )?;

    Ok(match mode {
        SpawnMode::Spawned { pid } => SpawnOrAttachResult::Spawned { pid },
        SpawnMode::Reattached => SpawnOrAttachResult::Reattached,
    })
}

/// List all PTY sessions currently known to the daemon.
///
/// Returns an empty list if the daemon is unavailable — callers should treat
/// that identically to "no surviving PTYs" rather than surfacing an error.
#[tauri::command]
pub async fn list_pty_sessions(
    state: State<'_, AppState>,
) -> AppResult<Vec<PtySession>> {
    // If the daemon client is a stub (daemon unavailable), list_terminals will
    // return an error; we swallow it and return an empty list so the frontend
    // degrades gracefully.
    let sessions = state
        .pty
        .lock()
        .list_live_sessions()
        .unwrap_or_default()
        .into_iter()
        .map(|info| PtySession {
            id: info.id,
            running: info.running,
            started_at: info.started_at,
        })
        .collect();
    Ok(sessions)
}

// ─── Terminal commands ────────────────────────────────────────────

#[tauri::command]
pub async fn list_terminals(
    state: State<'_, AppState>,
    workspace_id: String,
) -> AppResult<Vec<crate::db::TerminalRow>> {
    state.db.lock().list_terminals(&workspace_id)
}

#[tauri::command]
pub async fn create_terminal(
    state: State<'_, AppState>,
    workspace_id: String,
    label: String,
) -> AppResult<crate::db::TerminalRow> {
    let id = Uuid::new_v4().to_string();
    let position = state
        .db
        .lock()
        .max_terminal_position(&workspace_id)?
        .map(|p| p + 1)
        .unwrap_or(0);
    let created_at = chrono::Utc::now().timestamp();
    state
        .db
        .lock()
        .create_terminal(&id, &workspace_id, &label, position, created_at)?;
    Ok(crate::db::TerminalRow {
        id,
        workspace_id,
        label,
        position,
        created_at,
    })
}

#[tauri::command]
pub async fn rename_terminal(
    state: State<'_, AppState>,
    id: String,
    label: String,
) -> AppResult<()> {
    state.db.lock().rename_terminal(&id, &label)
}

#[tauri::command]
pub async fn delete_terminal(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    // Kill the live PTY if one exists; ignore "not found".
    let _ = state.pty.lock().kill(&id);
    state.db.lock().delete_terminal(&id)
}

// ─── Clone command ────────────────────────────────────────────────

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneCredentials {
    pub username: String,
    pub token: String,
}

/// Parse a single stderr line from `git clone --progress` into structured
/// progress data.  Returns `None` for lines that don't match.
///
/// Git progress lines look like:
///   `Receiving objects:  47% (118/250), 1.23 MiB | 512.00 KiB/s`
///   `Resolving deltas: 100% (50/50), done.`
///   `Counting objects: 100% (250/250), done.`
pub fn parse_clone_progress(line: &str) -> Option<serde_json::Value> {
    use regex::Regex;
    // Compile once per parse call — acceptable for non-hot-loop usage.
    let re = Regex::new(
        r"^(?P<phase>[A-Za-z][A-Za-z ]+):\s+(?P<pct>\d+)%\s+\((?P<cur>\d+)/(?P<total>\d+)\)",
    )
    .ok()?;

    let caps = re.captures(line.trim())?;
    let phase = caps["phase"].trim().to_string();
    let percent: u32 = caps["pct"].parse().ok()?;
    let current: u32 = caps["cur"].parse().ok()?;
    let total: u32 = caps["total"].parse().ok()?;

    Some(serde_json::json!({
        "phase": phase,
        "percent": percent,
        "current": current,
        "total": total,
    }))
}

/// Clone `url` into `target` by shelling out to the user's login shell.
///
/// This ensures the child process inherits SSH_AUTH_SOCK, ~/.ssh/config,
/// credential helpers (osxkeychain), gitconfig — exactly as if the user
/// ran `git clone` in their own terminal.
async fn clone_via_shell(
    app: &tauri::AppHandle,
    url: &str,
    target: &std::path::Path,
    host: &str,
    is_ssh: bool,
    credentials: Option<&CloneCredentials>,
) -> Result<(), AppError> {
    use std::os::unix::fs::PermissionsExt;
    use tokio::io::AsyncBufReadExt;
    use tokio::process::Command;
    use std::process::Stdio;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());

    // Escape target path for use in the shell command.
    let target_str = target.to_string_lossy();
    // Use printf '%s' style quoting — single-quote the path, escaping any
    // single quotes within by ending the quoted string, adding an escaped
    // single quote, then reopening.
    let target_escaped = target_str.replace('\'', "'\\''");
    let url_escaped = url.replace('\'', "'\\''");

    let git_cmd = format!(
        "git clone --progress -- '{}' '{}'",
        url_escaped, target_escaped
    );

    // Build environment overrides.
    let mut env_overrides: Vec<(String, String)> = vec![
        // Prevent git from blocking on tty prompts.
        ("GIT_TERMINAL_PROMPT".into(), "0".into()),
    ];

    // Askpass script path — only created when credentials are provided.
    // We hold an `Option<tempfile::NamedTempFile>` so the file lives until
    // after `child.wait()` completes, then is auto-deleted on drop.
    let _askpass_tmp: Option<tempfile::NamedTempFile>;

    if let Some(creds) = credentials {
        let script = format!(
            "#!/bin/sh\ncase \"$1\" in\n  *[Uu]sername*) printf '%%s' \"$OCTOPUS_GIT_USERNAME\" ;;\n  *[Pp]assword*) printf '%%s' \"$OCTOPUS_GIT_TOKEN\" ;;\nesac\n"
        );

        let mut tmp = tempfile::Builder::new()
            .prefix("octopus-askpass-")
            .suffix(".sh")
            .tempfile()
            .map_err(|e| AppError::Other(format!("failed to create askpass tempfile: {e}")))?;

        use std::io::Write as _;
        tmp.write_all(script.as_bytes())
            .map_err(|e| AppError::Other(format!("failed to write askpass script: {e}")))?;

        // Make executable.
        std::fs::set_permissions(tmp.path(), std::fs::Permissions::from_mode(0o755))
            .map_err(|e| AppError::Other(format!("failed to chmod askpass: {e}")))?;

        let askpass_path = tmp.path().to_string_lossy().to_string();
        env_overrides.push(("OCTOPUS_GIT_USERNAME".into(), creds.username.clone()));
        env_overrides.push(("OCTOPUS_GIT_TOKEN".into(), creds.token.clone()));
        env_overrides.push(("GIT_ASKPASS".into(), askpass_path));

        _askpass_tmp = Some(tmp);
    } else {
        _askpass_tmp = None;
    }

    let mut cmd = Command::new(&shell);
    cmd.arg("-l").arg("-c").arg(&git_cmd);
    cmd.envs(env_overrides);
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::Other(format!("failed to spawn shell for git clone: {e}")))?;

    // Stream stderr line-by-line: parse progress, collect for error context.
    let stderr_handle = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Other("no stderr handle".into()))?;

    let mut lines = tokio::io::BufReader::new(stderr_handle).lines();
    let mut stderr_lines: Vec<String> = Vec::new();

    while let Ok(Some(line)) = lines.next_line().await {
        if let Some(payload) = parse_clone_progress(&line) {
            let _ = app.emit("clone://progress", payload);
        }
        stderr_lines.push(line);
    }

    let status = child
        .wait()
        .await
        .map_err(|e| AppError::Other(format!("git clone wait failed: {e}")))?;

    if status.success() {
        return Ok(());
    }

    // Build a context string from the last few non-empty stderr lines.
    let context: String = stderr_lines
        .iter()
        .rev()
        .filter(|l| !l.trim().is_empty())
        .take(3)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .cloned()
        .collect::<Vec<_>>()
        .join("\n");

    let full_stderr = stderr_lines.join("\n");

    // Classify the error so the frontend can show the right panel.
    if full_stderr.contains("Permission denied (publickey)")
        || full_stderr.contains("Could not read from remote repository")
        || (full_stderr.contains("Permission denied") && is_ssh)
    {
        return Err(AppError::SshKeyMissing { host: host.to_string() });
    }

    if full_stderr.contains("Authentication failed")
        || full_stderr.contains("terminal prompts disabled")
        || full_stderr.contains("could not read Username")
        || full_stderr.contains("could not read Password")
        || (full_stderr.contains("Repository not found") && !is_ssh)
    {
        return Err(AppError::AuthRequired { host: host.to_string() });
    }

    Err(AppError::Other(format!(
        "git clone failed:\n{context}"
    )))
}

#[tauri::command]
pub async fn clone_project(
    state: State<'_, AppState>,
    app: AppHandle,
    path: String,
    url: String,
    name_override: Option<String>,
    credentials: Option<CloneCredentials>,
) -> AppResult<ProjectInfo> {
    use crate::git_url::parse_git_url;

    let parsed = parse_git_url(&url)
        .ok_or_else(|| AppError::Other(format!("Could not parse git URL: {url}")))?;

    let target_name = name_override
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| parsed.repo.clone());

    let base_path = expand_tilde(&path);
    let target_path = std::path::Path::new(&base_path).join(&target_name);

    if target_path.exists() {
        return Err(AppError::Other(format!(
            "Directory already exists: {}",
            target_path.display()
        )));
    }

    clone_via_shell(
        &app,
        &url,
        &target_path,
        &parsed.host,
        parsed.is_ssh,
        credentials.as_ref(),
    )
    .await?;

    // Insert into DB and return ProjectInfo.
    let id = uuid::Uuid::new_v4().to_string();
    let path_str = target_path.to_string_lossy().to_string();
    {
        let db = state.db.lock();
        db.insert_project(&id, &target_name, &path_str)?;
        // Auto-create a workspace for the cloned repo's default branch, so the
        // user lands on a usable "main"/"master" workspace instead of the empty
        // state — same as open_project/create_project.
        ensure_main_workspace(&db, &id, &path_str)?;
    }

    Ok(ProjectInfo {
        id,
        name: target_name,
        path: path_str,
        jira_project_key: None,
        pinned: false,
    })
}

#[tauri::command]
pub async fn update_project_customization(
    state: State<'_, AppState>,
    project_id: String,
    name: Option<String>,
    tint: Option<String>,
) -> AppResult<()> {
    state.db.lock().update_project(
        &project_id,
        name.as_deref(),
        tint.as_deref(),
    )
}

#[tauri::command]
pub async fn set_project_pinned(
    state: State<'_, AppState>,
    project_id: String,
    pinned: bool,
) -> AppResult<()> {
    state.db.lock().set_project_pinned(&project_id, pinned)
}

#[tauri::command]
pub async fn set_project_order(state: State<'_, AppState>, ids: Vec<String>) -> AppResult<()> {
    state.db.lock().set_project_order(&ids)
}

#[tauri::command]
pub async fn close_project(
    state: State<'_, AppState>,
    project_id: String,
) -> AppResult<()> {
    // Soft-close: the row, its workspaces, terminals and chats are preserved
    // so the project can be reopened from "Recently closed" (B1).
    state.db.lock().close_project(&project_id)
}

#[tauri::command]
pub async fn delete_project(
    state: State<'_, AppState>,
    project_id: String,
) -> AppResult<()> {
    // Look up the project to get its path and list all workspaces
    let (path, workspaces) = {
        let db = state.db.lock();
        let (_, _, path) = db
            .get_project_by_id(&project_id)?
            .ok_or_else(|| AppError::Other(format!("project not found: {}", project_id)))?;

        // Get all workspaces for this project
        let workspaces = db.list_workspaces(&project_id)?;
        (path, workspaces)
    }; // Lock is released here

    // Delete all workspaces and their associated worktrees
    for workspace in workspaces {
        // Call the existing delete_workspace logic to properly clean up worktrees
        let _ = delete_workspace(
            state.clone(),
            workspace.id,
            path.clone(),
            workspace.branch,
            workspace.worktree_path,
        )
        .await;
    }

    // Delete the project directory from disk
    let project_path = std::path::Path::new(&path);
    if project_path.exists() {
        std::fs::remove_dir_all(project_path).map_err(|e| {
            AppError::Other(format!("failed to delete project directory '{}': {}", path, e))
        })?;
    }

    // Remove from database
    state.db.lock().delete_project(&project_id)?;
    Ok(())
}

// ─── Budget commands ──────────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendSnapshot {
    pub cost_usd: f64,
    pub tokens: i64,
}

#[tauri::command]
pub async fn list_budgets(
    state: State<'_, AppState>,
) -> AppResult<Vec<crate::db::BudgetRow>> {
    state.db.lock().list_budgets()
}

#[tauri::command]
pub async fn set_budget(
    state: State<'_, AppState>,
    scope_type: String,
    scope_id: String,
    period: String,
    limit_usd: f64,
) -> AppResult<()> {
    state.db.lock().upsert_budget(&scope_type, &scope_id, &period, limit_usd)
}

#[tauri::command]
pub async fn clear_budget(
    state: State<'_, AppState>,
    scope_type: String,
    scope_id: String,
    period: String,
) -> AppResult<()> {
    state.db.lock().delete_budget(&scope_type, &scope_id, &period)
}

#[tauri::command]
pub async fn current_spend(
    state: State<'_, AppState>,
    scope_type: String,
    scope_id: String,
    period: String,
) -> AppResult<SpendSnapshot> {
    let (cost_usd, tokens) = state.db.lock().period_spend(&scope_type, &scope_id, &period)?;
    Ok(SpendSnapshot { cost_usd, tokens })
}

#[tauri::command]
pub async fn export_token_events_csv(
    state: State<'_, AppState>,
    start_iso: String,
    end_iso: String,
) -> AppResult<String> {
    state.db.lock().export_token_events_csv(&start_iso, &end_iso)
}

// ─── Usage breakdown (cloud vs local) ────────────────────────────

#[tauri::command]
pub async fn get_usage_breakdown(
    state: State<'_, AppState>,
    start_iso: String,
    end_iso: String,
) -> AppResult<crate::db::UsageBreakdown> {
    let router = crate::provider_router::ProviderRouter::load()?;
    state.db.lock().usage_breakdown(&router, &start_iso, &end_iso)
}

// ─── Pricing refresh from LiteLLM ────────────────────────────────

/// Shape of a single entry in the LiteLLM pricing dataset.
#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "snake_case", default)]
pub(crate) struct LiteLlmEntry {
    pub input_cost_per_token: f64,
    pub output_cost_per_token: f64,
    pub cache_read_input_token_cost: f64,
    pub cache_creation_input_token_cost: f64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RefreshPricingResult {
    pub models_updated: u32,
    pub models_total: u32,
    pub fetched_at: String,
}

/// Parse the LiteLLM pricing JSON into a map of model_id → entry.
/// Extracted for unit testing without network.
pub(crate) fn parse_litellm_pricing(json_str: &str) -> HashMap<String, LiteLlmEntry> {
    let raw: HashMap<String, serde_json::Value> =
        serde_json::from_str(json_str).unwrap_or_default();
    raw.into_iter()
        .filter_map(|(k, v)| {
            let entry: LiteLlmEntry = serde_json::from_value(v).ok()?;
            // Only keep entries that have at least an input cost set.
            if entry.input_cost_per_token > 0.0 {
                Some((k, entry))
            } else {
                None
            }
        })
        .collect()
}

#[tauri::command]
pub async fn refresh_pricing(state: State<'_, AppState>) -> AppResult<RefreshPricingResult> {
    const LITELLM_URL: &str =
        "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| AppError::Other(format!("failed to build http client: {e}")))?;

    let body = client
        .get(LITELLM_URL)
        .send()
        .await
        .map_err(|e| AppError::Other(format!("pricing fetch failed: {e}")))?
        .text()
        .await
        .map_err(|e| AppError::Other(format!("pricing read failed: {e}")))?;

    let prices = parse_litellm_pricing(&body);
    let fetched_at = Utc::now().to_rfc3339();

    // Load the current provider config, update matching models, save.
    let providers_path = dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(".octopush")
        .join("providers.json");

    let mut providers: Vec<crate::provider_router::ProviderConfig> = if providers_path.exists() {
        let content = std::fs::read_to_string(&providers_path)
            .map_err(|e| AppError::Other(format!("read providers.json: {e}")))?;
        serde_json::from_str(&content)
            .map_err(|e| AppError::Other(format!("parse providers.json: {e}")))?
    } else {
        // Fall back to builtins — ProviderRouter::load() will persist them.
        crate::provider_router::ProviderRouter::load()?;
        let content = std::fs::read_to_string(&providers_path)
            .map_err(|e| AppError::Other(format!("read providers.json after init: {e}")))?;
        serde_json::from_str(&content)
            .map_err(|e| AppError::Other(format!("parse providers.json after init: {e}")))?
    };

    let mut models_total: u32 = 0;
    let mut models_updated: u32 = 0;

    for provider in &mut providers {
        for model in &mut provider.models {
            models_total += 1;
            if let Some(entry) = prices.get(&model.id) {
                model.input_cost_per_m = entry.input_cost_per_token * 1_000_000.0;
                model.output_cost_per_m = entry.output_cost_per_token * 1_000_000.0;
                if entry.cache_read_input_token_cost > 0.0 {
                    model.cache_read_cost_per_m = entry.cache_read_input_token_cost * 1_000_000.0;
                }
                if entry.cache_creation_input_token_cost > 0.0 {
                    model.cache_creation_cost_per_m =
                        entry.cache_creation_input_token_cost * 1_000_000.0;
                }
                tracing::info!(
                    model = %model.id,
                    input_per_m = model.input_cost_per_m,
                    output_per_m = model.output_cost_per_m,
                    "pricing updated from LiteLLM"
                );
                models_updated += 1;
            } else {
                tracing::debug!(model = %model.id, "no LiteLLM price match — skipping");
            }
        }
    }

    // Persist updated providers.json.
    let json = serde_json::to_string_pretty(&providers)
        .map_err(|e| AppError::Other(format!("serialize providers: {e}")))?;
    std::fs::write(&providers_path, json)
        .map_err(|e| AppError::Other(format!("write providers.json: {e}")))?;

    // Reload router in state so in-memory pricing is immediately up to date.
    let updated_router = crate::provider_router::ProviderRouter::load()?;
    *state.router.lock() = updated_router;

    // Persist the refresh timestamp to settings.
    let mut settings = crate::settings::load_settings().unwrap_or_default();
    settings.last_pricing_refresh = Some(fetched_at.clone());
    let _ = crate::settings::save_settings(&settings);

    Ok(RefreshPricingResult {
        models_updated,
        models_total,
        fetched_at,
    })
}

// ─── Settings ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_settings() -> AppResult<crate::settings::AppSettings> {
    crate::settings::load_settings()
}

#[tauri::command]
pub async fn save_settings(settings: crate::settings::AppSettings) -> AppResult<()> {
    crate::settings::save_settings(&settings)
}

#[tauri::command]
pub async fn save_git_credentials(host: String, username: String, token: String) -> AppResult<()> {
    crate::settings::save_git_credentials(&host, &username, &token)
}

/// Persist the full provider catalog to ~/.octopush/providers.json.
#[tauri::command]
pub async fn save_providers(providers: Vec<crate::provider_router::ProviderConfig>) -> AppResult<()> {
    crate::provider_router::validate_providers(&providers)
        .map_err(crate::error::AppError::Other)?;
    crate::provider_router::write_providers(&providers)?;
    Ok(())
}

/// Return the built-in provider defaults (for "reset to defaults" in the UI).
#[tauri::command]
pub fn get_default_providers() -> Vec<crate::provider_router::ProviderConfig> {
    crate::provider_router::default_providers_list()
}

// ─── Issue tracker commands ───────────────────────────────────────

/// Build a Jira client from saved settings, or a clear error if unconfigured.
fn jira_client() -> AppResult<crate::issue_tracker::jira::JiraClient> {
    let cfg = crate::settings::get_issue_tracker_config()
        .ok_or_else(|| AppError::Other("Issue tracker not configured".into()))?;
    Ok(crate::issue_tracker::jira::JiraClient::new(cfg))
}

/// The current user's assigned, not-done issues (the backlog).
#[tauri::command]
pub async fn list_my_issues() -> AppResult<Vec<crate::issue_tracker::Issue>> {
    use crate::issue_tracker::IssueTracker;
    jira_client()?.list_my_issues().await
}

/// A single issue by key (for the active workspace's linked ticket).
#[tauri::command]
pub async fn get_issue(key: String) -> AppResult<crate::issue_tracker::Issue> {
    use crate::issue_tracker::IssueTracker;
    jira_client()?.get_issue(&key).await
}

/// All open tickets under `epic_key` (regardless of assignee). Backs the
/// WorkContext "Epic" pill.
#[tauri::command]
pub async fn list_issues_in_epic(
    epic_key: String,
) -> AppResult<Vec<crate::issue_tracker::Issue>> {
    use crate::issue_tracker::IssueTracker;
    jira_client()?.list_issues_in_epic(&epic_key).await
}

/// Read the saved tracker config (token included so the Settings form can
/// show it — same trust model as provider keys, on-device only).
#[tauri::command]
pub fn get_issue_tracker_config() -> Option<crate::issue_tracker::jira::JiraConfig> {
    crate::settings::get_issue_tracker_config()
}

/// Persist the tracker config to ~/.octopush/settings.json.
#[tauri::command]
pub fn save_issue_tracker_config(config: crate::issue_tracker::jira::JiraConfig) -> AppResult<()> {
    crate::settings::save_issue_tracker_config(config)
}

// ─── Directory listing ────────────────────────────────────────────

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// Read one level of a directory, respecting `.gitignore`.
/// Directories are returned first (alphabetical), then files (alphabetical).
/// `.git` is always excluded.
#[tauri::command]
pub async fn read_directory(path: String) -> AppResult<Vec<DirectoryEntry>> {
    let path = expand_tilde(&path);
    let base = std::path::Path::new(&path);

    if !base.exists() {
        return Err(AppError::Other(format!("Path does not exist: {}", path)));
    }
    if !base.is_dir() {
        return Err(AppError::Other(format!("Not a directory: {}", path)));
    }

    let mut dirs: Vec<DirectoryEntry> = Vec::new();
    let mut files: Vec<DirectoryEntry> = Vec::new();

    // WalkBuilder with max_depth(1) gives us the root entry + its direct children.
    // standard_filters(true) enables .gitignore, .ignore, hidden-file filtering.
    // We add_custom_ignore_filename(".gitignore") is already included in standard_filters.
    let walker = ignore::WalkBuilder::new(base)
        .max_depth(Some(1))
        .standard_filters(true)
        .require_git(false) // apply .gitignore rules even outside a git repo
        .hidden(false) // include dot-files like .gitignore itself; gitignore rules handle exclusions
        .build();

    for result in walker {
        let entry = match result {
            Ok(e) => e,
            Err(_) => continue,
        };

        // Skip the root itself (depth 0).
        if entry.depth() == 0 {
            continue;
        }

        let entry_path = entry.path();
        let name = entry_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();

        // Always skip .git directory.
        if name == ".git" {
            continue;
        }

        let abs_path = entry_path.to_string_lossy().into_owned();
        let is_dir = entry_path.is_dir();

        let de = DirectoryEntry {
            name,
            path: abs_path,
            is_dir,
        };

        if is_dir {
            dirs.push(de);
        } else {
            files.push(de);
        }
    }

    // Sort each group alphabetically, case-insensitive.
    dirs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    dirs.extend(files);
    Ok(dirs)
}

// ─── File I/O ─────────────────────────────────────────────────────

#[tauri::command]
pub async fn read_file(path: String) -> AppResult<String> {
    let path = expand_tilde(&path);
    std::fs::read_to_string(&path)
        .map_err(|e| AppError::Other(format!("read_file({}): {e}", path)))
}

#[tauri::command]
pub async fn write_file(path: String, content: String) -> AppResult<()> {
    let path = expand_tilde(&path);
    std::fs::write(&path, content)
        .map_err(|e| AppError::Other(format!("write_file({}): {e}", path)))
}

// ─── File edits (Review canvas) ───────────────────────────────────

#[tauri::command]
pub async fn list_file_edits(
    state: State<'_, AppState>,
    workspace_id: String,
) -> AppResult<Vec<crate::db::FileEditRow>> {
    state.db.lock().list_file_edits_for_workspace(&workspace_id)
}

#[tauri::command]
pub async fn get_message(
    state: State<'_, AppState>,
    message_id: i64,
) -> AppResult<crate::db::ChatMessageRow> {
    state
        .db
        .lock()
        .get_chat_message(message_id)?
        .ok_or_else(|| AppError::Other(format!("message {message_id} not found")))
}

// ─── Hunk operations ──────────────────────────────────────────────

/// Apply a unified-diff hunk in reverse (undo a change).
#[tauri::command]
pub async fn revert_hunk(workspace_path: String, hunk_text: String) -> AppResult<()> {
    use std::io::Write as _;
    use tempfile::NamedTempFile;

    let workspace_path = expand_tilde(&workspace_path);
    let mut tmp = NamedTempFile::new()
        .map_err(|e| AppError::Other(format!("failed to create tempfile: {e}")))?;
    tmp.write_all(hunk_text.as_bytes())
        .map_err(|e| AppError::Other(format!("failed to write hunk: {e}")))?;
    tmp.flush()
        .map_err(|e| AppError::Other(format!("failed to flush hunk: {e}")))?;

    let output = std::process::Command::new("git")
        .args(["apply", "--reverse", "-p1", tmp.path().to_str().unwrap_or("")])
        .current_dir(&workspace_path)
        .output()
        .map_err(|e| AppError::Other(format!("failed to run git apply: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Other(format!("git apply --reverse failed: {stderr}")));
    }
    Ok(())
}

/// Stage a single unified-diff hunk (partial staging).
#[tauri::command]
pub async fn stage_hunk(workspace_path: String, hunk_text: String) -> AppResult<()> {
    use std::io::Write as _;
    use tempfile::NamedTempFile;

    let workspace_path = expand_tilde(&workspace_path);
    let mut tmp = NamedTempFile::new()
        .map_err(|e| AppError::Other(format!("failed to create tempfile: {e}")))?;
    tmp.write_all(hunk_text.as_bytes())
        .map_err(|e| AppError::Other(format!("failed to write hunk: {e}")))?;
    tmp.flush()
        .map_err(|e| AppError::Other(format!("failed to flush hunk: {e}")))?;

    let output = std::process::Command::new("git")
        .args(["apply", "--cached", "-p1", tmp.path().to_str().unwrap_or("")])
        .current_dir(&workspace_path)
        .output()
        .map_err(|e| AppError::Other(format!("failed to run git apply: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Other(format!("git apply --cached failed: {stderr}")));
    }
    Ok(())
}

/// Stage all changes (git add -A).
#[tauri::command]
pub async fn stage_all_changes(workspace_path: String) -> AppResult<()> {
    let workspace_path = expand_tilde(&workspace_path);
    let output = std::process::Command::new("git")
        .args(["add", "-A"])
        .current_dir(&workspace_path)
        .output()
        .map_err(|e| AppError::Other(format!("failed to run git add: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Other(format!("git add -A failed: {stderr}")));
    }
    Ok(())
}

/// Stage a single file. `file_path` is relative to `workspace_path`.
#[tauri::command]
pub async fn stage_file(workspace_path: String, file_path: String) -> AppResult<()> {
    let workspace_path = expand_tilde(&workspace_path);
    let output = std::process::Command::new("git")
        .args(["add", "--", &file_path])
        .current_dir(&workspace_path)
        .output()
        .map_err(|e| AppError::Other(format!("failed to run git add: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Other(format!("git add failed: {stderr}")));
    }
    Ok(())
}

/// Unstage every staged change in the workspace (`git reset HEAD --`).
/// Idempotent: running it with an empty index is a no-op success.
#[tauri::command]
pub async fn unstage_all_changes(workspace_path: String) -> AppResult<()> {
    let workspace_path = expand_tilde(&workspace_path);
    let output = std::process::Command::new("git")
        .args(["reset", "HEAD", "--"])
        .current_dir(&workspace_path)
        .output()
        .map_err(|e| AppError::Other(format!("failed to run git reset: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Other(format!("git reset failed: {stderr}")));
    }
    Ok(())
}

/// Unstage a single file (`git restore --staged <path>` semantics, with a
/// fall-back to `git reset HEAD --` for repos that have no commits yet).
#[tauri::command]
pub async fn unstage_file(workspace_path: String, file_path: String) -> AppResult<()> {
    let workspace_path = expand_tilde(&workspace_path);
    // Try `git restore --staged` first (Git 2.23+).
    let output = std::process::Command::new("git")
        .args(["restore", "--staged", "--", &file_path])
        .current_dir(&workspace_path)
        .output()
        .map_err(|e| AppError::Other(format!("failed to run git restore: {e}")))?;
    if output.status.success() {
        return Ok(());
    }
    // Fall back to `git reset HEAD -- <path>` for older git or empty repos.
    let output = std::process::Command::new("git")
        .args(["reset", "HEAD", "--", &file_path])
        .current_dir(&workspace_path)
        .output()
        .map_err(|e| AppError::Other(format!("failed to run git reset: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Other(format!("unstage failed: {stderr}")));
    }
    Ok(())
}

/// Commit the staged changes with `message`. Uses the user's login shell so
/// `user.name`/`user.email` from gitconfig and any commit signing setup
/// behave as if the user ran `git commit` in their own terminal.
#[tauri::command]
pub async fn commit_changes(workspace_path: String, message: String) -> AppResult<String> {
    if message.trim().is_empty() {
        return Err(AppError::Other("commit message cannot be empty".into()));
    }
    let workspace_path = expand_tilde(&workspace_path);

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    let msg_escaped = message.replace('\'', "'\\''");
    let cmd = format!("git commit -m '{}'", msg_escaped);

    let output = std::process::Command::new(&shell)
        .arg("-l").arg("-c").arg(&cmd)
        .current_dir(&workspace_path)
        .output()
        .map_err(|e| AppError::Other(format!("failed to spawn git commit: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = if !stderr.trim().is_empty() {
            stderr.to_string()
        } else {
            stdout.to_string()
        };
        return Err(AppError::Other(format!("git commit failed: {}", detail.trim())));
    }

    // Return the new HEAD short SHA so the frontend can show a confirmation.
    let head = std::process::Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .current_dir(&workspace_path)
        .output()
        .map_err(|e| AppError::Other(format!("failed to read HEAD: {e}")))?;
    let sha = String::from_utf8_lossy(&head.stdout).trim().to_string();
    Ok(sha)
}

/// Ask the `gh` CLI for the most recent PR on `branch` (any state). Returns
/// `None` if gh isn't installed, isn't authed, or there's no matching PR.
/// Runs in the user's login shell so PATH and keychain credentials behave
/// like in a terminal.
async fn try_gh_cli(workspace_path: &str, branch: &str) -> Option<crate::github::Pr> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    // `gh pr list --json …` returns a JSON array. `--state all` covers
    // open, draft, merged, and closed PRs. `--limit 1` gives the most recent.
    let cmd = format!(
        "gh pr list --state all --head '{}' --json number,title,url,state,isDraft,mergedAt --limit 1",
        branch.replace('\'', "'\\''"),
    );

    let output = tokio::process::Command::new(&shell)
        .arg("-l").arg("-c").arg(&cmd)
        .current_dir(workspace_path)
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        tracing::info!(
            stderr = %String::from_utf8_lossy(&output.stderr).chars().take(200).collect::<String>(),
            "find_pr_for_branch: gh cli not usable, falling back to API",
        );
        return None;
    }

    let prs: Vec<serde_json::Value> = serde_json::from_slice(&output.stdout).ok()?;
    // gh cli returns "state" as "OPEN"/"CLOSED"/"MERGED" (uppercase), and a
    // separate "isDraft" bool. Normalise to lowercase for pr_from_json.
    let mut pr = prs.into_iter().next()?;
    if let Some(s) = pr.get("state").and_then(|v| v.as_str()) {
        let lower = s.to_lowercase();
        pr["state"] = serde_json::Value::String(lower);
    }
    // gh cli uses "mergedAt" (camelCase); map it to "merged_at" for pr_from_json.
    if let Some(merged_at) = pr.get("mergedAt").cloned() {
        pr["merged_at"] = merged_at;
    }
    Some(crate::github::pr_from_json(&pr))
}

/// Look up the most recent pull request for the current branch on GitHub
/// (any state: open, draft, merged, or closed).
///
/// Returns `None` (encoded as null on the JS side) when:
///   - the workspace is not a git repo
///   - the `origin` remote is missing or not on GitHub
///   - the branch has no PR at all
///
/// Uses the saved GitHub PAT (Settings → Git credentials → github.com) if
/// available; otherwise hits the API unauthenticated, which is fine for
/// public repos but rate-limited to 60 requests/hour per IP.
#[tauri::command]
pub async fn find_pr_for_branch(workspace_path: String) -> AppResult<Option<crate::github::Pr>> {
    let workspace_path = expand_tilde(&workspace_path);
    let path = std::path::Path::new(&workspace_path);

    // Read everything we need from libgit2 into owned Strings, then drop
    // the Repository handle before any `.await`. `git2::Repository` is not
    // Send, so holding it across an await would mark the future !Send and
    // refuse to compile.
    let (branch, owner, repo_name) = {
        let repo = match crate::git_ops::open_repo(path) {
            Ok(r) => r,
            Err(e) => {
                tracing::info!(error = %e, "find_pr_for_branch: cannot open repo");
                return Ok(None);
            }
        };
        let branch = match crate::git_ops::current_branch(&repo) {
            Some(b) => b,
            None => {
                tracing::info!("find_pr_for_branch: detached HEAD");
                return Ok(None);
            }
        };
        let remote = match repo.find_remote("origin") {
            Ok(r) => r,
            Err(e) => {
                tracing::info!(error = %e, "find_pr_for_branch: no `origin` remote");
                return Ok(None);
            }
        };
        let url = match remote.url() {
            Some(u) => u.to_string(),
            None => {
                tracing::info!("find_pr_for_branch: remote `origin` has no url");
                return Ok(None);
            }
        };
        let parsed = match crate::git_url::parse_git_url(&url) {
            Some(p) => p,
            None => {
                tracing::info!(url = %url, "find_pr_for_branch: could not parse remote url");
                return Ok(None);
            }
        };
        if parsed.host != "github.com" {
            tracing::info!(host = %parsed.host, "find_pr_for_branch: non-github host");
            return Ok(None);
        }
        (branch, parsed.owner, parsed.repo)
    };

    // 1. Try the `gh` CLI first — most users who ran `gh pr create` already
    //    have an authed `gh`, no extra setup required. Runs in their login
    //    shell so PATH and macOS keychain credential storage work as if
    //    they invoked `gh` from a terminal.
    if let Some(pr) = try_gh_cli(&workspace_path, &branch).await {
        tracing::info!(number = pr.number, "find_pr_for_branch: resolved via gh cli");
        return Ok(Some(pr));
    }

    // 2. Fall back to a direct GitHub API call, optionally authenticated
    //    with a saved Octopush PAT or a GITHUB_TOKEN / GH_TOKEN env var.
    //    `state=all` returns open, draft, merged, and closed PRs; sorted by
    //    most recently updated so the first result is the most relevant PR.
    let token = crate::settings::get_git_credentials("github.com")
        .map(|c| c.token)
        .or_else(|| std::env::var("GITHUB_TOKEN").ok())
        .or_else(|| std::env::var("GH_TOKEN").ok());
    let has_token = token.is_some();

    let api = format!(
        "https://api.github.com/repos/{}/{}/pulls?head={}:{}&state=all&sort=updated&direction=desc&per_page=1",
        owner,
        repo_name,
        owner,
        // The branch passes through a URL — keep the path-encoded form so
        // branch names containing `/` (e.g. `feat/foo`) survive.
        urlencoding::encode(&branch),
    );

    tracing::info!(
        owner = %owner,
        repo = %repo_name,
        branch = %branch,
        authenticated = has_token,
        "find_pr_for_branch: querying github",
    );

    let client = reqwest::Client::builder()
        .user_agent("octopush/0.1")
        .build()
        .map_err(|e| AppError::Other(format!("http client: {e}")))?;

    let mut req = client.get(&api).header("Accept", "application/vnd.github+json");
    if let Some(tok) = token {
        req = req.header("Authorization", format!("Bearer {}", tok));
    }

    let resp = req
        .send()
        .await
        .map_err(|e| {
            tracing::warn!(error = %e, "find_pr_for_branch: network error");
            AppError::Other(format!("github request failed: {e}"))
        })?;

    let status = resp.status();
    if !status.is_success() {
        // 404 happens for private repos accessed without a token. Surface
        // it in logs so the user can diagnose, but keep the chip hidden
        // gracefully.
        let body = resp.text().await.unwrap_or_default();
        tracing::info!(
            status = %status,
            authenticated = has_token,
            body = %body.chars().take(200).collect::<String>(),
            "find_pr_for_branch: non-success response",
        );
        return Ok(None);
    }

    let prs: Vec<serde_json::Value> = resp
        .json()
        .await
        .map_err(|e| AppError::Other(format!("github response parse: {e}")))?;

    tracing::info!(count = prs.len(), "find_pr_for_branch: github returned");
    let Some(pr) = prs.into_iter().next() else {
        return Ok(None);
    };

    Ok(Some(crate::github::pr_from_json(&pr)))
}

/// Push the current branch to its tracked upstream (creating it on the remote
/// if needed via `--set-upstream`). Uses the login shell so SSH agents, the
/// macOS credential helper, and `~/.gitconfig` work like they do in the
/// user's terminal. Returns the trimmed final stderr line, which usually
/// includes either the new remote refs or the error reason.
#[tauri::command]
pub async fn push_branch(workspace_path: String) -> AppResult<String> {
    let workspace_path = expand_tilde(&workspace_path);

    // Read current branch shorthand to pass as upstream target.
    let branch_out = std::process::Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&workspace_path)
        .output()
        .map_err(|e| AppError::Other(format!("failed to read branch: {e}")))?;
    let branch = String::from_utf8_lossy(&branch_out.stdout).trim().to_string();
    if branch.is_empty() || branch == "HEAD" {
        return Err(AppError::Other(
            "cannot push: not on a named branch".into(),
        ));
    }

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    let cmd = format!(
        "git push --set-upstream origin '{}' 2>&1",
        branch.replace('\'', "'\\''")
    );

    let output = std::process::Command::new(&shell)
        .arg("-l").arg("-c").arg(&cmd)
        .current_dir(&workspace_path)
        .output()
        .map_err(|e| AppError::Other(format!("failed to spawn git push: {e}")))?;

    let combined = String::from_utf8_lossy(&output.stdout).to_string();
    if !output.status.success() {
        return Err(AppError::Other(format!("git push failed: {}", combined.trim())));
    }
    Ok(combined.trim().to_string())
}

// ─── Test runner ──────────────────────────────────────────────────

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TestRunResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

/// Run a test command via the user's login shell (inherits SSH_AUTH_SOCK,
/// PATH, etc.) in the given workspace directory. Times out after 60 seconds.
#[tauri::command]
pub async fn run_test_command(workspace_path: String, command: String) -> AppResult<TestRunResult> {
    use tokio::process::Command as TokioCommand;
    use tokio::time::{timeout, Duration};

    let workspace_path = expand_tilde(&workspace_path);
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());

    let run = async {
        TokioCommand::new(&shell)
            .arg("-lc")
            .arg(&command)
            .current_dir(&workspace_path)
            .output()
            .await
            .map_err(|e| AppError::Other(format!("failed to spawn test command: {e}")))
    };

    let output = timeout(Duration::from_secs(60), run)
        .await
        .map_err(|_| AppError::Other("test command timed out after 60s".into()))??;

    Ok(TestRunResult {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}

// ─── Workspace test command ───────────────────────────────────────

#[tauri::command]
pub async fn set_workspace_test_command(
    state: State<'_, AppState>,
    workspace_id: String,
    command: String,
) -> AppResult<()> {
    state.db.lock().set_workspace_test_command(&workspace_id, &command)
}

/// Detect a sensible default test command by looking for project files.
#[tauri::command]
pub async fn detect_default_test_command(workspace_path: String) -> AppResult<Option<String>> {
    let path = std::path::Path::new(&workspace_path);
    if path.join("package.json").exists() {
        return Ok(Some("npm test".into()));
    }
    if path.join("Cargo.toml").exists() {
        return Ok(Some("cargo test".into()));
    }
    if path.join("pytest.ini").exists() || path.join("pyproject.toml").exists() {
        return Ok(Some("pytest".into()));
    }
    Ok(None)
}

// ─── Workspace-wide file & text search ────────────────────────────

/// A single text-search hit, relative to the workspace root.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    /// File path relative to the workspace root.
    pub file: String,
    /// 1-based line number.
    pub line: u32,
    /// 1-based column of the first character of the match.
    pub col: u32,
    /// The full source line containing the match, trimmed for transport.
    /// Useful as a preview in the UI.
    pub preview: String,
}

/// Hard limits so a giant repo or pathological query can't lock the UI.
const FILE_LIST_CAP: usize = 20_000;
const FILE_SIZE_CAP_BYTES: u64 = 1_000_000; // skip files > 1 MB
const SEARCH_RESULT_CAP: usize = 500;
const PREVIEW_LEN_CAP: usize = 200;

/// List every non-ignored file in the workspace. Honors `.gitignore`,
/// `.ignore`, `core.excludesFile`, and skips `.git`. Returns file paths
/// relative to `workspace_path` so the frontend can display them cleanly
/// and pass them to `openFile`.
#[tauri::command]
pub async fn list_workspace_files(workspace_path: String) -> AppResult<Vec<String>> {
    let workspace_path = expand_tilde(&workspace_path);
    let base = std::path::PathBuf::from(&workspace_path);
    if !base.is_dir() {
        return Err(AppError::Other(format!("not a directory: {workspace_path}")));
    }

    // Walking + collecting can take seconds on huge repos. Move it to a
    // blocking task so we don't park the tokio runtime.
    let result = tokio::task::spawn_blocking(move || {
        let mut files = Vec::with_capacity(1024);
        let walker = ignore::WalkBuilder::new(&base)
            .standard_filters(true)
            .require_git(false)
            .hidden(false)
            .build();
        for entry in walker {
            let Ok(entry) = entry else { continue };
            if entry.depth() == 0 {
                continue;
            }
            // Skip directories and any path that crosses through `.git`.
            let path = entry.path();
            if entry.file_type().map(|t| !t.is_file()).unwrap_or(true) {
                continue;
            }
            if path.components().any(|c| c.as_os_str() == ".git") {
                continue;
            }
            if let Ok(rel) = path.strip_prefix(&base) {
                files.push(rel.to_string_lossy().into_owned());
            }
            if files.len() >= FILE_LIST_CAP {
                break;
            }
        }
        files.sort();
        files
    })
    .await
    .map_err(|e| AppError::Other(format!("file walk join error: {e}")))?;

    Ok(result)
}

/// Search every non-ignored text file for `query`. Always literal (not
/// regex); case-insensitive when `case_sensitive` is false. Skips binary
/// files (defined as files containing a NUL in the first 8 KiB) and any
/// file larger than 1 MB. Returns up to 500 hits.
#[tauri::command]
pub async fn search_workspace_text(
    workspace_path: String,
    query: String,
    case_sensitive: bool,
) -> AppResult<Vec<SearchHit>> {
    let workspace_path = expand_tilde(&workspace_path);
    let base = std::path::PathBuf::from(&workspace_path);
    if !base.is_dir() {
        return Err(AppError::Other(format!("not a directory: {workspace_path}")));
    }
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }

    let needle_owned = if case_sensitive {
        query.clone()
    } else {
        query.to_lowercase()
    };

    let hits = tokio::task::spawn_blocking(move || {
        let mut hits: Vec<SearchHit> = Vec::new();
        let walker = ignore::WalkBuilder::new(&base)
            .standard_filters(true)
            .require_git(false)
            .hidden(false)
            .build();

        for entry in walker {
            if hits.len() >= SEARCH_RESULT_CAP {
                break;
            }
            let Ok(entry) = entry else { continue };
            if entry.depth() == 0 {
                continue;
            }
            let path = entry.path();
            if entry.file_type().map(|t| !t.is_file()).unwrap_or(true) {
                continue;
            }
            if path.components().any(|c| c.as_os_str() == ".git") {
                continue;
            }
            // Skip oversized files outright.
            let size = match std::fs::metadata(path).map(|m| m.len()) {
                Ok(s) => s,
                Err(_) => continue,
            };
            if size > FILE_SIZE_CAP_BYTES {
                continue;
            }
            // Read in bytes; bail on binary files.
            let bytes = match std::fs::read(path) {
                Ok(b) => b,
                Err(_) => continue,
            };
            if bytes
                .iter()
                .take(8192)
                .any(|&b| b == 0)
            {
                continue;
            }
            let text = match std::str::from_utf8(&bytes) {
                Ok(s) => s,
                Err(_) => continue,
            };

            let rel = match path.strip_prefix(&base) {
                Ok(r) => r.to_string_lossy().into_owned(),
                Err(_) => continue,
            };

            for (idx, line) in text.lines().enumerate() {
                let haystack = if case_sensitive {
                    line.to_string()
                } else {
                    line.to_lowercase()
                };
                if let Some(col) = haystack.find(&needle_owned) {
                    // Trim very long lines for transport.
                    let preview = if line.len() > PREVIEW_LEN_CAP {
                        let start = col.saturating_sub(40);
                        let end = (col + needle_owned.len() + 60).min(line.len());
                        let snippet = &line[start..end];
                        if start > 0 {
                            format!("…{snippet}")
                        } else {
                            snippet.to_string()
                        }
                    } else {
                        line.to_string()
                    };
                    hits.push(SearchHit {
                        file: rel.clone(),
                        line: (idx as u32) + 1,
                        col: (col as u32) + 1,
                        preview,
                    });
                    if hits.len() >= SEARCH_RESULT_CAP {
                        break;
                    }
                }
            }
        }
        hits
    })
    .await
    .map_err(|e| AppError::Other(format!("search join error: {e}")))?;

    Ok(hits)
}

// ─── Performance monitor ──────────────────────────────────────────

/// Sample current RAM (RSS) + CPU% for Octopush's process groups.
/// Async so the per-poll process scan runs off the UI thread.
#[tauri::command]
pub async fn get_perf_stats(perf: tauri::State<'_, crate::perf::PerfState>) -> Result<crate::perf::PerfStats, String> {
    // Hold the System lock only across the refresh+sample, not the FFI loop below.
    let samples = {
        let mut sys = perf.0.lock();
        crate::perf::sample_system(&mut sys)
    };
    let app_pid = std::process::id();
    let daemon_pid = crate::perf::daemon_pid();
    let responsible = crate::perf::responsible_map(&samples);
    let app_pids = crate::perf::compute_app_pids(&samples, app_pid, daemon_pid, &responsible);
    let ts = chrono::Utc::now().timestamp();
    let disk = crate::perf::home_disk();
    Ok(crate::perf::compute_stats(&samples, &app_pids, daemon_pid, disk, ts))
}

/// On-demand sizes of common build/cache dirs in a workspace. Async so the
/// directory walk runs off the UI thread.
#[tauri::command]
pub async fn get_workspace_cache_sizes(workspace_path: String) -> crate::perf::WorkspaceCacheSizes {
    let root = std::path::PathBuf::from(&workspace_path);
    let scanned = crate::perf::scan_caches(&root);
    let total_bytes = scanned.iter().map(|(_, b)| *b).sum();
    crate::perf::WorkspaceCacheSizes {
        entries: scanned.into_iter().map(|(name, bytes)| crate::perf::CacheEntry { name, bytes }).collect(),
        total_bytes,
    }
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
