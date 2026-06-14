//! Tauri IPC commands bridging the JS frontend to the Rust core.

use crate::context_guard::ContextGuard;
use crate::error::{AppError, AppResult};
use crate::providers::{LlmContent, LlmMessage, LlmRequest, LlmRole};
use crate::orchestrator::types::CheckpointAction;
use crate::orchestrator::Orchestrator;
use crate::pty_manager::SpawnOptions;
use crate::session::{CreateSessionArgs, Session, SessionStatus};
use crate::state::AppState;
use crate::token_engine::{BudgetStatus, TokenEvent, TokenReport};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

// ─── Timeout helper ───────────────────────────────────────────────

/// Run a blocking closure with a wall-clock timeout. `None` on timeout (the closure keeps
/// running on the blocking pool but its result is dropped) — keeps slow git2 graph walks
/// from hanging the UI.
pub async fn run_with_timeout<F, T>(dur: std::time::Duration, f: F) -> Option<T>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    match tokio::time::timeout(dur, tokio::task::spawn_blocking(f)).await {
        Ok(Ok(v)) => Some(v),
        _ => None,
    }
}

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
    pub tint: Option<String>,
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
        let pinned = existing.as_ref().map(|p| p.pinned).unwrap_or(false);
        let tint = existing.as_ref().and_then(|p| p.tint.clone());
        Ok(ProjectInfo { id, name, path: p, jira_project_key, pinned, tint })
    } else {
        let id = uuid::Uuid::new_v4().to_string();
        let name = std::path::Path::new(&path).file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());
        db.insert_project(&id, &name, &path)?;
        ensure_main_workspace(&db, &id, &path)?;
        Ok(ProjectInfo { id, name, path, jira_project_key: None, pinned: false, tint: None })
    }
}

#[tauri::command]
pub async fn list_recent_projects(state: State<'_, AppState>) -> AppResult<Vec<ProjectInfo>> {
    let rows = state.db.lock().list_projects()?;
    Ok(rows.into_iter().map(|(id, name, path, _, jira_project_key, pinned, tint)| ProjectInfo { id, name, path, jira_project_key, pinned, tint }).collect())
}

#[tauri::command]
pub async fn list_closed_projects(state: State<'_, AppState>) -> AppResult<Vec<ProjectInfo>> {
    let rows = state.db.lock().list_closed_projects()?;
    Ok(rows
        .into_iter()
        .map(|(id, name, path, _, jira_project_key, pinned, tint)| ProjectInfo {
            id,
            name,
            path,
            jira_project_key,
            pinned,
            tint,
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
    db.insert_workspace(&id, project_id, &branch, "", &branch, Some(project_path), "", None)?;
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
    Ok(ProjectInfo { id, name, path: full_path_str, jira_project_key: None, pinned: false, tint: None })
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

    // Explicit base branch wins; blank falls back to the repo's default.
    let base = crate::git_ops::resolve_base(
        &from_branch,
        crate::git_ops::default_branch(project_path)?,
    )?;

    crate::git_ops::create_branch(project_path, &branch, &base)?;
    let wt_path = project_path.parent().unwrap_or(project_path)
        .join(format!(".octopus-worktrees/{}", &branch));
    crate::git_ops::create_worktree(project_path, &branch, &wt_path)?;
    let id = uuid::Uuid::new_v4().to_string();
    state.db.lock().insert_workspace(
        &id, &project_id, &name, &task, &branch,
        Some(&wt_path.to_string_lossy()), &setup_script,
        Some(&base), // the RESOLVED base, not the raw (possibly blank) request
    )?;
    let workspaces = state.db.lock().list_workspaces(&project_id)?;
    Ok(workspaces.into_iter().find(|w| w.id == id).unwrap())
}

/// Local + remote-tracking branches for the workspace creator's base picker.
/// Locals keep their "default first" ordering; remotes come fully qualified
/// (`origin/dev`) so the picker can pass them straight back as a base.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BranchList {
    pub local: Vec<String>,
    pub remote: Vec<String>,
}

#[tauri::command]
pub async fn list_branches(path: String) -> AppResult<BranchList> {
    let path = expand_tilde(&path);
    let p = std::path::Path::new(&path);
    Ok(BranchList {
        local: crate::git_ops::list_branches(p)?,
        remote: crate::git_ops::list_remote_branches(p)?,
    })
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
) -> AppResult<()> {
    state.db.lock().update_workspace_link(&workspace_id, linked_issue_key)
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
    let mut status = crate::git_ops::status_files(std::path::Path::new(&path))?;
    let p = path.clone();
    match run_with_timeout(std::time::Duration::from_secs(3), move || {
        crate::git_ops::ahead_behind(std::path::Path::new(&p))
    }).await {
        Some(Some((a, b))) => { status.ahead = a; status.behind = b; status.ahead_behind_known = true; }
        _ => { status.ahead = 0; status.behind = 0; status.ahead_behind_known = false; }
    }
    Ok(status)
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
        // summary — default it to clean and keep going. `is_dirty` is fast
        // (index walk); `ahead_behind` can block on graph traversal so we
        // time it out separately to keep the rail responsive.
        let dirty = crate::git_ops::is_dirty(path).unwrap_or(false);
        let wt2 = wt.clone();
        let (ahead, behind) = run_with_timeout(std::time::Duration::from_secs(3), move || {
            crate::git_ops::ahead_behind(std::path::Path::new(&wt2))
        }).await.flatten().unwrap_or((0, 0));
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
pub async fn get_git_diff(path: String, ignore_whitespace: Option<bool>) -> AppResult<String> {
    let path = expand_tilde(&path);
    crate::git_ops::get_diff_text(std::path::Path::new(&path), ignore_whitespace.unwrap_or(false))
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
    let project_path_abs = std::fs::canonicalize(&project_path)
        .unwrap_or_else(|_| std::path::PathBuf::from(&project_path));
    // Recreate the worktree from the kept branch (create_worktree attaches to
    // the existing refs/heads/<branch>; it does NOT create a new branch), then
    // flip status back to active.
    if let Some(wt) = worktree_path {
        let wt = expand_tilde(&wt);
        // The "main" workspace points at the project root itself. Never recreate
        // a worktree there — create_worktree self-heals by remove_dir_all'ing an
        // existing target path, which would wipe the repo root. (Mirrors the
        // is_main_workspace guard in archive_workspace/delete_workspace.)
        let wt_abs = std::fs::canonicalize(&wt)
            .unwrap_or_else(|_| std::path::PathBuf::from(&wt));
        if wt_abs != project_path_abs {
            crate::git_ops::create_worktree(
                std::path::Path::new(&project_path),
                &branch,
                std::path::Path::new(&wt),
            )?;
        }
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

/// Request that the in-flight agentic turn for this workspace stop. The loop
/// halts before its next iteration (or next tool) and emits the done event.
#[tauri::command]
pub async fn cancel_chat(state: State<'_, AppState>, workspace_id: String) -> AppResult<()> {
    state.chat.cancel(&workspace_id);
    Ok(())
}

// ─── Direct-mode orchestration commands ──────────────────────────

#[tauri::command]
pub async fn list_pipelines(
    state: State<'_, AppState>,
) -> AppResult<Vec<serde_json::Value>> {
    let db = state.db.lock();
    let pipelines = db.list_pipelines()?;
    let mut out = Vec::new();
    for p in pipelines {
        let stages = db.get_pipeline_stages(&p.id)?;
        out.push(serde_json::json!({ "pipeline": p, "stages": stages }));
    }
    Ok(out)
}

#[tauri::command]
pub async fn get_pipeline(
    state: State<'_, AppState>,
    pipeline_id: String,
) -> AppResult<serde_json::Value> {
    let db = state.db.lock();
    let stages = db.get_pipeline_stages(&pipeline_id)?;
    Ok(serde_json::json!({ "stages": stages }))
}

#[tauri::command]
pub async fn save_pipeline(
    state: State<'_, AppState>,
    pipeline_id: Option<String>,
    name: String,
    description: String,
    stages: Vec<crate::db::StageDraft>,
) -> AppResult<String> {
    state.db.lock().save_pipeline(pipeline_id, &name, &description, &stages)
}

#[tauri::command]
pub async fn delete_pipeline(
    state: State<'_, AppState>,
    pipeline_id: String,
) -> AppResult<()> {
    state.db.lock().delete_pipeline(&pipeline_id)
}

#[tauri::command]
pub async fn create_run(
    state: State<'_, AppState>,
    workspace_id: String,
    pipeline_id: String,
    task: String,
    reference_model: Option<String>,
    linked_issue_key: Option<String>,
    stage_overrides: Option<Vec<(i64, String)>>,
) -> AppResult<String> {
    let overrides = stage_overrides.unwrap_or_default();
    state.db.lock().create_run(
        &workspace_id,
        &pipeline_id,
        &task,
        reference_model.as_deref(),
        linked_issue_key.as_deref(),
        &overrides,
    )
}

#[tauri::command]
pub async fn start_run(
    state: State<'_, AppState>,
    orch: State<'_, Arc<Orchestrator>>,
    run_id: String,
    budget_usd: Option<f64>,
) -> AppResult<()> {
    if orch.has_concurrent_run(&run_id).await? {
        return Err(AppError::Other(
            "another run in this workspace is already executing".into(),
        ));
    }
    // Persist the optional spend cap before the drive starts. Only a finite
    // positive budget is meaningful; anything else stays NULL (no budget).
    if let Some(b) = budget_usd {
        if b.is_finite() && b > 0.0 {
            state.db.lock().set_run_budget(&run_id, Some(b))?;
        }
    }
    Arc::clone(&*orch).start_run(run_id);
    Ok(())
}

#[tauri::command]
pub async fn get_run(
    state: State<'_, AppState>,
    run_id: String,
) -> AppResult<serde_json::Value> {
    let db = state.db.lock();
    let run = db.get_run(&run_id)?;
    let stages = db.list_run_stages(&run_id)?;
    Ok(serde_json::json!({ "run": run, "stages": stages }))
}

#[tauri::command]
pub async fn list_runs(
    state: State<'_, AppState>,
    workspace_id: String,
) -> AppResult<Vec<crate::db::RunRow>> {
    state.db.lock().list_runs(&workspace_id)
}

#[tauri::command]
pub async fn resolve_checkpoint(
    orch: State<'_, Arc<Orchestrator>>,
    run_id: String,
    action: String,
    feedback: Option<String>,
    model_override: Option<String>,
) -> AppResult<()> {
    let action = match action.as_str() {
        "approve" => CheckpointAction::Approve,
        "edit" => CheckpointAction::Edit,
        "abort" => CheckpointAction::Abort,
        "reject" => CheckpointAction::Reject { feedback, model_override },
        "resume" => CheckpointAction::Resume,
        "send_back" => CheckpointAction::SendBack { feedback },
        other => return Err(crate::error::AppError::Other(format!("unknown action: {other}"))),
    };
    // Drive in the background; the frontend reacts to run:// events.
    Arc::clone(&*orch).spawn_resolve_checkpoint(run_id, action);
    Ok(())
}

#[tauri::command]
pub async fn abort_run(
    orch: State<'_, Arc<Orchestrator>>,
    run_id: String,
) -> AppResult<()> {
    Arc::clone(&*orch).abort_run(&run_id).await
}

/// Stop the run's in-flight stage without aborting the run: the stage halts
/// and lands in the normal failed/decision-strip recovery flow.
#[tauri::command]
pub async fn stop_stage(
    orch: State<'_, Arc<Orchestrator>>,
    run_id: String,
) -> AppResult<()> {
    orch.stop_current_stage(&run_id)
}

/// Ask a running run to pause at its next stage boundary. The next pending stage
/// is parked awaiting the director; approving it resumes the run. Safe no-op if
/// the run isn't currently driving.
#[tauri::command]
pub async fn request_run_pause(
    orch: State<'_, Arc<Orchestrator>>,
    run_id: String,
) -> AppResult<()> {
    orch.request_pause(&run_id);
    Ok(())
}

/// The persisted live journal for a stage, oldest first. Rows that fail to
/// parse (shouldn't happen — we wrote them) are skipped rather than erroring.
#[tauri::command]
pub async fn get_stage_log(
    state: State<'_, AppState>,
    stage_id: String,
) -> AppResult<Vec<serde_json::Value>> {
    let rows = state.db.lock().list_stage_log(&stage_id)?;
    Ok(rows
        .iter()
        .filter_map(|r| serde_json::from_str(r).ok())
        .collect())
}

/// Archived attempts for a stage (snapshots taken before loop-back / reject
/// resets), oldest first.
#[tauri::command]
pub async fn list_stage_iterations(
    state: State<'_, AppState>,
    stage_id: String,
) -> AppResult<Vec<crate::db::StageIterationRow>> {
    state.db.lock().list_stage_iterations(&stage_id)
}

#[tauri::command]
pub async fn estimate_run_cost(
    state: State<'_, AppState>,
    pipeline_id: String,
    stage_overrides: Option<Vec<(i64, String)>>,
) -> AppResult<serde_json::Value> {
    // Heuristic per-role token estimate (refined later from history).
    fn est_tokens(role: &str) -> (u64, u64) {
        match role {
            "implement" | "fix" => (12_000, 6_000),
            "plan" | "refine" => (4_000, 1_500),
            "code_review" | "plan_review" | "critique" | "verify" | "repro" => (8_000, 1_000),
            "test" => (6_000, 2_000),
            _ => (4_000, 1_000),
        }
    }
    let overrides = stage_overrides.unwrap_or_default();
    let db = state.db.lock();
    let stages = db.get_pipeline_stages(&pipeline_id)?;
    let reference = crate::orchestrator::cost::pick_reference_model();
    let mut cost = 0.0;
    let mut baseline = 0.0;
    for s in &stages {
        let (i, o) = est_tokens(&s.role);
        let model = overrides
            .iter()
            .find(|(pos, _)| *pos == s.position)
            .map(|(_, m)| m.as_str())
            .unwrap_or(s.agent_model.as_str());
        cost += crate::orchestrator::cost::stage_cost(model, i, o, 0, 0);
        if let Some(ref_model) = &reference {
            baseline += crate::orchestrator::cost::baseline_cost(ref_model, i, o);
        }
    }
    if reference.is_none() || baseline < cost {
        baseline = cost;
    }
    Ok(serde_json::json!({ "estimateUsd": cost, "baselineUsd": baseline }))
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
    // DB delete first: it is the only step that can fail meaningfully, and
    // if it does the terminal must stay fully intact (shell + scrollback) so
    // the user can retry. The daemon-side removal (kill shell, release fds,
    // delete scrollback log) is destructive, so it goes last; "not found"
    // and daemon errors are ignored.
    state.db.lock().delete_terminal(&id)?;
    let _ = state.pty.lock().remove(&id);
    Ok(())
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
        tint: None,
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
    pub is_ignored: bool,
}

/// The one workspace walker. Shared by `walk_one_level` (read_directory),
/// `list_workspace_files` and `search_workspace_text`:
///  - `apply_ignore_filters = true` turns the standard ignore sources on
///    (`.gitignore`, `.ignore`, global excludes); `false` disables them all
///    so gitignored entries appear too,
///  - `.gitignore` rules apply even outside a git checkout (`require_git(false)`),
///  - dot-files like `.gitignore` itself are included (`hidden(false)`),
///  - `.git` directories are pruned at every depth — the single place this
///    exclusion is implemented.
/// Callers keep their own depth-0 skip and file-type filtering.
pub(crate) fn workspace_walker(
    base: &std::path::Path,
    max_depth: Option<usize>,
    apply_ignore_filters: bool,
) -> ignore::Walk {
    let mut builder = ignore::WalkBuilder::new(base);
    builder
        .max_depth(max_depth)
        .standard_filters(apply_ignore_filters)
        .require_git(false)
        .hidden(false)
        .filter_entry(|entry| entry.file_name() != ".git");
    builder.build()
}

/// One level of `base`: entry paths only (root itself and `.git` excluded).
/// `apply_ignore_filters = true` is today's behavior (gitignore rules on);
/// `false` disables every ignore source so gitignored entries appear too.
fn walk_one_level(base: &std::path::Path, apply_ignore_filters: bool) -> Vec<std::path::PathBuf> {
    workspace_walker(base, Some(1), apply_ignore_filters)
        .filter_map(|result| result.ok())
        .filter(|entry| entry.depth() > 0)
        .map(|entry| entry.path().to_path_buf())
        .collect()
}

/// Build a gitignore matcher for `base`, honoring every `.gitignore` from the
/// repository root (nearest ancestor containing `.git`, or `base` itself when
/// outside a repo) down to `base`, plus `.git/info/exclude`. Used by
/// `read_directory`'s show-ignored mode to flag entries without a second walk.
fn build_ignore_matcher(base: &std::path::Path) -> ignore::gitignore::Gitignore {
    // Find the repo root: nearest ancestor (including base) containing `.git`
    // (a dir in normal checkouts, a file in linked worktrees).
    let root = base
        .ancestors()
        .find(|a| a.join(".git").exists())
        .unwrap_or(base);

    let mut builder = ignore::gitignore::GitignoreBuilder::new(root);
    // Add .gitignore files from root down to base (outermost first; deeper
    // files take precedence, matching git's semantics).
    let dirs: Vec<&std::path::Path> = base
        .ancestors()
        .take_while(|a| a.starts_with(root))
        .collect();
    for dir in dirs.iter().rev() {
        let gi = dir.join(".gitignore");
        if gi.is_file() {
            builder.add(gi);
        }
    }
    let exclude = root.join(".git").join("info").join("exclude");
    if exclude.is_file() {
        builder.add(exclude);
    }
    builder.build().unwrap_or_else(|_| ignore::gitignore::Gitignore::empty())
}

/// Read one level of a directory. By default `.gitignore` rules apply (today's
/// behavior). With `show_ignored = Some(true)`, a single unfiltered walk runs
/// and each entry is flagged `is_ignored` via a gitignore matcher that honors
/// every `.gitignore` from the repo root down to `base` (so children of an
/// ignored directory are flagged too, and there is no two-walk race).
/// Directories are returned first (alphabetical), then files (alphabetical).
/// `.git` is always excluded.
#[tauri::command]
pub async fn read_directory(
    path: String,
    show_ignored: Option<bool>,
) -> AppResult<Vec<DirectoryEntry>> {
    let path = expand_tilde(&path);
    let base = std::path::Path::new(&path);

    if !base.exists() {
        return Err(AppError::Other(format!("Path does not exist: {}", path)));
    }
    if !base.is_dir() {
        return Err(AppError::Other(format!("Not a directory: {}", path)));
    }

    // (path, is_ignored) pairs for this level.
    let entries: Vec<(std::path::PathBuf, bool)> = if show_ignored.unwrap_or(false) {
        let matcher = build_ignore_matcher(base);
        walk_one_level(base, false)
            .into_iter()
            .map(|p| {
                let is_dir = p.is_dir();
                let ignored = matcher
                    .matched_path_or_any_parents(&p, is_dir)
                    .is_ignore();
                (p, ignored)
            })
            .collect()
    } else {
        walk_one_level(base, true)
            .into_iter()
            .map(|p| (p, false))
            .collect()
    };

    let mut dirs: Vec<DirectoryEntry> = Vec::new();
    let mut files: Vec<DirectoryEntry> = Vec::new();
    for (entry_path, is_ignored) in entries {
        let name = entry_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let is_dir = entry_path.is_dir();
        let de = DirectoryEntry {
            name,
            path: entry_path.to_string_lossy().into_owned(),
            is_dir,
            is_ignored,
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

const BINARY_SNIFF_BYTES: usize = 8192;
/// Hard cap above which `read_file_checked` refuses to load (avoids OOM).
const READ_CAP_BYTES: u64 = 50 * 1024 * 1024;

/// File modification time as epoch milliseconds, or 0 if unavailable.
fn mtime_millis(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Debug, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileReadResult {
    Text { content: String, size: u64, mtime: i64 },
    Binary { size: u64, mtime: i64 },
    UnsupportedEncoding { size: u64, mtime: i64 },
    TooLarge { size: u64 },
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub mtime: i64,
}

/// Sync core of `read_file_checked` (testable without a tokio runtime).
pub(crate) fn read_file_checked_inner(path: &str, max_bytes: u64) -> AppResult<FileReadResult> {
    let meta = std::fs::metadata(path)
        .map_err(|e| AppError::Other(format!("read_file_checked({path}): {e}")))?;
    let size = meta.len();
    let mtime = mtime_millis(&meta);
    if size > max_bytes {
        return Ok(FileReadResult::TooLarge { size });
    }
    let bytes = std::fs::read(path)
        .map_err(|e| AppError::Other(format!("read_file_checked({path}): {e}")))?;
    if bytes.iter().take(BINARY_SNIFF_BYTES).any(|&b| b == 0) {
        return Ok(FileReadResult::Binary { size, mtime });
    }
    match String::from_utf8(bytes) {
        Ok(content) => Ok(FileReadResult::Text { content, size, mtime }),
        Err(_) => Ok(FileReadResult::UnsupportedEncoding { size, mtime }),
    }
}

#[tauri::command]
pub async fn read_file_checked(path: String, max_bytes: Option<u64>) -> AppResult<FileReadResult> {
    let path = expand_tilde(&path);
    read_file_checked_inner(&path, max_bytes.unwrap_or(READ_CAP_BYTES))
}

/// Kept for any non-editor callers that want a plain string read.
#[tauri::command]
pub async fn read_file(path: String) -> AppResult<String> {
    let path = expand_tilde(&path);
    std::fs::read_to_string(&path)
        .map_err(|e| AppError::Other(format!("read_file({}): {e}", path)))
}

/// Sync core of `write_file` (testable; returns the post-write mtime).
pub(crate) fn write_file_inner(path: &str, content: &str) -> AppResult<WriteResult> {
    std::fs::write(path, content)
        .map_err(|e| AppError::Other(format!("write_file({path}): {e}")))?;
    let mtime = std::fs::metadata(path).map(|m| mtime_millis(&m)).unwrap_or(0);
    Ok(WriteResult { mtime })
}

#[tauri::command]
pub async fn write_file(path: String, content: String) -> AppResult<WriteResult> {
    let path = expand_tilde(&path);
    write_file_inner(&path, &content)
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    pub mtime_ms: i64,
    pub size: u64,
}

/// Sync core of `file_meta` (testable without a tokio runtime).
/// `Ok(None)` means the file does not exist (deleted under an open buffer).
pub(crate) fn file_meta_inner(path: &str) -> AppResult<Option<FileMeta>> {
    match std::fs::metadata(path) {
        Ok(meta) => Ok(Some(FileMeta {
            mtime_ms: mtime_millis(&meta),
            size: meta.len(),
        })),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(AppError::Other(format!("file_meta({path}): {e}"))),
    }
}

/// Cheap stat for external-change detection: the editor compares this against
/// the mtime tracked at open/save time before overwriting and on window focus.
#[tauri::command]
pub async fn file_meta(path: String) -> AppResult<Option<FileMeta>> {
    let path = expand_tilde(&path);
    file_meta_inner(&path)
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

/// Map common `git apply` stderr to a plain-English message; fall back to the
/// trimmed stderr for anything unrecognized.
pub fn friendly_git_error(stderr: &str) -> String {
    let s = stderr.to_lowercase();
    if s.contains("patch does not apply") || s.contains("while searching for") {
        "This change no longer matches the file — it may have changed since. Refresh the diff and try again.".to_string()
    } else if s.contains("already exists in working directory") {
        "That file already exists — can't apply the change.".to_string()
    } else {
        stderr.trim().to_string()
    }
}

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
        return Err(AppError::Other(friendly_git_error(&stderr)));
    }
    Ok(())
}

/// Apply a unified-diff hunk (re-apply a previously reverted change).
#[tauri::command]
pub async fn apply_hunk(workspace_path: String, hunk_text: String) -> AppResult<()> {
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
        .args(["apply", "-p1", tmp.path().to_str().unwrap_or("")])
        .current_dir(&workspace_path)
        .output()
        .map_err(|e| AppError::Other(format!("failed to run git apply: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Other(friendly_git_error(&stderr)));
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
        return Err(AppError::Other(friendly_git_error(&stderr)));
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

// ─── Conflict resolution (G7 slice II) ────────────────────────────

/// Resolve a conflicted file by taking one side wholesale:
/// `git checkout --ours|--theirs -- <file>` then `git add -- <file>`.
/// The git_lock is held across BOTH steps so no other mutating command can
/// interleave between the checkout and the add.
#[tauri::command]
pub async fn resolve_conflict_take(
    workspace_path: String,
    file: String,
    side: String,
) -> AppResult<()> {
    let flag = match side.as_str() {
        "ours" => "--ours",
        "theirs" => "--theirs",
        other => return Err(AppError::Other(format!(
            "invalid side '{other}' — expected \"ours\" or \"theirs\""
        ))),
    };
    let workspace_path = expand_tilde(&workspace_path);
    let _guard = crate::git_lock::git_lock(&workspace_path).await;

    let output = std::process::Command::new("git")
        .args(["checkout", flag, "--"])
        .arg(&file)
        .current_dir(&workspace_path)
        .output()
        .map_err(|e| AppError::Other(format!("failed to run git checkout: {e}")))?;
    if !output.status.success() {
        // e.g. delete/modify conflict where the chosen side has no version.
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Other(friendly_git_error(&stderr)));
    }

    let output = std::process::Command::new("git")
        .args(["add", "--"])
        .arg(&file)
        .current_dir(&workspace_path)
        .output()
        .map_err(|e| AppError::Other(format!("failed to run git add: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Other(friendly_git_error(&stderr)));
    }
    Ok(())
}

/// Mark a hand-merged (or AI-merged) file as resolved: `git add -- <file>`
/// clears the unmerged index state.
#[tauri::command]
pub async fn mark_conflict_resolved(workspace_path: String, file: String) -> AppResult<()> {
    let workspace_path = expand_tilde(&workspace_path);
    let _guard = crate::git_lock::git_lock(&workspace_path).await;
    let output = std::process::Command::new("git")
        .args(["add", "--"])
        .arg(&file)
        .current_dir(&workspace_path)
        .output()
        .map_err(|e| AppError::Other(format!("failed to run git add: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Other(friendly_git_error(&stderr)));
    }
    Ok(())
}

/// Continue the in-progress merge/rebase once conflicts are staged. Runs via
/// the user's login shell (gitconfig identity, signing) with
/// `-c core.editor=true` so git never opens an interactive editor for the
/// merge/rebase commit message. MoreConflicts = a later rebase step conflicted.
#[tauri::command]
pub async fn continue_operation(workspace_path: String) -> AppResult<crate::git_ops::ContinueOutcome> {
    let workspace_path = expand_tilde(&workspace_path);
    let _guard = crate::git_lock::git_lock(&workspace_path).await;
    let op = crate::git_ops::operation_state(std::path::Path::new(&workspace_path))?
        .ok_or_else(|| AppError::Other("no merge or rebase in progress".into()))?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    let cmd = format!("git -c core.editor=true {op} --continue 2>&1");
    let output = std::process::Command::new(&shell)
        .arg("-l").arg("-c").arg(&cmd)
        .current_dir(&workspace_path)
        .output()
        .map_err(|e| AppError::Other(format!("failed to spawn git {op} --continue: {e}")))?;
    let combined = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let kind = crate::git_ops::classify_continue(output.status.success(), &combined);
    Ok(crate::git_ops::ContinueOutcome { kind, output: combined })
}

/// Abort the in-progress merge/rebase, restoring the pre-operation state.
/// Returns the trimmed combined output.
#[tauri::command]
pub async fn abort_operation(workspace_path: String) -> AppResult<String> {
    let workspace_path = expand_tilde(&workspace_path);
    let _guard = crate::git_lock::git_lock(&workspace_path).await;
    let op = crate::git_ops::operation_state(std::path::Path::new(&workspace_path))?
        .ok_or_else(|| AppError::Other("no merge or rebase in progress".into()))?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    let cmd = format!("git {op} --abort 2>&1");
    let output = std::process::Command::new(&shell)
        .arg("-l").arg("-c").arg(&cmd)
        .current_dir(&workspace_path)
        .output()
        .map_err(|e| AppError::Other(format!("failed to spawn git {op} --abort: {e}")))?;
    let combined = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() {
        return Err(AppError::Other(format!("git {op} --abort failed: {combined}")));
    }
    Ok(combined)
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
    let _guard = crate::git_lock::git_lock(&workspace_path).await;

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

/// A branch and its open PR, for the rail's per-workspace PR indicator.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchPr {
    pub branch: String,
    pub pr: crate::github::Pr,
}

/// Parse `gh pr list --json number,title,url,state,isDraft,headRefName` output
/// (a JSON array) into branch→PR pairs. Pure (no IO), unit-testable. Skips
/// entries without a headRefName; normalises gh's UPPERCASE `state`.
pub(crate) fn parse_open_pr_list(values: &[serde_json::Value]) -> Vec<BranchPr> {
    values
        .iter()
        .filter_map(|v| {
            let branch = v.get("headRefName")?.as_str()?.to_string();
            let mut pr_val = v.clone();
            if let Some(s) = pr_val.get("state").and_then(|x| x.as_str()) {
                pr_val["state"] = serde_json::Value::String(s.to_lowercase());
            }
            Some(BranchPr {
                branch,
                pr: crate::github::pr_from_json(&pr_val),
            })
        })
        .collect()
}

/// List open pull requests for the repo at `path`, for the workspace
/// creator's "start from a pull request" menu. Runs `gh pr list` in the
/// user's login shell (same pattern as `try_gh_cli`) so PATH and keychain
/// credentials behave like in a terminal.
///
/// `gh` missing, unauthenticated, or pointed at a non-GitHub remote all
/// surface as a friendly error — the UI maps any failure to a quiet
/// "GitHub CLI not available" empty state.
#[tauri::command]
pub async fn list_prs(path: String) -> AppResult<Vec<crate::github::PrInfo>> {
    let path = expand_tilde(&path);
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    let output = tokio::process::Command::new(&shell)
        .arg("-l").arg("-c")
        .arg("gh pr list --json number,title,headRefName,author --limit 30")
        .current_dir(&path)
        .output()
        .await
        .map_err(|e| AppError::Other(format!("GitHub CLI not available: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let snippet: String = stderr.trim().chars().take(200).collect();
        return Err(AppError::Other(format!("GitHub CLI not available: {snippet}")));
    }

    crate::github::pr_infos_from_json(&String::from_utf8_lossy(&output.stdout))
        .map_err(|e| AppError::Other(format!("GitHub CLI returned unexpected output: {e}")))
}

/// Make a PR's head ref available as a local branch so it can serve as a
/// workspace base. No-op when the branch already exists locally; otherwise
/// `git fetch origin pull/<n>/head:<headRefName>` in the login shell (works
/// for same-repo and fork PRs alike — GitHub exposes every PR head under
/// `pull/<n>/head` regardless of where the branch lives).
#[tauri::command]
pub async fn ensure_pr_branch(
    path: String,
    number: u64,
    head_ref_name: String,
) -> AppResult<()> {
    let path = expand_tilde(&path);

    // Already fetched (or it's a same-repo branch the user has locally)?
    // Scoped so the !Send `Repository` handle drops before any await.
    {
        if let Ok(repo) = crate::git_ops::open_repo(std::path::Path::new(&path)) {
            if repo
                .find_reference(&format!("refs/heads/{head_ref_name}"))
                .is_ok()
            {
                return Ok(());
            }
        }
    }

    let _guard = crate::git_lock::git_lock(&path).await;
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    let cmd = crate::github::pr_fetch_command(number, &head_ref_name);
    let output = std::process::Command::new(&shell)
        .arg("-l").arg("-c").arg(&cmd)
        .current_dir(&path)
        .output()
        .map_err(|e| AppError::Other(format!("failed to spawn git fetch: {e}")))?;

    if !output.status.success() {
        let combined = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Err(AppError::Other(format!(
            "fetching the head of PR #{number} failed: {combined}"
        )));
    }
    Ok(())
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

/// Batch: all OPEN pull requests for the project's GitHub repo, keyed by head
/// branch, for the rail's PR indicator. Uses `gh` in the user's login shell
/// (gh resolves owner/repo from origin). Returns an empty list — never an
/// error — when gh is missing/unauthed, the repo isn't on GitHub, or there are
/// no open PRs.
#[tauri::command]
pub async fn open_prs_for_project(project_path: String) -> AppResult<Vec<BranchPr>> {
    let project_path = expand_tilde(&project_path);
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    let cmd = "gh pr list --state open --json number,title,url,state,isDraft,headRefName --limit 200";
    let output = match tokio::process::Command::new(&shell)
        .arg("-l")
        .arg("-c")
        .arg(cmd)
        .current_dir(&project_path)
        .output()
        .await
    {
        Ok(o) => o,
        Err(_) => return Ok(Vec::new()),
    };
    if !output.status.success() {
        return Ok(Vec::new());
    }
    let values: Vec<serde_json::Value> = match serde_json::from_slice(&output.stdout) {
        Ok(v) => v,
        Err(_) => return Ok(Vec::new()),
    };
    Ok(parse_open_pr_list(&values))
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

#[tauri::command]
pub async fn fetch_changes(workspace_path: String) -> AppResult<String> {
    let workspace_path = expand_tilde(&workspace_path);
    let _guard = crate::git_lock::git_lock(&workspace_path).await;
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    let output = std::process::Command::new(&shell)
        .arg("-l").arg("-c").arg("git fetch 2>&1")
        .current_dir(&workspace_path)
        .output()
        .map_err(|e| AppError::Other(format!("failed to spawn git fetch: {e}")))?;
    let combined = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() {
        return Err(AppError::Other(format!("git fetch failed: {combined}")));
    }
    Ok(combined)
}

#[tauri::command]
pub async fn pull(workspace_path: String, strategy: String) -> AppResult<crate::git_ops::PullOutcome> {
    let workspace_path = expand_tilde(&workspace_path);
    let _guard = crate::git_lock::git_lock(&workspace_path).await;
    let flag = match strategy.as_str() {
        "ffOnly" => "--ff-only",
        "rebase" => "--rebase",
        "merge" => "--no-rebase",
        other => return Err(AppError::Other(format!("unknown pull strategy: {other}"))),
    };
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    let cmd = format!("git pull {flag} 2>&1");
    let output = std::process::Command::new(&shell)
        .arg("-l").arg("-c").arg(&cmd)
        .current_dir(&workspace_path)
        .output()
        .map_err(|e| AppError::Other(format!("failed to spawn git pull: {e}")))?;
    let combined = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let kind = crate::git_ops::classify_pull(output.status.success(), &combined);
    Ok(crate::git_ops::PullOutcome { kind, output: combined })
}

// ─── G7 slice IV: branch ops ──────────────────────────────────────

/// Switch the workspace to an existing local branch. Worktree-aware: a
/// branch checked out in another workspace errors with a friendly message
/// (workspaces are worktrees — git forbids double checkouts).
#[tauri::command]
pub async fn switch_branch(workspace_path: String, name: String) -> AppResult<String> {
    let workspace_path = expand_tilde(&workspace_path);
    let _guard = crate::git_lock::git_lock(&workspace_path).await;
    crate::git_ops::switch_branch(std::path::Path::new(&workspace_path), &name)
}

/// Create `name` off `base` and switch to it, under one git_lock guard.
#[tauri::command]
pub async fn create_and_switch_branch(
    workspace_path: String,
    name: String,
    base: String,
) -> AppResult<String> {
    let workspace_path = expand_tilde(&workspace_path);
    let _guard = crate::git_lock::git_lock(&workspace_path).await;
    crate::git_ops::create_and_switch_branch(
        std::path::Path::new(&workspace_path),
        &name,
        &base,
    )
}

// ─── G7 slice IV: stash ───────────────────────────────────────────

/// Stash the working tree (untracked included) with an optional message.
#[tauri::command]
pub async fn stash_push(workspace_path: String, message: String) -> AppResult<()> {
    let workspace_path = expand_tilde(&workspace_path);
    let _guard = crate::git_lock::git_lock(&workspace_path).await;
    crate::git_ops::stash_push(std::path::Path::new(&workspace_path), &message)
}

/// The stash stack, most recent first. Read-only — no git_lock needed.
#[tauri::command]
pub async fn stash_list(workspace_path: String) -> AppResult<Vec<crate::git_ops::StashInfo>> {
    let workspace_path = expand_tilde(&workspace_path);
    crate::git_ops::stash_list(std::path::Path::new(&workspace_path))
}

/// Apply + drop one stash entry.
#[tauri::command]
pub async fn stash_pop(workspace_path: String, index: usize) -> AppResult<()> {
    let workspace_path = expand_tilde(&workspace_path);
    let _guard = crate::git_lock::git_lock(&workspace_path).await;
    crate::git_ops::stash_pop(std::path::Path::new(&workspace_path), index)
}

/// Discard one stash entry without applying it.
#[tauri::command]
pub async fn stash_drop(workspace_path: String, index: usize) -> AppResult<()> {
    let workspace_path = expand_tilde(&workspace_path);
    let _guard = crate::git_lock::git_lock(&workspace_path).await;
    crate::git_ops::stash_drop(std::path::Path::new(&workspace_path), index)
}

// ─── G7 slice V: advanced ops ─────────────────────────────────────

/// `git reset --soft|--mixed|--hard [target]` (target defaults to HEAD;
/// typically a SHA from the history browser). Mode is validated; the UI
/// confirm-gates hard resets.
#[tauri::command]
pub async fn reset_head(
    workspace_path: String,
    mode: String,
    target: Option<String>,
) -> AppResult<String> {
    let workspace_path = expand_tilde(&workspace_path);
    let _guard = crate::git_lock::git_lock(&workspace_path).await;
    crate::git_ops::reset_head(
        std::path::Path::new(&workspace_path),
        &mode,
        target.as_deref(),
    )
}

/// `git clean -fd` — returns the removed paths for the confirmation toast.
#[tauri::command]
pub async fn clean_untracked(workspace_path: String) -> AppResult<Vec<String>> {
    let workspace_path = expand_tilde(&workspace_path);
    let _guard = crate::git_lock::git_lock(&workspace_path).await;
    crate::git_ops::clean_untracked(std::path::Path::new(&workspace_path))
}

/// Cherry-pick one commit onto HEAD. Conflict is a tagged outcome (the
/// conflict section takes over), never an Err.
#[tauri::command]
pub async fn cherry_pick(
    workspace_path: String,
    sha: String,
) -> AppResult<crate::git_ops::PullOutcome> {
    let workspace_path = expand_tilde(&workspace_path);
    let _guard = crate::git_lock::git_lock(&workspace_path).await;
    crate::git_ops::cherry_pick(std::path::Path::new(&workspace_path), &sha)
}

/// Create a lightweight tag at `sha` (or HEAD when omitted).
#[tauri::command]
pub async fn create_tag(
    workspace_path: String,
    name: String,
    sha: Option<String>,
) -> AppResult<()> {
    let workspace_path = expand_tilde(&workspace_path);
    let _guard = crate::git_lock::git_lock(&workspace_path).await;
    crate::git_ops::create_tag(
        std::path::Path::new(&workspace_path),
        &name,
        sha.as_deref(),
    )
}

/// All tag names. Read-only — no git_lock needed.
#[tauri::command]
pub async fn list_tags(workspace_path: String) -> AppResult<Vec<String>> {
    let workspace_path = expand_tilde(&workspace_path);
    crate::git_ops::list_tags(std::path::Path::new(&workspace_path))
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
        // workspace_walker prunes `.git` at every depth.
        for entry in workspace_walker(&base, None, true) {
            let Ok(entry) = entry else { continue };
            if entry.depth() == 0 {
                continue;
            }
            // Skip directories — only real files are listed.
            let path = entry.path();
            if entry.file_type().map(|t| !t.is_file()).unwrap_or(true) {
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
        // workspace_walker prunes `.git` at every depth.
        for entry in workspace_walker(&base, None, true) {
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

// ─── AI primitive ─────────────────────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCompleteResult {
    pub text: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: f64,
}

/// Name of the forced tool used for guaranteed-shape (JSON-schema) output.
pub(crate) const AI_RESULT_TOOL: &str = "emit_result";

/// Pure request builder — one user/text message. With `json_schema` the
/// request carries a single forced tool whose input IS the schema, so the
/// provider returns guaranteed-shape JSON instead of prose to scrape.
/// Unit-testable.
pub fn build_ai_request(
    model: &str,
    system: String,
    prompt: String,
    max_tokens: u32,
    json_schema: Option<serde_json::Value>,
) -> LlmRequest {
    let (tools, tool_choice) = match json_schema {
        Some(schema) => (
            vec![crate::providers::LlmTool {
                name: AI_RESULT_TOOL.to_string(),
                description: "Return the final result. Call this tool exactly once with the complete answer.".to_string(),
                input_schema: schema,
            }],
            Some(AI_RESULT_TOOL.to_string()),
        ),
        None => (vec![], None),
    };
    LlmRequest {
        model: model.to_string(),
        max_tokens,
        system,
        messages: vec![LlmMessage { role: LlmRole::User, content: LlmContent::Text(prompt) }],
        tools,
        tool_choice,
    }
}

/// Pick the caller-visible text out of an LLM response: a forced-tool call
/// yields its input serialized as JSON (the guaranteed-shape path); anything
/// else falls back to the prose text, which callers may still scrape.
/// Unit-testable.
pub(crate) fn ai_response_text(resp: crate::providers::LlmResponse) -> String {
    match resp.tool_uses.into_iter().next() {
        Some(u) => u.input.to_string(),
        None => resp.text,
    }
}

/// Guard against responses truncated at the max_tokens cap. Truncated output is
/// unusable for callers expecting structured (JSON) replies — surface a clear
/// error instead of returning broken partial text. Unit-testable.
pub fn ensure_not_truncated(stop_reason: &crate::providers::LlmStopReason) -> AppResult<()> {
    if matches!(stop_reason, crate::providers::LlmStopReason::MaxTokens) {
        return Err(AppError::Other(
            "AI output hit the token limit before completing — try a smaller diff or raise max tokens.".into(),
        ));
    }
    Ok(())
}

/// Build the `token_events` row for a one-shot AI call. Session attribution
/// reuses the workspace id (the same convention ChatEngine uses); callers
/// without a workspace (e.g. commit drafting from a bare project path) land
/// in a shared "ai-adhoc" bucket so the spend still shows up in Usage.
/// `timestamp` stays empty — `TokenEngine::record` stamps now(). Unit-testable.
pub(crate) fn ai_token_event(
    workspace_id: Option<&str>,
    model: &str,
    resp: &crate::providers::LlmResponse,
    cost_usd: f64,
) -> TokenEvent {
    TokenEvent {
        id: None,
        session_id: workspace_id.unwrap_or("ai-adhoc").to_string(),
        timestamp: String::new(),
        input_tokens: resp.input_tokens,
        output_tokens: resp.output_tokens,
        cache_read_tokens: resp.cache_read_tokens,
        cache_creation_tokens: resp.cache_creation_tokens,
        model: model.to_string(),
        cost_usd,
    }
}

/// Generic one-shot model call — the shared G5 AI primitive. Returns text +
/// token counts + computed cost, and records the usage to `token_events`
/// (attributed to `workspace_id` when given) so Usage dashboards see
/// AI-review / draft / conflict spend. With `json_schema` the model is
/// forced through a schema'd tool call, so `text` is guaranteed-shape JSON
/// (callers keep their prose-scrape parser as a fallback).
#[tauri::command]
pub async fn ai_complete(
    state: State<'_, AppState>,
    model: String,
    system: String,
    prompt: String,
    max_tokens: Option<u32>,
    workspace_id: Option<String>,
    json_schema: Option<serde_json::Value>,
) -> AppResult<AiCompleteResult> {
    let (provider, api_base, api_key) = crate::chat_engine::resolve_provider(&model)?;
    let req = build_ai_request(&model, system, prompt, max_tokens.unwrap_or(8192), json_schema);
    let client = crate::chat_engine::shared_http_client();
    let resp = provider.complete(&api_base, api_key.as_deref(), &req, client).await?;
    ensure_not_truncated(&resp.stop_reason)?;
    let cost = crate::token_engine::compute_cost(
        &model,
        resp.input_tokens,
        resp.output_tokens,
        resp.cache_read_tokens,
        resp.cache_creation_tokens,
    );
    if resp.input_tokens > 0 || resp.output_tokens > 0 {
        // Best-effort: a recording failure must not fail the AI call itself.
        if let Err(e) = state.tokens.record(ai_token_event(workspace_id.as_deref(), &model, &resp, cost)) {
            tracing::warn!(error = %e, "failed to record ai_complete token event");
        }
    }
    let (input_tokens, output_tokens) = (resp.input_tokens, resp.output_tokens);
    Ok(AiCompleteResult {
        text: ai_response_text(resp),
        input_tokens,
        output_tokens,
        cost_usd: cost,
    })
}

// ─── G4 staging commands ──────────────────────────────────────────

#[tauri::command]
pub async fn get_staged_diff(path: String) -> AppResult<String> {
    let path = expand_tilde(&path);
    crate::git_ops::get_staged_diff_text(std::path::Path::new(&path))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastCommit { pub short_sha: String, pub subject: String, pub body: String }

#[tauri::command]
pub async fn get_last_commit(workspace_path: String) -> AppResult<Option<LastCommit>> {
    let workspace_path = expand_tilde(&workspace_path);
    Ok(crate::git_ops::last_commit(std::path::Path::new(&workspace_path))?
        .map(|(short_sha, subject, body)| LastCommit { short_sha, subject, body }))
}

// ─── G7 slice III: history ────────────────────────────────────────

#[tauri::command]
pub async fn git_log(
    path: String,
    limit: usize,
    skip: usize,
) -> AppResult<Vec<crate::git_ops::CommitInfo>> {
    let path = expand_tilde(&path);
    crate::git_ops::git_log(std::path::Path::new(&path), limit, skip)
}

#[tauri::command]
pub async fn commit_diff(path: String, sha: String) -> AppResult<String> {
    let path = expand_tilde(&path);
    crate::git_ops::commit_diff_text(std::path::Path::new(&path), &sha)
}

#[tauri::command]
pub async fn blame_file(path: String, file: String) -> AppResult<Vec<crate::git_ops::BlameLine>> {
    let path = expand_tilde(&path);
    crate::git_ops::blame_file(std::path::Path::new(&path), &file)
}

#[tauri::command]
pub async fn amend_commit(workspace_path: String, message: String) -> AppResult<String> {
    if message.trim().is_empty() {
        return Err(AppError::Other("commit message cannot be empty".into()));
    }
    let workspace_path = expand_tilde(&workspace_path);
    let _guard = crate::git_lock::git_lock(&workspace_path).await;
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    let msg_escaped = message.replace('\'', "'\\''");
    let cmd = format!("git commit --amend -m '{}'", msg_escaped);
    let output = std::process::Command::new(&shell)
        .arg("-l").arg("-c").arg(&cmd)
        .current_dir(&workspace_path)
        .output()
        .map_err(|e| AppError::Other(format!("failed to spawn git commit --amend: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = if !stderr.trim().is_empty() { stderr } else { stdout };
        return Err(AppError::Other(format!("git commit --amend failed: {}", detail.trim())));
    }
    let head = std::process::Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .current_dir(&workspace_path)
        .output()
        .map_err(|e| AppError::Other(format!("failed to read HEAD: {e}")))?;
    Ok(String::from_utf8_lossy(&head.stdout).trim().to_string())
}

/// Sync core of `discard_file` (testable). Tracked → restore to HEAD; untracked → delete.
pub(crate) fn discard_file_inner(workspace_path: &str, file_path: &str) -> AppResult<()> {
    let ws = std::path::Path::new(workspace_path);
    let full = ws.join(file_path);

    // Containment guard: refuse to act on a path that resolves outside the workspace.
    let ws_canon = ws.canonicalize().unwrap_or_else(|_| ws.to_path_buf());
    let full_canon = full.canonicalize().unwrap_or_else(|_| full.clone());
    if !full_canon.starts_with(&ws_canon) {
        return Err(AppError::Other("refusing to discard a path outside the workspace".into()));
    }

    // Is the file tracked (exists in HEAD)?
    let tracked = std::process::Command::new("git")
        .args(["cat-file", "-e", &format!("HEAD:{file_path}")])
        .current_dir(workspace_path)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if tracked {
        let output = std::process::Command::new("git")
            .args(["restore", "--staged", "--worktree", "--", file_path])
            .current_dir(workspace_path)
            .output()
            .map_err(|e| AppError::Other(format!("failed to run git restore: {e}")))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(AppError::Other(format!("discard failed: {}", stderr.trim())));
        }
    } else {
        // Not in HEAD. It may still be staged as a new file — drain that index
        // entry first (best-effort), then delete the worktree copy (file or dir).
        let _ = std::process::Command::new("git")
            .args(["restore", "--staged", "--", file_path])
            .current_dir(workspace_path)
            .output();
        if full.is_dir() {
            std::fs::remove_dir_all(&full)
                .map_err(|e| AppError::Other(format!("discard (delete dir) failed: {e}")))?;
        } else if full.exists() {
            std::fs::remove_file(&full)
                .map_err(|e| AppError::Other(format!("discard (delete) failed: {e}")))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn discard_file(workspace_path: String, file_path: String) -> AppResult<()> {
    let workspace_path = expand_tilde(&workspace_path);
    discard_file_inner(&workspace_path, &file_path)
}

// ─── File operations (G6 slice II) ────────────────────────────────

/// Resolve `target` (relative to the workspace, or absolute) and verify it is
/// contained inside the workspace. Canonicalizes the workspace root and the
/// target's PARENT (the leaf may not exist yet for creates), mirrors the
/// `starts_with` guard used by `discard_file_inner`, and refuses any path with
/// a `.git` component as well as the workspace root itself.
pub(crate) fn contained_path(workspace_path: &str, target: &str) -> AppResult<std::path::PathBuf> {
    let ws = expand_tilde(workspace_path);
    let ws_canon = std::path::Path::new(&ws)
        .canonicalize()
        .map_err(|e| AppError::Other(format!("workspace not found: {e}")))?;

    let target = expand_tilde(target);
    let target_path = std::path::Path::new(&target);
    let joined = if target_path.is_absolute() {
        target_path.to_path_buf()
    } else {
        ws_canon.join(target_path)
    };

    let parent = joined
        .parent()
        .ok_or_else(|| AppError::Other("invalid path: no parent".into()))?;
    let leaf = joined
        .file_name()
        .ok_or_else(|| AppError::Other("invalid path: no file name".into()))?
        .to_os_string();
    let parent_canon = parent
        .canonicalize()
        .map_err(|e| AppError::Other(format!("parent directory not found: {e}")))?;
    let resolved = parent_canon.join(&leaf);

    if !resolved.starts_with(&ws_canon) {
        return Err(AppError::Other("refusing to touch a path outside the workspace".into()));
    }
    if resolved == ws_canon {
        return Err(AppError::Other("refusing to operate on the workspace root".into()));
    }
    if resolved.components().any(|c| c.as_os_str() == ".git") {
        return Err(AppError::Other("refusing to touch .git".into()));
    }
    Ok(resolved)
}

/// A new entry's name must be a single path component.
fn validate_simple_name(name: &str) -> AppResult<()> {
    if name.trim().is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        return Err(AppError::Other(format!("invalid name: {name:?}")));
    }
    Ok(())
}

pub(crate) fn fs_rename_inner(workspace_path: &str, from: &str, to: &str) -> AppResult<()> {
    let from_p = contained_path(workspace_path, from)?;
    let to_p = contained_path(workspace_path, to)?;
    if let Ok(to_meta) = to_p.symlink_metadata() {
        // On case-insensitive filesystems (e.g. macOS APFS) a case-only rename
        // makes the destination stat to the source itself — allow that.
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let same_entry = from_p
                .symlink_metadata()
                .map(|m| m.dev() == to_meta.dev() && m.ino() == to_meta.ino())
                .unwrap_or(false);
            if !same_entry {
                return Err(AppError::Other("destination already exists".into()));
            }
        }
        #[cfg(not(unix))]
        {
            let _ = to_meta;
            return Err(AppError::Other("destination already exists".into()));
        }
    }
    std::fs::rename(&from_p, &to_p).map_err(|e| AppError::Other(format!("rename failed: {e}")))
}

pub(crate) fn fs_create_file_inner(workspace_path: &str, parent: &str, name: &str) -> AppResult<()> {
    validate_simple_name(name)?;
    let target = std::path::Path::new(parent).join(name);
    let p = contained_path(workspace_path, &target.to_string_lossy())?;
    if p.symlink_metadata().is_ok() {
        return Err(AppError::Other("an entry with that name already exists".into()));
    }
    std::fs::write(&p, "").map_err(|e| AppError::Other(format!("create file failed: {e}")))
}

pub(crate) fn fs_create_dir_inner(workspace_path: &str, parent: &str, name: &str) -> AppResult<()> {
    validate_simple_name(name)?;
    let target = std::path::Path::new(parent).join(name);
    let p = contained_path(workspace_path, &target.to_string_lossy())?;
    if p.symlink_metadata().is_ok() {
        return Err(AppError::Other("an entry with that name already exists".into()));
    }
    std::fs::create_dir(&p).map_err(|e| AppError::Other(format!("create folder failed: {e}")))
}

pub(crate) fn fs_delete_inner(workspace_path: &str, target: &str) -> AppResult<()> {
    let p = contained_path(workspace_path, target)?;
    let meta = p
        .symlink_metadata()
        .map_err(|e| AppError::Other(format!("nothing to delete: {e}")))?;
    if meta.is_dir() {
        std::fs::remove_dir_all(&p).map_err(|e| AppError::Other(format!("delete failed: {e}")))
    } else {
        std::fs::remove_file(&p).map_err(|e| AppError::Other(format!("delete failed: {e}")))
    }
}

#[tauri::command]
pub async fn fs_rename(workspace_path: String, from: String, to: String) -> AppResult<()> {
    fs_rename_inner(&workspace_path, &from, &to)
}

#[tauri::command]
pub async fn fs_create_file(workspace_path: String, parent: String, name: String) -> AppResult<()> {
    fs_create_file_inner(&workspace_path, &parent, &name)
}

#[tauri::command]
pub async fn fs_create_dir(workspace_path: String, parent: String, name: String) -> AppResult<()> {
    fs_create_dir_inner(&workspace_path, &parent, &name)
}

#[tauri::command]
pub async fn fs_delete(workspace_path: String, target: String) -> AppResult<()> {
    fs_delete_inner(&workspace_path, &target)
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

// ── MCP server integration (Connect to Claude Code) ───────────────────────

/// Current state of the bundled `octopush-mcp` server and its Claude Code
/// registration — drives the Integrations settings card.
#[tauri::command]
pub async fn mcp_connection_status() -> AppResult<crate::mcp_setup::McpStatus> {
    // `status()` shells out to the `claude` CLI; run it off the async runtime
    // so a slow CLI can't stall other IPC handlers.
    tokio::task::spawn_blocking(crate::mcp_setup::status)
        .await
        .map_err(|e| AppError::Other(format!("status task failed: {e}")))
}

/// One-click: register the bundled `octopush-mcp` server with Claude Code at
/// user scope. Returns a structured result (with a manual fallback command) so
/// the UI can guide the user when the CLI isn't found.
#[tauri::command]
pub async fn connect_claude_code() -> AppResult<crate::mcp_setup::McpConnectResult> {
    tokio::task::spawn_blocking(crate::mcp_setup::connect)
        .await
        .map_err(|e| AppError::Other(format!("connect task failed: {e}")))
}

#[cfg(test)]
mod ai_complete_tests {
    use crate::providers::{LlmContent, LlmRole};

    #[test]
    fn build_ai_request_makes_one_user_text_message_no_tools() {
        let req = super::build_ai_request("claude-sonnet-4-6", "SYS".into(), "PROMPT".into(), 8192, None);
        assert_eq!(req.model, "claude-sonnet-4-6");
        assert_eq!(req.max_tokens, 8192);
        assert_eq!(req.system, "SYS");
        assert_eq!(req.tools.len(), 0);
        assert_eq!(req.tool_choice, None);
        assert_eq!(req.messages.len(), 1);
        assert_eq!(req.messages[0].role, LlmRole::User);
        match &req.messages[0].content {
            LlmContent::Text(t) => assert_eq!(t, "PROMPT"),
            _ => panic!("expected Text content"),
        }
    }

    #[test]
    fn build_ai_request_with_schema_forces_the_emit_result_tool() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": { "summary": { "type": "string" } },
            "required": ["summary"]
        });
        let req = super::build_ai_request("m", "SYS".into(), "PROMPT".into(), 100, Some(schema.clone()));
        assert_eq!(req.tools.len(), 1);
        assert_eq!(req.tools[0].name, super::AI_RESULT_TOOL);
        assert_eq!(req.tools[0].input_schema, schema);
        assert_eq!(req.tool_choice.as_deref(), Some(super::AI_RESULT_TOOL));
    }

    #[test]
    fn ai_response_text_prefers_the_tool_input_then_falls_back_to_prose() {
        use crate::providers::{LlmResponse, LlmStopReason, LlmToolUse};
        let structured = LlmResponse {
            text: "ignored preamble".into(),
            tool_uses: vec![LlmToolUse {
                id: "tu_1".into(),
                name: super::AI_RESULT_TOOL.into(),
                input: serde_json::json!({ "summary": "ok", "findings": [] }),
            }],
            stop_reason: LlmStopReason::ToolUse,
            input_tokens: 1,
            output_tokens: 1,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            rate_limit: None,
        };
        let text = super::ai_response_text(structured);
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed["summary"], "ok");

        let prose = LlmResponse {
            text: "plain answer".into(),
            tool_uses: vec![],
            stop_reason: LlmStopReason::EndTurn,
            input_tokens: 1,
            output_tokens: 1,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
            rate_limit: None,
        };
        assert_eq!(super::ai_response_text(prose), "plain answer");
    }

    #[test]
    fn ensure_not_truncated_rejects_max_tokens_only() {
        use crate::providers::LlmStopReason;
        let err = super::ensure_not_truncated(&LlmStopReason::MaxTokens).unwrap_err();
        assert!(err.to_string().contains("token limit"), "got: {err}");
        assert!(super::ensure_not_truncated(&LlmStopReason::EndTurn).is_ok());
        assert!(super::ensure_not_truncated(&LlmStopReason::ToolUse).is_ok());
        assert!(super::ensure_not_truncated(&LlmStopReason::Other("stop".into())).is_ok());
    }
}
