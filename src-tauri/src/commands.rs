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
    // Remove from DB
    state.db.lock().delete_workspace(&workspace_id)?;
    Ok(())
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
    state
        .db
        .lock()
        .insert_project(&id, &target_name, &path_str)?;

    Ok(ProjectInfo {
        id,
        name: target_name,
        path: path_str,
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
