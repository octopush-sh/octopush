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
use std::sync::atomic::{AtomicU64, Ordering};
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

/// Bring every active workspace Octopush made in line with the setting: on
/// launch, and when the toggle flips. On, the hooks are installed with the
/// same guards as for a new workspace (needs `hook_bin`); off, our entries are
/// stripped. Probes the CLI version, so call it off the UI path.
///
/// Sweeps run one at a time, and a newer sweep cancels an older one at its
/// next workspace (#539): a quick off-then-on can't have the stale off-sweep
/// strip what the on-sweep just installed. The setting is re-read for every
/// workspace, so whichever sweep runs last applies the saved value.
pub fn sync_all_workspaces(db: &Mutex<Db>, hook_bin: Option<&Path>) {
    let sweep = sweeps().begin();
    let _one_at_a_time = sweeps().running.lock();
    sync_workspaces(db, hooks_enabled, || sweeps().is_latest(sweep), hook_bin);
}

/// The sweep generation counter and the lock that serializes sweeps.
#[derive(Default)]
struct Sweeps {
    latest: AtomicU64,
    running: Mutex<()>,
}

impl Sweeps {
    /// A new sweep's generation; every older sweep is now stale.
    fn begin(&self) -> u64 {
        self.latest.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn is_latest(&self, sweep: u64) -> bool {
        self.latest.load(Ordering::SeqCst) == sweep
    }
}

fn sweeps() -> &'static Sweeps {
    static SWEEPS: OnceLock<Sweeps> = OnceLock::new();
    SWEEPS.get_or_init(Default::default)
}

/// One sweep. `enabled` (a settings read) runs before each workspace; the
/// sweep stops as soon as `is_latest` says a newer one has started, which then
/// covers every workspace itself.
fn sync_workspaces(
    db: &Mutex<Db>,
    enabled: impl Fn() -> bool,
    is_latest: impl Fn() -> bool,
    hook_bin: Option<&Path>,
) {
    for ws in active_workspaces(db) {
        if !is_latest() {
            return;
        }
        if !enabled() {
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
/// don't map. Only the signal and `session_id` are stored. Prints nothing.
pub fn record_hook(db: &Db, terminal: Option<&str>, kind: Option<&str>, payload: &str) -> bool {
    record_hook_from(db, terminal, kind, None, payload)
}

/// [`record_hook`], told how the hook's session was started (`entrypoint`:
/// the hook's own `CLAUDE_CODE_ENTRYPOINT`). A print-mode or SDK session is
/// not the one a person drives in the terminal, though a `claude -p` the
/// agent runs inherits the terminal's id: its start and end are not queued,
/// and its other signals are queued without its session id, so it changes
/// attention exactly as before and never which session the terminal runs.
pub fn record_hook_from(
    db: &Db,
    terminal: Option<&str>,
    kind: Option<&str>,
    entrypoint: Option<&str>,
    payload: &str,
) -> bool {
    let Some(terminal) = terminal.map(str::trim).filter(|t| !t.is_empty()) else { return false };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) else { return false };
    let Some(event) = agent_adapter::parse_hook_event(&value, kind) else { return false };
    let interactive = agent_adapter::interactive_entrypoint(entrypoint);
    if !interactive && event.signal.is_session() {
        return false;
    }
    let session = event.session_id.as_deref().filter(|_| interactive);
    db.insert_hook_signal(terminal, event.signal.as_str(), session).is_ok()
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
/// otherwise grow without bound. With the toggle on, each row also says
/// which Claude Code session its terminal runs ([`remember_sessions`]); with
/// it off, what was known is forgotten, since a session can then end or
/// change with nothing to say so.
fn poll_once(db: &Db, enabled: bool, now: DateTime<Utc>) -> AppResult<Vec<(String, HookSignal)>> {
    let rows = db.drain_hook_signals()?;
    if enabled {
        remember_sessions(db, &rows);
    } else if let Err(e) = db.clear_terminal_claude_sessions() {
        tracing::warn!(error = %e, "could not forget the terminals' Claude Code sessions");
    }
    Ok(deliverable(rows, enabled, now))
}

// ─── Which Claude Code session a terminal runs ────────────────────
//
// A hook payload is the only place a Run terminal and Claude Code's own
// session id meet: the terminal id comes from the hook's environment, the
// session id from its payload. The transcript ledger is keyed by that session
// id (`cc:<session id>`), so the pair is what lets the Run Companion show one
// terminal's context and spend and not another's.
//
// A terminal has at most ONE current session (`terminal_claude_session`,
// keyed by the terminal), kept in the database because a PTY, and the Claude
// Code session in it, outlives the app:
//
// - `SessionStart` names the session the terminal runs from now on: `claude`
//   started, or `/clear`, `/resume`, `--resume`, `--continue`, a fork or a
//   compaction gave the process that session.
// - `SessionEnd` ends it: the terminal then has no current session, and that
//   session is remembered as ended, so a late signal of its own (an async
//   `Stop` still in flight) can't bring it back. Only its `SessionStart` (a
//   resume) can.
// - Any other signal (`Stop`, a `Notification`) names its session too. That is
//   the whole link for a session whose hooks predate the two above (it was
//   already running when they were installed), and how a terminal comes back
//   to its own session after anything else was taken for it.
// - A session is current in one terminal only: named by another terminal (it
//   was resumed there), it leaves the first, which then has none.

/// Apply what each of `rows` says about its terminal's session, in order. A
/// row too old to deliver still counts: its prompt was answered long ago, but
/// the session it names did start, speak or end in that terminal at that
/// time. A row without a session id says nothing. A failed write only costs
/// the Companion its Context section, so it is logged and never fails the
/// poll.
pub(crate) fn remember_sessions(db: &Db, rows: &[HookSignalRow]) {
    for row in rows {
        let Some(session) = row.session_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) else { continue };
        let Some(signal) = HookSignal::parse(&row.signal) else { continue };
        // Stored in one shape so the times compare as text; a row whose time
        // can't be read is not evidence of when.
        let Ok(at) = DateTime::parse_from_rfc3339(&row.created_at) else { continue };
        let at = at.with_timezone(&Utc).to_rfc3339();
        let done = match signal {
            HookSignal::SessionEnded => db.end_terminal_claude_session(&row.terminal_id, session, &at),
            HookSignal::SessionStarted => db.link_terminal_claude_session(&row.terminal_id, session, &at, true).map(|_| ()),
            _ => db.link_terminal_claude_session(&row.terminal_id, session, &at, false).map(|_| ()),
        };
        if let Err(e) = done {
            tracing::warn!(error = %e, "could not record a terminal's Claude Code session");
        }
    }
}

/// Whether the terminals' recorded sessions can be relied on: only while the
/// setting is on. Off, hooks no longer report, so a session can end or
/// change unseen (and what was known is dropped at the next poll).
pub fn sessions_known() -> bool {
    hooks_enabled()
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
    /// `pty://claude-session`: the terminal's Claude Code session started,
    /// changed or ended.
    SessionChanged,
}

/// The poller's per-row step: `signal` becomes the event to emit. An
/// attention signal also marks `terminal` as reporting through hooks; a
/// session starting or ending says nothing about attention and leaves that
/// as it was.
fn deliver_one(hooked: &mut HashSet<String>, terminal: &str, signal: HookSignal) -> HookEmit {
    if signal.is_session() {
        return HookEmit::SessionChanged;
    }
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
                    HookEmit::SessionChanged => app.emit("pty://claude-session", HookSettledEvent { session_id: terminal }),
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
        sync_workspaces(&db, || true, || true, None);
        assert!(mine.join(agent_adapter::LOCAL_SETTINGS_FILE).is_file());

        // An off-sweep a newer sweep has superseded strips nothing.
        sync_workspaces(&db, || false, || false, None);
        assert!(mine.join(agent_adapter::LOCAL_SETTINGS_FILE).is_file(), "a stale sweep stops");

        sync_workspaces(&db, || false, || true, None);
        assert!(!mine.join(agent_adapter::LOCAL_SETTINGS_FILE).exists(), "ours, active: stripped");
        assert!(adopted.join(agent_adapter::LOCAL_SETTINGS_FILE).is_file(), "an adopted checkout is never touched");
        assert!(archived.join(agent_adapter::LOCAL_SETTINGS_FILE).is_file(), "archived rows are skipped");
    }

    #[test]
    fn a_sweep_re_reads_the_setting_and_stops_once_superseded_mid_way() {
        let (_tmp, db) = test_db();
        let db = Mutex::new(db);
        let root = tempfile::tempdir().unwrap();
        let s = |p: &Path| p.to_string_lossy().to_string();
        db.lock().insert_project("p", "p", &s(root.path())).unwrap();
        let wts: Vec<PathBuf> = (0..3)
            .map(|i| {
                let wt = root.path().join(".octopus-worktrees").join(format!("w{i}"));
                std::fs::create_dir_all(&wt).unwrap();
                agent_adapter::install_claude_hooks(&wt, Path::new("/x/octopush-mcp")).unwrap();
                let id = format!("w{i}");
                db.lock().insert_workspace_managed(&id, "p", &id, "", &id, Some(&s(&wt)), "", None, true, true).unwrap();
                wt
            })
            .collect();
        let hooked = |wt: &PathBuf| wt.join(agent_adapter::LOCAL_SETTINGS_FILE).is_file();

        // The toggle comes back on after the first strip: the rest are kept.
        let reads = std::cell::Cell::new(0);
        let enabled = || {
            reads.set(reads.get() + 1);
            reads.get() > 1
        };
        sync_workspaces(&db, enabled, || true, None);
        assert_eq!(reads.get(), 3, "read once per workspace");
        assert_eq!(wts.iter().filter(|wt| hooked(wt)).count(), 2);

        // A newer sweep starts after the first workspace: the old one stops there.
        for wt in &wts {
            agent_adapter::install_claude_hooks(wt, Path::new("/x/octopush-mcp")).unwrap();
        }
        let checks = std::cell::Cell::new(0);
        let is_latest = || {
            checks.set(checks.get() + 1);
            checks.get() == 1
        };
        sync_workspaces(&db, || false, is_latest, None);
        assert_eq!(wts.iter().filter(|wt| hooked(wt)).count(), 2, "one stripped, then cancelled");
    }

    #[test]
    fn only_the_newest_sweep_is_latest() {
        let sweeps = Sweeps::default();
        let off = sweeps.begin();
        assert!(sweeps.is_latest(off));
        let on = sweeps.begin();
        assert!(!sweeps.is_latest(off), "the older sweep is cancelled");
        assert!(sweeps.is_latest(on));
    }

    fn hook(event: &str, session: &str) -> String {
        format!(r#"{{"hook_event_name":"{event}","session_id":"{session}","cwd":"/w"}}"#)
    }

    /// Queue one hook payload for `terminal` and run a poll, a moment after
    /// the last one so the links order by time.
    fn fire(db: &Db, terminal: &str, event: &str, session: &str) -> Vec<(String, HookSignal)> {
        std::thread::sleep(std::time::Duration::from_millis(3));
        assert!(record_hook(db, Some(terminal), None, &hook(event, session)), "{event} {session}");
        poll_once(db, true, Utc::now()).unwrap()
    }

    fn session_of(db: &Db, terminal: &str) -> Option<String> {
        db.terminal_claude_session(terminal).unwrap().map(|(s, _)| s)
    }

    #[test]
    fn a_session_start_links_the_terminal_at_once_and_its_end_unlinks_it() {
        let (_tmp, db) = test_db();
        assert_eq!(session_of(&db, "t1"), None, "a terminal that never ran a hook");

        // `claude` starts: the terminal runs that session from this moment,
        // and the Companion is told to look again.
        assert_eq!(fire(&db, "t1", "SessionStart", "s1"), [("t1".to_string(), HookSignal::SessionStarted)]);
        assert_eq!(session_of(&db, "t1").as_deref(), Some("s1"));
        let (_, at) = db.terminal_claude_session("t1").unwrap().unwrap();
        assert!(at.ends_with("+00:00") && DateTime::parse_from_rfc3339(&at).is_ok(), "linked_at {at}");
        let mut hooked = HashSet::new();
        assert_eq!(deliver_one(&mut hooked, "t1", HookSignal::SessionStarted), HookEmit::SessionChanged);
        assert_eq!(deliver_one(&mut hooked, "t1", HookSignal::SessionEnded), HookEmit::SessionChanged);
        assert!(hooked.is_empty(), "a session starting or ending is not an attention signal");

        // `/exit`: no current session. A bare prompt, or another CLI in that
        // terminal, has no Claude Code figures to show.
        assert_eq!(fire(&db, "t1", "SessionEnd", "s1"), [("t1".to_string(), HookSignal::SessionEnded)]);
        assert_eq!(session_of(&db, "t1"), None);
        // Its own `Stop`, still in flight when it ended, can't bring it back.
        fire(&db, "t1", "Stop", "s1");
        assert_eq!(session_of(&db, "t1"), None, "an ended session stays ended");
        // Resuming it can: its `SessionStart` says so.
        fire(&db, "t1", "SessionStart", "s1");
        assert_eq!(session_of(&db, "t1").as_deref(), Some("s1"));
        fire(&db, "t1", "Stop", "s1");
        assert_eq!(session_of(&db, "t1").as_deref(), Some("s1"));
    }

    #[test]
    fn clear_and_resume_move_the_terminal_to_the_new_session_without_waiting_for_a_turn() {
        let (_tmp, db) = test_db();
        fire(&db, "t1", "SessionStart", "s1");
        // `/clear`, in the order Claude Code fires them (recorded on 2.1.327):
        // the old session ends, then the new one starts.
        fire(&db, "t1", "SessionEnd", "s1");
        assert_eq!(session_of(&db, "t1"), None, "between the two there is nothing to show");
        fire(&db, "t1", "SessionStart", "s2");
        assert_eq!(session_of(&db, "t1").as_deref(), Some("s2"));
        // `/resume` of an older conversation: the same two events.
        fire(&db, "t1", "SessionEnd", "s2");
        fire(&db, "t1", "SessionStart", "s0");
        assert_eq!(session_of(&db, "t1").as_deref(), Some("s0"));
        // Both in one poll, as they arrive 30 ms apart: still in order.
        assert!(record_hook(&db, Some("t1"), None, &hook("SessionEnd", "s0")));
        assert!(record_hook(&db, Some("t1"), None, &hook("SessionStart", "s3")));
        poll_once(&db, true, Utc::now()).unwrap();
        assert_eq!(session_of(&db, "t1").as_deref(), Some("s3"));
        // An end that names another session than the current one changes nothing.
        fire(&db, "t1", "SessionEnd", "s1");
        assert_eq!(session_of(&db, "t1").as_deref(), Some("s3"));
    }

    #[test]
    fn a_terminal_has_one_current_session_and_a_session_one_terminal() {
        let (_tmp, db) = test_db();
        // t1 ran s1, then (cleared) s2.
        fire(&db, "t1", "SessionStart", "s1");
        fire(&db, "t1", "SessionEnd", "s1");
        fire(&db, "t1", "SessionStart", "s2");
        fire(&db, "t2", "SessionStart", "s9");
        let rows: i64 = db.conn_ref().query_row("SELECT COUNT(*) FROM terminal_claude_session", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 2, "one row per terminal");

        // s2 is resumed in t2 (t1's process was killed, so no end was said).
        // t2 runs it now; t1 has no session, not its older one.
        fire(&db, "t2", "SessionEnd", "s9");
        fire(&db, "t2", "SessionStart", "s2");
        assert_eq!(session_of(&db, "t2").as_deref(), Some("s2"));
        assert_eq!(session_of(&db, "t1"), None, "never falls back to s1");
    }

    #[test]
    fn a_session_whose_hooks_predate_session_start_is_linked_by_its_next_signal() {
        let (_tmp, db) = test_db();
        // Already running when the session hooks were installed: no start.
        fire(&db, "t1", "Stop", "s1");
        assert_eq!(session_of(&db, "t1").as_deref(), Some("s1"));
        // The newest signal names the terminal's session; another terminal keeps its own.
        fire(&db, "t2", "Stop", "s9");
        fire(&db, "t1", "Stop", "s2");
        assert_eq!(session_of(&db, "t1").as_deref(), Some("s2"));
        assert_eq!(session_of(&db, "t2").as_deref(), Some("s9"));

        // A payload without a session id changes nothing.
        assert!(record_hook(&db, Some("t1"), None, r#"{"hook_event_name":"Stop"}"#));
        poll_once(&db, true, Utc::now()).unwrap();
        assert_eq!(session_of(&db, "t1").as_deref(), Some("s2"));

        // A row queued while the app was closed is not delivered, but it
        // still says what happened in that terminal: here, that s2 ended.
        assert!(record_hook(&db, Some("t1"), None, &hook("SessionEnd", "s2")));
        let later = Utc::now() + chrono::Duration::seconds(STALE_AFTER_SECS + 60);
        assert!(poll_once(&db, true, later).unwrap().is_empty());
        assert_eq!(session_of(&db, "t1"), None);

        // With the setting off nothing confirms a session any more: what was
        // known is forgotten, and nothing new is learned.
        assert!(record_hook(&db, Some("t2"), None, &hook("SessionStart", "s10")));
        assert!(poll_once(&db, false, Utc::now()).unwrap().is_empty());
        assert_eq!(session_of(&db, "t2"), None);
    }

    /// A `claude -p` the agent runs inherits the terminal's id. Claude Code
    /// says in the hook's environment that it is print mode (`sdk-cli`,
    /// recorded on 2.1.327), so it never becomes the terminal's session.
    #[test]
    fn a_print_mode_session_in_the_terminal_never_takes_it_over() {
        let (_tmp, db) = test_db();
        fire(&db, "t1", "SessionStart", "parent");
        let nested = |event: &str| record_hook_from(&db, Some("t1"), None, Some("sdk-cli"), &hook(event, "nested"));
        assert!(!nested("SessionStart"), "not queued at all");
        assert!(nested("Stop"), "its turn ending still settles the terminal's attention, as before");
        assert!(!nested("SessionEnd"));
        let rows = db.drain_hook_signals().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0].signal.as_str(), rows[0].session_id.as_deref()), ("settled", None), "without its session id");
        remember_sessions(&db, &rows);
        assert_eq!(session_of(&db, "t1").as_deref(), Some("parent"));

        // A CLI that doesn't say how it was started: the nested session is
        // taken for the terminal's while it runs, its end unlinks it, and the
        // parent's next signal puts the terminal back on the parent.
        let unsaid = |event: &str, session: &str| {
            std::thread::sleep(std::time::Duration::from_millis(3));
            assert!(record_hook_from(&db, Some("t1"), None, None, &hook(event, session)));
            poll_once(&db, true, Utc::now()).unwrap();
        };
        unsaid("SessionStart", "nested-2");
        assert_eq!(session_of(&db, "t1").as_deref(), Some("nested-2"));
        unsaid("SessionEnd", "nested-2");
        assert_eq!(session_of(&db, "t1"), None, "nothing is shown rather than the nested session");
        unsaid("Stop", "parent");
        assert_eq!(session_of(&db, "t1").as_deref(), Some("parent"));
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
