//! Discovery and one-click registration of the bundled `octopush-mcp` server
//! with MCP clients (Claude Code today).
//!
//! The binary ships as a Tauri sidecar, so at runtime it sits next to the app
//! executable — we resolve it the same way `pty_daemon::resolve_daemon_binary`
//! resolves the PTY server. Registration shells out to the Claude Code CLI
//! (`claude mcp add`). Because a macOS GUI app does not inherit the user's
//! shell `PATH`, we also probe the well-known install locations, and always
//! hand back a copy-pasteable `manualCommand` so the user can self-serve when
//! the CLI can't be found.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use crate::error::{AppError, AppResult};

const MCP_BIN: &str = "octopush-mcp";
/// The MCP server name registered with the client. Tools then surface as
/// `mcp__octopush__<tool>`.
pub(crate) const SERVER_NAME: &str = "octopush";

/// Locate the bundled `octopush-mcp` binary. Mirrors the PTY daemon's resolver:
/// sibling-of-exe first (production `.app` and `cargo run`), then `$PATH`, then
/// the dev `target/{debug,release}` trees.
pub fn resolve_mcp_binary() -> AppResult<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let candidate = parent.join(MCP_BIN);
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }

    if let Ok(path_var) = std::env::var("PATH") {
        for dir in path_var.split(':') {
            let candidate = PathBuf::from(dir).join(MCP_BIN);
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }

    for relative in &[
        "target/release/octopush-mcp",
        "target/debug/octopush-mcp",
        "src-tauri/target/release/octopush-mcp",
        "src-tauri/target/debug/octopush-mcp",
    ] {
        if let Ok(cwd) = std::env::current_dir() {
            let candidate = cwd.join(relative);
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }

    Err(AppError::Other(
        "octopush-mcp binary not found next to the app or in $PATH".into(),
    ))
}

/// Find the Claude Code CLI. Checks `$PATH` first, then the locations the
/// official installers use — GUI apps launched from Finder don't see the shell
/// `PATH`, so the absolute probes are what make this work in a packaged build.
pub fn resolve_claude_cli() -> Option<PathBuf> {
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in path_var.split(':') {
            let candidate = PathBuf::from(dir).join("claude");
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    let mut candidates = vec![
        PathBuf::from("/opt/homebrew/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
        PathBuf::from("/usr/bin/claude"),
    ];
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".claude/local/claude"));
        candidates.push(home.join(".local/bin/claude"));
        candidates.push(home.join(".bun/bin/claude"));
        candidates.push(home.join(".npm-global/bin/claude"));
    }
    candidates.into_iter().find(|p| p.exists())
}

/// The argv (after `claude`) that registers the bundled server at user scope:
/// `mcp add octopush -s user -- <binary>`. One source for the one-click
/// connect and the contract test against Claude Code's recorded `mcp add`.
pub(crate) fn mcp_add_args(binary: &Path) -> Vec<std::ffi::OsString> {
    let mut args: Vec<std::ffi::OsString> =
        ["mcp", "add", SERVER_NAME, "-s", "user", "--"].iter().map(Into::into).collect();
    args.push(binary.as_os_str().to_owned());
    args
}

/// The argv (after `claude`) that removes a user-scope registration.
pub(crate) const MCP_REMOVE_ARGS: [&str; 5] = ["mcp", "remove", SERVER_NAME, "-s", "user"];

/// The terminal command a user can run to register the server by hand.
pub(crate) fn manual_command(binary_path: Option<&str>) -> String {
    let path = binary_path.unwrap_or("/path/to/octopush-mcp");
    format!("claude mcp add {SERVER_NAME} -s user -- \"{path}\"")
}

/// Whether Claude Code already has the `octopush` server registered.
fn is_registered(claude: &Path) -> bool {
    Command::new(claude)
        .args(["mcp", "get", SERVER_NAME])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Snapshot of the integration's state, for rendering the settings card.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    /// Resolved absolute path to the bundled binary, if found.
    pub binary_path: Option<String>,
    pub binary_found: bool,
    pub claude_found: bool,
    /// True when `claude mcp get octopush` succeeds.
    pub registered: bool,
    /// Copy-pasteable manual registration command.
    pub manual_command: String,
}

pub fn status() -> McpStatus {
    let binary = resolve_mcp_binary().ok();
    let binary_path = binary.as_ref().map(|p| p.display().to_string());
    let claude = resolve_claude_cli();
    let registered = claude.as_deref().map(is_registered).unwrap_or(false);
    McpStatus {
        binary_found: binary.is_some(),
        claude_found: claude.is_some(),
        registered,
        manual_command: manual_command(binary_path.as_deref()),
        binary_path,
    }
}

/// Result of attempting a one-click connect.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct McpConnectResult {
    pub ok: bool,
    pub registered: bool,
    /// Human-readable outcome to surface in the UI.
    pub message: String,
    pub manual_command: String,
    pub binary_path: Option<String>,
}

/// Register the bundled server with Claude Code at user scope. Idempotent:
/// removes any existing `octopush` entry first so re-running always converges
/// on the bundled binary's current path (important across app upgrades).
pub fn connect() -> McpConnectResult {
    let binary = match resolve_mcp_binary() {
        Ok(b) => b,
        Err(e) => {
            return McpConnectResult {
                ok: false,
                registered: false,
                message: format!("Could not locate the octopush-mcp binary: {e}"),
                manual_command: manual_command(None),
                binary_path: None,
            };
        }
    };
    let binary_path = binary.display().to_string();

    let Some(claude) = resolve_claude_cli() else {
        return McpConnectResult {
            ok: false,
            registered: false,
            message: "Claude Code CLI not found on this machine. Run the command below in your terminal instead.".into(),
            manual_command: manual_command(Some(&binary_path)),
            binary_path: Some(binary_path),
        };
    };

    // Remove-then-add makes the operation idempotent; ignore remove failures
    // (it simply may not exist yet).
    let _ = Command::new(&claude)
        .args(MCP_REMOVE_ARGS)
        .output();

    let out = Command::new(&claude)
        .args(mcp_add_args(&binary))
        .output();

    match out {
        Ok(o) if o.status.success() => McpConnectResult {
            ok: true,
            registered: true,
            message: "Connected to Claude Code. Start a new Claude Code session to load the Octopush tools.".into(),
            manual_command: manual_command(Some(&binary_path)),
            binary_path: Some(binary_path),
        },
        Ok(o) => {
            let detail = String::from_utf8_lossy(&o.stderr);
            let detail = detail.trim();
            McpConnectResult {
                ok: false,
                registered: false,
                message: if detail.is_empty() {
                    "Claude Code rejected the registration. Try the manual command below.".into()
                } else {
                    format!("Claude Code error: {detail}")
                },
                manual_command: manual_command(Some(&binary_path)),
                binary_path: Some(binary_path),
            }
        }
        Err(e) => McpConnectResult {
            ok: false,
            registered: false,
            message: format!("Could not run the Claude Code CLI: {e}"),
            manual_command: manual_command(Some(&binary_path)),
            binary_path: Some(binary_path),
        },
    }
}
