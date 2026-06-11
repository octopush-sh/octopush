//! Git operations for project and workspace management.

use crate::error::{AppError, AppResult};
use git2::{Repository, StatusOptions, WorktreeAddOptions};
use serde::Serialize;
use std::path::Path;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub branch: Option<String>,
    pub changed_files: Vec<FileChange>,
    pub ahead: usize,
    pub behind: usize,
    /// Whether the current branch has an upstream tracking branch configured.
    /// `false` means the branch has never been pushed — Publish needs to
    /// `--set-upstream` to create it.
    pub has_upstream: bool,
    /// Count of files with an unresolved merge conflict.
    pub conflicted: usize,
    /// False when ahead/behind couldn't be computed in time (huge-graph timeout);
    /// the UI hides the ↑/↓ badge rather than showing a misleading 0.
    pub ahead_behind_known: bool,
    /// The in-progress multi-step operation, if any: "merge" or "rebase".
    /// None when the repo is in its normal state.
    pub operation: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub status: String,
    /// The file has changes in the index (staged for commit).
    pub staged: bool,
    /// The file has unstaged worktree modifications.
    pub unstaged: bool,
    /// The file is in an unresolved merge-conflict (unmerged index) state.
    pub conflicted: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullOutcome { pub kind: PullKind, pub output: String }

#[derive(Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum PullKind { Ok, Diverged, Conflict, Error }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinueOutcome { pub kind: ContinueKind, pub output: String }

#[derive(Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum ContinueKind { Ok, MoreConflicts, Error }

/// Classify a `git merge|rebase --continue` result from its exit success +
/// combined output. Pure. MoreConflicts = the next step of a multi-commit
/// rebase hit conflicts (the resolution section should persist).
pub fn classify_continue(success: bool, combined: &str) -> ContinueKind {
    let s = combined.to_lowercase();
    if success {
        ContinueKind::Ok
    } else if s.contains("conflict") || s.contains("could not apply") {
        ContinueKind::MoreConflicts
    } else {
        ContinueKind::Error
    }
}

/// Classify a `git pull` result from its exit success + combined output. Pure.
pub fn classify_pull(success: bool, combined: &str) -> PullKind {
    let s = combined.to_lowercase();
    if success {
        PullKind::Ok
    } else if s.contains("not possible to fast-forward") || s.contains("divergent") || s.contains("have diverged") {
        PullKind::Diverged
    } else if s.contains("conflict") || s.contains("automatic merge failed") || s.contains("could not apply") {
        PullKind::Conflict
    } else {
        PullKind::Error
    }
}

/// Map a libgit2 repository state to the operation name the UI cares about.
fn state_to_operation(state: git2::RepositoryState) -> Option<&'static str> {
    match state {
        git2::RepositoryState::Merge => Some("merge"),
        git2::RepositoryState::Rebase
        | git2::RepositoryState::RebaseInteractive
        | git2::RepositoryState::RebaseMerge => Some("rebase"),
        _ => None,
    }
}

/// The in-progress multi-step operation ("merge" or "rebase"), if any.
/// Cheap: `repo.state()` is a flag read (checks for MERGE_HEAD / rebase
/// directories) — no graph walk.
pub fn operation_state(path: &Path) -> AppResult<Option<&'static str>> {
    let repo = open_repo(path)?;
    Ok(state_to_operation(repo.state()))
}

pub fn init_repo(path: &Path) -> AppResult<()> {
    Repository::init(path).map_err(|e| AppError::Other(format!("git init: {e}")))?;
    Ok(())
}

pub fn open_repo(path: &Path) -> AppResult<Repository> {
    Repository::open(path).map_err(|e| AppError::Other(format!("git open: {e}")))
}

pub fn current_branch(repo: &Repository) -> Option<String> {
    repo.head().ok()?.shorthand().map(String::from)
}

pub fn is_git_repo(path: &Path) -> bool {
    Repository::open(path).is_ok()
}

/// Return the name of the default branch, or None if the repo has no commits.
pub fn default_branch(path: &Path) -> AppResult<Option<String>> {
    let repo = open_repo(path)?;
    let result = match repo.head() {
        Ok(head) => head.shorthand().map(String::from),
        Err(_) => None, // Empty repo — no HEAD
    };
    Ok(result)
}

/// Local branch names: the repo's default (HEAD) branch first, the rest
/// alphabetical (case-insensitive). Used by the workspace creator's base picker.
pub fn list_branches(path: &Path) -> AppResult<Vec<String>> {
    let repo = open_repo(path)?;
    let default = default_branch(path)?;
    let mut names: Vec<String> = repo
        .branches(Some(git2::BranchType::Local))
        .map_err(|e| AppError::Other(format!("list branches: {e}")))?
        .filter_map(|b| b.ok())
        .filter_map(|(b, _)| b.name().ok().flatten().map(String::from))
        .collect();
    names.sort_by_key(|n| n.to_lowercase());
    // Promote the default branch only if it's a real local branch — a detached
    // HEAD reports "HEAD" as the default, which must not become a phantom entry.
    if let Some(def) = default {
        if names.iter().any(|n| n == &def) {
            names.retain(|n| n != &def);
            names.insert(0, def);
        }
    }
    Ok(names)
}

/// Resolve the base branch for a new workspace: an explicit non-blank choice
/// wins; otherwise the repo's default branch; empty repos with no choice error.
pub fn resolve_base(from_branch: &str, default: Option<String>) -> AppResult<String> {
    let explicit = from_branch.trim();
    if !explicit.is_empty() {
        return Ok(explicit.to_string());
    }
    default.ok_or_else(|| AppError::Other("repository has no branches yet".into()))
}

/// Ensure the repo has at least one commit AND that commit captures whatever
/// files live in the working tree. Handles three scenarios:
///   (a) No HEAD yet → stage everything, create the initial commit.
///   (b) HEAD exists but its tree is empty (e.g. left over from an older
///       Octopush bug that ran an empty initial commit on `open_project`)
///       AND files are sitting on disk → amend the HEAD commit so it
///       contains those files. Worktrees branched off `main` then inherit
///       them.
///   (c) HEAD exists with a non-empty tree → do nothing. We never touch a
///       real codebase's history.
pub fn ensure_initial_commit(path: &Path) -> AppResult<()> {
    let repo = open_repo(path)?;

    // Decide whether we need to write/amend an initial commit.
    enum Action {
        Skip,
        FreshCommit,
        AmendEmptyHead,
    }
    let action = match repo.head() {
        Err(_) => Action::FreshCommit,
        Ok(head_ref) => {
            let head_commit = head_ref
                .peel_to_commit()
                .map_err(|e| AppError::Other(format!("peel HEAD: {e}")))?;
            let head_tree = head_commit
                .tree()
                .map_err(|e| AppError::Other(format!("HEAD tree: {e}")))?;
            if head_tree.len() == 0 {
                Action::AmendEmptyHead
            } else {
                Action::Skip
            }
        }
    };
    if matches!(action, Action::Skip) {
        return Ok(());
    }

    let sig = repo
        .signature()
        .or_else(|_| git2::Signature::now("Octopush", "octopush@localhost"))
        .map_err(|e| AppError::Other(format!("git signature: {e}")))?;

    // Stage any existing files. add_all with "*" respects .gitignore but
    // sweeps everything else into the index.
    let mut index = repo
        .index()
        .map_err(|e| AppError::Other(format!("open index: {e}")))?;
    index
        .add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
        .map_err(|e| AppError::Other(format!("add_all: {e}")))?;
    index
        .write()
        .map_err(|e| AppError::Other(format!("write index: {e}")))?;
    let tree_id = index
        .write_tree()
        .map_err(|e| AppError::Other(format!("write tree: {e}")))?;
    let tree = repo
        .find_tree(tree_id)
        .map_err(|e| AppError::Other(format!("find tree: {e}")))?;

    match action {
        Action::FreshCommit => {
            repo.commit(Some("HEAD"), &sig, &sig, "Initial commit", &tree, &[])
                .map_err(|e| AppError::Other(format!("initial commit: {e}")))?;
        }
        Action::AmendEmptyHead => {
            let head = repo
                .head()
                .map_err(|e| AppError::Other(format!("head: {e}")))?;
            let head_commit = head
                .peel_to_commit()
                .map_err(|e| AppError::Other(format!("peel HEAD: {e}")))?;
            head_commit
                .amend(
                    Some("HEAD"),
                    Some(&sig),
                    Some(&sig),
                    None,
                    Some("Initial commit"),
                    Some(&tree),
                )
                .map_err(|e| AppError::Other(format!("amend HEAD: {e}")))?;
        }
        Action::Skip => unreachable!(),
    }

    Ok(())
}

/// Branch + changed files (incl. conflict flag) + cheap has_upstream. Does NOT do the
/// (potentially slow) ahead/behind graph walk — that's `ahead_behind`, timed at the
/// command layer.
pub fn status_files(path: &Path) -> AppResult<GitStatus> {
    let repo = open_repo(path)?;
    let branch = current_branch(&repo);
    let mut opts = StatusOptions::new();
    opts.include_untracked(true);
    let statuses = repo.statuses(Some(&mut opts))
        .map_err(|e| AppError::Other(format!("git status: {e}")))?;
    let changed_files: Vec<FileChange> = statuses.iter().map(|entry| {
        let path = entry.path().unwrap_or("").to_string();
        let st = entry.status();
        let conflicted = st.is_conflicted();
        let staged =
            st.is_index_new() || st.is_index_modified() || st.is_index_deleted()
            || st.is_index_renamed() || st.is_index_typechange();
        let unstaged =
            st.is_wt_new() || st.is_wt_modified() || st.is_wt_deleted()
            || st.is_wt_renamed() || st.is_wt_typechange();
        let status = if conflicted { "conflicted" }
            else if st.is_index_new() || st.is_wt_new() { "new" }
            else if st.is_index_modified() || st.is_wt_modified() { "modified" }
            else if st.is_index_deleted() || st.is_wt_deleted() { "deleted" }
            else if st.is_index_renamed() || st.is_wt_renamed() { "renamed" }
            else { "unknown" };
        FileChange { path, status: status.to_string(), staged, unstaged, conflicted }
    }).collect();
    let conflicted = changed_files.iter().filter(|f| f.conflicted).count();
    let has_upstream = repo
        .head().ok()
        .and_then(|h| h.shorthand().map(|s| s.to_string()))
        .and_then(|name| repo.find_branch(&name, git2::BranchType::Local).ok())
        .map(|b| b.upstream().is_ok())
        .unwrap_or(false);
    let operation = state_to_operation(repo.state()).map(String::from);
    Ok(GitStatus {
        branch, changed_files, ahead: 0, behind: 0, has_upstream, conflicted,
        ahead_behind_known: false, operation,
    })
}

/// Ahead/behind vs the upstream (the slow graph walk). None if no upstream / can't compute.
pub fn ahead_behind(path: &Path) -> Option<(usize, usize)> {
    let repo = open_repo(path).ok()?;
    upstream_ahead_behind(&repo)
}

/// Fully-computed status (files + ahead/behind), synchronous. Convenience for tests/non-command callers.
pub fn get_status(path: &Path) -> AppResult<GitStatus> {
    let mut s = status_files(path)?;
    if let Some((a, b)) = ahead_behind(path) {
        s.ahead = a; s.behind = b;
    }
    s.ahead_behind_known = true;
    Ok(s)
}

/// Compact git signal for the rail: `(dirty, ahead, behind)`.
/// `dirty` is true when the worktree has any staged/unstaged/untracked change.
/// Thin wrapper over [`get_status`]; lives here so it can be unit-tested
/// against a temp repo without the Tauri command/DB layer.
pub fn dirty_ahead_behind(path: &Path) -> AppResult<(bool, usize, usize)> {
    let dirty = is_dirty(path)?;
    let repo = open_repo(path)?;
    let (ahead, behind) = upstream_ahead_behind(&repo).unwrap_or((0, 0));
    Ok((dirty, ahead, behind))
}

/// Fast "has any uncommitted change?" check. Unlike `get_status`, this does
/// NOT recurse into untracked directories — an untracked folder counts as a
/// single entry — so a directory of hundreds of untracked files costs one
/// stat instead of hundreds. Used for the rail's dirty indicator where only
/// the boolean matters.
pub fn is_dirty(path: &Path) -> AppResult<bool> {
    let repo = open_repo(path)?;
    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(false);
    let statuses = repo
        .statuses(Some(&mut opts))
        .map_err(|e| AppError::Other(format!("git status: {e}")))?;
    Ok(!statuses.is_empty())
}

/// Return (ahead, behind) commits relative to the configured upstream of
/// HEAD. Returns None if no upstream is configured (e.g. a branch that has
/// never been pushed) or the comparison cannot be computed.
fn upstream_ahead_behind(repo: &Repository) -> Option<(usize, usize)> {
    let head = repo.head().ok()?;
    let branch_name = head.shorthand()?;
    let branch = repo
        .find_branch(branch_name, git2::BranchType::Local)
        .ok()?;
    let upstream = branch.upstream().ok()?;
    let local_oid = head.target()?;
    let upstream_oid = upstream.get().target()?;
    repo.graph_ahead_behind(local_oid, upstream_oid).ok()
}

pub fn create_branch(path: &Path, branch_name: &str, from: &str) -> AppResult<()> {
    let repo = open_repo(path)?;
    // If branch already exists, skip (idempotent).
    if repo.find_reference(&format!("refs/heads/{branch_name}")).is_ok() {
        return Ok(());
    }
    let from_ref = repo.find_reference(&format!("refs/heads/{from}"))
        .map_err(|e| AppError::Other(format!("branch '{from}' not found: {e}")))?;
    let commit = from_ref.peel_to_commit()
        .map_err(|e| AppError::Other(format!("peel: {e}")))?;
    repo.branch(branch_name, &commit, false)
        .map_err(|e| AppError::Other(format!("create branch: {e}")))?;
    Ok(())
}

pub fn create_worktree(repo_path: &Path, branch: &str, worktree_path: &Path) -> AppResult<()> {
    // Clean up the working-tree directory itself in case a previous run
    // bailed mid-way and left a partial checkout.
    if worktree_path.exists() {
        let _ = std::fs::remove_dir_all(worktree_path);
    }

    let repo = open_repo(repo_path)?;

    // ── Self-heal stale worktree state ───────────────────────────
    // A previous failed attempt can leave the repo in one of three
    // states, all of which would make `repo.worktree(branch, …)` fail:
    //   1. Registered-but-invalid worktree (`validate().is_err()` —
    //      working tree dir was deleted out from under libgit2).
    //   2. Orphan directory at `.git/worktrees/<name>/` that libgit2
    //      never finished initialising.
    //   3. A "registered and valid" worktree whose name collides with
    //      ours — the user is retrying the same task name after a
    //      previous failure, and the previous attempt got far enough
    //      to register the worktree even though the user never saw it
    //      succeed.
    //
    // For (3), we force-prune the colliding worktree only when our
    // top-level `worktree_path.exists()` removal has already wiped its
    // working tree from disk. That signals "we already decided to
    // recycle this slot." If the user has an unrelated hand-made
    // worktree with the same name, its directory wouldn't have been
    // at `worktree_path`, so it survives.
    if let Ok(names) = repo.worktrees() {
        for opt_name in names.iter() {
            let Some(name) = opt_name else { continue };
            let Ok(wt) = repo.find_worktree(name) else { continue };
            let invalid = wt.validate().is_err();
            let same_name = name == branch;
            if invalid || same_name {
                let mut prune_opts = git2::WorktreePruneOptions::new();
                // Allow pruning even if libgit2 thinks the worktree is
                // currently valid — we just decided to recycle it.
                prune_opts.valid(true);
                prune_opts.working_tree(true);
                let _ = wt.prune(Some(&mut prune_opts));
            }
        }
    }
    // Sweep any orphan directories under .git/worktrees/ that the
    // registry no longer references (typical when libgit2 created the
    // dir before failing the rest of the init).
    if let Some(git_dir) = repo.path().to_str() {
        let worktrees_meta = std::path::Path::new(git_dir).join("worktrees");
        if worktrees_meta.exists() {
            let registered: std::collections::HashSet<String> = repo
                .worktrees()
                .ok()
                .map(|names| {
                    names
                        .iter()
                        .filter_map(|n| n.map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            if let Ok(entries) = std::fs::read_dir(&worktrees_meta) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if registered.contains(&name) {
                        continue;
                    }
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }
    }

    std::fs::create_dir_all(
        worktree_path.parent().unwrap_or(worktree_path),
    )?;

    // Use WorktreeAddOptions with the existing branch reference so
    // git2 doesn't try to create a new refs/heads/<name> (which would
    // conflict with the branch we already created in create_branch).
    let branch_ref = repo.find_reference(&format!("refs/heads/{branch}"))
        .map_err(|e| AppError::Other(format!("branch '{branch}' not found: {e}")))?;

    let mut opts = WorktreeAddOptions::new();
    opts.reference(Some(&branch_ref));

    repo.worktree(branch, worktree_path, Some(&opts))
        .map_err(|e| AppError::Other(format!("create worktree: {e}")))?;

    Ok(())
}

pub fn delete_worktree(repo_path: &Path, worktree_name: &str) -> AppResult<()> {
    let repo = open_repo(repo_path)?;
    if let Ok(wt) = repo.find_worktree(worktree_name) {
        let mut opts = git2::WorktreePruneOptions::new();
        opts.valid(true);
        opts.working_tree(true);
        let _ = wt.prune(Some(&mut opts));
    }
    Ok(())
}

pub fn delete_branch(path: &Path, branch_name: &str) -> AppResult<()> {
    let repo = open_repo(path)?;
    if let Ok(mut branch) = repo.find_branch(branch_name, git2::BranchType::Local) {
        branch.delete().map_err(|e| AppError::Other(format!("delete branch: {e}")))?;
    }
    Ok(())
}

/// Shared diff-to-text printer. Converts any `git2::Diff` into a unified-
/// patch string, capped at 1 MiB to guard against enormous diffs stalling
/// the UI.
fn diff_to_text(diff: &git2::Diff) -> AppResult<String> {
    const MAX_DIFF_BYTES: usize = 1_048_576;
    let mut buf = Vec::new();
    let mut truncated = false;
    let print_result = diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        if buf.len() >= MAX_DIFF_BYTES {
            truncated = true;
            return false; // abort generation — stops reading remaining file content
        }
        // libgit2 strips the leading `+`/`-`/` ` marker from `line.content()`
        // and exposes it separately as `line.origin()`. Re-emit the marker so
        // the resulting patch is a faithful unified diff that downstream
        // consumers (e.g., the Diffs counter) can parse line-by-line.
        let origin = line.origin();
        if matches!(origin, '+' | '-' | ' ') {
            buf.push(origin as u8);
        }
        // Bound the per-line append: a single newline-less line (minified
        // bundle, one-line JSON) would otherwise blow past the cap in one call.
        let remaining = MAX_DIFF_BYTES.saturating_sub(buf.len());
        let content = line.content();
        let take = remaining.min(content.len());
        buf.extend_from_slice(&content[..take]);
        if take < content.len() {
            truncated = true;
            return false; // stop: this line alone hit the cap
        }
        true
    });
    if let Err(e) = print_result {
        // A `false` return from our callback aborts with GIT_EUSER; that's the
        // intended truncation, not a real failure. Propagate any other error.
        if !truncated {
            return Err(AppError::Other(format!("diff print: {e}")));
        }
    }
    let mut out = String::from_utf8_lossy(&buf).to_string();
    if truncated {
        out.push_str("\n... diff truncated (too large to display fully) ...\n");
    }
    Ok(out)
}

pub fn get_diff_text(path: &Path, ignore_whitespace: bool) -> AppResult<String> {
    let repo = open_repo(path)?;
    // Include untracked files (treat each as a synthesized "new file" diff)
    // and recurse into untracked directories. Without these flags, brand-new
    // files in the worktree are invisible to the Review canvas — see the
    // "Nothing to review" bug on workspaces where every change is a new file.
    let mut opts = git2::DiffOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true);
    if ignore_whitespace {
        opts.ignore_whitespace(true);
    }
    let diff = repo
        .diff_index_to_workdir(None, Some(&mut opts))
        .map_err(|e| AppError::Other(format!("diff: {e}")))?;
    diff_to_text(&diff)
}

/// Staged diff: HEAD tree → index (what `git diff --cached` shows). "" when nothing
/// is staged. On an empty repo (no HEAD), diffs the empty tree → index.
pub fn get_staged_diff_text(path: &Path) -> AppResult<String> {
    let repo = open_repo(path)?;
    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let mut opts = git2::DiffOptions::new();
    let diff = repo
        .diff_tree_to_index(head_tree.as_ref(), None, Some(&mut opts))
        .map_err(|e| AppError::Other(format!("staged diff: {e}")))?;
    diff_to_text(&diff)
}

/// (short_sha, subject, body) of HEAD, or None if the repo has no commits yet.
pub fn last_commit(path: &Path) -> AppResult<Option<(String, String, String)>> {
    let repo = open_repo(path)?;
    let commit = match repo.head().ok().and_then(|h| h.peel_to_commit().ok()) {
        Some(c) => c,
        None => return Ok(None),
    };
    let short_sha = commit.id().to_string()[..7].to_string();
    let msg = commit.message().unwrap_or("");
    let mut lines = msg.splitn(2, '\n');
    let subject = lines.next().unwrap_or("").trim().to_string();
    let body = lines.next().unwrap_or("").trim_start_matches('\n').trim_end().to_string();
    Ok(Some((short_sha, subject, body)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn dirty_ahead_behind_reports_clean_then_dirty() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path()).unwrap();

        // Freshly initialized repo, no files → clean, no upstream → 0/0.
        let (dirty, ahead, behind) = dirty_ahead_behind(dir.path()).unwrap();
        assert!(!dirty, "empty repo should be clean");
        assert_eq!((ahead, behind), (0, 0));

        // An untracked file makes it dirty (get_status includes untracked).
        fs::write(dir.path().join("a.txt"), "hello").unwrap();
        let (dirty2, _, _) = dirty_ahead_behind(dir.path()).unwrap();
        assert!(dirty2, "untracked file should mark the worktree dirty");
    }

    #[test]
    fn is_dirty_detects_untracked_dir_without_recursing() {
        use std::fs;
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path()).unwrap();
        assert!(!is_dirty(dir.path()).unwrap(), "fresh repo is clean");

        fs::create_dir(dir.path().join("docs")).unwrap();
        fs::write(dir.path().join("docs/a.md"), "x").unwrap();
        fs::write(dir.path().join("docs/b.md"), "y").unwrap();
        assert!(is_dirty(dir.path()).unwrap(), "untracked dir marks dirty");
        let (dirty, _, _) = dirty_ahead_behind(dir.path()).unwrap();
        assert!(dirty);
    }

    #[test]
    fn get_diff_text_caps_large_untracked_content() {
        use std::fs;
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path()).unwrap();
        // 3 MiB of multi-line content. A real "large untracked folder" diff is
        // many lines; libgit2 invokes the print callback per line, so the cap
        // engages at a line boundary once the buffer fills.
        let line = "x".repeat(63);
        let big = format!("{line}\n").repeat(3 * 1024 * 1024 / 64);
        fs::write(dir.path().join("big.txt"), &big).unwrap();

        let diff = get_diff_text(dir.path(), false).unwrap();
        assert!(diff.len() < 1_300_000, "diff should be capped near 1 MiB, got {}", diff.len());
        assert!(diff.contains("diff truncated"), "should carry the truncation marker");
    }

    #[test]
    fn get_diff_text_caps_single_long_untracked_line() {
        use std::fs;
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path()).unwrap();
        // 3 MiB on ONE line (no newlines) — e.g. a minified bundle.
        let big = "x".repeat(3 * 1024 * 1024);
        fs::write(dir.path().join("bundle.min.js"), &big).unwrap();

        let diff = get_diff_text(dir.path(), false).unwrap();
        assert!(diff.len() < 1_300_000, "single huge line must be capped, got {}", diff.len());
        assert!(diff.contains("diff truncated"));
    }

    // ── G4 helpers/tests ──────────────────────────────────────────
    fn commit_file(dir: &std::path::Path, name: &str, content: &str, msg: &str) -> git2::Oid {
        let repo = Repository::open(dir).unwrap();
        std::fs::write(dir.join(name), content).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(std::path::Path::new(name)).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = git2::Signature::now("Test", "test@example.com").unwrap();
        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&git2::Commit> = parent.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parents).unwrap()
    }

    #[test]
    fn staged_diff_shows_only_index_changes() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path()).unwrap();
        commit_file(dir.path(), "a.txt", "one\n", "first");
        std::fs::write(dir.path().join("a.txt"), "two\n").unwrap();
        let repo = Repository::open(dir.path()).unwrap();
        let mut idx = repo.index().unwrap();
        idx.add_path(std::path::Path::new("a.txt")).unwrap();
        idx.write().unwrap();
        std::fs::write(dir.path().join("a.txt"), "three\n").unwrap();
        let staged = get_staged_diff_text(dir.path()).unwrap();
        assert!(staged.contains("+two"), "staged diff shows staged line: {staged}");
        assert!(!staged.contains("+three"), "staged diff must NOT include the unstaged line");
    }

    #[test]
    fn staged_diff_empty_when_nothing_staged() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path()).unwrap();
        commit_file(dir.path(), "a.txt", "one\n", "first");
        assert_eq!(get_staged_diff_text(dir.path()).unwrap(), "");
    }

    #[test]
    fn last_commit_returns_subject_and_body() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path()).unwrap();
        commit_file(dir.path(), "a.txt", "one\n", "feat: thing\n\nbody line 1\nbody line 2");
        let lc = last_commit(dir.path()).unwrap().expect("a commit exists");
        assert_eq!(lc.1, "feat: thing");
        assert!(lc.2.contains("body line 1"));
        assert_eq!(lc.0.len(), 7, "short sha is 7 chars: {}", lc.0);
    }

    #[test]
    fn last_commit_none_on_empty_repo() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path()).unwrap();
        assert!(last_commit(dir.path()).unwrap().is_none());
    }

    #[test]
    fn classify_pull_distinguishes_outcomes() {
        use super::{classify_pull, PullKind};
        assert_eq!(classify_pull(true, "Already up to date."), PullKind::Ok);
        assert_eq!(classify_pull(false, "fatal: Not possible to fast-forward, aborting."), PullKind::Diverged);
        assert_eq!(classify_pull(false, "hint: You have divergent branches"), PullKind::Diverged);
        assert_eq!(classify_pull(false, "CONFLICT (content): Merge conflict in a.txt"), PullKind::Conflict);
        assert_eq!(classify_pull(false, "error: Automatic merge failed"), PullKind::Conflict);
        assert_eq!(classify_pull(false, "fatal: couldn't find remote ref"), PullKind::Error);
    }

    #[test]
    fn classify_continue_distinguishes_outcomes() {
        use super::{classify_continue, ContinueKind};
        assert_eq!(classify_continue(true, "[main 1a2b3c4] merge side"), ContinueKind::Ok);
        assert_eq!(classify_continue(true, ""), ContinueKind::Ok);
        assert_eq!(
            classify_continue(false, "CONFLICT (content): Merge conflict in a.txt"),
            ContinueKind::MoreConflicts,
        );
        assert_eq!(
            classify_continue(false, "error: could not apply f00ba4... next commit"),
            ContinueKind::MoreConflicts,
        );
        assert_eq!(
            classify_continue(false, "error: Committing is not possible because you have unmerged files."),
            ContinueKind::Error,
        );
        assert_eq!(classify_continue(false, "fatal: No rebase in progress?"), ContinueKind::Error);
    }
}
