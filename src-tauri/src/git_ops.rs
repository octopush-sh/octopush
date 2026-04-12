//! Git operations for project and workspace management.

use crate::error::{AppError, AppResult};
use git2::{Repository, StatusOptions};
use serde::Serialize;
use std::path::Path;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub branch: Option<String>,
    pub changed_files: Vec<FileChange>,
    pub ahead: usize,
    pub behind: usize,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub status: String,
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

/// Ensure the repo has at least one commit (needed before creating branches).
/// If the repo is empty, creates an initial empty commit on "main".
pub fn ensure_initial_commit(path: &Path) -> AppResult<()> {
    let repo = open_repo(path)?;
    if repo.head().is_ok() {
        return Ok(()); // Already has commits
    }
    // Create an initial empty commit
    let sig = repo.signature()
        .or_else(|_| git2::Signature::now("Octopus sh", "octopus@localhost"))
        .map_err(|e| AppError::Other(format!("git signature: {e}")))?;
    let tree_id = repo.index()
        .and_then(|mut idx| { idx.write()?; idx.write_tree() })
        .map_err(|e| AppError::Other(format!("write tree: {e}")))?;
    let tree = repo.find_tree(tree_id)
        .map_err(|e| AppError::Other(format!("find tree: {e}")))?;
    repo.commit(Some("HEAD"), &sig, &sig, "Initial commit", &tree, &[])
        .map_err(|e| AppError::Other(format!("initial commit: {e}")))?;
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
        let status = if st.is_index_new() || st.is_wt_new() { "new" }
            else if st.is_index_modified() || st.is_wt_modified() { "modified" }
            else if st.is_index_deleted() || st.is_wt_deleted() { "deleted" }
            else if st.is_index_renamed() || st.is_wt_renamed() { "renamed" }
            else { "unknown" };
        FileChange { path, status: status.to_string() }
    }).collect();
    Ok(GitStatus { branch, changed_files, ahead: 0, behind: 0 })
}

pub fn create_branch(path: &Path, branch_name: &str, from: &str) -> AppResult<()> {
    let repo = open_repo(path)?;
    let from_ref = repo.find_reference(&format!("refs/heads/{from}"))
        .map_err(|e| AppError::Other(format!("branch '{from}' not found: {e}")))?;
    let commit = from_ref.peel_to_commit()
        .map_err(|e| AppError::Other(format!("peel: {e}")))?;
    repo.branch(branch_name, &commit, false)
        .map_err(|e| AppError::Other(format!("create branch: {e}")))?;
    Ok(())
}

pub fn create_worktree(repo_path: &Path, branch: &str, worktree_path: &Path) -> AppResult<()> {
    let repo = open_repo(repo_path)?;
    std::fs::create_dir_all(worktree_path)?;
    repo.worktree(branch, worktree_path, None)
        .map_err(|e| AppError::Other(format!("create worktree: {e}")))?;
    let wt_repo = Repository::open(worktree_path)
        .map_err(|e| AppError::Other(format!("open worktree: {e}")))?;
    wt_repo.set_head(&format!("refs/heads/{branch}"))
        .map_err(|e| AppError::Other(format!("checkout: {e}")))?;
    Ok(())
}

pub fn get_diff_text(path: &Path) -> AppResult<String> {
    let repo = open_repo(path)?;
    let diff = repo.diff_index_to_workdir(None, None)
        .map_err(|e| AppError::Other(format!("diff: {e}")))?;
    let mut buf = Vec::new();
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        buf.extend_from_slice(line.content());
        true
    }).map_err(|e| AppError::Other(format!("diff print: {e}")))?;
    Ok(String::from_utf8_lossy(&buf).to_string())
}
