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

pub fn get_status(path: &Path) -> AppResult<GitStatus> {
    let repo = open_repo(path)?;
    let branch = current_branch(&repo);
    let mut opts = StatusOptions::new();
    opts.include_untracked(true);
    let statuses = repo.statuses(Some(&mut opts))
        .map_err(|e| AppError::Other(format!("git status: {e}")))?;
    let changed_files: Vec<FileChange> = statuses.iter().map(|entry| {
        let path = entry.path().unwrap_or("").to_string();
        let st = entry.status();
        let staged =
            st.is_index_new() || st.is_index_modified() || st.is_index_deleted()
            || st.is_index_renamed() || st.is_index_typechange();
        let unstaged =
            st.is_wt_new() || st.is_wt_modified() || st.is_wt_deleted()
            || st.is_wt_renamed() || st.is_wt_typechange();
        let status = if st.is_index_new() || st.is_wt_new() { "new" }
            else if st.is_index_modified() || st.is_wt_modified() { "modified" }
            else if st.is_index_deleted() || st.is_wt_deleted() { "deleted" }
            else if st.is_index_renamed() || st.is_wt_renamed() { "renamed" }
            else { "unknown" };
        FileChange {
            path,
            status: status.to_string(),
            staged,
            unstaged,
        }
    }).collect();

    // Compute ahead/behind against the upstream tracking branch, if any.
    let upstream = upstream_ahead_behind(&repo);
    let has_upstream = upstream.is_some();
    let (ahead, behind) = upstream.unwrap_or((0, 0));

    Ok(GitStatus { branch, changed_files, ahead, behind, has_upstream })
}

/// Compact git signal for the rail: `(dirty, ahead, behind)`.
/// `dirty` is true when the worktree has any staged/unstaged/untracked change.
/// Thin wrapper over [`get_status`]; lives here so it can be unit-tested
/// against a temp repo without the Tauri command/DB layer.
pub fn dirty_ahead_behind(path: &Path) -> AppResult<(bool, usize, usize)> {
    let status = get_status(path)?;
    Ok((!status.changed_files.is_empty(), status.ahead, status.behind))
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

pub fn get_diff_text(path: &Path) -> AppResult<String> {
    let repo = open_repo(path)?;
    // Include untracked files (treat each as a synthesized "new file" diff)
    // and recurse into untracked directories. Without these flags, brand-new
    // files in the worktree are invisible to the Review canvas — see the
    // "Nothing to review" bug on workspaces where every change is a new file.
    let mut opts = git2::DiffOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true);
    let diff = repo.diff_index_to_workdir(None, Some(&mut opts))
        .map_err(|e| AppError::Other(format!("diff: {e}")))?;
    let mut buf = Vec::new();
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        // libgit2 strips the leading `+`/`-`/` ` marker from `line.content()`
        // and exposes it separately as `line.origin()`. Re-emit the marker so
        // the resulting patch is a faithful unified diff that downstream
        // consumers (e.g., the Diffs counter) can parse line-by-line.
        let origin = line.origin();
        if matches!(origin, '+' | '-' | ' ') {
            buf.push(origin as u8);
        }
        buf.extend_from_slice(line.content());
        true
    }).map_err(|e| AppError::Other(format!("diff print: {e}")))?;
    Ok(String::from_utf8_lossy(&buf).to_string())
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
}
