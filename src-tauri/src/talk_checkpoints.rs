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
//! A rewind writes only the files that differ (deletions first, so a
//! case-only rename on macOS can't delete the file it just restored) and
//! keeps the state it replaced under `<thread>/undo`.

use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

pub const REF_ROOT: &str = "refs/octopush/talk";
/// Checkpoints older than this are pruned whenever a new one is taken.
pub const MAX_AGE_DAYS: i64 = 30;
/// The mode git records for a submodule; such entries are never rewound.
const GITLINK: &str = "160000";

static IDX_SEQ: AtomicU64 = AtomicU64::new(0);

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

fn stdout_ok(out: Output, what: &str) -> AppResult<String> {
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(AppError::Other(format!("{what}: {}", String::from_utf8_lossy(&out.stderr).trim())))
    }
}

/// A temp index path that is removed when dropped.
struct TempIndex(PathBuf);

impl TempIndex {
    fn new() -> Self {
        let seq = IDX_SEQ.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!("octopush-talk-idx-{}-{}", std::process::id(), seq));
        let _ = std::fs::remove_file(&p);
        TempIndex(p)
    }
}

impl Drop for TempIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
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

fn is_repo(ws: &Path) -> bool {
    git(ws, None, &["rev-parse", "--git-dir"]).map(|o| o.status.success()).unwrap_or(false)
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
/// return its id. Tracked and untracked files are captured, ignored ones never.
pub fn snapshot(ws: &Path) -> AppResult<String> {
    let idx = TempIndex::new();
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
    stdout_ok(git(ws, Some(&idx.0), &["add", "-A"])?, "add -A")?;
    let tree = stdout_ok(git(ws, Some(&idx.0), &["write-tree"])?, "write-tree")?;
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

/// Take the checkpoint of a user turn, unless it already has one (a
/// regenerate re-runs the same turn, whose checkpoint stays the state before
/// its first attempt). Best-effort: a failure only means no rewind for this
/// turn. Returns whether the turn has a checkpoint.
pub fn capture_before(ws: &Path, thread_id: &str, message_id: i64) -> bool {
    if !valid_thread(thread_id) || !is_repo(ws) {
        return false;
    }
    let name = ref_for(thread_id, message_id);
    if resolve(ws, &name).is_some() {
        return true;
    }
    match snapshot(ws).and_then(|sha| set_ref(ws, &name, &sha)) {
        Ok(()) => {
            if let Err(e) = prune_older_than(ws, MAX_AGE_DAYS) {
                tracing::warn!(error = %e, "talk checkpoints: pruning failed");
            }
            true
        }
        Err(e) => {
            tracing::warn!(error = %e, thread_id, message_id, "talk checkpoint capture failed");
            false
        }
    }
}

/// Records how a turn left the tree when it is dropped — on every exit path
/// of the turn, an error or a Stop included.
pub struct AfterTurn {
    ws: PathBuf,
    thread_id: String,
    message_id: i64,
}

impl AfterTurn {
    pub fn new(ws: &Path, thread_id: &str, message_id: i64) -> Self {
        AfterTurn { ws: ws.to_path_buf(), thread_id: thread_id.to_string(), message_id }
    }
}

impl Drop for AfterTurn {
    fn drop(&mut self) {
        let name = after_ref_for(&self.thread_id, self.message_id);
        if let Err(e) = snapshot(&self.ws).and_then(|sha| set_ref(&self.ws, &name, &sha)) {
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
}

fn kind_of(status: char) -> &'static str {
    match status {
        'A' => "restored",
        'D' => "removed",
        _ => "reverted",
    }
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

/// What rewinding to the checkpoint of `message_id` would change, against
/// the tree as it is now.
pub fn preview(ws: &Path, thread_id: &str, message_id: i64) -> AppResult<RewindPreview> {
    check_thread(thread_id)?;
    let target = resolve(ws, &ref_for(thread_id, message_id))
        .ok_or_else(|| AppError::Other("This turn has no checkpoint.".into()))?;
    let current = snapshot(ws)?;
    let outside = outside_paths(ws, thread_id, message_id, &current)?;
    let changes = diff(ws, &current, &target)?
        .into_iter()
        .filter(|c| !c.submodule)
        .map(|c| RewindChange {
            outside_talk: outside.contains(&c.path),
            kind: kind_of(c.status),
            path: c.path,
        })
        .collect();
    Ok(RewindPreview { message_id, current, changes })
}

/// Make the worktree match `target` from `current` by writing only the files
/// that differ. Deletions run first: a directory that becomes a file (or a
/// case-only rename on a case-insensitive disk) is then written cleanly.
fn apply(ws: &Path, current: &str, target: &str) -> AppResult<usize> {
    let changes: Vec<RawChange> = diff(ws, current, target)?.into_iter().filter(|c| !c.submodule).collect();
    for c in changes.iter().filter(|c| c.status == 'D') {
        let p = ws.join(&c.path);
        let _ = std::fs::remove_file(&p);
        let mut parent = p.parent();
        while let Some(dir) = parent {
            if dir == ws {
                break;
            }
            if std::fs::read_dir(dir).map(|mut d| d.next().is_none()).unwrap_or(false) {
                let _ = std::fs::remove_dir(dir);
                parent = dir.parent();
            } else {
                break;
            }
        }
    }
    let writes: Vec<&str> = changes.iter().filter(|c| c.status != 'D').map(|c| c.path.as_str()).collect();
    if !writes.is_empty() {
        let idx = TempIndex::new();
        stdout_ok(git(ws, Some(&idx.0), &["read-tree", target])?, "read-tree")?;
        let mut child = git_cmd(ws, Some(&idx.0), &["checkout-index", "-f", "-z", "--stdin"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| AppError::Other(format!("git checkout-index: {e}")))?;
        if let Some(mut stdin) = child.stdin.take() {
            for p in &writes {
                stdin.write_all(p.as_bytes())?;
                stdin.write_all(&[0])?;
            }
        }
        let out = child.wait_with_output()?;
        if !out.status.success() {
            return Err(AppError::Other(format!(
                "checkout-index: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            )));
        }
    }
    Ok(changes.len())
}

/// Rewind the worktree to the checkpoint of `message_id`. `expected` is the
/// `current` of the preview the user confirmed: if the files changed since,
/// nothing is written and the user is asked to look again. The replaced
/// state is kept as the thread's undo. Returns the number of files changed.
pub fn rewind(ws: &Path, thread_id: &str, message_id: i64, expected: &str) -> AppResult<usize> {
    check_thread(thread_id)?;
    if !valid_sha(expected) {
        return Err(AppError::Other("invalid preview id".into()));
    }
    let target = resolve(ws, &ref_for(thread_id, message_id))
        .ok_or_else(|| AppError::Other("This turn has no checkpoint.".into()))?;
    let now = snapshot(ws)?;
    if tree_of(ws, &now)? != tree_of(ws, expected)? {
        return Err(AppError::Other("The files changed since the preview. Look at the rewind again.".into()));
    }
    set_ref(ws, &undo_ref_for(thread_id), &now)?;
    apply(ws, &now, &target)
}

/// Put back the tree the thread's last rewind replaced.
pub fn undo(ws: &Path, thread_id: &str) -> AppResult<usize> {
    check_thread(thread_id)?;
    let undo_ref = undo_ref_for(thread_id);
    let target = resolve(ws, &undo_ref).ok_or_else(|| AppError::Other("Nothing to undo.".into()))?;
    let now = snapshot(ws)?;
    let n = apply(ws, &now, &target)?;
    delete_ref(ws, &undo_ref)?;
    Ok(n)
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
