//! Talk checkpoints (#958): rewind a conversation's files to a turn.
//!
//! Before each Talk turn that can write, the worktree is snapshotted as a
//! commit under a private ref, `refs/octopush/talk/<thread>/<message>`, built
//! through a TEMPORARY index seeded from a copy of the real one (so only the
//! files that changed are hashed). The user's index, HEAD and branch never
//! move, and ignored files are never read. When the turn ends, a second
//! snapshot, `<message>-after`, records how the turn left the tree, so a
//! rewind can say which files someone other than this conversation changed
//! in between. Because the tree is snapshotted, not the tool calls, edits by
//! `write_file`, `run_command` and sub-agents are all covered.
//!
//! What a snapshot holds is bounded and filtered:
//! - a [`Budget`] caps the files and bytes it may hash and the time it may
//!   take; past it the turn gets no checkpoint and a `<message>-skipped`
//!   marker says why;
//! - a file whose name the Secret guard treats as sensitive (an env file, a
//!   private key…) is never stored, tracked or not.
//!
//! A rewind writes only the files that differ (deletions first, so a
//! case-only rename on macOS can't delete the file it just restored) and
//! keeps the state it replaced under `<thread>/undo`. What counts as ignored
//! depends on the `.gitignore` in the tree at that moment, so a rewind (and
//! its undo) never trusts one side alone: a path that is git-ignored under
//! the rules on disk now OR under the rules of the snapshot it is moving to
//! is left alone, a file on disk that the current snapshot doesn't know is
//! never overwritten, and a directory is only ever removed when it is empty.
//! Every path left alone is reported, so the dialog can list it.

use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::collections::{BTreeSet, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

pub const REF_ROOT: &str = "refs/octopush/talk";
/// Checkpoints older than this are pruned whenever a new one is taken.
pub const MAX_AGE_DAYS: i64 = 30;
/// The mode git records for a submodule; such entries are never rewound.
const GITLINK: &str = "160000";

/// What one snapshot may cost. It runs before the turn starts, so a large
/// untracked folder must not stall the turn or grow `.git/objects`.
#[derive(Debug, Clone, Copy)]
pub struct Budget {
    /// Changed or untracked files the snapshot may hash.
    pub files: usize,
    /// Their total size on disk.
    pub bytes: u64,
    /// Wall-clock time for the whole snapshot.
    pub timeout: Duration,
}

impl Budget {
    pub const DEFAULT: Budget =
        Budget { files: 5_000, bytes: 200 * 1024 * 1024, timeout: Duration::from_secs(20) };
}

fn git_cmd(ws: &Path, index: Option<&Path>, args: &[&str]) -> Command {
    let mut cmd = Command::new("git");
    cmd.args(args)
        .current_dir(ws)
        // A snapshot commit needs an identity, also where the user set none.
        .env("GIT_AUTHOR_NAME", "Octopush")
        .env("GIT_AUTHOR_EMAIL", "talk@octopush.local")
        .env("GIT_COMMITTER_NAME", "Octopush")
        .env("GIT_COMMITTER_EMAIL", "talk@octopush.local");
    if let Some(idx) = index {
        cmd.env("GIT_INDEX_FILE", idx);
    }
    cmd
}

fn git(ws: &Path, index: Option<&Path>, args: &[&str]) -> AppResult<Output> {
    git_cmd(ws, index, args)
        .output()
        .map_err(|e| AppError::Other(format!("git {args:?}: {e}")))
}

/// Run `cmd` to its end or to `deadline`, whichever comes first, feeding it
/// `stdin`. The pipes are drained on their own threads, so a child that
/// writes more than a pipe holds can't block the wait. Past the deadline the
/// child is killed and the call fails.
fn run_until(mut cmd: Command, stdin: Option<Vec<u8>>, deadline: Option<Instant>, what: &str) -> AppResult<Output> {
    if deadline.is_some_and(|d| Instant::now() >= d) {
        return Err(AppError::Other(TOOK_TOO_LONG.into()));
    }
    cmd.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| AppError::Other(format!("git {what}: {e}")))?;
    let writer = child.stdin.take().zip(stdin).map(|(mut pipe, bytes)| {
        std::thread::spawn(move || {
            // A child that exits early closes the pipe: its status tells.
            let _ = pipe.write_all(&bytes);
        })
    });
    fn drain<R: Read + Send + 'static>(pipe: Option<R>) -> std::thread::JoinHandle<Vec<u8>> {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            if let Some(mut p) = pipe {
                let _ = p.read_to_end(&mut buf);
            }
            buf
        })
    }
    let out = drain(child.stdout.take());
    let err = drain(child.stderr.take());
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AppError::Other(format!("git {what}: {e}")));
            }
        }
        if deadline.is_some_and(|d| Instant::now() >= d) {
            timed_out = true;
            let _ = child.kill();
            break child.wait().map_err(|e| AppError::Other(format!("git {what}: {e}")))?;
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    if let Some(w) = writer {
        let _ = w.join();
    }
    let stdout = out.join().unwrap_or_default();
    let stderr = err.join().unwrap_or_default();
    if timed_out {
        return Err(AppError::Other(TOOK_TOO_LONG.into()));
    }
    Ok(Output { status, stdout, stderr })
}

const TOOK_TOO_LONG: &str = "reading the changed files took too long";

fn stdout_ok(out: Output, what: &str) -> AppResult<String> {
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(AppError::Other(format!("{what}: {}", String::from_utf8_lossy(&out.stderr).trim())))
    }
}

fn bytes_ok(out: Output, what: &str) -> AppResult<Vec<u8>> {
    if out.status.success() {
        Ok(out.stdout)
    } else {
        Err(AppError::Other(format!("{what}: {}", String::from_utf8_lossy(&out.stderr).trim())))
    }
}

/// NUL-separated paths, as git prints them with `-z`.
fn split_z(out: &[u8]) -> Vec<String> {
    out.split(|&b| b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8_lossy(s).into_owned())
        .collect()
}

fn join_z<S: AsRef<str>>(paths: &[S]) -> Vec<u8> {
    let mut buf = Vec::new();
    for p in paths {
        buf.extend_from_slice(p.as_ref().as_bytes());
        buf.push(0);
    }
    buf
}

/// A file the Secret guard's name rules treat as sensitive: never stored in
/// a snapshot and never written or removed by a rewind.
fn sensitive(path: &str) -> bool {
    crate::secret_scan::is_sensitive_name(path)
}

/// A private scratch directory: an unpredictable name, created readable by
/// the user only (`tempfile`), removed with everything in it when dropped.
fn private_dir() -> AppResult<tempfile::TempDir> {
    Ok(tempfile::Builder::new().prefix("octopush-talk-").tempdir()?)
}

/// A temporary git index inside its own private directory. `.0` is the
/// index path; it doesn't exist until git writes it.
struct TempIndex(PathBuf, #[allow(dead_code)] tempfile::TempDir);

impl TempIndex {
    fn new() -> AppResult<Self> {
        let dir = private_dir()?;
        Ok(TempIndex(dir.path().join("index"), dir))
    }
}

/// A private scratch work tree. `.0` is its path.
struct TempDir(PathBuf, #[allow(dead_code)] tempfile::TempDir);

impl TempDir {
    fn new() -> AppResult<Self> {
        let dir = private_dir()?;
        Ok(TempDir(dir.path().to_path_buf(), dir))
    }
}

/// Thread ids are UUIDs; anything else is refused before it reaches a ref name.
fn valid_thread(thread_id: &str) -> bool {
    !thread_id.is_empty() && thread_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// A full or abbreviated object id, so a value from the webview can never be
/// read by git as an option.
fn valid_sha(s: &str) -> bool {
    (7..=64).contains(&s.len()) && s.chars().all(|c| c.is_ascii_hexdigit())
}

fn check_thread(thread_id: &str) -> AppResult<()> {
    if valid_thread(thread_id) {
        Ok(())
    } else {
        Err(AppError::Other(format!("invalid conversation id: {thread_id}")))
    }
}

pub fn ref_for(thread_id: &str, message_id: i64) -> String {
    format!("{REF_ROOT}/{thread_id}/{message_id}")
}

pub fn after_ref_for(thread_id: &str, message_id: i64) -> String {
    format!("{REF_ROOT}/{thread_id}/{message_id}-after")
}

pub fn undo_ref_for(thread_id: &str) -> String {
    format!("{REF_ROOT}/{thread_id}/undo")
}

pub fn rewound_ref_for(thread_id: &str) -> String {
    format!("{REF_ROOT}/{thread_id}/rewound")
}

/// Set while the thread's last rewind (or undo) stopped part-way.
pub fn partial_ref_for(thread_id: &str) -> String {
    format!("{REF_ROOT}/{thread_id}/partial")
}

/// The marker of a turn whose checkpoint was skipped; its commit message
/// carries the reason.
pub fn skipped_ref_for(thread_id: &str, message_id: i64) -> String {
    format!("{REF_ROOT}/{thread_id}/{message_id}-skipped")
}

/// Whether `ws` is the top of a git worktree. A folder that only sits
/// inside some parent repository (a home directory under git) is not: its
/// snapshot would be the whole parent tree, with paths that don't start at `ws`.
fn is_repo(ws: &Path) -> bool {
    git(ws, None, &["rev-parse", "--is-inside-work-tree", "--show-prefix"])
        .ok()
        .filter(|o| o.status.success())
        // `true` then an empty prefix: the trimmed output is exactly `true`.
        .is_some_and(|o| String::from_utf8_lossy(&o.stdout).trim() == "true")
}

fn check_repo(ws: &Path) -> AppResult<()> {
    if is_repo(ws) {
        Ok(())
    } else {
        Err(AppError::Other("This folder isn't the top of a git repository.".into()))
    }
}

fn resolve(ws: &Path, refname: &str) -> Option<String> {
    let spec = format!("{refname}^{{commit}}");
    let out = git(ws, None, &["rev-parse", "--verify", "-q", &spec]).ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn set_ref(ws: &Path, refname: &str, sha: &str) -> AppResult<()> {
    stdout_ok(git(ws, None, &["update-ref", refname, sha])?, "update-ref").map(|_| ())
}

fn delete_ref(ws: &Path, refname: &str) -> AppResult<()> {
    stdout_ok(git(ws, None, &["update-ref", "-d", refname])?, "update-ref -d").map(|_| ())
}

fn tree_of(ws: &Path, commit: &str) -> AppResult<String> {
    let spec = format!("{commit}^{{tree}}");
    stdout_ok(git(ws, None, &["rev-parse", "--verify", &spec])?, "rev-parse tree")
}

/// Snapshot the worktree as a commit (parent: HEAD, when there is one) and
/// return its id, within the default [`Budget`].
pub fn snapshot(ws: &Path) -> AppResult<String> {
    snapshot_with(ws, &Budget::DEFAULT)
}

/// Snapshot the worktree within `budget`. Tracked and untracked files are
/// captured; ignored files, sensitive-named files and embedded repositories
/// never are. The paths to hash are listed first and checked against the
/// budget BEFORE anything is written to the object store, so a snapshot that
/// is refused leaves no objects behind.
pub fn snapshot_with(ws: &Path, budget: &Budget) -> AppResult<String> {
    let deadline = Some(Instant::now() + budget.timeout);
    let idx = TempIndex::new()?;
    let head = git(ws, None, &["rev-parse", "--verify", "-q", "HEAD"])?;
    let head = head
        .status
        .success()
        .then(|| String::from_utf8_lossy(&head.stdout).trim().to_string());
    // Seed from the real index: its stat cache spares re-hashing every file.
    let real = stdout_ok(git(ws, None, &["rev-parse", "--git-path", "index"])?, "git-path index")?;
    let real = PathBuf::from(real);
    let real = if real.is_absolute() { real } else { ws.join(real) };
    if std::fs::copy(&real, &idx.0).is_err() {
        // No index yet: start from HEAD's tree (or from nothing in a new repo).
        if let Some(h) = &head {
            stdout_ok(git(ws, Some(&idx.0), &["read-tree", h])?, "read-tree")?;
        }
    }

    // Sensitive-named files leave the snapshot whatever the index says, so
    // a rewind never sees them as something to write or remove.
    let tracked = bytes_ok(
        run_until(git_cmd(ws, Some(&idx.0), &["ls-files", "-z", "--cached"]), None, deadline, "ls-files")?,
        "ls-files",
    )?;
    let mut remove: BTreeSet<String> = split_z(&tracked).into_iter().filter(|p| sensitive(p)).collect();

    // What differs from the index: modified, deleted and untracked files
    // (the standard ignore rules apply to the untracked ones).
    let changed = bytes_ok(
        run_until(
            git_cmd(
                ws,
                Some(&idx.0),
                &["ls-files", "-z", "--modified", "--deleted", "--others", "--exclude-standard"],
            ),
            None,
            deadline,
            "ls-files",
        )?,
        "ls-files",
    )?;
    let mut add: BTreeSet<String> = BTreeSet::new();
    let mut bytes: u64 = 0;
    for path in split_z(&changed) {
        // An untracked embedded repository is listed as `dir/`: left out,
        // like a submodule.
        if path.ends_with('/') || sensitive(&path) || add.contains(&path) {
            continue;
        }
        // A path behind a symbolic link is not in the worktree any more.
        let behind_link = ancestors(&path).into_iter().any(|a| on_disk(ws, a) != OnDisk::Dir);
        match std::fs::symlink_metadata(ws.join(&path)) {
            Ok(md) if !md.is_dir() && !behind_link => {
                bytes = bytes.saturating_add(md.len());
                add.insert(path);
                if add.len() > budget.files {
                    return Err(AppError::Other(format!("more than {} changed or untracked files", budget.files)));
                }
                if bytes > budget.bytes {
                    return Err(AppError::Other(format!(
                        "more than {} MB of changed or untracked files",
                        budget.bytes / (1024 * 1024)
                    )));
                }
            }
            // Gone, or a directory now sits where the file was.
            _ => {
                remove.insert(path);
            }
        }
    }
    if !remove.is_empty() {
        let list: Vec<&String> = remove.iter().collect();
        bytes_ok(
            run_until(
                git_cmd(ws, Some(&idx.0), &["update-index", "-z", "--force-remove", "--stdin"]),
                Some(join_z(&list)),
                deadline,
                "update-index",
            )?,
            "update-index (remove)",
        )?;
    }
    if !add.is_empty() {
        let list: Vec<&String> = add.iter().collect();
        // `--remove` only covers a file that vanished since it was listed.
        bytes_ok(
            run_until(
                git_cmd(ws, Some(&idx.0), &["update-index", "-z", "--add", "--remove", "--replace", "--stdin"]),
                Some(join_z(&list)),
                deadline,
                "update-index",
            )?,
            "update-index (add)",
        )?;
    }
    let tree = stdout_ok(
        run_until(git_cmd(ws, Some(&idx.0), &["write-tree"]), None, deadline, "write-tree")?,
        "write-tree",
    )?;
    let mut args = vec!["commit-tree", tree.as_str(), "-m", "octopush talk checkpoint"];
    if let Some(h) = &head {
        args.push("-p");
        args.push(h.as_str());
    }
    stdout_ok(git(ws, None, &args)?, "commit-tree")
}

/// The refs of one thread: (the part after `<thread>/`, object id).
fn thread_refs(ws: &Path, thread_id: &str) -> AppResult<Vec<(String, String)>> {
    let pattern = format!("{REF_ROOT}/{thread_id}");
    let prefix = format!("{pattern}/");
    let out = stdout_ok(
        git(ws, None, &["for-each-ref", "--format=%(refname) %(objectname)", &pattern])?,
        "for-each-ref",
    )?;
    Ok(out
        .lines()
        .filter_map(|l| {
            let (name, sha) = l.split_once(' ')?;
            Some((name.strip_prefix(&prefix)?.to_string(), sha.to_string()))
        })
        .collect())
}

/// The user-message ids of `thread_id` that have a checkpoint, ascending.
pub fn list(ws: &Path, thread_id: &str) -> AppResult<Vec<i64>> {
    if !valid_thread(thread_id) || !is_repo(ws) {
        return Ok(Vec::new());
    }
    let mut ids: Vec<i64> = thread_refs(ws, thread_id)?
        .iter()
        .filter_map(|(tail, _)| tail.parse().ok())
        .collect();
    ids.sort_unstable();
    ids.dedup();
    Ok(ids)
}

/// A turn that ran without a checkpoint, and why.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkippedTurn {
    pub message_id: i64,
    pub reason: String,
}

/// What the conversation shows per user turn: the turns whose files can be
/// rewound, and the turns that have no checkpoint, with the reason.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoints {
    pub turns: Vec<i64>,
    pub skipped: Vec<SkippedTurn>,
    /// The thread's last rewind can still be undone.
    pub can_undo: bool,
}

pub fn checkpoints(ws: &Path, thread_id: &str) -> AppResult<Checkpoints> {
    if !valid_thread(thread_id) || !is_repo(ws) {
        return Ok(Checkpoints::default());
    }
    let refs = thread_refs(ws, thread_id)?;
    let mut turns: Vec<i64> = refs.iter().filter_map(|(tail, _)| tail.parse().ok()).collect();
    turns.sort_unstable();
    turns.dedup();
    let mut skipped = Vec::new();
    for (tail, sha) in &refs {
        let Some(id) = tail.strip_suffix("-skipped").and_then(|t| t.parse::<i64>().ok()) else { continue };
        if turns.contains(&id) {
            continue;
        }
        let reason = git(ws, None, &["log", "-1", "--format=%b", sha])
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
        skipped.push(SkippedTurn { message_id: id, reason });
    }
    skipped.sort_by_key(|s| s.message_id);
    let has = |tail: &str| refs.iter().any(|(t, _)| t == tail);
    Ok(Checkpoints { turns, skipped, can_undo: has("undo") && has("rewound") })
}

/// Record that the turn `message_id` has no checkpoint: an empty commit
/// whose message carries `reason`, so the conversation can say so.
fn mark_skipped(ws: &Path, thread_id: &str, message_id: i64, reason: &str) -> AppResult<()> {
    let tree = stdout_ok(run_until(git_cmd(ws, None, &["mktree"]), Some(Vec::new()), None, "mktree")?, "mktree")?;
    let message = format!("octopush talk checkpoint skipped\n\n{reason}");
    let sha = stdout_ok(git(ws, None, &["commit-tree", &tree, "-m", &message])?, "commit-tree")?;
    set_ref(ws, &skipped_ref_for(thread_id, message_id), &sha)
}

/// Take the checkpoint of a user turn, unless it already has one (a
/// regenerate re-runs the same turn, whose checkpoint stays the state before
/// its first attempt). Best-effort: a failure only means no rewind for this
/// turn. Returns whether the turn has a checkpoint.
pub fn capture_before(ws: &Path, thread_id: &str, message_id: i64) -> bool {
    capture_before_with(ws, thread_id, message_id, &Budget::DEFAULT)
}

/// [`capture_before`] within `budget`. A snapshot that is over it, too slow
/// or failing is skipped and marked, and a regenerate of that turn takes
/// none either: the state before its first attempt is no longer there.
pub fn capture_before_with(ws: &Path, thread_id: &str, message_id: i64, budget: &Budget) -> bool {
    if !valid_thread(thread_id) || !is_repo(ws) {
        return false;
    }
    let name = ref_for(thread_id, message_id);
    if resolve(ws, &name).is_some() {
        return true;
    }
    if resolve(ws, &skipped_ref_for(thread_id, message_id)).is_some() {
        return false;
    }
    match snapshot_with(ws, budget).and_then(|sha| set_ref(ws, &name, &sha)) {
        Ok(()) => {
            if let Err(e) = prune_older_than(ws, MAX_AGE_DAYS) {
                tracing::warn!(error = %e, "talk checkpoints: pruning failed");
            }
            true
        }
        Err(e) => {
            tracing::warn!(error = %e, thread_id, message_id, "talk checkpoint skipped");
            let reason = e.to_string();
            let reason = reason.strip_prefix("other: ").unwrap_or(&reason);
            if let Err(e) = mark_skipped(ws, thread_id, message_id, reason) {
                tracing::warn!(error = %e, "talk checkpoint: could not record the skip");
            }
            false
        }
    }
}

/// Run checkpoint work (git subprocesses, file writes) on a blocking thread,
/// never on an async runtime worker.
pub async fn off_runtime<T, F>(f: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Other(format!("talk checkpoint: {e}")))?
}

/// The turn whose end must be recorded: `send_agentic` records it once the
/// turn returns — on every exit path, an error or a Stop included — while
/// the turn still counts as running, so no rewind can race the snapshot.
pub struct AfterTurn {
    ws: PathBuf,
    thread_id: String,
    message_id: i64,
}

impl AfterTurn {
    pub fn new(ws: &Path, thread_id: &str, message_id: i64) -> Self {
        AfterTurn { ws: ws.to_path_buf(), thread_id: thread_id.to_string(), message_id }
    }

    /// Snapshot how the turn left the tree as `<message>-after`. Best-effort.
    pub fn record(self) {
        let name = after_ref_for(&self.thread_id, self.message_id);
        if let Err(e) = snapshot(&self.ws).and_then(|sha| set_ref(&self.ws, &name, &sha)) {
            tracing::warn!(error = %e, "talk checkpoint (after turn) failed");
        }
    }

    /// `record`, on a blocking thread.
    pub async fn record_off_runtime(self) {
        if let Err(e) = off_runtime(move || {
            self.record();
            Ok(())
        })
        .await
        {
            tracing::warn!(error = %e, "talk checkpoint (after turn) failed");
        }
    }
}

/// One entry of `git diff-tree -r -z --raw`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawChange {
    /// `A`, `D`, `M` or `T`, from the first tree to the second.
    pub status: char,
    pub path: String,
    pub submodule: bool,
}

/// Parse `git diff-tree -r -z --no-renames` raw output:
/// `:<mode> <mode> <sha> <sha> <status>\0<path>\0` per entry.
pub fn parse_raw_diff(out: &[u8]) -> Vec<RawChange> {
    let parts: Vec<&[u8]> = out.split(|&b| b == 0).filter(|s| !s.is_empty()).collect();
    let mut changes = Vec::new();
    let mut i = 0;
    while i + 1 < parts.len() {
        let header = String::from_utf8_lossy(parts[i]);
        let Some(header) = header.strip_prefix(':') else {
            i += 1;
            continue;
        };
        let path = parts[i + 1];
        i += 2;
        let fields: Vec<&str> = header.split_whitespace().collect();
        if fields.len() < 5 {
            continue;
        }
        let status = fields[4].chars().next().unwrap_or('M');
        changes.push(RawChange {
            status,
            path: String::from_utf8_lossy(path).into_owned(),
            submodule: fields[0] == GITLINK || fields[1] == GITLINK,
        });
    }
    changes
}

fn diff(ws: &Path, from: &str, to: &str) -> AppResult<Vec<RawChange>> {
    let out = git(ws, None, &["diff-tree", "-r", "-z", "--no-renames", from, to])?;
    if !out.status.success() {
        return Err(AppError::Other(format!("diff-tree: {}", String::from_utf8_lossy(&out.stderr).trim())));
    }
    Ok(parse_raw_diff(&out.stdout))
}

/// One file a rewind will change.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RewindChange {
    pub path: String,
    /// `restored` (gone now, back after), `removed` (created since) or
    /// `reverted` (its content goes back).
    pub kind: &'static str,
    /// Changed between this conversation's turns (by the user, another
    /// conversation, a terminal), so the rewind would undo that too.
    pub outside_talk: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RewindPreview {
    pub message_id: i64,
    /// The snapshot of the tree as previewed: the rewind refuses to run if
    /// the files moved on since.
    pub current: String,
    pub changes: Vec<RewindChange>,
    /// Paths that differ but that the rewind will not write or remove.
    pub untouched: Vec<Untouched>,
}

/// A path a rewind left as it is on disk, and why.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Untouched {
    pub path: String,
    /// `ignored` (git-ignored now or at the destination), `sensitive` (a
    /// name the Secret guard protects: such a file is in no snapshot, so it
    /// is listed when it is tracked and differs from the last commit), `exists` (something the current
    /// snapshot doesn't hold is on disk there), `unchecked` (its ignore
    /// status couldn't be established) or `failed` (it couldn't be removed).
    pub reason: &'static str,
}

/// What a rewind or an undo did.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RewindOutcome {
    /// Files written or removed.
    pub changed: usize,
    pub untouched: Vec<Untouched>,
    /// Set when it stopped part-way: some files were changed, some not.
    pub error: Option<String>,
    /// The state before the rewind is kept and can be put back.
    pub can_undo: bool,
}

/// The paths changed outside this thread's turns since the turn `from_id`:
/// between each turn's end (`-after`) and the next turn's start, and between
/// the last turn's end and `current`. A turn with no `-after` (interrupted
/// hard) contributes nothing rather than a guess.
fn outside_paths(ws: &Path, thread_id: &str, from_id: i64, current: &str) -> AppResult<HashSet<String>> {
    let refs = thread_refs(ws, thread_id)?;
    let sha_of = |tail: &str| refs.iter().find(|(t, _)| t == tail).map(|(_, s)| s.clone());
    let mut turns: Vec<i64> = refs.iter().filter_map(|(t, _)| t.parse().ok()).filter(|&id| id >= from_id).collect();
    turns.sort_unstable();
    turns.dedup();
    let mut paths = HashSet::new();
    for (i, id) in turns.iter().enumerate() {
        let Some(after) = sha_of(&format!("{id}-after")) else { continue };
        let next = match turns.get(i + 1) {
            Some(n) => sha_of(&n.to_string()),
            None => Some(current.to_string()),
        };
        let Some(next) = next else { continue };
        for c in diff(ws, &after, &next)? {
            paths.insert(c.path);
        }
    }
    Ok(paths)
}

/// The paths among `paths` that the ignore rules protect, as (ignored,
/// unchecked): ignored under the rules on disk now, or under the
/// `.gitignore` files of the snapshot `target`. Both are asked with
/// `--no-index`, so a path that matches a rule counts even when it is
/// tracked: when in doubt the file is left alone. A path git can't answer
/// for (it now sits behind a symbolic link, say) is `unchecked`.
fn protected_paths(ws: &Path, target: &str, paths: &[String]) -> AppResult<(HashSet<String>, HashSet<String>)> {
    let mut ignored = HashSet::new();
    let mut unchecked = HashSet::new();
    if paths.is_empty() {
        return Ok((ignored, unchecked));
    }
    // 1. The rules on disk now (every `.gitignore`, `info/exclude`, the
    //    user's global excludes).
    check_ignore(ws, None, paths, &mut ignored, &mut unchecked)?;

    // 2. The rules of the destination: its `.gitignore` files, laid out in
    //    a scratch work tree that holds nothing else.
    let listing = bytes_ok(git(ws, None, &["ls-tree", "-r", "-z", target])?, "ls-tree")?;
    let rules: Vec<String> = listing
        .split(|&b| b == 0)
        .filter_map(|entry| {
            let entry = String::from_utf8_lossy(entry);
            let (meta, path) = entry.split_once('\t')?;
            let regular = meta.starts_with("100644 ") || meta.starts_with("100755 ");
            let named = path == ".gitignore" || path.ends_with("/.gitignore");
            (regular && named).then(|| path.to_string())
        })
        .collect();
    if !rules.is_empty() {
        let scratch = TempDir::new()?;
        let idx = TempIndex::new()?;
        stdout_ok(git(ws, Some(&idx.0), &["read-tree", target])?, "read-tree")?;
        let prefix = format!("--prefix={}/", scratch.0.display());
        bytes_ok(
            run_until(
                git_cmd(ws, Some(&idx.0), &["checkout-index", "-z", "--stdin", &prefix]),
                Some(join_z(&rules)),
                None,
                "checkout-index",
            )?,
            "checkout-index (rules)",
        )?;
        let git_dir = stdout_ok(git(ws, None, &["rev-parse", "--absolute-git-dir"])?, "rev-parse git-dir")?;
        let rest: Vec<String> = paths.iter().filter(|p| !ignored.contains(*p)).cloned().collect();
        check_ignore(&scratch.0, Some(&git_dir), &rest, &mut ignored, &mut unchecked)?;
    }
    Ok((ignored, unchecked))
}

/// `git check-ignore` for `paths` in `dir` (with `git_dir`, `dir` is a
/// scratch work tree of that repository). When git refuses the batch, each
/// path is asked alone and the ones it still refuses are `unchecked`.
fn check_ignore(
    dir: &Path,
    git_dir: Option<&str>,
    paths: &[String],
    ignored: &mut HashSet<String>,
    unchecked: &mut HashSet<String>,
) -> AppResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let ask = |batch: &[String]| -> AppResult<Option<Vec<String>>> {
        let mut cmd = Command::new("git");
        if let Some(gd) = git_dir {
            cmd.arg(format!("--git-dir={gd}")).arg(format!("--work-tree={}", dir.display()));
        }
        cmd.args(["check-ignore", "--no-index", "-z", "--stdin"]).current_dir(dir);
        let out = run_until(cmd, Some(join_z(batch)), None, "check-ignore")?;
        // 0: some are ignored · 1: none is · anything else: git refused.
        Ok(match out.status.code() {
            Some(0) | Some(1) => Some(split_z(&out.stdout)),
            _ => None,
        })
    };
    if let Some(hits) = ask(paths)? {
        ignored.extend(hits);
        return Ok(());
    }
    // Asking one by one costs a process each: past a small batch, everything
    // is simply left alone.
    if paths.len() > 200 {
        unchecked.extend(paths.iter().cloned());
        return Ok(());
    }
    for p in paths {
        match ask(std::slice::from_ref(p))? {
            Some(hits) => ignored.extend(hits),
            None => {
                unchecked.insert(p.clone());
            }
        }
    }
    Ok(())
}

/// What sits on disk at `rel`, links not followed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OnDisk {
    Nothing,
    File,
    Dir,
}

fn on_disk(ws: &Path, rel: &str) -> OnDisk {
    match std::fs::symlink_metadata(ws.join(rel)) {
        Ok(md) if md.is_dir() => OnDisk::Dir,
        Ok(_) => OnDisk::File,
        Err(_) => OnDisk::Nothing,
    }
}

/// The parent paths of `rel`, outermost first (`a`, `a/b` for `a/b/c`).
fn ancestors(rel: &str) -> Vec<&str> {
    rel.match_indices('/').map(|(i, _)| &rel[..i]).collect()
}

/// What a rewind will do, decided before anything is written.
#[derive(Debug, Default)]
struct Plan {
    /// In the current snapshot, not in the destination.
    deletes: Vec<String>,
    /// In the destination, not in the current snapshot: written only where
    /// nothing is on disk.
    creates: Vec<String>,
    /// In both, with different content.
    rewrites: Vec<String>,
    untouched: Vec<Untouched>,
}

/// Plan the move of the worktree from the snapshot `current` to `target`.
/// `current` must be a snapshot of the tree as it is on disk: what it
/// doesn't hold is, by construction, ignored, sensitive or unknown, and so
/// not the rewind's to touch.
fn plan(ws: &Path, current: &str, target: &str) -> AppResult<Plan> {
    let changes: Vec<RawChange> = diff(ws, current, target)?.into_iter().filter(|c| !c.submodule).collect();
    let paths: Vec<String> = changes.iter().map(|c| c.path.clone()).collect();
    let (ignored, unchecked) = protected_paths(ws, target, &paths)?;
    let reason_for = |path: &str| -> Option<&'static str> {
        if sensitive(path) {
            Some("sensitive")
        } else if ignored.contains(path) {
            Some("ignored")
        } else if unchecked.contains(path) {
            Some("unchecked")
        } else {
            None
        }
    };
    let mut plan = Plan::default();
    let mut pending = Vec::new();
    for c in changes {
        if let Some(reason) = reason_for(&c.path) {
            plan.untouched.push(Untouched { path: c.path, reason });
        } else if c.status == 'D' {
            plan.deletes.push(c.path);
        } else {
            pending.push(c);
        }
    }
    // A write may count on what the deletions clear first: a parent path
    // that is a file to remove, a directory whose files are removed, or the
    // other spelling of a case-only rename.
    let deleting: HashSet<&str> = plan.deletes.iter().map(String::as_str).collect();
    let deleting_lower: HashSet<String> = plan.deletes.iter().map(|p| p.to_lowercase()).collect();
    let mut blocked = Vec::new();
    for c in pending {
        let parent_in_the_way = ancestors(&c.path)
            .into_iter()
            .any(|a| on_disk(ws, a) == OnDisk::File && !deleting.contains(a));
        let dir_prefix = format!("{}/", c.path);
        let clears = plan.deletes.iter().any(|d| d.starts_with(&dir_prefix));
        let create = c.status == 'A';
        let leaf_in_the_way = match on_disk(ws, &c.path) {
            OnDisk::Nothing => false,
            // A file the current snapshot doesn't hold is never overwritten.
            OnDisk::File => create && !deleting_lower.contains(&c.path.to_lowercase()),
            OnDisk::Dir => !clears,
        };
        if parent_in_the_way || leaf_in_the_way {
            blocked.push(Untouched { path: c.path, reason: "exists" });
        } else if create {
            plan.creates.push(c.path);
        } else {
            plan.rewrites.push(c.path);
        }
    }
    plan.untouched.append(&mut blocked);
    // Sensitive-named files are in no snapshot, so a change to one never
    // shows in the diff above. A tracked one that differs from the last
    // commit is reported all the same: the rewind can't put it back, and
    // must not pass over it in silence.
    for path in changed_sensitive(ws) {
        if !plan.untouched.iter().any(|u| u.path == path) {
            plan.untouched.push(Untouched { path, reason: "sensitive" });
        }
    }
    Ok(plan)
}

/// The tracked, sensitive-named files whose content on disk differs from
/// HEAD (edited, staged or deleted). Git compares them in memory: nothing
/// is stored. Empty when there is no commit yet or git can't say.
fn changed_sensitive(ws: &Path) -> Vec<String> {
    let Ok(out) = git(ws, None, &["diff", "--name-only", "-z", "--no-renames", "HEAD", "--"]) else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    split_z(&out.stdout).into_iter().filter(|p| sensitive(p)).collect()
}

/// What rewinding to the checkpoint of `message_id` would change, against
/// the tree as it is now.
pub fn preview(ws: &Path, thread_id: &str, message_id: i64) -> AppResult<RewindPreview> {
    check_thread(thread_id)?;
    check_repo(ws)?;
    let target = resolve(ws, &ref_for(thread_id, message_id))
        .ok_or_else(|| AppError::Other("This turn has no checkpoint.".into()))?;
    let current = snapshot(ws).map_err(cannot_read)?;
    let outside = outside_paths(ws, thread_id, message_id, &current)?;
    let plan = plan(ws, &current, &target)?;
    let change = |path: &String, kind: &'static str| RewindChange {
        outside_talk: outside.contains(path),
        kind,
        path: path.clone(),
    };
    let mut changes: Vec<RewindChange> = plan
        .creates
        .iter()
        .map(|p| change(p, "restored"))
        .chain(plan.deletes.iter().map(|p| change(p, "removed")))
        .chain(plan.rewrites.iter().map(|p| change(p, "reverted")))
        .collect();
    changes.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(RewindPreview { message_id, current, changes, untouched: plan.untouched })
}

/// A snapshot that couldn't be taken, said as what it means for a rewind.
fn cannot_read(e: AppError) -> AppError {
    let s = e.to_string();
    let s = s.strip_prefix("other: ").unwrap_or(&s);
    AppError::Other(format!("The files can't be compared right now: {s}."))
}

/// Run `git checkout-index` for `paths` out of `index`. With `force`, a
/// file on disk is replaced; without it, git itself refuses to write over
/// anything.
fn checkout(ws: &Path, index: &Path, paths: &[String], force: bool) -> AppResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut args = vec!["checkout-index", "-z", "--stdin"];
    if force {
        args.push("-f");
    }
    let out = run_until(git_cmd(ws, Some(index), &args), Some(join_z(paths)), None, "checkout-index")?;
    bytes_ok(out, "checkout-index").map(|_| ())
}

/// Carry out `plan`, moving the worktree towards `target`. Deletions run
/// first: a directory that becomes a file (or a case-only rename on a
/// case-insensitive disk) is then written cleanly. Only files are removed,
/// and a directory only once it is empty, so whatever else it holds stays.
/// Each write is checked against the disk again after the deletions.
/// Returns the files changed, every path left as it was, and the error when
/// it stopped part-way.
fn apply(ws: &Path, target: &str, plan: Plan) -> (usize, Vec<Untouched>, Option<AppError>) {
    let mut untouched = plan.untouched;
    let mut changed = 0;
    for path in &plan.deletes {
        let p = ws.join(path);
        match std::fs::remove_file(&p) {
            Ok(()) => changed += 1,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => changed += 1,
            Err(_) => {
                untouched.push(Untouched { path: path.clone(), reason: "failed" });
                continue;
            }
        }
        let mut parent = p.parent();
        while let Some(dir) = parent {
            // `remove_dir` only ever removes an empty directory.
            if dir == ws || std::fs::remove_dir(dir).is_err() {
                break;
            }
            parent = dir.parent();
        }
    }
    let clear_above = |path: &str| ancestors(path).into_iter().all(|a| on_disk(ws, a) != OnDisk::File);
    let mut creates = Vec::new();
    for path in plan.creates {
        if clear_above(&path) && on_disk(ws, &path) == OnDisk::Nothing {
            creates.push(path);
        } else {
            untouched.push(Untouched { path, reason: "exists" });
        }
    }
    let mut rewrites = Vec::new();
    for path in plan.rewrites {
        if clear_above(&path) && on_disk(ws, &path) != OnDisk::Dir {
            rewrites.push(path);
        } else {
            untouched.push(Untouched { path, reason: "exists" });
        }
    }
    let written = TempIndex::new().and_then(|idx| {
        stdout_ok_res(git(ws, Some(&idx.0), &["read-tree", target]), "read-tree")
            .and_then(|_| checkout(ws, &idx.0, &creates, false))
            .and_then(|_| checkout(ws, &idx.0, &rewrites, true))
    });
    match written {
        Ok(()) => (changed + creates.len() + rewrites.len(), untouched, None),
        Err(e) => (changed, untouched, Some(e)),
    }
}

fn stdout_ok_res(out: AppResult<Output>, what: &str) -> AppResult<String> {
    stdout_ok(out?, what)
}

fn same_tree(ws: &Path, a: &str, b: &str) -> bool {
    matches!((tree_of(ws, a), tree_of(ws, b)), (Ok(x), Ok(y)) if x == y)
}

/// Snapshot what a rewind or an undo left, as `<thread>/rewound`: the undo
/// compares the tree with it. Without it there is nothing safe to undo, so
/// a stale one is dropped. Returns whether it was recorded.
fn record_left(ws: &Path, thread_id: &str) -> bool {
    let name = rewound_ref_for(thread_id);
    match snapshot(ws).and_then(|sha| set_ref(ws, &name, &sha)) {
        Ok(()) => true,
        Err(e) => {
            tracing::warn!(error = %e, "talk rewind: could not record the state it left");
            let _ = delete_ref(ws, &name);
            false
        }
    }
}

fn outcome(
    ws: &Path,
    thread_id: &str,
    (changed, untouched, failed): (usize, Vec<Untouched>, Option<AppError>),
    can_undo: bool,
) -> RewindOutcome {
    let partial = partial_ref_for(thread_id);
    let error = failed.map(|e| {
        tracing::warn!(error = %e, "talk rewind stopped part-way");
        let s = e.to_string();
        s.strip_prefix("other: ").unwrap_or(&s).to_string()
    });
    if error.is_some() && can_undo {
        if let Some(sha) = resolve(ws, &undo_ref_for(thread_id)) {
            let _ = set_ref(ws, &partial, &sha);
        }
    } else if resolve(ws, &partial).is_some() {
        let _ = delete_ref(ws, &partial);
    }
    RewindOutcome { changed, untouched, error, can_undo }
}

/// Rewind the worktree to the checkpoint of `message_id`. `expected` is the
/// `current` of the preview the user confirmed: if the files changed since,
/// nothing is written and the user is asked to look again. The replaced
/// state is kept as the thread's undo, and the state the rewind left as
/// `<thread>/rewound`, so the undo can tell whether anything moved on since.
///
/// A rewind that stops part-way still returns `Ok`, with `error` set and
/// the undo on offer. Trying again from that half-rewound state keeps the
/// FIRST undo target: the undo then goes back to before the first attempt,
/// not to the half-way state.
pub fn rewind(ws: &Path, thread_id: &str, message_id: i64, expected: &str) -> AppResult<RewindOutcome> {
    check_thread(thread_id)?;
    check_repo(ws)?;
    if !valid_sha(expected) {
        return Err(AppError::Other("invalid preview id".into()));
    }
    let target = resolve(ws, &ref_for(thread_id, message_id))
        .ok_or_else(|| AppError::Other("This turn has no checkpoint.".into()))?;
    let now = snapshot(ws).map_err(cannot_read)?;
    if tree_of(ws, &now)? != tree_of(ws, expected)? {
        return Err(AppError::Other("The files changed since the preview. Look at the rewind again.".into()));
    }
    let plan = plan(ws, &now, &target)?;
    let undo_ref = undo_ref_for(thread_id);
    let resuming = resolve(ws, &partial_ref_for(thread_id)).is_some()
        && resolve(ws, &undo_ref).is_some()
        && resolve(ws, &rewound_ref_for(thread_id)).is_some_and(|left| same_tree(ws, &left, &now));
    if !resuming {
        set_ref(ws, &undo_ref, &now)?;
    }
    let done = apply(ws, &target, plan);
    let can_undo = record_left(ws, thread_id);
    Ok(outcome(ws, thread_id, done, can_undo))
}

/// Put back the tree the thread's last rewind replaced. Refused when the
/// files no longer match what the rewind left (a new turn or the user changed
/// them since): the undo would silently revert those edits too. It follows
/// the same rules as a rewind, so it never writes over or removes an ignored
/// file either. An undo that stops part-way keeps its target and can be
/// run again.
pub fn undo(ws: &Path, thread_id: &str) -> AppResult<RewindOutcome> {
    check_thread(thread_id)?;
    check_repo(ws)?;
    let undo_ref = undo_ref_for(thread_id);
    let rewound_ref = rewound_ref_for(thread_id);
    let (Some(target), Some(left)) = (resolve(ws, &undo_ref), resolve(ws, &rewound_ref)) else {
        return Err(AppError::Other("Nothing to undo.".into()));
    };
    let now = snapshot(ws).map_err(cannot_read)?;
    if tree_of(ws, &now)? != tree_of(ws, &left)? {
        return Err(AppError::Other(
            "The files changed since the rewind, so it can't be undone without losing those changes.".into(),
        ));
    }
    let plan = plan(ws, &now, &target)?;
    let done = apply(ws, &target, plan);
    if done.2.is_some() {
        let can_undo = record_left(ws, thread_id);
        return Ok(outcome(ws, thread_id, done, can_undo));
    }
    delete_ref(ws, &undo_ref)?;
    delete_ref(ws, &rewound_ref)?;
    Ok(outcome(ws, thread_id, done, false))
}

/// Give a forked thread the checkpoints of the turns it copied:
/// `pairs` maps each copied message id to its id in the fork.
pub fn copy_to_fork(ws: &Path, from_thread: &str, to_thread: &str, pairs: &[(i64, i64)]) {
    if !valid_thread(from_thread) || !valid_thread(to_thread) || !is_repo(ws) {
        return;
    }
    let Ok(refs) = thread_refs(ws, from_thread) else { return };
    for (old, new) in pairs {
        for (src, dst) in [
            (old.to_string(), ref_for(to_thread, *new)),
            (format!("{old}-after"), after_ref_for(to_thread, *new)),
            (format!("{old}-skipped"), skipped_ref_for(to_thread, *new)),
        ] {
            if let Some((_, sha)) = refs.iter().find(|(t, _)| *t == src) {
                if let Err(e) = set_ref(ws, &dst, sha) {
                    tracing::warn!(error = %e, "talk checkpoint copy to fork failed");
                }
            }
        }
    }
}

/// Delete every checkpoint of a thread (the thread is being deleted).
pub fn prune_thread(ws: &Path, thread_id: &str) {
    if !valid_thread(thread_id) || !is_repo(ws) {
        return;
    }
    let Ok(refs) = thread_refs(ws, thread_id) else { return };
    for (tail, _) in refs {
        let _ = delete_ref(ws, &format!("{REF_ROOT}/{thread_id}/{tail}"));
    }
}

/// Delete every checkpoint of `thread_ids` from the repository `dir` belongs
/// to (their workspace is being deleted or archived). The refs live in the
/// repository's shared git directory, so any of its checkouts will do.
pub fn prune_threads(dir: &Path, thread_ids: &[String]) {
    let inside = git(dir, None, &["rev-parse", "--git-dir"]).is_ok_and(|o| o.status.success());
    if !inside {
        return;
    }
    for thread_id in thread_ids.iter().filter(|t| valid_thread(t)) {
        let Ok(refs) = thread_refs(dir, thread_id) else { continue };
        for (tail, _) in refs {
            let _ = delete_ref(dir, &format!("{REF_ROOT}/{thread_id}/{tail}"));
        }
    }
}

/// The refs among `lines` (`<refname> <unix seconds>`) older than `cutoff`.
pub fn expired_refs(lines: &str, cutoff: i64) -> Vec<String> {
    lines
        .lines()
        .filter_map(|l| {
            let (name, ts) = l.rsplit_once(' ')?;
            let ts: i64 = ts.trim().parse().ok()?;
            (ts < cutoff).then(|| name.to_string())
        })
        .collect()
}

/// Delete every Talk checkpoint of the repository older than `days`.
pub fn prune_older_than(ws: &Path, days: i64) -> AppResult<usize> {
    let out = stdout_ok(
        git(ws, None, &["for-each-ref", "--format=%(refname) %(committerdate:unix)", REF_ROOT])?,
        "for-each-ref",
    )?;
    let cutoff = chrono::Utc::now().timestamp() - days * 86_400;
    let old = expired_refs(&out, cutoff);
    for name in &old {
        delete_ref(ws, name)?;
    }
    Ok(old.len())
}
