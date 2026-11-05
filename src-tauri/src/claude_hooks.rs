//! Run-mode attention from Claude Code's own hooks (#287).
//!
//! In a worktree Octopush created, `.claude/settings.local.json` gets
//! `Notification` and `Stop` hooks (the file shape lives in `agent_adapter`,
//! a fragile surface). Each hook runs `octopush-mcp hook` inside the Run
//! terminal, which queues one `hook_signals` row keyed by the terminal's
//! `OCTOPUSH_TERMINAL_ID`. The app drains that queue once a second and emits
//! `pty://attention` (with a `reason`) or `pty://settled`.
//!
//! Everything is gated on Settings' `claudeHooksEnabled` (on unless set to
//! `false`) and
//! on a known Claude Code version at or above the tested floor; otherwise the
//! terminal bell/idle heuristic is unchanged. Once a terminal has delivered a
//! hook signal, the daemon's idle heuristic stays quiet for it while the
//! setting is on. On launch and whenever the toggle flips, every active
//! managed worktree is brought in line: hooks installed while on, stripped
//! while off.

use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use chrono::{DateTime, Utc};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::agent_adapter::{self, HookSignal};
use crate::db::{Db, HookSignalRow, WorkspaceRow};
use crate::error::AppResult;

/// Set in every Run terminal's environment; the hook reads it to name the
/// terminal its signal belongs to.
pub const TERMINAL_ENV: &str = "OCTOPUSH_TERMINAL_ID";

/// The `info/exclude` line that keeps our settings file out of git.
pub const EXCLUDE_LINE: &str = "/.claude/settings.local.json";
const EXCLUDE_COMMENT: &str = "# added by Octopush (Claude Code hooks)";

const POLL_EVERY: Duration = Duration::from_secs(1);
/// A queued signal older than this is dropped, not delivered: PTYs outlive
/// the app, so a relaunch would otherwise replay prompts answered long ago.
const STALE_AFTER_SECS: i64 = 10;
/// Hook payloads are a few hundred bytes; anything past this isn't one.
pub const MAX_PAYLOAD: u64 = 1 << 20;

/// Settings › General's toggle: an unset value is on, only an explicit `false`
/// is off.
fn hooks_enabled() -> bool {
    enabled_from(crate::settings::load_settings().ok().and_then(|s| s.claude_hooks_enabled))
}

fn enabled_from(setting: Option<bool>) -> bool {
    setting.unwrap_or(true)
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
    // Unless git ignores the file, it would show in Review and in crew commits.
    match keep_local_settings_out_of_git(&wt) {
        Ok(true) => {}
        Ok(false) => {
            tracing::info!(workspace = %ws.id, "settings.local.json is tracked; Claude Code hooks skipped");
            return false;
        }
        Err(e) => {
            tracing::warn!(workspace = %ws.id, error = %e, "info/exclude not writable; Claude Code hooks skipped");
            return false;
        }
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

/// Whether a settings save from `before` to `after` flips the toggle.
pub fn toggled(before: Option<bool>, after: Option<bool>) -> bool {
    enabled_from(before) != enabled_from(after)
}

/// Bring every active workspace Octopush made in line with the setting, read
/// now: on launch, and when the toggle flips. On, the hooks are installed with
/// the same guards as for a new workspace (needs `hook_bin`); off, our entries
/// are stripped. Probes the CLI version, so call it off the UI path.
pub fn sync_all_workspaces(db: &Mutex<Db>, hook_bin: Option<&Path>) {
    sync_workspaces(db, hooks_enabled(), hook_bin);
}

fn sync_workspaces(db: &Mutex<Db>, enabled: bool, hook_bin: Option<&Path>) {
    for ws in active_workspaces(db) {
        if !enabled {
            remove_for_workspace(db, &ws.id, ws.worktree_path.as_deref());
        } else if let Some(bin) = hook_bin {
            install_for_workspace(db, &ws, bin);
        }
    }
}

/// Every non-archived workspace with a worktree path; [`octopush_worktree`]
/// still decides which of them are ours.
fn active_workspaces(db: &Mutex<Db>) -> Vec<WorkspaceRow> {
    let d = db.lock();
    let paths = match d.list_workspace_paths() {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(error = %e, "workspaces not listed; Claude Code hooks not synced");
            return Vec::new();
        }
    };
    paths
        .into_iter()
        .filter_map(|(id, _, _)| d.get_workspace(&id).ok().flatten())
        .filter(|ws| ws.status != "archived")
        .collect()
}

/// Append [`EXCLUDE_LINE`] to the repo's shared `info/exclude` (the common
/// git dir, so it also covers the main checkout — whose working tree is never
/// touched). Idempotent; never removes anything.
pub fn ensure_local_settings_excluded(worktree: &Path) -> std::io::Result<()> {
    let repo = git2::Repository::open(worktree).map_err(std::io::Error::other)?;
    append_exclude(&common_dir(repo.path())?.join("info").join("exclude"))
}

/// [`ensure_local_settings_excluded`], then whether git now keeps the file
/// out of the worktree's changes: ignored and not in the index. `info/exclude`
/// doesn't apply to a tracked file, so a repo that commits it gets `false`.
fn keep_local_settings_out_of_git(worktree: &Path) -> std::io::Result<bool> {
    ensure_local_settings_excluded(worktree)?;
    let repo = git2::Repository::open(worktree).map_err(std::io::Error::other)?;
    let rel = Path::new(agent_adapter::LOCAL_SETTINGS_FILE);
    let tracked = repo.index().map_err(std::io::Error::other)?.get_path(rel, 0).is_some();
    Ok(!tracked && repo.status_should_ignore(rel).map_err(std::io::Error::other)?)
}

/// The shared git dir for `git_dir`, resolved as git resolves
/// `--git-common-dir`: a linked worktree's git dir has a `commondir` file
/// naming it (usually `../..`); any other git dir is its own.
fn common_dir(git_dir: &Path) -> std::io::Result<PathBuf> {
    match std::fs::read_to_string(git_dir.join("commondir")) {
        Ok(text) => Ok(git_dir.join(text.trim_end())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(git_dir.to_path_buf()),
        Err(e) => Err(e),
    }
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

/// The value after `--kind` in `octopush-mcp hook`'s arguments, if any.
pub fn hook_kind(args: &[String]) -> Option<&str> {
    let at = args.iter().position(|a| a == agent_adapter::HOOK_KIND_FLAG)?;
    args.get(at + 1).map(String::as_str)
}

/// What `octopush-mcp hook` does with one payload: queue its signal for
/// `terminal`. `kind` is the hook's `--kind` (see `parse_hook_event`).
/// `false` (nothing written) outside an Octopush terminal or for a payload we
/// don't map. Only the signal and `session_id` are stored.
pub fn record_hook(db: &Db, terminal: Option<&str>, kind: Option<&str>, payload: &str) -> bool {
    let Some(terminal) = terminal.map(str::trim).filter(|t| !t.is_empty()) else { return false };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) else { return false };
    let Some(event) = agent_adapter::parse_hook_event(&value, kind) else { return false };
    db.insert_hook_signal(terminal, event.signal.as_str(), event.session_id.as_deref()).is_ok()
}

// ─── App side: the poller ─────────────────────────────────────────

fn hooked() -> &'static Mutex<HashSet<String>> {
    static HOOKED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    HOOKED.get_or_init(Default::default)
}

/// Whether `terminal` has delivered a hook signal this app session and the
/// setting is still on — then the daemon's idle heuristic stays quiet for it
/// (also after a `Stop`). Turning the setting off gives it the heuristic back.
pub fn has_hook_signals(terminal: &str) -> bool {
    let known = hooked().lock().contains(terminal);
    suppress_idle(known, hooks_enabled)
}

/// The reader thread's check: drop the daemon's idle attention only for a
/// hooked terminal while the setting is on. `enabled` (a settings read) runs
/// only for a hooked terminal.
fn suppress_idle(hooked: bool, enabled: impl FnOnce() -> bool) -> bool {
    hooked && enabled()
}

/// The rows to deliver, in order. With the toggle off, none: hooks a user
/// installed earlier then change nothing. Rows older than
/// [`STALE_AFTER_SECS`] (or with an unreadable time) are dropped.
fn deliverable(rows: Vec<HookSignalRow>, enabled: bool, now: DateTime<Utc>) -> Vec<(String, HookSignal)> {
    if !enabled {
        return Vec::new();
    }
    rows.into_iter()
        .filter(|r| is_fresh(&r.created_at, now))
        .filter_map(|r| Some((r.terminal_id, HookSignal::parse(&r.signal)?)))
        .collect()
}

/// One poll. The queue is drained with the toggle off too, and those rows are
/// dropped: hooks still in a worktree keep queuing, and the table would
/// otherwise grow without bound.
fn poll_once(db: &Db, enabled: bool, now: DateTime<Utc>) -> AppResult<Vec<(String, HookSignal)>> {
    Ok(deliverable(db.drain_hook_signals()?, enabled, now))
}

fn is_fresh(created_at: &str, now: DateTime<Utc>) -> bool {
    DateTime::parse_from_rfc3339(created_at)
        .is_ok_and(|t| now - t.with_timezone(&Utc) <= chrono::Duration::seconds(STALE_AFTER_SECS))
}

/// What the poller emits for one delivered row.
#[derive(Debug, PartialEq)]
enum HookEmit {
    /// `pty://attention` with this `reason`.
    Attention(&'static str),
    /// `pty://settled`.
    Settled,
}

/// The poller's per-row step: `terminal` now reports through hooks, and
/// `signal` becomes the event to emit.
fn deliver_one(hooked: &mut HashSet<String>, terminal: &str, signal: HookSignal) -> HookEmit {
    hooked.insert(terminal.to_string());
    match signal {
        HookSignal::Settled => HookEmit::Settled,
        s => HookEmit::Attention(s.as_str()),
    }
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
            let poll = move || {
                let enabled = hooks_enabled();
                poll_once(&db.lock(), enabled, Utc::now())
            };
            let rows = match tauri::async_runtime::spawn_blocking(poll).await {
                Ok(Ok(rows)) => rows,
                Ok(Err(e)) => {
                    tracing::warn!(error = %e, "hook_signals drain failed");
                    continue;
                }
                Err(_) => continue,
            };
            for (terminal, signal) in rows {
                let emit = deliver_one(&mut hooked().lock(), &terminal, signal);
                let _ = match emit {
                    HookEmit::Settled => app.emit("pty://settled", HookSettledEvent { session_id: terminal }),
                    HookEmit::Attention(reason) => {
                        app.emit("pty://attention", HookAttentionEvent { session_id: terminal, reason })
                    }
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
    fn common_dir_follows_a_worktrees_commondir_file() {
        let dir = tempfile::tempdir().unwrap();
        let main_git = dir.path().join(".git");
        let wt_git = main_git.join("worktrees/feat");
        std::fs::create_dir_all(&wt_git).unwrap();
        assert_eq!(common_dir(&main_git).unwrap(), main_git, "a main git dir is its own");
        std::fs::write(wt_git.join("commondir"), "../..\n").unwrap();
        let resolved = common_dir(&wt_git).unwrap();
        assert_eq!(resolved, wt_git.join("../.."));
        assert_eq!(resolved.canonicalize().unwrap(), main_git.canonicalize().unwrap());
        std::fs::write(wt_git.join("commondir"), format!("{}\n", main_git.display())).unwrap();
        assert_eq!(common_dir(&wt_git).unwrap(), main_git, "an absolute commondir is used as is");
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

        assert!(keep_local_settings_out_of_git(&wt).unwrap(), "untracked and ignored");
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
        let idle_without_type = r#"{"hook_event_name":"Notification","message":"waiting","session_id":"s1"}"#;
        assert!(!record_hook(&db, None, None, stop), "outside an Octopush terminal");
        assert!(!record_hook(&db, Some("  "), None, stop));
        assert!(!record_hook(&db, Some("t1"), None, "not json"));
        assert!(!record_hook(&db, Some("t1"), Some("permission"), r#"{"hook_event_name":"PreToolUse"}"#));
        assert!(!record_hook(&db, Some("t1"), None, idle_without_type), "no kind and no notification_type");
        assert!(record_hook(&db, Some("t1"), None, ask));
        assert!(record_hook(&db, Some("t1"), Some("input"), idle_without_type));
        assert!(record_hook(&db, Some("t1"), None, stop));

        let rows = db.drain_hook_signals().unwrap();
        let got: Vec<_> = rows.iter().map(|r| (r.terminal_id.as_str(), r.signal.as_str(), r.session_id.as_deref())).collect();
        assert_eq!(got, [("t1", "permission", Some("s1")), ("t1", "input", Some("s1")), ("t1", "settled", Some("s1"))]);
        assert!(db.drain_hook_signals().unwrap().is_empty(), "a drained row is delivered once");
        assert!(!format!("{rows:?}").contains("secret text"), "message text is never stored");

        assert!(deliverable(rows.clone(), false, Utc::now()).is_empty(), "toggle off delivers nothing");
        assert_eq!(deliverable(rows, true, Utc::now()), [
            ("t1".to_string(), HookSignal::NeedsPermission),
            ("t1".to_string(), HookSignal::NeedsInput),
            ("t1".to_string(), HookSignal::Settled),
        ]);
    }

    #[test]
    fn the_kind_is_read_from_the_hook_arguments() {
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(hook_kind(&args(&["octopush-mcp", "hook", "--kind", "permission", "--octopush-hook"])), Some("permission"));
        assert_eq!(hook_kind(&args(&["octopush-mcp", "hook", "--octopush-hook"])), None);
        assert_eq!(hook_kind(&args(&["octopush-mcp", "hook", "--kind"])), None);
    }

    #[test]
    fn the_setting_is_on_unless_turned_off() {
        assert!(enabled_from(None), "unset is on");
        assert!(enabled_from(Some(true)));
        assert!(!enabled_from(Some(false)));
    }

    #[test]
    fn the_poller_drops_rows_while_the_setting_is_off() {
        let (_tmp, db) = test_db();
        db.insert_hook_signal("t1", "permission", None).unwrap();
        db.insert_hook_signal("t2", "input", None).unwrap();
        assert!(poll_once(&db, false, Utc::now()).unwrap().is_empty());
        // Drained and dropped: nothing piles up, nothing replays once it's back on.
        assert!(db.drain_hook_signals().unwrap().is_empty(), "the queue is empty while off");
        assert!(poll_once(&db, true, Utc::now()).unwrap().is_empty());

        db.insert_hook_signal("t1", "settled", None).unwrap();
        assert_eq!(poll_once(&db, true, Utc::now()).unwrap(), [("t1".to_string(), HookSignal::Settled)]);
        assert!(poll_once(&db, true, Utc::now()).unwrap().is_empty(), "drained once");
    }

    #[test]
    fn only_a_flip_of_the_effective_setting_counts_as_a_toggle() {
        assert!(!toggled(None, Some(true)), "unset is already on");
        assert!(!toggled(Some(false), Some(false)));
        assert!(toggled(None, Some(false)));
        assert!(toggled(Some(true), Some(false)));
        assert!(toggled(Some(false), Some(true)));
        assert!(toggled(Some(false), None));
    }

    #[test]
    fn turning_the_setting_off_strips_our_hooks_from_active_managed_worktrees_only() {
        let (_tmp, db) = test_db();
        let db = Mutex::new(db);
        let root = tempfile::tempdir().unwrap();
        let mk = |name: &str| {
            let wt = root.path().join(".octopus-worktrees").join(name);
            std::fs::create_dir_all(&wt).unwrap();
            agent_adapter::install_claude_hooks(&wt, Path::new("/x/octopush-mcp")).unwrap();
            assert!(wt.join(agent_adapter::LOCAL_SETTINGS_FILE).is_file());
            wt
        };
        let (mine, adopted, archived) = (mk("mine"), mk("adopted"), mk("archived"));
        let s = |p: &Path| p.to_string_lossy().to_string();
        {
            let d = db.lock();
            d.insert_project("p", "p", &s(root.path())).unwrap();
            d.insert_workspace_managed("mine", "p", "mine", "", "a", Some(&s(&mine)), "", None, true, true).unwrap();
            d.insert_workspace_managed("adopted", "p", "adopted", "", "b", Some(&s(&adopted)), "", None, false, false).unwrap();
            d.insert_workspace_managed("archived", "p", "archived", "", "c", Some(&s(&archived)), "", None, true, true).unwrap();
            d.archive_workspace("archived").unwrap();
        }

        // On, without a hook binary to install: nothing is touched.
        sync_workspaces(&db, true, None);
        assert!(mine.join(agent_adapter::LOCAL_SETTINGS_FILE).is_file());

        sync_workspaces(&db, false, None);
        assert!(!mine.join(agent_adapter::LOCAL_SETTINGS_FILE).exists(), "ours, active: stripped");
        assert!(adopted.join(agent_adapter::LOCAL_SETTINGS_FILE).is_file(), "an adopted checkout is never touched");
        assert!(archived.join(agent_adapter::LOCAL_SETTINGS_FILE).is_file(), "archived rows are skipped");
    }

    #[test]
    fn signals_queued_while_the_app_was_closed_are_dropped() {
        let now = Utc::now();
        let row = |id: i64, terminal: &str, age_secs: i64| HookSignalRow {
            id,
            terminal_id: terminal.to_string(),
            signal: "permission".to_string(),
            session_id: None,
            created_at: (now - chrono::Duration::seconds(age_secs)).to_rfc3339(),
        };
        let mut unreadable = row(4, "t4", 0);
        unreadable.created_at = "yesterday".to_string();
        let rows = vec![row(1, "t1", 3600), row(2, "t2", STALE_AFTER_SECS + 1), row(3, "t3", 1), unreadable];
        assert_eq!(deliverable(rows, true, now), [("t3".to_string(), HookSignal::NeedsPermission)]);
    }

    #[test]
    fn a_hooked_terminal_gets_its_attention_from_hooks_alone_while_the_setting_is_on() {
        let mut hooked = HashSet::new();
        assert_eq!(deliver_one(&mut hooked, "t1", HookSignal::NeedsPermission), HookEmit::Attention("permission"));
        assert_eq!(deliver_one(&mut hooked, "t1", HookSignal::NeedsInput), HookEmit::Attention("input"));
        assert_eq!(deliver_one(&mut hooked, "t1", HookSignal::Settled), HookEmit::Settled);

        // After `Stop`, the daemon's idle ping for t1 stays dropped.
        assert!(suppress_idle(hooked.contains("t1"), || true));
        // A terminal without hooks keeps the heuristic, without a settings read.
        assert!(!suppress_idle(hooked.contains("t2"), || panic!("read settings for an unhooked terminal")));
        // Turning the setting off gives the hooked terminal its heuristic back.
        assert!(!suppress_idle(hooked.contains("t1"), || false));
    }

    #[test]
    fn a_committed_settings_file_is_never_installed_into() {
        let root = tempfile::tempdir().unwrap();
        let main = root.path().join("project");
        let repo = git2::Repository::init(&main).unwrap();
        let rel = Path::new(agent_adapter::LOCAL_SETTINGS_FILE);
        std::fs::create_dir_all(main.join(".claude")).unwrap();
        std::fs::write(main.join(rel), "{}\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(rel).unwrap();
        index.write().unwrap();
        let sig = git2::Signature::now("t", "t@example.com").unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "init", &tree, &[]).unwrap();
        let wt = root.path().join(".octopus-worktrees").join("feat");
        std::fs::create_dir_all(wt.parent().unwrap()).unwrap();
        repo.worktree("feat", &wt, None).unwrap();
        assert!(wt.join(rel).is_file(), "the worktree checks out the committed file");

        assert!(!keep_local_settings_out_of_git(&wt).unwrap(), "a tracked file isn't kept out by info/exclude");
    }
}
