//! Workspace creation, shared by the Tauri command layer and the
//! `octopush-mcp` binary so both create workspaces through exactly one
//! code path.
//!
//! A workspace is a row in the `workspaces` table backed by a git worktree.
//! Creating one means: make sure the repo can branch, resolve the base,
//! create-or-reuse the branch, create the worktree, and record the row. The
//! flow is idempotent on `(project, branch)` — re-running it returns the
//! existing workspace (restoring it first if it was archived) instead of
//! creating a duplicate — which is what makes "create a workspace for a branch
//! that already exists" safe.
//!
//! The DB handle is passed as `&Mutex<Db>` rather than `&Db` on purpose: the
//! git checkout can take seconds on a large repo, so we hold the lock only for
//! the brief DB reads/writes and never across the worktree materialisation.

use std::path::{Path, PathBuf};

use parking_lot::Mutex;

use crate::db::{Db, WorkspaceRow};
use crate::error::{AppError, AppResult};

/// Turn free text into a git-branch-safe slug, byte-for-byte matching the
/// frontend's `slugify` in `WorkspaceCreator.tsx` so a workspace created from
/// the MCP gets the exact branch name the UI would have produced. The frontend
/// is: lowercase → drop everything except ASCII word chars, whitespace and
/// `-` → collapse runs of whitespace/`_` (NOT `-`) to a single `-` → trim
/// leading/trailing `-`. Note literal hyphens are preserved, never collapsed.
pub fn slugify(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut sep_run = false; // inside a run of whitespace/underscore
    for ch in text.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            if sep_run {
                out.push('-');
                sep_run = false;
            }
            out.push(ch);
        } else if ch.is_whitespace() || ch == '_' {
            sep_run = true; // becomes a single '-' before the next kept char
        } else if ch == '-' {
            // A literal hyphen is kept verbatim (frontend's char class allows
            // '-' and its collapse step only targets [\s_]). Flush a pending
            // separator run first so spacing around it is preserved.
            if sep_run {
                out.push('-');
                sep_run = false;
            }
            out.push('-');
        }
        // Any other character (punctuation, non-ASCII) is dropped.
    }
    out.trim_matches('-').to_string()
}

/// Create — or reuse — a workspace for `branch` in `project`.
///
/// `project_path` must be an absolute, tilde-expanded path to the project's
/// git repository (the main worktree). Returns the resulting workspace row,
/// whether freshly created, already active, or restored from the archive.
#[allow(clippy::too_many_arguments)]
pub fn create(
    db: &Mutex<Db>,
    project_id: &str,
    project_path: &Path,
    name: &str,
    task: &str,
    branch: &str,
    from_branch: &str,
    setup_script: &str,
) -> AppResult<WorkspaceRow> {
    let branch = branch.trim();
    if branch.is_empty() {
        return Err(AppError::Other("a workspace needs a branch name".into()));
    }

    // Idempotent: one workspace per (project, branch), including archived rows.
    // Bind to a local first so the lock guard is released before
    // reuse_or_restore re-locks — `parking_lot::Mutex` isn't re-entrant, and an
    // `if let` scrutinee's temporary would otherwise live through the body.
    let existing = db.lock().find_workspace_by_branch(project_id, branch)?;
    if let Some(existing) = existing {
        return reuse_or_restore(db, project_path, existing);
    }

    // Materialise the git side WITHOUT holding the DB lock.
    let (base, worktree_path) = provision_worktree(project_path, branch, from_branch)?;

    let id = uuid::Uuid::new_v4().to_string();
    let d = db.lock();
    // Re-check under the lock to close the check-then-create race within this
    // process (a concurrent caller may have created it while we provisioned).
    if let Some(existing) = d.find_workspace_by_branch(project_id, branch)? {
        return Ok(existing);
    }
    d.insert_workspace(
        &id,
        project_id,
        name,
        task,
        branch,
        Some(&worktree_path.to_string_lossy()),
        setup_script,
        Some(&base), // the RESOLVED base, not the raw (possibly blank) request
    )?;
    d.get_workspace(&id)?
        .ok_or_else(|| AppError::Other("workspace created but could not be reloaded".into()))
}

/// Run the git side of creation: ensure the repo can branch, resolve the base,
/// create-or-reuse the branch, and create the worktree. Returns the resolved
/// base and the worktree path. Touches git only — no DB — so the caller can
/// run it without holding the DB lock.
fn provision_worktree(
    project_path: &Path,
    branch: &str,
    from_branch: &str,
) -> AppResult<(String, PathBuf)> {
    // Ensure the repo has at least one commit (empty repos can't branch).
    crate::git_ops::ensure_initial_commit(project_path)?;

    // Explicit base branch wins; blank falls back to the repo's default.
    let base = crate::git_ops::resolve_base(
        from_branch,
        crate::git_ops::default_branch(project_path)?,
    )?;

    // create_branch is idempotent — it reuses an existing branch of this name.
    crate::git_ops::create_branch(project_path, branch, &base)?;

    let worktree_path = project_path
        .parent()
        .unwrap_or(project_path)
        .join(format!(".octopus-worktrees/{branch}"));
    crate::git_ops::create_worktree(project_path, branch, &worktree_path)?;

    Ok((base, worktree_path))
}

/// Hand back the existing workspace for this branch, making sure it's usable.
/// Its worktree is rebuilt if missing — archiving removes it, and an active
/// workspace's worktree can also vanish out-of-band (rm -rf, an unmounted
/// drive) — and an archived row is flipped back to active. A healthy worktree
/// is never touched (it may hold uncommitted work), and the "main" workspace
/// (whose worktree is the project root) is never rebuilt.
fn reuse_or_restore(
    db: &Mutex<Db>,
    project_path: &Path,
    ws: WorkspaceRow,
) -> AppResult<WorkspaceRow> {
    if let Some(wt) = ws.worktree_path.as_deref() {
        let wt_path = Path::new(wt);
        // A present worktree has a `.git` entry (a file, for linked worktrees).
        let missing = !wt_path.join(".git").exists();
        if missing && !same_path(wt_path, project_path) {
            crate::git_ops::create_worktree(project_path, &ws.branch, wt_path)?;
        }
    }

    if ws.status == "archived" {
        let d = db.lock();
        d.restore_workspace(&ws.id)?;
        return d.get_workspace(&ws.id)?.ok_or_else(|| {
            AppError::Other("workspace restored but could not be reloaded".into())
        });
    }

    Ok(ws)
}

/// Path equality with the same raw-string fallback the archive/restore commands
/// use: a `canonicalize` failure (broken symlink, restricted parent) must not
/// be read as "different path" — that's how an archived main workspace could be
/// mistaken for a normal one and its project root clobbered.
fn same_path(a: &Path, b: &Path) -> bool {
    let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    canon(a) == canon(b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use parking_lot::Mutex;
    use tempfile::{tempdir, NamedTempFile};

    fn test_db() -> Mutex<Db> {
        let tmp = NamedTempFile::new().unwrap();
        Mutex::new(Db::open(tmp.path()).unwrap())
    }

    /// A repo nested one level inside its own tempdir, so the worktrees
    /// `create()` derives at `project_path.parent()/.octopus-worktrees/<branch>`
    /// land *inside* this tempdir — isolated from other (parallel) tests and
    /// cleaned up when the dir drops, instead of leaking into the shared temp
    /// root.
    fn test_repo() -> tempfile::TempDir {
        let root = tempdir().unwrap();
        let repo = root.path().join("proj");
        std::fs::create_dir_all(&repo).unwrap();
        crate::git_ops::init_repo(&repo).unwrap();
        crate::git_ops::ensure_initial_commit(&repo).unwrap();
        root
    }

    #[test]
    fn slugify_matches_frontend_rules() {
        assert_eq!(slugify("Scan AGP Docker image"), "scan-agp-docker-image");
        assert_eq!(slugify("feat: do the thing"), "feat-do-the-thing");
        assert_eq!(slugify("  trailing  and __mixed-- "), "trailing-and-mixed");
        assert_eq!(slugify("GUIDE-2887"), "guide-2887");
        assert_eq!(slugify("***"), "");
        // Literal hyphens are preserved, never collapsed — must match the
        // frontend exactly so the same task yields the same branch.
        assert_eq!(slugify("Add login - logout flow"), "add-login---logout-flow");
    }

    #[test]
    fn create_then_recreate_same_branch_is_idempotent() {
        let root = test_repo();
        let repo = root.path().join("proj");
        let db = test_db();
        db.lock()
            .insert_project("p1", "Proj", &repo.to_string_lossy())
            .unwrap();

        let ws = create(&db, "p1", &repo, "scan", "Scan task", "idem-branch", "", "").unwrap();
        assert_eq!(ws.branch, "idem-branch");
        let wt = ws.worktree_path.clone().unwrap();
        assert!(std::path::Path::new(&wt).join(".git").exists(), "worktree exists");

        // Re-running for the same branch returns the SAME row, no duplicate.
        let again = create(&db, "p1", &repo, "scan", "Scan task", "idem-branch", "", "").unwrap();
        assert_eq!(again.id, ws.id, "idempotent on (project, branch)");
        assert_eq!(db.lock().list_workspaces("p1").unwrap().len(), 1, "no duplicate row");
    }

    #[test]
    fn create_for_archived_branch_restores_it() {
        let root = test_repo();
        let repo = root.path().join("proj");
        let db = test_db();
        db.lock()
            .insert_project("p1", "Proj", &repo.to_string_lossy())
            .unwrap();

        let ws = create(&db, "p1", &repo, "scan", "Scan task", "arch-branch", "", "").unwrap();
        // Archive it (drop the worktree dir + mark the row archived), as the
        // archive command does.
        let wt = ws.worktree_path.clone().unwrap();
        std::fs::remove_dir_all(&wt).ok();
        crate::git_ops::delete_worktree(&repo, "arch-branch").unwrap();
        db.lock().archive_workspace(&ws.id).unwrap();
        assert!(db.lock().list_workspaces("p1").unwrap().is_empty(), "hidden once archived");

        // Creating it again restores the SAME row and rebuilds its worktree.
        let restored = create(&db, "p1", &repo, "scan", "Scan task", "arch-branch", "", "").unwrap();
        assert_eq!(restored.id, ws.id, "restored, not duplicated");
        assert_eq!(restored.status, "active");
        assert!(std::path::Path::new(&wt).join(".git").exists(), "worktree rebuilt");
        assert_eq!(db.lock().list_workspaces("p1").unwrap().len(), 1, "single row");
    }

    #[test]
    fn create_rejects_blank_branch() {
        let root = test_repo();
        let repo = root.path().join("proj");
        let db = test_db();
        db.lock()
            .insert_project("p1", "Proj", &repo.to_string_lossy())
            .unwrap();
        assert!(create(&db, "p1", &repo, "x", "x", "  ", "", "").is_err());
    }
}
