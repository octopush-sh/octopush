//! Octopus sh — native core.
//!
//! Phase 1 scope: embedded PTY sessions, SQLite persistence, and the IPC
//! surface the React frontend needs to open/read/write/resize/kill them.
//! Token tracking, provider routing and multi-agent orchestration live in
//! later phases and are intentionally not wired up yet.

mod commands;
mod db;
mod error;
mod pty_manager;
mod session;
mod state;

use state::AppState;
use tracing_subscriber::EnvFilter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Structured logging — RUST_LOG=debug for verbose, defaults to info.
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .try_init();

    let app_state = AppState::init().expect("failed to initialize app state");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            commands::create_session,
            commands::list_sessions,
            commands::write_to_session,
            commands::write_text_to_session,
            commands::resize_session,
            commands::kill_session,
            commands::delete_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
