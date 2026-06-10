//! Octopush — native core.

pub mod agent_adapter;
pub mod chat_engine;
mod commands;
pub mod context_guard;
mod db;
mod error;
pub mod git_ops;
pub mod git_url;
pub mod provider_router;
pub mod providers;
pub mod pty_client;
pub mod pty_daemon;
mod pty_manager;
mod session;
pub mod session_recap;
pub mod settings;
mod state;
pub mod template;
pub mod theme;
pub mod token_engine;
pub mod perf;
pub mod issue_tracker;
pub mod github;
pub mod orchestrator;
pub mod git_lock;

#[cfg(test)]
mod tests;

use state::AppState;
use tauri::Manager;
use tracing_subscriber::EnvFilter;

/// One-time idempotent migration: moves data from the old `octopus-sh`
/// directories to the new `octopush` directories so existing users don't
/// lose their settings, providers, themes, or database.
fn migrate_legacy_data_dir() {
    // 1) Home config dir: ~/.octopus-sh → ~/.octopush
    if let Some(home) = dirs::home_dir() {
        let old = home.join(".octopus-sh");
        let new = home.join(".octopush");
        if old.exists() && !new.exists() {
            if let Err(e) = std::fs::rename(&old, &new) {
                tracing::warn!(error = %e, "failed to migrate ~/.octopus-sh -> ~/.octopush");
            } else {
                tracing::info!("migrated ~/.octopus-sh -> ~/.octopush");
            }
        }
    }
    // 2) Application Support dir: octopus-sh → octopush
    if let Some(data) = dirs::data_dir() {
        let old = data.join("octopus-sh");
        let new = data.join("octopush");
        if old.exists() && !new.exists() {
            if let Err(e) = std::fs::rename(&old, &new) {
                tracing::warn!(error = %e, "failed to migrate Application Support/octopus-sh -> octopush");
            } else {
                tracing::info!("migrated Application Support/octopus-sh -> octopush");
            }
        }
        // 3) DB file inside the data dir: octopus.db → octopush.db
        let old_db = data.join("octopush").join("octopus.db");
        let new_db = data.join("octopush").join("octopush.db");
        if old_db.exists() && !new_db.exists() {
            if let Err(e) = std::fs::rename(&old_db, &new_db) {
                tracing::warn!(error = %e, "failed to rename octopus.db -> octopush.db");
            } else {
                tracing::info!("renamed octopus.db -> octopush.db");
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .try_init();

    migrate_legacy_data_dir();

    // Ensure the PTY daemon is running.  Failure is non-fatal — the app starts
    // in degraded mode (no terminals) rather than refusing to launch.
    let daemon_client = match pty_daemon::ensure_daemon_running()
        .and_then(|sock_path| {
            pty_client::DaemonClient::connect_to(sock_path.to_str().unwrap_or(""))
        }) {
        Ok(client) => {
            tracing::info!("PTY daemon connected");
            Some(client)
        }
        Err(e) => {
            tracing::warn!(error = %e, "PTY daemon unavailable — terminal features disabled");
            None
        }
    };

    let app_state = AppState::init(daemon_client).expect("failed to initialize app state");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(app_state)
        .manage(perf::PerfState::new())
        .invoke_handler(tauri::generate_handler![
            // Sessions
            commands::create_session,
            commands::list_sessions,
            commands::write_to_session,
            commands::write_text_to_session,
            commands::resize_session,
            commands::kill_session,
            commands::delete_session,
            // Tokens
            commands::get_token_report,
            commands::record_token_event,
            commands::get_budget_status,
            commands::set_token_budget,
            // Templates
            commands::list_templates,
            commands::save_template,
            commands::delete_template,
            // Providers / Agents
            commands::list_providers,
            commands::list_models,
            commands::suggest_model,
            commands::list_adapters,
            commands::switch_agent,
            // Recap / Export
            commands::get_session_recap,
            commands::export_session_json,
            commands::export_session_csv,
            // Theme
            commands::get_theme,
            commands::set_theme,
            commands::list_themes,
            // Projects
            commands::open_project,
            commands::list_recent_projects,
            commands::create_project,
            commands::update_project_customization,
            commands::set_project_pinned,
            commands::set_project_order,
            commands::close_project,
            commands::list_closed_projects,
            commands::reopen_project,
            commands::delete_project,
            // Workspaces
            commands::create_workspace,
            commands::list_workspaces,
            commands::delete_workspace,
            commands::archive_workspace,
            commands::list_archived_workspaces,
            commands::restore_workspace,
            commands::update_workspace_customization,
            commands::rename_workspace,
            commands::update_workspace_link,
            commands::update_project_jira_key,
            commands::get_git_status,
            commands::workspaces_git_summary,
            commands::get_git_diff,
            // Chat
            commands::send_chat_message,
            commands::list_chat_messages,
            // Direct mode (orchestration)
            commands::list_pipelines,
            commands::get_pipeline,
            commands::save_pipeline,
            commands::delete_pipeline,
            commands::create_run,
            commands::start_run,
            commands::get_run,
            commands::list_runs,
            commands::resolve_checkpoint,
            commands::abort_run,
            commands::estimate_run_cost,
            commands::get_stage_log,
            // File operations
            commands::open_file_in_system,
            commands::reveal_in_finder,
            commands::open_in_terminal,
            commands::open_in_editor,
            commands::detect_editors,
            // Clone
            commands::clone_project,
            // Budgets
            commands::list_budgets,
            commands::set_budget,
            commands::clear_budget,
            commands::current_spend,
            commands::export_token_events_csv,
            // Usage breakdown
            commands::get_usage_breakdown,
            // Pricing refresh
            commands::refresh_pricing,
            // Settings
            commands::get_settings,
            commands::save_settings,
            commands::save_git_credentials,
            // Provider catalog
            commands::save_providers,
            commands::get_default_providers,
            // Terminals
            commands::list_terminals,
            commands::create_terminal,
            commands::rename_terminal,
            commands::delete_terminal,
            // PTY daemon
            commands::list_pty_sessions,
            commands::spawn_or_attach_terminal,
            // Performance monitor
            commands::get_perf_stats,
            commands::get_workspace_cache_sizes,
            // Directory listing
            commands::read_directory,
            // File I/O
            commands::read_file,
            commands::read_file_checked,
            commands::write_file,
            // File edits (Review canvas)
            commands::list_file_edits,
            commands::get_message,
            // Hunk operations
            commands::revert_hunk,
            commands::apply_hunk,
            commands::stage_hunk,
            commands::stage_all_changes,
            // Stage / commit / push flow
            commands::stage_file,
            commands::unstage_file,
            commands::unstage_all_changes,
            commands::commit_changes,
            commands::get_staged_diff,
            commands::get_last_commit,
            commands::amend_commit,
            commands::discard_file,
            commands::push_branch,
            commands::fetch_changes,
            commands::pull,
            commands::find_pr_for_branch,
            commands::open_prs_for_project,
            // Workspace-wide file & text search
            commands::list_workspace_files,
            commands::search_workspace_text,
            // Test runner
            commands::run_test_command,
            commands::set_workspace_test_command,
            commands::detect_default_test_command,
            // Issue tracker
            commands::list_my_issues,
            commands::get_issue,
            commands::list_issues_in_epic,
            commands::get_issue_tracker_config,
            commands::save_issue_tracker_config,
            // AI primitive (G5)
            commands::ai_complete,
        ])
        .setup(|app| {
            // Restore sessions that were active when the app last closed.
            let state = app.state::<AppState>();
            restore_active_sessions(app.handle().clone(), &state);

            // Direct-mode orchestrator: seed builtin pipelines + register engine.
            {
                let st = app.state::<AppState>();
                if let Err(e) = st.db.lock().seed_builtin_pipelines() {
                    tracing::error!(error = %e, "failed to seed builtin pipelines");
                }
                let sink = std::sync::Arc::new(orchestrator::events::TauriEventSink {
                    app: app.handle().clone(),
                });
                let orch = std::sync::Arc::new(orchestrator::Orchestrator::new(
                    std::sync::Arc::clone(&st.db),
                    sink,
                ));
                app.manage(orch);
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Re-spawn PTYs for sessions that were `active` or `idle` on last shutdown.
fn restore_active_sessions(app: tauri::AppHandle, state: &AppState) {
    let sessions = match state.db.lock().list_sessions() {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(error = %e, "failed to load sessions for restore");
            return;
        }
    };

    for session in sessions {
        use crate::session::SessionStatus;
        if session.status != SessionStatus::Active && session.status != SessionStatus::Idle {
            continue;
        }

        let guard =
            crate::context_guard::ContextGuard::auto_configure(&session.id, std::path::Path::new(&session.project_root));
        let mut env = std::collections::HashMap::new();
        guard.apply_env(&mut env);

        let db_for_hook = std::sync::Arc::clone(&state.db);
        let scanner_hook: crate::pty_manager::OutputHook = Box::new(move |sid, bytes| {
            if let Some(ev) = crate::token_engine::scan_pty_output(sid, bytes) {
                let engine =
                    crate::token_engine::TokenEngine::new(std::sync::Arc::clone(&db_for_hook));
                let _ = engine.record(ev);
            }
        });

        if let Err(e) = state.pty.lock().spawn(
            app.clone(),
            crate::pty_manager::SpawnOptions {
                id: session.id.clone(),
                session_name: session.name.clone(),
                cwd: session.project_root.clone(),
                env,
                rows: 24,
                cols: 80,
                shell: None,
                on_output: Some(scanner_hook),
            },
        ) {
            tracing::warn!(session = %session.name, error = %e, "failed to restore session PTY");
            let _ = state
                .db
                .lock()
                .update_status(&session.id, SessionStatus::Error);
        } else {
            tracing::info!(session = %session.name, "restored session PTY");
        }
    }
}
