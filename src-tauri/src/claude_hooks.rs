//! Run-mode attention from Claude Code's own hooks (#287).
//!
//! In a worktree Octopush created, `.claude/settings.local.json` gets
//! `Notification` and `Stop` hooks (the file shape lives in `agent_adapter`,
//! a fragile surface). Each hook runs `octopush-mcp hook` inside the Run
//! terminal, which queues one `hook_signals` row keyed by the terminal's
//! `OCTOPUSH_TERMINAL_ID`. The app drains that queue once a second and emits
//! `pty://attention` (with a `reason`) or `pty://settled`.
//!
//! Everything is gated on Settings' `claudeHooksEnabled` (off by default) and
//! on a known Claude Code version at or above the tested floor; otherwise the
//! terminal bell/idle heuristic is unchanged. Once a terminal has delivered a
//! hook signal, the daemon's idle heuristic stays quiet for it.

use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::agent_adapter::{self, HookSignal};
use crate::db::{Db, HookSignalRow, WorkspaceRow};

/// Set in every Run terminal's environment; the hook reads it to name the
/// terminal its signal belongs to.
pub const TERMINAL_ENV: &str = "OCTOPUSH_TERMINAL_ID";

/// The `info/exclude` line that keeps our settings file out of git.
pub const EXCLUDE_LINE: &str = "/.claude/settings.local.json";
const EXCLUDE_COMMENT: &str = "# added by Octopush (Claude Code hooks)";

const POLL_EVERY: Duration = Duration::from_secs(1);
/// Hook payloads are a few hundred bytes; anything past this isn't one.
pub const MAX_PAYLOAD: u64 = 1 << 20;

fn hooks_enabled() -> bool {
    crate::settings::load_settings().ok().and_then(|s| s.claude_hooks_enabled) == Some(true)
}

/// The worktree to install into, only when Octopush made it: a managed
/// workspace directly under `.octopus-worktrees/`. Never the main checkout or
/// an adopted one.
fn octopush_worktree(db: &Mutex<Db>, workspace_id: &str, worktree_path: Option<&str>) -> Option<PathBuf> {
    let wt = PathBuf::from(worktree_path?);
    let in_worktrees = wt.parent().and_then(Path::file_name).is_some_and(|n| n == ".octopus-worktrees");
    let managed = db.lock().is_workspace_managed(workspace_id).unwrap_or(false);
    (in_worktrees && managed && wt.is_dir()).then_some(wt)
}

/// Install the hooks for `ws` when everything allows it; `true` when they are
/// in place. Probes the CLI version (cached), so call it off the UI path.
pub fn install_for_workspace(db: &Mutex<Db>, ws: &WorkspaceRow, hook_bin: &Path) -> bool {
    let Some(wt) = octopush_worktree(db, &ws.id, ws.worktree_path.as_deref()) else { return false };
    if !hooks_enabled() || !agent_adapter::claude_cli_version().supports_hooks() {
        return false;
    }
    // Without the exclude the file would show in Review and in crew commits.
    if let Err(e) = ensure_local_settings_excluded(&wt) {
        tracing::warn!(workspace = %ws.id, error = %e, "info/exclude not writable; Claude Code hooks skipped");
        return false;
    }
    match agent_adapter::install_claude_hooks(&wt, hook_bin) {
        Ok(installed) => installed,
        Err(e) => {
            tracing::warn!(workspace = %ws.id, error = %e, "Claude Code hooks not installed");
            false
        }
    }
}

/// Remove our hooks before an archive/delete removes the worktree. Only ever
/// touches a worktree Octopush made; the toggle doesn't matter here.
pub fn remove_for_workspace(db: &Mutex<Db>, workspace_id: &str, worktree_path: Option<&str>) {
    if let Some(wt) = octopush_worktree(db, workspace_id, worktree_path) {
        if let Err(e) = agent_adapter::remove_claude_hooks(&wt) {
            tracing::warn!(workspace = %workspace_id, error = %e, "Claude Code hooks not removed");
        }
    }
}

/// Append [`EXCLUDE_LINE`] to the repo's shared `info/exclude` (the common
/// git dir, so it also covers the main checkout — whose working tree is never
/// touched). Idempotent; never removes anything.
pub fn ensure_local_settings_excluded(worktree: &Path) -> std::io::Result<()> {
    let repo = git2::Repository::open(worktree).map_err(std::io::Error::other)?;
    append_exclude(&repo.commondir().join("info").join("exclude"))
}

fn append_exclude(file: &Path) -> std::io::Result<()> {
    let text = match std::fs::read_to_string(file) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e),
    };
    if text.lines().any(|l| l.trim() == EXCLUDE_LINE) {
        return Ok(());
    }
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let sep = if text.is_empty() || text.ends_with('\n') { "" } else { "\n" };
    let mut out = std::fs::OpenOptions::new().create(true).append(true).open(file)?;
    writeln!(out, "{sep}{EXCLUDE_COMMENT}\n{EXCLUDE_LINE}")
}

/// What `octopush-mcp hook` does with one payload: queue its signal for
/// `terminal`. `false` (nothing written) outside an Octopush terminal or for
/// a payload we don't map. Only the signal and `session_id` are stored.
pub fn record_hook(db: &Db, terminal: Option<&str>, payload: &str) -> bool {
    let Some(terminal) = terminal.map(str::trim).filter(|t| !t.is_empty()) else { return false };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) else { return false };
    let Some(event) = agent_adapter::parse_hook_event(&value) else { return false };
    db.insert_hook_signal(terminal, event.signal.as_str(), event.session_id.as_deref()).is_ok()
}

// ─── App side: the poller ─────────────────────────────────────────

fn hooked() -> &'static Mutex<HashSet<String>> {
    static HOOKED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    HOOKED.get_or_init(Default::default)
}

/// Whether `terminal` has delivered a hook signal this app session — then
/// the daemon's idle heuristic stays quiet for it (also after a `Stop`).
pub fn has_hook_signals(terminal: &str) -> bool {
    hooked().lock().contains(terminal)
}

/// The rows to deliver, in order. With the toggle off, none: hooks a user
/// installed earlier then change nothing.
fn deliverable(rows: Vec<HookSignalRow>, enabled: bool) -> Vec<(String, HookSignal)> {
    if !enabled {
        return Vec::new();
    }
    rows.into_iter()
        .filter_map(|r| Some((r.terminal_id, HookSignal::parse(&r.signal)?)))
        .collect()
}

#[derive(Serialize, Clone)]
struct HookAttentionEvent {
    #[serde(rename = "sessionId")]
    session_id: String,
    /// `permission` | `input`.
    reason: &'static str,
}

#[derive(Serialize, Clone)]
struct HookSettledEvent {
    #[serde(rename = "sessionId")]
    session_id: String,
}

/// Drain `hook_signals` every second and re-emit each row for its terminal.
pub fn spawn_poller(app: AppHandle, db: Arc<Mutex<Db>>) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(POLL_EVERY).await;
            let db = Arc::clone(&db);
            let rows = match tauri::async_runtime::spawn_blocking(move || db.lock().drain_hook_signals()).await {
                Ok(Ok(rows)) => rows,
                Ok(Err(e)) => {
                    tracing::warn!(error = %e, "hook_signals drain failed");
                    continue;
                }
                Err(_) => continue,
            };
            if rows.is_empty() {
                continue;
            }
            for (terminal, signal) in deliverable(rows, hooks_enabled()) {
                hooked().lock().insert(terminal.clone());
                let _ = match signal {
                    HookSignal::Settled => app.emit("pty://settled", HookSettledEvent { session_id: terminal }),
                    s => app.emit("pty://attention", HookAttentionEvent { session_id: terminal, reason: s.as_str() }),
                };
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> (tempfile::NamedTempFile, Db) {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let db = Db::open(tmp.path()).unwrap();
        (tmp, db)
    }

    #[test]
    fn exclude_is_appended_once_under_its_comment() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("info/exclude");
        append_exclude(&file).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), format!("{EXCLUDE_COMMENT}\n{EXCLUDE_LINE}\n"));
        append_exclude(&file).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap().matches(EXCLUDE_LINE).count(), 1);

        // An existing file without a trailing newline keeps its last line intact.
        std::fs::write(&file, "*.log").unwrap();
        append_exclude(&file).unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), format!("*.log\n{EXCLUDE_COMMENT}\n{EXCLUDE_LINE}\n"));
    }

    #[test]
    fn a_linked_worktree_writes_the_shared_exclude_and_git_ignores_the_file() {
        let root = tempfile::tempdir().unwrap();
        let main = root.path().join("project");
        let repo = git2::Repository::init(&main).unwrap();
        let sig = git2::Signature::now("t", "t@example.com").unwrap();
        let tree = repo.find_tree(repo.index().unwrap().write_tree().unwrap()).unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[]).unwrap();
        let wt = root.path().join(".octopus-worktrees").join("feat");
        std::fs::create_dir_all(wt.parent().unwrap()).unwrap();
        repo.worktree("feat", &wt, None).unwrap();

        ensure_local_settings_excluded(&wt).unwrap();
        let exclude = std::fs::read_to_string(main.join(".git/info/exclude")).unwrap();
        assert!(exclude.lines().any(|l| l == EXCLUDE_LINE), "{exclude}");

        agent_adapter::install_claude_hooks(&wt, Path::new("/x/octopush-mcp")).unwrap();
        let wt_repo = git2::Repository::open(&wt).unwrap();
        assert!(wt_repo.status_should_ignore(Path::new(".claude/settings.local.json")).unwrap());
        assert!(!main.join(".claude").exists(), "the main checkout's working tree is untouched");
    }

    #[test]
    fn only_a_managed_worktree_under_octopus_worktrees_is_ours() {
        let (_tmp, db) = test_db();
        let db = Mutex::new(db);
        let root = tempfile::tempdir().unwrap();
        let inside = root.path().join(".octopus-worktrees/feat");
        std::fs::create_dir_all(&inside).unwrap();
        let inside_s = inside.to_string_lossy().to_string();
        let outside_s = root.path().to_string_lossy().to_string();
        {
            let d = db.lock();
            d.insert_project("p", "p", &outside_s).unwrap();
            d.insert_workspace_managed("mine", "p", "mine", "", "feat", Some(&inside_s), "", None, true, true).unwrap();
            d.insert_workspace_managed("adopted", "p", "adopted", "", "x", Some(&inside_s), "", None, false, false).unwrap();
            d.insert_workspace_managed("root", "p", "root", "", "main", Some(&outside_s), "", None, true, false).unwrap();
        }
        assert_eq!(octopush_worktree(&db, "mine", Some(&inside_s)), Some(inside.clone()));
        assert_eq!(octopush_worktree(&db, "adopted", Some(&inside_s)), None);
        assert_eq!(octopush_worktree(&db, "root", Some(&outside_s)), None);
        assert_eq!(octopush_worktree(&db, "mine", None), None);
    }

    #[test]
    fn hook_payloads_queue_once_and_only_from_an_octopush_terminal() {
        let (_tmp, db) = test_db();
        let stop = r#"{"hook_event_name":"Stop","session_id":"s1","cwd":"/w"}"#;
        let ask = r#"{"hook_event_name":"Notification","notification_type":"permission_prompt","message":"secret text","session_id":"s1"}"#;
        assert!(!record_hook(&db, None, stop), "outside an Octopush terminal");
        assert!(!record_hook(&db, Some("  "), stop));
        assert!(!record_hook(&db, Some("t1"), "not json"));
        assert!(!record_hook(&db, Some("t1"), r#"{"hook_event_name":"PreToolUse"}"#));
        assert!(record_hook(&db, Some("t1"), ask));
        assert!(record_hook(&db, Some("t1"), stop));

        let rows = db.drain_hook_signals().unwrap();
        let got: Vec<_> = rows.iter().map(|r| (r.terminal_id.as_str(), r.signal.as_str(), r.session_id.as_deref())).collect();
        assert_eq!(got, [("t1", "permission", Some("s1")), ("t1", "settled", Some("s1"))]);
        assert!(db.drain_hook_signals().unwrap().is_empty(), "a drained row is delivered once");
        assert!(!format!("{rows:?}").contains("secret text"), "message text is never stored");

        assert!(deliverable(rows.clone(), false).is_empty(), "toggle off delivers nothing");
        assert_eq!(deliverable(rows, true), [
            ("t1".to_string(), HookSignal::NeedsPermission),
            ("t1".to_string(), HookSignal::Settled),
        ]);
    }
}
