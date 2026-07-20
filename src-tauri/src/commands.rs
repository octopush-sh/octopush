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

    // Build a token scanner hook wired to the shared TokenEngine. `scan_and_record`
    // gates on the daemon `seq` so a reattach's replayed scrollback isn't re-counted.
    let db_for_hook = std::sync::Arc::clone(&state.db);
    let scanner_hook: crate::pty_manager::OutputHook = Box::new(move |sid, seq, bytes| {
        let engine = crate::token_engine::TokenEngine::new(std::sync::Arc::clone(&db_for_hook));
        engine.scan_and_record(sid, seq, bytes);
    });

    // Merge guard env into PTY env (isolated HISTFILE, project type, git branch).
    let mut env = HashMap::new();
    guard.apply_env(&mut env);

    // Inject the selected model so CLI agents can read it.
    env.insert("OCTOPUSH_MODEL".into(), session.agent.model.clone());

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
    // Frontend-supplied one-off event → the catch-all surface.
    state.tokens.record(event, "adhoc")
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
        // For now: update the OCTOPUSH_MODEL env var hint for
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

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GenesisRenameCandidate {
    pub project_id: String,
    pub prompt: String,
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
        ensure_main_workspace(&db, &id, &p, None)?;
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
        ensure_main_workspace(&db, &id, &path, None)?;
        Ok(ProjectInfo { id, name, path, jira_project_key: None, pinned: false, tint: None })
    }
}

/// Find-or-create the canonical **Sketchbook** — a real git project at
/// `~/.octopush/sketchbook` where "think it through first" missions live as TALK
/// threads (genesis G5). A normal project in every respect (so sketches are
/// versioned for free and there is NO special "design mission" surface) — it's
/// just singleton + named, unlike `create_project` which suffixes collisions.
#[tauri::command]
pub async fn ensure_sketchbook(state: State<'_, AppState>) -> AppResult<ProjectInfo> {
    let path = expand_tilde("~/.octopush/sketchbook");
    let path_buf = std::path::PathBuf::from(&path);
    if !path_buf.exists() || !crate::git_ops::is_git_repo(&path_buf) {
        std::fs::create_dir_all(&path_buf)?;
        crate::git_ops::init_repo(&path_buf)?;
    }
    crate::git_ops::ensure_initial_commit(&path_buf)?;

    let db = state.db.lock();
    if let Some((id, _name, p)) = db.get_project_by_path(&path)? {
        db.reopen_project(&id)?;
        ensure_main_workspace(&db, &id, &p, None)?;
        let existing = db.get_project(&id)?;
        let jira_project_key = existing.as_ref().and_then(|p| p.jira_project_key.clone());
        let pinned = existing.as_ref().map(|p| p.pinned).unwrap_or(false);
        let tint = existing.as_ref().and_then(|p| p.tint.clone());
        Ok(ProjectInfo { id, name: "Sketchbook".into(), path: p, jira_project_key, pinned, tint })
    } else {
        let id = uuid::Uuid::new_v4().to_string();
        db.insert_project(&id, "Sketchbook", &path)?;
        ensure_main_workspace(&db, &id, &path, None)?;
        Ok(ProjectInfo { id, name: "Sketchbook".into(), path, jira_project_key: None, pinned: false, tint: None })
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
    task: Option<&str>,
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
    // user's default branch is. `task`, when present (prompt genesis), seeds the
    // main workspace's task → becomes the paired mission's title (M1 pairing).
    db.insert_workspace(&id, project_id, &branch, task.unwrap_or(""), &branch, Some(project_path), "", None)?;
    // Every workspace is born with a mission — the main workspace becomes a
    // 'build' mission owning the project root.
    if let Some(ws) = db.get_workspace(&id)? {
        crate::mission::ensure_for_workspace(db, &ws, "build", "worktree")?;
    }
    Ok(())
}

#[tauri::command]
pub async fn create_project(
    state: State<'_, AppState>,
    path: String,
    name: String,
    task: Option<String>,
) -> AppResult<ProjectInfo> {
    let path = expand_tilde(&path);
    let base = std::path::Path::new(&path);
    // The location must be an absolute path. An editable field feeds this, and an
    // empty/relative base would make `Path::join` yield a RELATIVE project path —
    // scaffolded against the process cwd and persisted as a relative string that
    // resolves differently next launch. Reject it at the source (mirrors the
    // name guard in resolve_free_project_dir).
    if path.trim().is_empty() || base.is_relative() {
        return Err(crate::error::AppError::Other(format!(
            "'{path}' is not a valid project location — an absolute path is required"
        )));
    }
    // Never `git init` over someone else's non-empty directory: if the target
    // exists with content, pick a free `<name>-2`, `-3`, … (an empty dir is
    // adopted). Prompt genesis derives the name from a prompt, so collisions are
    // real (two "task tracker" ideas → two projects, not one clobbered).
    let (full_path, name) = resolve_free_project_dir(base, &name)?;
    std::fs::create_dir_all(&full_path)?;
    crate::git_ops::init_repo(&full_path)?;
    // Commit a baseline so the default branch has a tree (otherwise the main
    // workspace we create below would also be empty).
    crate::git_ops::ensure_initial_commit(&full_path)?;
    let id = uuid::Uuid::new_v4().to_string();
    let full_path_str = full_path.to_string_lossy().to_string();
    let db = state.db.lock();
    db.insert_project(&id, &name, &full_path_str)?;
    ensure_main_workspace(&db, &id, &full_path_str, task.as_deref())?;
    // A project created WITH a task is a prompt-genesis project — mark it so the
    // one-shot post-build rename (G6) can offer a name once its first crew ships
    // (the heuristic slug is anonymous; the built thing knows what it is).
    if let Some(t) = task.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        let _ = db.meta_set(&format!("genesis_prompt:{id}"), t);
        // Genesis runs SANDBOXED by default (B3): a brand-new project built by a
        // crew you're not watching should be write-confined. The build-capable
        // seatbelt profile covers common toolchains; if a stack needs something
        // outside it the failure is legible and the sandbox is a one-click toggle
        // in the launcher. Sets it on the main workspace's just-paired mission.
        if let Some(m) = db.active_mission_for_workspace(
            db.list_workspaces(&id)?.first().map(|w| w.id.as_str()).unwrap_or(""),
        )? {
            let _ = db.update_mission_exec_isolation(&m.id, "sandbox");
        }
    }
    Ok(ProjectInfo { id, name, path: full_path_str, jira_project_key: None, pinned: false, tint: None })
}

/// The canonical Sketchbook path (expanded, no side effect — does NOT provision
/// it). The frontend compares a project's path against this to know whether it's
/// the Sketchbook, exactly (a substring check would false-match a project opened
/// from a subfolder inside it) and OS-correctly (the backend owns the separator).
#[tauri::command]
pub fn sketchbook_path() -> String {
    expand_tilde("~/.octopush/sketchbook")
}

/// Atomically CLAIM a genesis project's one-shot post-build rename (G6),
/// resolved from a workspace of the just-completed run. Returns the prompt
/// exactly once (then the marker is set), else `None`. Drives the rename toast.
#[tauri::command]
pub async fn claim_genesis_rename(
    state: State<'_, AppState>,
    workspace_id: String,
) -> AppResult<Option<GenesisRenameCandidate>> {
    Ok(state
        .db
        .lock()
        .claim_genesis_rename(&workspace_id)?
        .map(|(project_id, prompt)| GenesisRenameCandidate { project_id, prompt }))
}

/// Resolve a free project directory under `base` for `name`, suffixing `-2`,
/// `-3`, … only when the target exists AND is non-empty. Returns the chosen path
/// and the (possibly suffixed) name. An empty existing dir is reused as-is.
pub(crate) fn resolve_free_project_dir(
    base: &std::path::Path,
    name: &str,
) -> AppResult<(std::path::PathBuf, String)> {
    // The name must be ONE safe path component. An editable field feeds this, so
    // an absolute path, a `..`, a separator, or an empty string would escape the
    // `~/Octopush` sandbox (`Path::join` replaces the base on an absolute arg and
    // keeps `..` literally) — or, when empty, git-init the container dir itself.
    let name = name.trim();
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
    {
        return Err(crate::error::AppError::Other(format!(
            "'{name}' is not a valid project name"
        )));
    }
    let is_free = |p: &std::path::Path| -> bool {
        match std::fs::read_dir(p) {
            Ok(mut entries) => entries.next().is_none(), // exists + empty → adopt
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => true, // doesn't exist → create
            Err(_) => false, // exists as a file / unreadable → not usable, suffix past it
        }
    };
    let first = base.join(name);
    if is_free(&first) {
        return Ok((first, name.to_string()));
    }
    for n in 2..1000 {
        let candidate_name = format!("{name}-{n}");
        let candidate = base.join(&candidate_name);
        if is_free(&candidate) {
            return Ok((candidate, candidate_name));
        }
    }
    Err(crate::error::AppError::Other(format!(
        "couldn't find a free directory for '{name}' under {}",
        base.display()
    )))
}

// ─── Workspace commands ───────────────────────────────────────────

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn create_workspace(
    state: State<'_, AppState>,
    project_id: String,
    project_path: String,
    name: String,
    task: String,
    branch: String,
    from_branch: String,
    setup_script: String,
    intent: Option<String>,
    git_isolation: Option<String>,
    exec_isolation: Option<String>,
) -> AppResult<crate::db::WorkspaceRow> {
    // Validate the axes BEFORE anything is created on disk. workspace::create
    // commits a DB row + a git worktree; a bad intent/isolation caught only at
    // pairing time (after that) would strand an orphaned workspace with no
    // mission. The wizard's TS unions can't send a bad value, but any other
    // caller of this public command could.
    let intent = intent.as_deref().unwrap_or("build");
    let git_isolation = git_isolation.as_deref().unwrap_or("worktree");
    let exec_isolation = exec_isolation.as_deref().unwrap_or("none");
    crate::mission::validate_axes(intent, git_isolation)?;
    crate::mission::validate_exec(exec_isolation)?;

    let project_path_expanded = expand_tilde(&project_path);
    let project_path = std::path::Path::new(&project_path_expanded);

    // Single shared code path with octopush-mcp. We pass the Mutex (not a held
    // guard) so workspace::create locks only for its brief DB reads/writes and
    // never across the worktree checkout. The UI doesn't need the outcome — the
    // creator's inline "branch exists" hint already tells the user about reuse,
    // and the store upserts by id so a reused row never duplicates in the rail.
    let (ws, _outcome) = crate::workspace::create(
        &state.db,
        &project_id,
        project_path,
        &name,
        &task,
        &branch,
        &from_branch,
        &setup_script,
    )?;
    // Pair the workspace with its mission (idempotent — a reused/adopted row
    // keeps its existing mission). Guarantees "no workspace without a mission".
    // Execution isolation is applied in place afterwards (only when it differs)
    // so both new and reused missions honor the wizard's Execution choice
    // without changing the shared pairing signature.
    {
        let db = state.db.lock();
        let mission = crate::mission::ensure_for_workspace(&db, &ws, intent, git_isolation)?;
        if mission.exec_isolation != exec_isolation {
            db.update_mission_exec_isolation(&mission.id, exec_isolation)?;
        }
    }
    Ok(ws)
}

// ─── Mission commands ─────────────────────────────────────────────

#[tauri::command]
pub async fn list_missions(
    state: State<'_, AppState>,
    project_id: String,
) -> AppResult<Vec<crate::db::MissionRow>> {
    state.db.lock().list_missions(&project_id)
}

#[tauri::command]
pub async fn get_mission(
    state: State<'_, AppState>,
    mission_id: String,
) -> AppResult<Option<crate::db::MissionRow>> {
    state.db.lock().get_mission(&mission_id)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn create_mission(
    state: State<'_, AppState>,
    project_id: String,
    intent: String,
    title: String,
    git_isolation: String,
    exec_isolation: String,
    workspace_id: Option<String>,
    linked_issue_key: Option<String>,
) -> AppResult<crate::db::MissionRow> {
    let db = state.db.lock();
    crate::mission::create(
        &db,
        &project_id,
        &intent,
        &title,
        &git_isolation,
        &exec_isolation,
        workspace_id.as_deref(),
        linked_issue_key.as_deref(),
    )
}

#[tauri::command]
pub async fn update_mission(
    state: State<'_, AppState>,
    mission_id: String,
    title: Option<String>,
    status: Option<String>,
    linked_issue_key: Option<String>,
    exec_isolation: Option<String>,
) -> AppResult<crate::db::MissionRow> {
    if let Some(s) = status.as_deref() {
        crate::mission::validate_status(s)?;
    }
    if let Some(e) = exec_isolation.as_deref() {
        crate::mission::validate_exec(e)?;
    }
    // Scope the DB lock so it's released before the (self-locking) ephemeral
    // auto-archive below — parking_lot's Mutex is not reentrant.
    let updated = {
        let db = state.db.lock();
        db.update_mission(
            &mission_id,
            title.as_deref(),
            status.as_deref(),
            linked_issue_key.as_deref(),
        )?;
        // The Execution axis can now be changed on an existing mission (e.g. the
        // launcher's "enable sandbox for an unattended run" one-click).
        if let Some(e) = exec_isolation.as_deref() {
            db.update_mission_exec_isolation(&mission_id, e)?;
        }
        db.get_mission(&mission_id)?
            .ok_or_else(|| crate::error::AppError::Other("mission not found".into()))?
    };
    // An ephemeral mission reaching a terminal state (done/archived) takes its
    // throwaway worktree with it — "archived when the mission is done".
    if matches!(status.as_deref(), Some("done") | Some("archived"))
        && updated.git_isolation == "ephemeral"
    {
        if let Some(ws_id) = updated.workspace_id.as_deref() {
            archive_workspace_internal(&state, ws_id)?;
        }
    }
    Ok(updated)
}

/// Archive a workspace's worktree (on disk, if Octopush owns it) + DB row,
/// resolving the project path from the workspace's project. Shared by the
/// ephemeral-mission auto-archive; mirrors the guarded removal the
/// `archive_workspace` command performs. Best-effort on the filesystem.
fn archive_workspace_internal(state: &AppState, workspace_id: &str) -> AppResult<()> {
    let ws = { state.db.lock().get_workspace(workspace_id)? };
    let Some(ws) = ws else { return Ok(()) };
    let project_path = { state.db.lock().get_project(&ws.project_id)?.map(|p| p.path) };
    let Some(project_path) = project_path else { return Ok(()) };
    if owns_worktree_on_disk(&state.db, workspace_id, &project_path, ws.worktree_path.as_deref()) {
        if let Some(wt) = &ws.worktree_path {
            let _ = crate::git_ops::delete_worktree(
                std::path::Path::new(&project_path),
                std::path::Path::new(wt),
            );
            let wt_path = std::path::Path::new(wt);
            if wt_path.exists() {
                let _ = std::fs::remove_dir_all(wt_path);
            }
        }
    }
    state.db.lock().archive_workspace(workspace_id)?;
    Ok(())
}

#[tauri::command]
pub async fn archive_mission(state: State<'_, AppState>, mission_id: String) -> AppResult<()> {
    let mission = { state.db.lock().get_mission(&mission_id)? };
    state.db.lock().archive_mission(&mission_id)?;
    // An ephemeral mission takes its throwaway worktree with it when archived.
    if let Some(m) = mission {
        if m.git_isolation == "ephemeral" {
            if let Some(ws_id) = m.workspace_id.as_deref() {
                archive_workspace_internal(&state, ws_id)?;
            }
        }
    }
    Ok(())
}

/// The Logbook rollup for a scope + period. Per-mission (the Companion card) is
/// FREE; cross-mission rollups (project / global — the Logbook Room) are Pro
/// (`logbook.reports`).
#[tauri::command]
pub async fn logbook_summary(
    state: State<'_, AppState>,
    scope_type: String,
    scope_id: Option<String>,
    from: String,
    to: String,
) -> AppResult<Vec<crate::db::LogbookMissionRow>> {
    if scope_type != "mission" {
        require_logbook_reports()?;
    }
    state
        .db
        .lock()
        .logbook_summary(&scope_type, scope_id.as_deref(), &from, &to)
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

/// Does `worktree_path` resolve to the project root (i.e. the "main" workspace)?
/// Uses a raw-string fallback when canonicalize fails so a missing/odd path is
/// never mistaken for a non-root worktree and destructively removed.
fn is_project_root(project_path: &str, worktree_path: &str) -> bool {
    let canon = |p: &str| std::fs::canonicalize(p).unwrap_or_else(|_| std::path::PathBuf::from(p));
    canon(project_path) == canon(worktree_path)
}

/// Should delete/archive touch the worktree on disk (and, for delete, the
/// branch)? Only when Octopush *created* it (`managed`) AND it isn't the project
/// root. Adopted checkouts and the main workspace are left on disk untouched.
fn owns_worktree_on_disk(
    db: &parking_lot::Mutex<crate::db::Db>,
    workspace_id: &str,
    project_path: &str,
    worktree_path: Option<&str>,
) -> bool {
    // Default to NOT-owned on a read error: a leaked worktree dir is a minor
    // annoyance, but rm -rf'ing an adopted (external) checkout is irreversible
    // data loss — so when uncertain, don't touch the disk.
    let managed = db.lock().is_workspace_managed(workspace_id).unwrap_or(false);
    let is_main = worktree_path.is_some_and(|wt| is_project_root(project_path, wt));
    managed && !is_main
}

#[tauri::command]
pub async fn delete_workspace(
    state: State<'_, AppState>,
    workspace_id: String,
    project_path: String,
    branch: String,
    worktree_path: Option<String>,
) -> AppResult<()> {
    let project_path = expand_tilde(&project_path);
    let is_main = worktree_path
        .as_deref()
        .is_some_and(|wt| is_project_root(&project_path, wt));

    // Remove the worktree directory only when Octopush created it (`managed`) and
    // it isn't the project root. An adopted checkout (made by the user/another
    // tool) and the main workspace are left on disk — we just drop the DB row.
    if owns_worktree_on_disk(&state.db, &workspace_id, &project_path, worktree_path.as_deref()) {
        if let Some(wt) = &worktree_path {
            // Prune the worktree's registry slot (by path — slot names aren't
            // tied to the branch), then remove its working-tree directory.
            let _ = crate::git_ops::delete_worktree(
                std::path::Path::new(&project_path),
                std::path::Path::new(wt),
            );
            let wt_path = std::path::Path::new(wt);
            if wt_path.exists() {
                let _ = std::fs::remove_dir_all(wt_path);
            }
        }
    }

    // Delete the branch only when Octopush itself created it — a reused or adopted
    // branch (someone else's work) is never destroyed. Gated separately from the
    // worktree: a workspace can create a worktree over a *pre-existing* branch, and
    // deleting that branch would throw away commits Octopush didn't make. Default
    // to NOT deleting on a read error (data-loss is worse than a leftover branch).
    let created_branch = state
        .db
        .lock()
        .is_branch_created_by_octopush(&workspace_id)
        .unwrap_or(false);
    if created_branch && !is_main {
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
    // Archive keeps the branch; `branch` is retained in the signature for
    // IPC/API symmetry but isn't needed here.
    let _ = &branch;
    let project_path = expand_tilde(&project_path);

    // Only remove on disk what Octopush created. An adopted checkout and the
    // main workspace (project root) keep their directory — archiving just flips
    // the DB row. (Archive always keeps the branch.)
    if owns_worktree_on_disk(&state.db, &workspace_id, &project_path, worktree_path.as_deref()) {
        if let Some(wt) = &worktree_path {
            // Prune the worktree's registry slot (by path), then remove its dir.
            let _ = crate::git_ops::delete_worktree(
                std::path::Path::new(&project_path),
                std::path::Path::new(wt),
            );
            let wt_path = std::path::Path::new(wt);
            if wt_path.exists() {
                let _ = std::fs::remove_dir_all(wt_path);
            }
        }
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
    // `branch`/`worktree_path` are kept in the signature for IPC symmetry, but the
    // heal re-derives everything from the authoritative DB row.
    let _ = (&branch, &worktree_path);

    // Make the worktree usable via the shared healer, which handles all three
    // cases without ever destroying work: adopt the branch's live checkout if it
    // moved, rebuild a managed worktree if the directory is entirely gone, or
    // leave a present directory untouched. Then flip status back to active.
    let mut ws = state
        .db
        .lock()
        .get_workspace(&workspace_id)?
        .ok_or_else(|| AppError::Other("workspace not found".into()))?;
    crate::workspace::heal_worktree(&state.db, std::path::Path::new(&project_path), &mut ws)?;
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
    // Phase 3 — backend budget enforcement. This is the authoritative gate: it
    // backstops the client-side pre-send check (which a direct IPC call bypasses)
    // and additionally enforces PROJECT-scope budgets the client never checks. A
    // conscious per-turn override skips it.
    if !request.override_budget {
        if let crate::db::BudgetVerdict::Block { scope, spent, limit } =
            state.db.lock().check_budget(Some(&request.workspace_id))?
        {
            return Err(AppError::BudgetExceeded { scope, spent, limit });
        }
    }
    state.chat.send_agentic(app, request).await
}

/// Delete a message and everything after it in a thread — backs Regenerate and
/// Edit-and-resend (the frontend then re-dispatches the turn).
#[tauri::command]
pub async fn truncate_chat_after(
    state: State<'_, AppState>,
    thread_id: String,
    message_id: i64,
) -> AppResult<()> {
    state.db.lock().truncate_chat_after(&thread_id, message_id)
}

/// Run a `$`-direct command in the thread's TALK shell (no LLM). Persists the
/// command + output into the conversation and returns the resulting cwd/exit
/// for the composer's cwd badge.
#[tauri::command]
pub async fn run_shell_command(
    app: AppHandle,
    state: State<'_, AppState>,
    request: crate::chat_engine::ShellRequest,
) -> AppResult<crate::talk_shell::ShellResult> {
    state.chat.run_shell_command(app, request).await
}

/// Send SIGINT (Ctrl-C) to a thread's live `$`-direct process. The streamer
/// then sees the command exit and resolves its card.
#[tauri::command]
pub async fn stop_shell_command(state: State<'_, AppState>, thread_id: String) -> AppResult<()> {
    state.chat.talk_shell.interrupt(&thread_id);
    Ok(())
}

/// Forward keystrokes to a thread's live process (interactive stdin: REPLs,
/// TUIs, prompts). Output streams back via `chat://shell-output`.
#[tauri::command]
pub async fn send_shell_input(
    state: State<'_, AppState>,
    thread_id: String,
    data: String,
) -> AppResult<()> {
    state.chat.talk_shell.write_stdin(&thread_id, data.as_bytes());
    Ok(())
}

/// Resize a thread's PTY so a full-screen TUI lays out to the live panel size.
#[tauri::command]
pub async fn resize_shell(
    state: State<'_, AppState>,
    thread_id: String,
    rows: u16,
    cols: u16,
) -> AppResult<()> {
    state.chat.talk_shell.resize(&thread_id, cols, rows);
    Ok(())
}

/// Most-recently-used `$`-direct commands for a workspace (recall palette / ↑).
#[tauri::command]
pub async fn list_shell_history(
    state: State<'_, AppState>,
    workspace_id: String,
    limit: Option<i64>,
) -> AppResult<Vec<String>> {
    state
        .db
        .lock()
        .list_shell_history(&workspace_id, limit.unwrap_or(50))
}

#[tauri::command]
pub async fn list_chat_messages(
    state: State<'_, AppState>,
    thread_id: String,
) -> AppResult<Vec<crate::db::ChatMessageRow>> {
    state.db.lock().list_chat_messages(&thread_id)
}

/// Request that the in-flight agentic turn for this thread stop. The loop
/// halts before its next iteration (or next tool) and emits the done event.
#[tauri::command]
pub async fn cancel_chat(state: State<'_, AppState>, thread_id: String) -> AppResult<()> {
    state.chat.cancel(&thread_id);
    Ok(())
}

/// Resolve an inline approval request for a dangerous agent command.
/// `decision` is "approve" | "always" | "deny".
#[tauri::command]
pub async fn respond_approval(
    state: State<'_, AppState>,
    call_id: String,
    decision: String,
) -> AppResult<()> {
    state
        .chat
        .respond_approval(&call_id, crate::chat_engine::ApprovalDecision::parse(&decision));
    Ok(())
}

// ─── Chat threads (conversations) ─────────────────────────────────

#[tauri::command]
pub async fn list_chat_threads(
    state: State<'_, AppState>,
    workspace_id: String,
) -> AppResult<Vec<crate::db::ChatThreadRow>> {
    state.db.lock().list_chat_threads(&workspace_id)
}

#[tauri::command]
pub async fn create_chat_thread(
    state: State<'_, AppState>,
    workspace_id: String,
    title: Option<String>,
) -> AppResult<crate::db::ChatThreadRow> {
    state
        .db
        .lock()
        .create_chat_thread(&workspace_id, title.as_deref().unwrap_or("New conversation"))
}

#[tauri::command]
pub async fn rename_chat_thread(
    state: State<'_, AppState>,
    thread_id: String,
    title: String,
) -> AppResult<()> {
    state.db.lock().rename_chat_thread(&thread_id, &title)
}

/// Pin/unpin a conversation — pinned threads sort to the top of the chat list.
#[tauri::command]
pub async fn set_thread_pinned(
    state: State<'_, AppState>,
    thread_id: String,
    pinned: bool,
) -> AppResult<()> {
    state.db.lock().set_thread_pinned(&thread_id, pinned)
}

#[tauri::command]
pub async fn delete_chat_thread(state: State<'_, AppState>, thread_id: String) -> AppResult<()> {
    // Stop any in-flight turn first — this also resolves a parked dangerous-
    // command approval (as Deny) so the agent loop doesn't stay blocked for the
    // full 300s timeout after the conversation is gone.
    state.chat.cancel(&thread_id);
    // Tear down the thread's TALK shell (kills the daemon PTY + releases the
    // session entry) so deleting conversations doesn't leak bash processes.
    state.chat.talk_shell.close(&thread_id);
    state.db.lock().delete_chat_thread(&thread_id)
}

/// List the skills available to a worktree (project ∪ user SKILL.md files).
#[tauri::command]
pub async fn list_skills(workspace_path: String) -> AppResult<Vec<crate::skills::SkillMeta>> {
    let skills = crate::skills::scan_skills(std::path::Path::new(&workspace_path));
    Ok(skills.iter().map(|s| s.meta()).collect())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentData {
    pub media_type: String,
    pub data: String,
    pub name: String,
}

/// Read an image file into a base64 attachment (images only, ≤ 5 MB) for the
/// chat composer. Returns the IANA media type, base64 data, and file name.
#[tauri::command]
pub async fn read_attachment(path: String) -> AppResult<AttachmentData> {
    use base64::Engine as _;
    let p = std::path::Path::new(&path);
    let bytes = std::fs::read(p)
        .map_err(|e| crate::error::AppError::Other(format!("Failed to read {path}: {e}")))?;
    if bytes.len() > 5_000_000 {
        return Err(crate::error::AppError::Other(
            "Image too large (max 5 MB).".into(),
        ));
    }
    // Detect the media type from the file's MAGIC BYTES (robust to a misleading
    // extension, which the API would otherwise reject). Fall back to the
    // extension only when the bytes don't match a known image signature.
    let media_type = sniff_image_media_type(&bytes)
        .or_else(|| {
            match p
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase())
                .as_deref()
            {
                Some("png") => Some("image/png"),
                Some("jpg") | Some("jpeg") => Some("image/jpeg"),
                Some("gif") => Some("image/gif"),
                Some("webp") => Some("image/webp"),
                _ => None,
            }
        })
        .ok_or_else(|| {
            crate::error::AppError::Other(
                "Unsupported attachment (images only: png, jpeg, gif, webp).".into(),
            )
        })?;
    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let name = p
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("image")
        .to_string();
    Ok(AttachmentData {
        media_type: media_type.to_string(),
        data,
        name,
    })
}

/// List the tools exposed by the worktree's configured + reachable MCP servers.
/// Connects lazily; unreachable servers are skipped.
#[tauri::command]
pub async fn list_mcp_tools(
    state: State<'_, AppState>,
    workspace_path: String,
) -> AppResult<Vec<crate::mcp::McpToolInfo>> {
    Ok(state
        .chat
        .mcp
        .list_tools(std::path::Path::new(&workspace_path)))
}

/// List the names of MCP servers configured for a worktree (project ∪ user),
/// whether or not they're currently reachable.
#[tauri::command]
pub async fn list_mcp_servers(workspace_path: String) -> AppResult<Vec<String>> {
    let mut names: Vec<String> =
        crate::mcp::load_server_configs(std::path::Path::new(&workspace_path))
            .into_keys()
            .collect();
    names.sort();
    Ok(names)
}

/// The user-level MCP server config (`~/.claude/mcp.json`), for the Settings UI.
#[tauri::command]
pub async fn get_mcp_config(
) -> AppResult<std::collections::HashMap<String, crate::mcp::McpServerConfig>> {
    Ok(crate::mcp::load_user_config())
}

/// Replace the user-level MCP server config.
#[tauri::command]
pub async fn save_mcp_config(
    servers: std::collections::HashMap<String, crate::mcp::McpServerConfig>,
) -> AppResult<()> {
    crate::mcp::save_user_config(&servers).map_err(crate::error::AppError::Other)
}

/// Smoke-test a single server config: spawn it, run the handshake, and return
/// its tools (or an error). The connection is dropped immediately after.
#[tauri::command]
pub async fn test_mcp_server(
    name: String,
    config: crate::mcp::McpServerConfig,
) -> AppResult<Vec<crate::mcp::McpToolInfo>> {
    let fut = tokio::task::spawn_blocking(move || crate::mcp::McpRegistry::test_connect(&name, &config));
    // Bound the test so a server that spawns but never speaks JSON-RPC doesn't
    // leave the UI spinner stuck forever.
    match tokio::time::timeout(std::time::Duration::from_secs(15), fut).await {
        Ok(join) => join
            .map_err(|e| crate::error::AppError::Other(e.to_string()))?
            .map_err(crate::error::AppError::Other),
        Err(_) => Err(crate::error::AppError::Other(
            "Connection timed out — the server didn't respond within 15s.".into(),
        )),
    }
}

/// Identify a supported image type from its leading bytes, or None.
fn sniff_image_media_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF8") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
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
    let saved_id = state.db.lock().save_pipeline(pipeline_id, &name, &description, &stages)?;
    // Library sync (Pro): fire-and-forget the edited item to the cloud so it
    // follows the user to their other machines. Never affects the save.
    if crate::entitlement::Entitlement::current()
        .has_feature(crate::entitlement::feature::LIBRARY_SYNC)
    {
        // Best-effort from here: the save already COMMITTED — a bookkeeping
        // read failure must never turn a successful save into an error.
        let item = {
            let db = state.db.lock();
            db.list_custom_pipelines_for_sync()
                .unwrap_or_default()
                .into_iter()
                .find(|p| p.id == saved_id)
                .map(|sp| crate::sync::SyncLibraryItem::pipeline(&sp))
        };
        if let Some(item) = item {
            tokio::spawn(async move {
                let client = crate::chat_engine::shared_http_client();
                crate::sync::push_library_items(client, vec![item]).await;
            });
        }
    }
    Ok(saved_id)
}

#[tauri::command]
pub async fn delete_pipeline(
    state: State<'_, AppState>,
    pipeline_id: String,
) -> AppResult<()> {
    state.db.lock().delete_pipeline(&pipeline_id)?;
    // Tombstone so the deletion follows the user (an edit made LATER on
    // another machine revives the item — newest intent wins).
    if crate::entitlement::Entitlement::current()
        .has_feature(crate::entitlement::feature::LIBRARY_SYNC)
    {
        let item = crate::sync::SyncLibraryItem::tombstone("pipeline", &pipeline_id);
        tokio::spawn(async move {
            let client = crate::chat_engine::shared_http_client();
            crate::sync::push_library_items(client, vec![item]).await;
        });
    }
    Ok(())
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
    // All start-time guards + the detached-spawn/fallback discipline live in
    // one shared path so the routines scheduler applies exactly the same gates.
    crate::orchestrator::launch::launch_run(&orch, &state.db, &run_id, budget_usd).await
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

/// All active (`running`/`paused`) runs across every workspace — drives the
/// global "Runs in progress" tray (incl. background runs in unopened workspaces).
#[tauri::command]
pub async fn list_active_runs(
    state: State<'_, AppState>,
) -> AppResult<Vec<crate::db::RunRow>> {
    state.db.lock().list_active_runs()
}

/// The current entitlement (derived from the signed-in user's Clerk plan). The
/// frontend mirrors this for UX; the meaningful gates live in the Rust core.
#[tauri::command]
pub async fn get_entitlement() -> AppResult<crate::entitlement::Entitlement> {
    Ok(crate::entitlement::Entitlement::current())
}

/// Monthly Direct-run usage for the launcher meter (`{used, limit, remaining}`).
/// `limit == null` when the plan is uncapped (Pro).
#[tauri::command]
pub async fn direct_run_usage(
    state: State<'_, AppState>,
) -> AppResult<crate::entitlement::DirectRunUsage> {
    let ent = crate::entitlement::Entitlement::current();
    let used = state.db.lock().count_started_runs_this_month()?;
    Ok(crate::entitlement::DirectRunUsage {
        used,
        limit: ent.direct_runs_per_month,
        remaining: ent.direct_runs_remaining(used),
    })
}

/// "Has this user ever started a Direct run?" — drives the one-shot "put a
/// crew on it" first-run invite. Durable (app_meta marker OR surviving rows).
#[tauri::command]
pub async fn has_ever_started_run(state: State<'_, AppState>) -> AppResult<bool> {
    state.db.lock().has_ever_started_run()
}

// ─── Routines (scheduled crews — Pro `routines.scheduled`) ─────────────────

/// Compute a routine's next fire from its schedule + the clock, validating the
/// spec. Shared by create/update/enable so the stored `next_due_at` is always
/// consistent with the schedule.
fn routine_next_due(kind: &str, spec: &str) -> AppResult<Option<String>> {
    crate::routines::validate_schedule(kind, spec).map_err(AppError::Other)?;
    Ok(crate::routines::next_due(kind, spec, chrono::Local::now()))
}

/// Full input validation (schedule spec + cross-field rules like fresh⇒daily),
/// shared by create and update.
fn validate_routine_input(input: &crate::db::RoutineInput) -> AppResult<Option<String>> {
    crate::routines::validate_routine(&input.workspace_mode, &input.schedule_kind)
        .map_err(AppError::Other)?;
    routine_next_due(&input.schedule_kind, &input.schedule_spec)
}

#[tauri::command]
pub async fn list_routines(state: State<'_, AppState>) -> AppResult<Vec<crate::db::RoutineRow>> {
    state.db.lock().list_routines()
}

#[tauri::command]
pub async fn create_routine(
    state: State<'_, AppState>,
    input: crate::db::RoutineInput,
) -> AppResult<String> {
    require_feature_gate(crate::entitlement::feature::ROUTINES_SCHEDULED)?;
    let next_due = validate_routine_input(&input)?;
    let id = uuid::Uuid::new_v4().to_string();
    // The app creates routines ENABLED (the command is Pro-gated above); the
    // enabled flag is written in the same insert so there's no toggle window.
    state.db.lock().insert_routine(&id, &input, next_due.as_deref(), true)?;
    Ok(id)
}

#[tauri::command]
pub async fn update_routine(
    state: State<'_, AppState>,
    routine_id: String,
    input: crate::db::RoutineInput,
) -> AppResult<()> {
    require_feature_gate(crate::entitlement::feature::ROUTINES_SCHEDULED)?;
    let next_due = validate_routine_input(&input)?;
    state.db.lock().update_routine(&routine_id, &input, next_due.as_deref())
}

#[tauri::command]
pub async fn delete_routine(state: State<'_, AppState>, routine_id: String) -> AppResult<()> {
    // Deletion is ungated — a downgraded user must always be able to remove a
    // routine they can no longer run.
    state.db.lock().delete_routine(&routine_id)
}

#[tauri::command]
pub async fn set_routine_enabled(
    state: State<'_, AppState>,
    routine_id: String,
    enabled: bool,
) -> AppResult<()> {
    // Enabling requires entitlement; disabling never does.
    if enabled {
        require_feature_gate(crate::entitlement::feature::ROUTINES_SCHEDULED)?;
    }
    // Read the routine once (its own lock, released before the write below —
    // parking_lot's mutex is NOT re-entrant, so the receiver-and-argument must
    // never both take the lock in one statement).
    let routine = state
        .db
        .lock()
        .get_routine(&routine_id)?
        .ok_or_else(|| AppError::Other("routine not found".into()))?;
    // Enabling re-seats the schedule from now; disabling preserves the stored
    // next_due (re-enabling from the UI is then instant) — the scheduler
    // ignores disabled rows regardless.
    let next_due = if enabled {
        routine_next_due(&routine.schedule_kind, &routine.schedule_spec)?
    } else {
        routine.next_due_at
    };
    state.db.lock().set_routine_enabled(&routine_id, enabled, next_due.as_deref())
}

/// Fire a routine immediately (the "run now" test affordance), independent of
/// its schedule and its enabled state. Reuses the exact scheduled fire path —
/// same workspace resolution, same guarded launch — so nothing is bypassed but
/// the schedule itself.
#[tauri::command]
pub async fn run_routine_now(
    orch: State<'_, Arc<Orchestrator>>,
    routine_id: String,
) -> AppResult<crate::routines::FireOutcomeView> {
    require_feature_gate(crate::entitlement::feature::ROUTINES_SCHEDULED)?;
    // Run the identical guarded fire path (condition gate included), then hand
    // the frontend the flattened `{ outcome, reason? }` so "Run now" reports
    // exactly what a scheduled fire would do.
    let outcome = Arc::clone(&*orch).run_routine_now(&routine_id).await?;
    Ok(outcome.view())
}

// ─── Cross-machine run history (Pro-real Part B / B1) ──────────────

/// Pro-gate for the sync commands — mirrors the `start_run` concurrency gate so a
/// non-entitled call surfaces the upgrade sheet.
fn require_feature_gate(feature: &str) -> AppResult<()> {
    if crate::entitlement::Entitlement::current().has_feature(feature) {
        Ok(())
    } else {
        Err(AppError::UpgradeRequired { feature: feature.into(), used: 0, limit: 0 })
    }
}

fn require_history_sync() -> AppResult<()> {
    require_feature_gate(crate::entitlement::feature::HISTORY_SYNC)
}

/// Cross-mission Logbook rollups + export are Pro; per-mission is free.
fn require_logbook_reports() -> AppResult<()> {
    require_feature_gate(crate::entitlement::feature::LOGBOOK_REPORTS)
}

/// The local read-only history mirror (instant, no network). The History view
/// paints this first, then refreshes via `history_sync_pull`. **Entitlement-gated
/// on read** (not just on pull): the mirror can hold runs pulled by a *previous*
/// signed-in Pro user, so a signed-out / Free user (e.g. the next person on a
/// shared machine) must not be able to read it — return empty for them. (The
/// mirror is also cleared on sign-out; this is the belt to that suspenders.)
#[tauri::command]
pub async fn history_list(state: State<'_, AppState>) -> AppResult<Vec<crate::sync::SyncRun>> {
    if !crate::entitlement::Entitlement::current()
        .has_feature(crate::entitlement::feature::HISTORY_SYNC)
    {
        return Ok(Vec::new());
    }
    state.db.lock().list_synced_runs()
}

/// Pull the signed-in Pro user's run history from the cloud, replace the local
/// mirror, and return it. Pro-gated (`history.sync`). Best-effort refresh: on a
/// network/transient error it falls back to the current local mirror rather than
/// failing (so opening History offline still shows the last-known data).
#[tauri::command]
pub async fn history_sync_pull(
    state: State<'_, AppState>,
) -> AppResult<Vec<crate::sync::SyncRun>> {
    require_history_sync()?;
    let client = crate::chat_engine::shared_http_client();
    match crate::sync::pull_runs(client).await {
        Ok(runs) => {
            state.db.lock().replace_synced_runs(&runs)?;
            Ok(runs)
        }
        Err(_) => state.db.lock().list_synced_runs(),
    }
}

/// One-shot backfill: push this machine's terminal runs (newest first, capped at
/// [`crate::sync::MAX_PUSH`]) so a Pro user's existing history is populated
/// immediately — not only from the next run onward. No-op for non-Pro; the server
/// upserts by run id so re-running it is idempotent. Returns the count attempted.
#[tauri::command]
pub async fn history_sync_push_all(state: State<'_, AppState>) -> AppResult<usize> {
    if !crate::entitlement::Entitlement::current()
        .has_feature(crate::entitlement::feature::HISTORY_SYNC)
    {
        return Ok(0);
    }
    let runs = {
        let db = state.db.lock();
        let machine_id = match db.get_or_create_machine_id() {
            Ok(id) if !id.is_empty() => id,
            _ => return Ok(0), // can't mint an id → skip (empty would mis-attribute)
        };
        let terminal = db.list_terminal_runs(crate::sync::MAX_PUSH as u32)?;
        terminal
            .iter()
            .map(|r| crate::sync::build_run_payload(&db, r, &machine_id))
            .collect::<Vec<_>>()
    };
    let count = runs.len();
    let client = crate::chat_engine::shared_http_client();
    crate::sync::push_runs(client, runs).await;

    // Heal the B2 detail for the MOST RECENT terminal runs. The terminal-time
    // detail push is fire-and-forget with no retry — a run finishing offline
    // (or into a 503) would otherwise lose its story cloud-side FOREVER. The
    // server upserts by run id, so re-pushing is idempotent; bounding to the
    // newest few keeps launch traffic small while covering the common case
    // (the run that finished right before the network hiccup). Granular locks:
    // one short lock per read, all string work outside.
    const DETAIL_HEAL_RECENT: usize = 10;
    let recent: Vec<crate::db::RunRow> = {
        let db = state.db.lock();
        db.list_terminal_runs(DETAIL_HEAL_RECENT as u32)?
    };
    for run in recent {
        let stage_rows = state.db.lock().list_run_stages(&run.id).unwrap_or_default();
        let mut details = Vec::with_capacity(stage_rows.len());
        for stage in &stage_rows {
            let raw = state.db.lock().list_stage_log(&stage.id).unwrap_or_default();
            details.push(crate::sync::build_stage_detail(stage, raw));
        }
        let mut detail = crate::sync::SyncRunDetail { run_id: run.id.clone(), stages: details };
        crate::sync::enforce_detail_budget(&mut detail);
        crate::sync::push_run_detail(client, detail).await;
    }
    Ok(count)
}

/// Fetch one synced run's full story — per-stage journals, artifact texts, and
/// diff snapshots — from the cloud, on demand (B2). `None` when the server has
/// no detail for that run (synced before B2, or its detail push failed); the
/// History view says so honestly. Pro-gated (`history.sync`); the local run's
/// detail never goes through here (DIRECT reads the local DB directly).
#[tauri::command]
pub async fn history_run_detail(
    run_id: String,
) -> AppResult<Option<crate::sync::SyncRunDetail>> {
    require_history_sync()?;
    crate::sync::pull_run_detail(crate::chat_engine::shared_http_client(), &run_id).await
}

/// Push the WHOLE custom library (pipelines + roles) to the cloud — the launch
/// heal for edits made offline or whose fire-and-forget push failed. The server
/// does per-item LWW, so re-pushing is idempotent and never regresses a newer
/// edit from another machine. No-op for non-Pro. Returns the count pushed.
#[tauri::command]
pub async fn library_sync_push_all(state: State<'_, AppState>) -> AppResult<usize> {
    if !crate::entitlement::Entitlement::current()
        .has_feature(crate::entitlement::feature::LIBRARY_SYNC)
    {
        return Ok(0);
    }
    let items: Vec<crate::sync::SyncLibraryItem> = {
        let db = state.db.lock();
        let mut items: Vec<crate::sync::SyncLibraryItem> = db
            .list_custom_pipelines_for_sync()?
            .iter()
            .map(crate::sync::SyncLibraryItem::pipeline)
            .collect();
        items.extend(
            db.list_custom_roles_for_sync()?
                .iter()
                .map(|(role, updated_at)| crate::sync::SyncLibraryItem::role(role, updated_at)),
        );
        items
    };
    let count = items.len();
    crate::sync::push_library_items(crate::chat_engine::shared_http_client(), items).await;
    Ok(count)
}

/// Pull the user's library and merge it per-item LWW into the local DB —
/// roles FIRST (pipelines reference role keys), then pipelines; tombstones
/// delete locally only when NEWER than the local edit (and tolerantly: an
/// in-use role or unknown id is skipped, never an error). Pro-gated. Returns
/// the number of items applied.
#[tauri::command]
pub async fn library_sync_pull(state: State<'_, AppState>) -> AppResult<usize> {
    require_feature_gate(crate::entitlement::feature::LIBRARY_SYNC)?;
    let items = crate::sync::pull_library(crate::chat_engine::shared_http_client()).await?;
    let mut applied = 0usize;

    // Apply order matters (and each step takes its own SHORT lock — this is a
    // launch-time merge, but the mutex is shared with every live surface):
    //   1. role UPSERTS — pipelines validate against roles;
    //   2. pipelines (upserts + tombstones);
    //   3. role TOMBSTONES LAST — so a role referenced by a pipeline pulled in
    //      this very merge counts as in-use and survives its own tombstone.
    for item in items.iter().filter(|i| i.kind == "role" && !i.deleted) {
        let Some(data) = &item.data else { continue };
        let Ok(mut role) =
            serde_json::from_value::<crate::orchestrator::roles::RoleDef>(data.clone())
        else {
            continue; // unparseable → skip, never fatal
        };
        if role.key != item.item_id {
            continue; // envelope/data identity mismatch — refuse quietly
        }
        role.is_builtin = false; // the wire never carries builtin authority
        if state
            .db
            .lock()
            .upsert_role_from_sync(&role, &item.updated_at)
            .unwrap_or(false)
        {
            applied += 1;
        }
    }

    for item in items.iter().filter(|i| i.kind == "pipeline") {
        if item.deleted {
            let db = state.db.lock();
            match db.pipeline_sync_state(&item.item_id) {
                Ok(Some((local, false))) if local.as_str() < item.updated_at.as_str() => {
                    if db.delete_pipeline(&item.item_id).is_ok() {
                        applied += 1;
                    }
                }
                _ => {}
            }
            continue;
        }
        let Some(data) = &item.data else { continue };
        let Ok(sp) = serde_json::from_value::<crate::sync::SyncPipeline>(data.clone()) else {
            continue;
        };
        if sp.id != item.item_id {
            continue; // envelope/data mismatch — refuse quietly
        }
        match state.db.lock().upsert_pipeline_from_sync(&sp) {
            Ok(true) => applied += 1,
            Ok(false) => {}
            Err(e) => tracing::warn!(pipeline = %sp.id, "library pull: pipeline skipped: {e}"),
        }
    }

    for item in items.iter().filter(|i| i.kind == "role" && i.deleted) {
        let db = state.db.lock();
        match db.role_sync_state(&item.item_id) {
            Ok(Some((local, false))) if local.as_str() < item.updated_at.as_str() => {
                if db.role_in_use(&item.item_id).unwrap_or(true) {
                    // Still referenced here: KEEPING it is a genuine local
                    // decision — bump its stamp so the next push beats the
                    // tombstone and the keep propagates (revives cloud-side).
                    let _ = db.touch_role(&item.item_id);
                    continue;
                }
                if db.delete_role(&item.item_id).is_ok() {
                    applied += 1;
                }
            }
            _ => {}
        }
    }
    Ok(applied)
}

// ─── Accounts (P1) ─────────────────────────────────────────────
/// Run the interactive Clerk sign-in: opens the system browser, captures the
/// loopback redirect, exchanges the code (PKCE, no secret), and stores the
/// session in the OS keychain. Returns the resulting auth status.
#[tauri::command]
pub async fn auth_begin_sign_in() -> AppResult<crate::auth::AuthStatus> {
    crate::auth::begin_sign_in().await
}

/// Clear the stored session (sign out locally). Also drops the local run-history
/// mirror — it may hold history pulled by this user from their OTHER machines, so
/// it must not linger for whoever uses this machine next (privacy on shared
/// machines). Best-effort: a mirror-clear failure never blocks the sign-out.
#[tauri::command]
pub async fn auth_sign_out(state: State<'_, AppState>) -> AppResult<()> {
    crate::auth::sign_out()?;
    let _ = state.db.lock().clear_synced_runs();
    Ok(())
}

/// Abort an in-flight interactive sign-in (the loopback returns ~immediately).
#[tauri::command]
pub async fn auth_cancel_sign_in() -> AppResult<()> {
    crate::auth::cancel_sign_in();
    Ok(())
}

/// Current sign-in status (signed in + identity, or signed out). Refreshes the
/// token silently if it has expired.
#[tauri::command]
pub async fn auth_status() -> AppResult<crate::auth::AuthStatus> {
    Ok(crate::auth::status().await)
}

/// Re-fetch identity from Clerk (incl. the plan in public_metadata), refreshing
/// the token if needed. Used to pick up a plan change after the user subscribes.
#[tauri::command]
pub async fn auth_refresh() -> AppResult<crate::auth::AuthStatus> {
    crate::auth::refresh_identity().await
}

/// Force a token refresh and return the current plan. Called right after the user
/// returns from checkout so a freshly-minted access token reflects the new plan —
/// lets Pro appear without a manual sign-out / sign-in.
#[tauri::command]
pub async fn auth_sync_plan() -> AppResult<Option<String>> {
    crate::auth::sync_plan().await
}

/// URL of Clerk's hosted account portal (sign-up / profile / MFA). The frontend
/// opens it in the browser via `open_file_in_system`.
#[tauri::command]
pub async fn auth_account_portal_url() -> AppResult<String> {
    Ok(crate::auth::account_portal_url())
}

/// Dodo checkout link for the signed-in user to subscribe to Pro. Opened in the
/// browser; carries the user's email + Clerk id so the webhook maps it back.
#[tauri::command]
pub async fn billing_checkout_url() -> AppResult<String> {
    crate::billing::checkout_url_for_current_user()
}

#[tauri::command]
pub async fn resolve_checkpoint(
    orch: State<'_, Arc<Orchestrator>>,
    run_id: String,
    action: String,
    feedback: Option<String>,
    model_override: Option<String>,
    max_turns_override: Option<i64>,
) -> AppResult<()> {
    let action = match action.as_str() {
        "approve" => CheckpointAction::Approve,
        "edit" => CheckpointAction::Edit,
        "abort" => CheckpointAction::Abort,
        "reject" => CheckpointAction::Reject { feedback, model_override, max_turns_override },
        "resume" => CheckpointAction::Resume { max_turns_override },
        "send_back" => CheckpointAction::SendBack { feedback },
        "discard" => CheckpointAction::Discard,
        other => return Err(crate::error::AppError::Other(format!("unknown action: {other}"))),
    };
    dispatch_checkpoint(&orch, run_id, None, action)
}

/// Resolve a checkpoint decision and resume the drive, choosing the detached
/// (Pro) or in-process path. Shared by `resolve_checkpoint` and
/// `answer_blocker` so the escape valve reuses the exact resume substrate.
/// `stage_id` scopes which parked/failed stage the action targets — the escape
/// valve passes its validated id; the plain checkpoint path passes `None`.
fn dispatch_checkpoint(
    orch: &Arc<Orchestrator>,
    run_id: String,
    stage_id: Option<String>,
    action: CheckpointAction,
) -> AppResult<()> {
    // Pro (`runs.detached`): apply the decision's mutations here — they're
    // synchronous and cheap — then hand the re-drive to a detached worker.
    // Guard rejections ("run is already executing") surface immediately
    // instead of via run://error, which is strictly better feedback.
    if crate::entitlement::Entitlement::current()
        .has_feature(crate::entitlement::feature::RUNS_DETACHED)
    {
        if let Some(budget_override) =
            orch.resolve_checkpoint_apply_only(&run_id, stage_id.as_deref(), action)?
        {
            if let Err(e) = orch.spawn_detached_segment(&run_id, budget_override) {
                tracing::warn!(run_id = %run_id, error = %e, "detached spawn failed — driving in-process");
                Arc::clone(orch).spawn_drive(run_id, budget_override);
            }
        }
        return Ok(());
    }
    // Drive in the background; the frontend reacts to run:// events.
    Arc::clone(orch).spawn_resolve_checkpoint(run_id, stage_id, action);
    Ok(())
}

/// Answer a stage that parked itself via the `ask_director` escape valve. The
/// `answers` are positional — one per question the stage asked (a missing or
/// empty entry falls back to that question's recommended default; extras are
/// ignored, so the frontend's "Accept all defaults" just sends the defaults).
/// The decisions become the stage's re-run feedback and the stage re-runs with
/// them injected — reusing the checkpoint resume substrate wholesale.
#[tauri::command]
pub async fn answer_blocker(
    state: State<'_, AppState>,
    orch: State<'_, Arc<Orchestrator>>,
    run_id: String,
    stage_id: String,
    answers: Vec<String>,
) -> AppResult<()> {
    // `stage_id` scopes the answer to the intended block (defensive: only one
    // stage is ever awaiting a decision at a time, but the frontend passes it
    // and a stale click must not answer a different stage). Reject clearly if
    // the stage is not actually blocked awaiting the director.
    let is_blocked = state.db.lock().list_run_stages(&run_id)?.into_iter().any(|s| {
        s.id == stage_id && s.status == "awaiting_checkpoint" && s.blocked_questions.is_some()
    });
    if !is_blocked {
        return Err(crate::error::AppError::Other(
            "this stage is not awaiting a director decision".into(),
        ));
    }
    // Thread the validated `stage_id` through so the resolution acts on exactly
    // the stage we just checked, not merely "the parked stage".
    dispatch_checkpoint(&orch, run_id, Some(stage_id), CheckpointAction::AnswerBlocker { answers })
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
    state: State<'_, AppState>,
    orch: State<'_, Arc<Orchestrator>>,
    run_id: String,
) -> AppResult<()> {
    // In-process flag first (harmless no-op for a detached run), then the
    // cross-process request — the worker's control poll picks it up within
    // ~1s and flips its own cancel flag.
    orch.stop_current_stage(&run_id)?;
    if state.db.lock().worker_lease_fresh(&run_id)? {
        state.db.lock().set_stop_requested(&run_id, true)?;
    }
    Ok(())
}

/// Ask a running run to pause at its next stage boundary. The next pending stage
/// is parked awaiting the director; approving it resumes the run. Safe no-op if
/// the run isn't currently driving.
#[tauri::command]
pub async fn request_run_pause(
    state: State<'_, AppState>,
    orch: State<'_, Arc<Orchestrator>>,
    run_id: String,
) -> AppResult<()> {
    orch.request_pause(&run_id);
    // Detached: mirror the request cross-process, and remember it was the
    // director's own hand so the bridge's checkpoint stays silent (reason
    // "director", exactly like the in-process pause_for_director).
    if state.db.lock().worker_lease_fresh(&run_id)? {
        state.db.lock().set_pause_requested(&run_id, true)?;
        orch.note_director_pause(&run_id);
    }
    Ok(())
}

/// Hot-edit a pending, not-yet-started run stage: gate, instructions, model,
/// max turns, and (for a looping review stage) loop mode. `None` for any
/// field leaves it unchanged. Only the run's own `run_stages` row is written
/// — the pipeline template is never touched. Rejects synchronously (a clear
/// English error) if the run has finished or the stage has already started.
#[tauri::command]
pub async fn update_run_stage(
    state: State<'_, AppState>,
    run_id: String,
    stage_id: String,
    checkpoint: Option<bool>,
    instructions: Option<String>,
    agent_model: Option<String>,
    max_iterations: Option<i64>,
    loop_mode: Option<String>,
) -> AppResult<()> {
    state.db.lock().update_run_stage(
        &run_id,
        &stage_id,
        checkpoint,
        instructions.as_deref(),
        agent_model.as_deref(),
        max_iterations,
        loop_mode.as_deref(),
    )
}

/// Re-run a finished (done/failed) stage and everything downstream of it, in
/// place: same pipeline row, same run. Validates + resets synchronously (a
/// guard rejection — e.g. the stage hasn't finished, or the run is currently
/// driving — surfaces immediately), then resumes the drive in the background;
/// the frontend follows progress via the existing `run://` events.
///
/// The optional patch fields let the director re-run *after changes* — the
/// edit is validated before anything resets and applied before the drive
/// resumes, atomically under the run's exclusion claim.
#[tauri::command]
pub async fn rerun_from_stage(
    orch: State<'_, Arc<Orchestrator>>,
    run_id: String,
    stage_id: String,
    checkpoint: Option<bool>,
    instructions: Option<String>,
    agent_model: Option<String>,
    max_iterations: Option<i64>,
    loop_mode: Option<String>,
) -> AppResult<()> {
    // An all-None patch is a plain "re-run as-is": validation passes
    // vacuously and the applier is a per-field no-op, so no emptiness
    // special-case is needed.
    let patch = crate::orchestrator::types::StageRerunPatch {
        checkpoint,
        instructions,
        agent_model,
        max_iterations,
        loop_mode,
    };
    orch.prepare_rerun(&run_id, &stage_id, Some(&patch))?;
    // Pro (`runs.detached`): the reset is done — hand the resumed drive to a
    // detached worker. The in-process claim `prepare_rerun` kept is released
    // first; the worker's lease takes over as the cross-process claim.
    if crate::entitlement::Entitlement::current()
        .has_feature(crate::entitlement::feature::RUNS_DETACHED)
    {
        orch.release_active(&run_id);
        if let Err(e) = orch.spawn_detached_segment(&run_id, false) {
            tracing::warn!(run_id = %run_id, error = %e, "detached spawn failed — driving in-process");
            Arc::clone(&*orch).spawn_drive(run_id, false);
        }
        return Ok(());
    }
    Arc::clone(&*orch).resume_claimed_drive(run_id);
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
    let overrides = stage_overrides.unwrap_or_default();
    let db = state.db.lock();
    let stages = db.get_pipeline_stages(&pipeline_id)?;
    let reference = crate::orchestrator::cost::pick_reference_model();
    let mut cost = 0.0;
    let mut baseline = 0.0;
    for s in &stages {
        // Token estimates come from the role's definition in the DB; fall back to
        // (4000, 1000) when the role is absent (custom/deleted roles).
        let (tok_in, tok_out) = db
            .get_role(&s.role)?
            .map(|r| (r.token_est_in as u64, r.token_est_out as u64))
            .unwrap_or((4_000, 1_000));
        let model = overrides
            .iter()
            .find(|(pos, _)| *pos == s.position)
            .map(|(_, m)| m.as_str())
            .unwrap_or(s.agent_model.as_str());
        cost += crate::orchestrator::cost::stage_cost(model, tok_in, tok_out, 0, 0);
        if let Some(ref_model) = &reference {
            baseline += crate::orchestrator::cost::baseline_cost(ref_model, tok_in, tok_out);
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
    // Logbook: resolve the terminal's workspace once, then beat coalesced PTY
    // activity from the output hook — throttled to ≤1 write/min per terminal
    // (record_activity coalesces into one span, so a beat a minute keeps a live
    // terminal's span growing while output flows, with negligible cost during
    // heavy output; the span closes on its own after the idle window).
    let ws_for_activity = state.db.lock().workspace_for_terminal(&id).ok().flatten();
    let db_for_activity = std::sync::Arc::clone(&state.db);
    let last_beat = std::sync::Arc::new(std::sync::atomic::AtomicI64::new(0));
    let scanner_hook: crate::pty_manager::OutputHook = Box::new(move |sid, seq, bytes| {
        let engine =
            crate::token_engine::TokenEngine::new(std::sync::Arc::clone(&db_for_hook));
        engine.scan_and_record(sid, seq, bytes);
        if let Some(ws) = &ws_for_activity {
            let now = chrono::Utc::now().timestamp();
            let prev = last_beat.load(std::sync::atomic::Ordering::Relaxed);
            if now - prev >= 60 {
                last_beat.store(now, std::sync::atomic::Ordering::Relaxed);
                let _ = db_for_activity.lock().record_activity(ws, "terminal", "pty");
            }
        }
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
            "#!/bin/sh\ncase \"$1\" in\n  *[Uu]sername*) printf '%%s' \"$OCTOPUSH_GIT_USERNAME\" ;;\n  *[Pp]assword*) printf '%%s' \"$OCTOPUSH_GIT_TOKEN\" ;;\nesac\n"
        );

        let mut tmp = tempfile::Builder::new()
            .prefix("octopush-askpass-")
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
        env_overrides.push(("OCTOPUSH_GIT_USERNAME".into(), creds.username.clone()));
        env_overrides.push(("OCTOPUSH_GIT_TOKEN".into(), creds.token.clone()));
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
        ensure_main_workspace(&db, &id, &path_str, None)?;
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
pub async fn save_providers(
    state: State<'_, AppState>,
    providers: Vec<crate::provider_router::ProviderConfig>,
) -> AppResult<()> {
    crate::provider_router::validate_providers(&providers)
        .map_err(crate::error::AppError::Other)?;
    crate::provider_router::write_providers(&providers)?;
    // Reload the in-memory router so `list_providers`/`list_models` reflect the
    // write immediately (else a just-enabled provider stays invisible until an
    // app restart — which strands genesis's inline-key readiness check).
    let updated = crate::provider_router::ProviderRouter::load()?;
    *state.router.lock() = updated;
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
    let stdout = run_gh_in(&path, "gh pr list --json number,title,headRefName,author --limit 30").await?;
    crate::github::pr_infos_from_json(&stdout)
        .map_err(|e| AppError::Other(format!("GitHub CLI returned unexpected output: {e}")))
}

/// Run a `gh …` invocation in the user's login shell (PATH + keychain behave
/// like a terminal) and return stdout, mapping any failure to a friendly
/// "GitHub CLI not available" error with a short stderr snippet. Shared by
/// `list_prs`-style callers so the spawn/status/snippet block lives once.
async fn run_gh_in(path: &str, gh_cmd: &str) -> AppResult<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into());
    let output = tokio::process::Command::new(&shell)
        .arg("-l").arg("-c")
        .arg(gh_cmd)
        .current_dir(path)
        .output()
        .await
        .map_err(|e| AppError::Other(format!("GitHub CLI not available: {e}")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let snippet: String = stderr.trim().chars().take(200).collect();
        return Err(AppError::Other(format!("GitHub CLI not available: {snippet}")));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// True when `host` is GitHub-the-service, incl. the documented SSH-over-HTTPS
/// firewall fallback (`ssh.github.com`, with or without an explicit port).
fn is_github_host(host: &str) -> bool {
    let host = host.split(':').next().unwrap_or(host);
    host == "github.com" || host == "ssh.github.com"
}

/// Open GitHub issues for the project — the "Ship it" picker's source. Any
/// failure maps to a friendly error the picker renders as an honest state.
#[tauri::command]
pub async fn list_github_issues(path: String) -> AppResult<Vec<crate::github::GhIssue>> {
    let path = expand_tilde(&path);
    let stdout = run_gh_in(&path, "gh issue list --state open --json number,title,body,url --limit 30").await?;
    crate::github::issues_from_json(&stdout)
        .map_err(|e| AppError::Other(format!("GitHub CLI returned unexpected output: {e}")))
}

/// Preflight for "Ship it": the crew's `pull_request` stage needs BOTH a
/// GitHub remote and a `gh` authenticated FOR GITHUB.COM — discovering that
/// mid-run, after the crew already built the change, is the failure mode this
/// check exists to prevent. ANY remote pointing at GitHub counts (not just
/// "origin" — `gh` resolves the repo itself), incl. the ssh.github.com:443
/// fallback. The auth probe is skipped when there's no GitHub remote (the
/// picker dead-ends on that first), and is host-scoped so an unrelated broken
/// GHE login can't fail it — nor a GHE-only login pass it.
#[tauri::command]
pub async fn github_ship_readiness(path: String) -> AppResult<crate::github::ShipReadiness> {
    let path = expand_tilde(&path);
    let github_remote = (|| -> Option<bool> {
        let repo = git2::Repository::discover(&path).ok()?;
        let names = repo.remotes().ok()?;
        for name in names.iter().flatten() {
            if let Ok(remote) = repo.find_remote(name) {
                if let Some(url) = remote.url() {
                    if let Some(parsed) = crate::git_url::parse_git_url(url) {
                        if is_github_host(&parsed.host) {
                            return Some(true);
                        }
                    }
                }
            }
        }
        Some(false)
    })()
    .unwrap_or(false);

    let gh_authenticated = if github_remote {
        run_gh_in(&path, "gh auth status --hostname github.com").await.is_ok()
    } else {
        false // moot — the picker dead-ends on the missing remote
    };

    Ok(crate::github::ShipReadiness { github_remote, gh_authenticated })
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
        // AI-command calls (structured/prose one-shots) don't request thinking.
        effort: None,
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
    // Phase 3 — backend budget enforcement. AI review / conflict / commit-draft
    // go through this primitive and were previously ungated; block the spend up
    // front when a configured budget is already at/over its limit.
    if let crate::db::BudgetVerdict::Block { scope, spent, limit } =
        state.db.lock().check_budget(workspace_id.as_deref())?
    {
        return Err(AppError::BudgetExceeded { scope, spent, limit });
    }
    let (provider, api_base, api_key) = crate::chat_engine::resolve_provider(&model)?;
    let req = build_ai_request(&model, system, prompt, max_tokens.unwrap_or(8192), json_schema);
    let client = crate::chat_engine::shared_http_client();
    let resp = provider.complete(&api_base, api_key.as_deref(), &req, client).await?;
    ensure_not_truncated(&resp.stop_reason)?;
    // Same pricing authority `record` uses, so the cost we return to the UI is
    // exactly the one persisted to the ledger (no hardcoded-vs-router drift).
    let cost = crate::token_engine::cost_for(
        &model,
        resp.input_tokens,
        resp.output_tokens,
        resp.cache_read_tokens,
        resp.cache_creation_tokens,
    );
    if resp.input_tokens > 0 || resp.output_tokens > 0 {
        // AI review / conflict / commit-draft go through this primitive. With a
        // workspace it's REVIEW-surface spend; without one it's the adhoc bucket.
        let surface = if workspace_id.is_some() { "review" } else { "adhoc" };
        // Best-effort: a recording failure must not fail the AI call itself.
        if let Err(e) = state.tokens.record(ai_token_event(workspace_id.as_deref(), &model, &resp, cost), surface) {
            tracing::warn!(error = %e, "failed to record ai_complete token event");
        }
        // Logbook: AI review on a workspace is review work on its mission.
        if let Some(ws) = workspace_id.as_deref() {
            let _ = state.db.lock().record_activity(ws, "review", "ai");
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

// ─── Role commands ────────────────────────────────────────────────

#[tauri::command]
pub async fn list_roles(state: State<'_, AppState>) -> AppResult<Vec<crate::orchestrator::roles::RoleDef>> {
    state.db.lock().list_roles()
}

#[tauri::command]
pub async fn save_role(state: State<'_, AppState>, role: crate::orchestrator::roles::RoleDef) -> AppResult<crate::orchestrator::roles::RoleDef> {
    let mut role = role;
    role.is_builtin = false; // user-saved roles are never built-in
    if role.key.trim().is_empty() { return Err(crate::error::AppError::Other("role key required".into())); }
    if role.prompt_body.trim().is_empty() { return Err(crate::error::AppError::Other("role prompt cannot be empty".into())); }
    let db = state.db.lock();
    if let Some(existing) = db.get_role(&role.key)? {
        if existing.is_builtin {
            return Err(crate::error::AppError::Other(format!(
                "the name '{}' maps to a built-in role key ('{}'); choose a different name",
                role.label, role.key
            )));
        }
    }
    db.upsert_role(&role)?;
    // Best-effort from here: the save already COMMITTED.
    let sync_item = db
        .role_sync_state(&role.key)
        .ok()
        .flatten()
        .map(|(updated_at, _)| crate::sync::SyncLibraryItem::role(&role, &updated_at));
    drop(db);
    // Library sync (Pro): the edited role follows the user. Best-effort.
    if crate::entitlement::Entitlement::current()
        .has_feature(crate::entitlement::feature::LIBRARY_SYNC)
    {
        if let Some(item) = sync_item {
            tokio::spawn(async move {
                let client = crate::chat_engine::shared_http_client();
                crate::sync::push_library_items(client, vec![item]).await;
            });
        }
    }
    Ok(role)
}

#[tauri::command]
pub async fn delete_role(state: State<'_, AppState>, key: String) -> AppResult<()> {
    let db = state.db.lock();
    if let Some(existing) = db.get_role(&key)? {
        if existing.is_builtin {
            return Err(crate::error::AppError::Other(format!("cannot delete the built-in role '{key}'")));
        }
    }
    if db.role_in_use(&key)? { return Err(crate::error::AppError::Other(format!("role '{key}' is used by a pipeline"))); }
    db.delete_role(&key)?;
    drop(db);
    if crate::entitlement::Entitlement::current()
        .has_feature(crate::entitlement::feature::LIBRARY_SYNC)
    {
        let item = crate::sync::SyncLibraryItem::tombstone("role", &key);
        tokio::spawn(async move {
            let client = crate::chat_engine::shared_http_client();
            crate::sync::push_library_items(client, vec![item]).await;
        });
    }
    Ok(())
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
            raw_content: vec![],
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
            raw_content: vec![],
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
