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

/// What `create` did, so callers can tell the user (and the MCP can report it).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CreateOutcome {
    /// A workspace for this branch already existed; returned unchanged.
    Existed,
    /// An archived workspace was un-archived (and its worktree rebuilt).
    Restored,
    /// An existing on-disk checkout of the branch was adopted (no new worktree).
    Adopted,
    /// A fresh worktree-backed workspace was created.
    Created,
}

/// Ensure a workspace for `branch` exists in `project`, and return it.
///
/// `project_path` must be an absolute, tilde-expanded path to the project's git
/// repository (the main worktree). This always succeeds at *giving you a place
/// to work on the branch* rather than failing when the branch is in use:
///
///  1. If a workspace already tracks the branch → return it (un-archiving and
///     rebuilding its worktree if needed).
///  2. If the branch is already checked out somewhere (the main worktree or an
///     untracked one) → **adopt** that checkout — git only allows a branch in
///     one worktree, so we register a workspace over the existing one instead
///     of trying (and failing) to make a second.
///  3. Otherwise → create a fresh worktree under `.octopus-worktrees/`.
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
) -> AppResult<(WorkspaceRow, CreateOutcome)> {
    let branch = branch.trim();
    if branch.is_empty() {
        return Err(AppError::Other("a workspace needs a branch name".into()));
    }
    // Validate here (shared by the app creator AND octopush-mcp): the branch is
    // used verbatim, so an illegal ref (spaces, `:`, control bytes) must fail with
    // a clear message rather than a cryptic git error at create_branch time.
    if !crate::git_ops::is_valid_branch_name(branch) {
        return Err(AppError::Other(format!(
            "'{branch}' is not a valid git branch name"
        )));
    }

    // 1. A tracked workspace already exists for this branch (any status).
    // Bind to a local first so the lock guard is released before
    // reuse_or_restore re-locks — `parking_lot::Mutex` isn't re-entrant, and an
    // `if let` scrutinee's temporary would otherwise live through the body.
    let existing = db.lock().find_workspace_by_branch(project_id, branch)?;
    if let Some(existing) = existing {
        return reuse_or_restore(db, project_path, existing);
    }

    // 2. The branch may already be checked out in a worktree (the main one or an
    //    untracked one). A branch can't be checked out twice, so adopt it.
    let checked_out_at = {
        let repo = crate::git_ops::open_repo(project_path)?;
        crate::git_ops::live_worktree_on_branch(&repo, branch)
    };
    if let Some(path) = checked_out_at {
        // Don't duplicate: if a row already points at that checkout (the main
        // workspace, or a row whose branch was switched), return it — restoring
        // it if it happens to be archived (never hand back a hidden row).
        if let Some(at_path) = workspace_at_path(db, project_id, &path)? {
            return reuse_or_restore(db, project_path, at_path);
        }
        let id = uuid::Uuid::new_v4().to_string();
        let d = db.lock();
        // Re-check under the lock to close the check-then-adopt race (a concurrent
        // caller may have created/adopted it while we were opening the repo).
        if let Some(existing) = d.find_workspace_by_branch(project_id, branch)? {
            return Ok((existing, CreateOutcome::Existed));
        }
        // Adopted, not created: born managed=false AND created_branch=false
        // (atomically) so delete/archive never rm -rf this external checkout, and
        // delete never removes a branch we didn't create.
        d.insert_workspace_managed(
            &id,
            project_id,
            name,
            task,
            branch,
            Some(&path.to_string_lossy()),
            setup_script,
            None,  // we didn't branch from anything — the branch already existed
            false, // managed: not ours
            false, // created_branch: we adopted an existing branch
        )?;
        let ws = d
            .get_workspace(&id)?
            .ok_or_else(|| AppError::Other("workspace adopted but could not be reloaded".into()))?;
        return Ok((ws, CreateOutcome::Adopted));
    }

    // 3. Not checked out anywhere → materialise a fresh worktree (no DB lock held
    //    across the git checkout). The id is generated first so the worktree gets a
    //    directory unique to THIS workspace (`<slug>-<id8>`) — two workspaces can
    //    never collide on one directory, whatever their branch names look like.
    let id = uuid::Uuid::new_v4().to_string();
    let (base, worktree_path, created_branch) =
        provision_worktree(project_path, branch, from_branch, &id)?;

    let d = db.lock();
    // Re-check under the lock to close the check-then-create race within this
    // process (a concurrent caller may have created it while we provisioned).
    if let Some(existing) = d.find_workspace_by_branch(project_id, branch)? {
        return Ok((existing, CreateOutcome::Existed));
    }
    d.insert_workspace_managed(
        &id,
        project_id,
        name,
        task,
        branch,
        Some(&worktree_path.to_string_lossy()),
        setup_script,
        Some(&base),    // the RESOLVED base, not the raw (possibly blank) request
        true,           // managed: Octopush made this worktree
        created_branch, // did we create the branch, or reuse an existing one?
    )?;
    let ws = d
        .get_workspace(&id)?
        .ok_or_else(|| AppError::Other("workspace created but could not be reloaded".into()))?;
    Ok((ws, CreateOutcome::Created))
}

/// Find a workspace (any status) in `project` whose worktree path resolves to
/// `path`, so adoption never registers a second row over a checkout that's
/// already tracked (e.g. the main worktree, or a workspace whose branch was
/// switched).
fn workspace_at_path(
    db: &Mutex<Db>,
    project_id: &str,
    path: &Path,
) -> AppResult<Option<WorkspaceRow>> {
    let target = canonical_or(path);
    let d = db.lock();
    let mut rows = d.list_workspaces(project_id)?;
    rows.extend(d.list_archived_workspaces(project_id)?);
    Ok(rows.into_iter().find(|w| {
        w.worktree_path
            .as_deref()
            .is_some_and(|p| canonical_or(Path::new(p)) == target)
    }))
}

/// Run the git side of creation: ensure the repo can branch, resolve the base,
/// create-or-reuse the branch, and create the worktree at a directory unique to
/// this workspace. Returns the resolved base, the worktree path, and whether the
/// branch was newly created (vs an existing one reused). Touches git only — no DB
/// — so the caller can run it without holding the DB lock.
fn provision_worktree(
    project_path: &Path,
    branch: &str,
    from_branch: &str,
    workspace_id: &str,
) -> AppResult<(String, PathBuf, bool)> {
    // Ensure the repo has at least one commit (empty repos can't branch).
    crate::git_ops::ensure_initial_commit(project_path)?;

    // Explicit base branch wins; blank falls back to the repo's default.
    let base = crate::git_ops::resolve_base(
        from_branch,
        crate::git_ops::default_branch(project_path)?,
    )?;

    // create_branch is idempotent — it reuses an existing branch of this name and
    // reports whether it actually created a new one (so delete only ever removes
    // branches Octopush itself created).
    let created_branch = crate::git_ops::create_branch(project_path, branch, &base)?;

    // Directory unique to this workspace: `<branch-slug>-<id8>`. The slug flattens
    // slashes (a `feat/foo` branch must NOT nest as `.octopus-worktrees/feat/foo`),
    // and the id suffix guarantees two workspaces never share one directory — so a
    // later workspace can never rm -rf an earlier one's tree.
    let dir_name = worktree_dir_name(branch, workspace_id);
    let desired = project_path
        .parent()
        .unwrap_or(project_path)
        .join(".octopus-worktrees")
        .join(&dir_name);
    // create_worktree returns where the worktree ACTUALLY landed.
    let actual = crate::git_ops::create_worktree(project_path, branch, &desired)?;

    Ok((base, actual, created_branch))
}

/// The directory basename for a workspace's worktree: `<branch-slug>-<id8>`.
/// Unique per workspace by construction (the id suffix), and filesystem-safe /
/// flat (the slug). Mirrored on the frontend by `worktreeDirName` for the path
/// preview.
fn worktree_dir_name(branch: &str, workspace_id: &str) -> String {
    let id8: String = workspace_id.chars().take(8).collect();
    format!("{}-{}", crate::git_ops::slot_name_for(branch), id8)
}

/// Hand back the existing workspace for this branch, made usable — and, crucially,
/// without ever destroying work. Three cases, in order:
///
/// 1. **The branch is checked out somewhere else than we recorded** (a teammate
///    or a Direct run moved it): point the row at that live checkout and mark it
///    not-ours (`managed=false`) so a later delete never rm -rf's a tree we don't
///    own. We can't `create_worktree` a branch that's already checked out anyway.
/// 2. **The branch isn't checked out and the recorded directory is entirely gone**
///    (archived-away, or an out-of-band `rm -rf`): rebuild a fresh managed
///    worktree at this workspace's unique directory and mark it ours.
/// 3. **The directory is present**: leave it completely alone — it may hold
///    uncommitted work, so preserving even a broken tree beats deleting it.
///
/// An archived row is flipped back to active in every case.
fn reuse_or_restore(
    db: &Mutex<Db>,
    project_path: &Path,
    ws: WorkspaceRow,
) -> AppResult<(WorkspaceRow, CreateOutcome)> {
    let mut ws = ws;
    let was_archived = ws.status == "archived";

    heal_worktree(db, project_path, &mut ws)?;

    if was_archived {
        let d = db.lock();
        d.restore_workspace(&ws.id)?;
        let restored = d.get_workspace(&ws.id)?.ok_or_else(|| {
            AppError::Other("workspace restored but could not be reloaded".into())
        })?;
        return Ok((restored, CreateOutcome::Restored));
    }

    Ok((ws, CreateOutcome::Existed))
}

/// Ensure `ws` points at a usable worktree, mutating the row (and DB) in place.
/// Shared by `reuse_or_restore` (create-time) and the `restore_workspace` command
/// so both heal a branch the same way. See `reuse_or_restore` for the three cases.
/// NEVER removes a present directory.
pub fn heal_worktree(
    db: &Mutex<Db>,
    project_path: &Path,
    ws: &mut WorkspaceRow,
) -> AppResult<()> {
    // Case 1: the branch is live in some worktree. A branch can be checked out in
    // only one place, so that place IS the workspace — adopt it.
    let checked_out_at = {
        let repo = crate::git_ops::open_repo(project_path)?;
        crate::git_ops::live_worktree_on_branch(&repo, &ws.branch)
    };
    if let Some(path) = checked_out_at {
        let here = path.to_string_lossy().to_string();
        let already = ws
            .worktree_path
            .as_deref()
            .is_some_and(|w| same_path(Path::new(w), &path));
        if !already {
            // The branch moved to a checkout we didn't record — adopt that
            // location and disown it (never rm on delete).
            let d = db.lock();
            d.set_workspace_worktree_path(&ws.id, &here)?;
            d.set_workspace_managed(&ws.id, false)?;
            ws.worktree_path = Some(here);
        }
        return Ok(());
    }

    // Case 2/3: not checked out anywhere. Rebuild only if the directory is entirely
    // gone; never touch a present one.
    let wt = ws.worktree_path.clone();
    let is_main = wt
        .as_deref()
        .is_some_and(|w| same_path(Path::new(w), project_path));
    let gone = wt.as_deref().map(|w| !Path::new(w).exists()).unwrap_or(true);
    if !is_main && gone {
        // Rebuild at this workspace's unique directory. The branch already exists,
        // so create_branch reuses it (created_branch is irrelevant here — we don't
        // change branch ownership on a heal). A rebuilt tree is ours → managed.
        let dir_name = worktree_dir_name(&ws.branch, &ws.id);
        let desired = project_path
            .parent()
            .unwrap_or(project_path)
            .join(".octopus-worktrees")
            .join(&dir_name);
        let actual = crate::git_ops::create_worktree(project_path, &ws.branch, &desired)?;
        let actual_str = actual.to_string_lossy().to_string();
        let d = db.lock();
        d.set_workspace_worktree_path(&ws.id, &actual_str)?;
        d.set_workspace_managed(&ws.id, true)?;
        ws.worktree_path = Some(actual_str);
    }
    Ok(())
}

fn canonical_or(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// Path equality with the same raw-string fallback the archive/restore commands
/// use: a `canonicalize` failure (broken symlink, restricted parent) must not
/// be read as "different path" — that's how an archived main workspace could be
/// mistaken for a normal one and its project root clobbered.
fn same_path(a: &Path, b: &Path) -> bool {
    canonical_or(a) == canonical_or(b)
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

        let (ws, outcome) =
            create(&db, "p1", &repo, "scan", "Scan task", "idem-branch", "", "").unwrap();
        assert_eq!(outcome, CreateOutcome::Created);
        assert!(db.lock().is_workspace_managed(&ws.id).unwrap(), "created worktree is managed");
        assert_eq!(ws.branch, "idem-branch");
        let wt = ws.worktree_path.clone().unwrap();
        assert!(std::path::Path::new(&wt).join(".git").exists(), "worktree exists");

        // Re-running for the same branch returns the SAME row, no duplicate.
        let (again, outcome2) =
            create(&db, "p1", &repo, "scan", "Scan task", "idem-branch", "", "").unwrap();
        assert_eq!(again.id, ws.id, "idempotent on (project, branch)");
        assert_eq!(outcome2, CreateOutcome::Existed);
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

        let (ws, _) = create(&db, "p1", &repo, "scan", "Scan task", "arch-branch", "", "").unwrap();
        // Archive it (drop the worktree dir + mark the row archived), as the
        // archive command does.
        let wt = ws.worktree_path.clone().unwrap();
        crate::git_ops::delete_worktree(&repo, std::path::Path::new(&wt)).unwrap();
        std::fs::remove_dir_all(&wt).ok();
        db.lock().archive_workspace(&ws.id).unwrap();
        assert!(db.lock().list_workspaces("p1").unwrap().is_empty(), "hidden once archived");

        // Creating it again restores the SAME row and rebuilds its worktree.
        let (restored, outcome) =
            create(&db, "p1", &repo, "scan", "Scan task", "arch-branch", "", "").unwrap();
        assert_eq!(restored.id, ws.id, "restored, not duplicated");
        assert_eq!(outcome, CreateOutcome::Restored);
        assert_eq!(restored.status, "active");
        assert!(std::path::Path::new(&wt).join(".git").exists(), "worktree rebuilt");
        assert_eq!(db.lock().list_workspaces("p1").unwrap().len(), 1, "single row");
    }

    #[test]
    fn create_adopts_an_untracked_checkout_without_touching_it() {
        let root = test_repo();
        let repo = root.path().join("proj");
        let db = test_db();
        db.lock()
            .insert_project("p1", "Proj", &repo.to_string_lossy())
            .unwrap();
        let base = crate::git_ops::default_branch(&repo).unwrap().unwrap();
        crate::git_ops::create_branch(&repo, "feat-x", &base).unwrap();

        // An untracked worktree for feat-x (exists on disk, no DB row).
        let wt_dir = tempdir().unwrap();
        let wt = wt_dir.path().join("feat-x");
        let landed = crate::git_ops::create_worktree(&repo, "feat-x", &wt).unwrap();
        std::fs::write(landed.join("mine.txt"), "keep\n").unwrap();

        let (ws, outcome) = create(&db, "p1", &repo, "x", "x", "feat-x", "", "").unwrap();
        assert_eq!(outcome, CreateOutcome::Adopted);
        assert!(
            !db.lock().is_workspace_managed(&ws.id).unwrap(),
            "adopted checkout is NOT managed — delete/archive must never rm it"
        );
        assert!(
            !db.lock().is_branch_created_by_octopush(&ws.id).unwrap(),
            "adopted branch is NOT ours — delete must never `git branch -D` it"
        );
        assert_eq!(
            canonical_or(Path::new(ws.worktree_path.as_deref().unwrap())),
            canonical_or(&landed),
            "row points at the existing checkout"
        );
        assert!(landed.join("mine.txt").exists(), "adopted checkout untouched");

        // Re-running is idempotent now that it's tracked.
        let (again, outcome2) = create(&db, "p1", &repo, "x", "x", "feat-x", "", "").unwrap();
        assert_eq!(again.id, ws.id);
        assert_eq!(outcome2, CreateOutcome::Existed);
        assert_eq!(db.lock().list_workspaces("p1").unwrap().len(), 1);
    }

    #[test]
    fn create_for_root_checkout_returns_main_workspace_not_a_duplicate() {
        let root = test_repo();
        let repo = root.path().join("proj");
        let db = test_db();
        db.lock()
            .insert_project("p1", "Proj", &repo.to_string_lossy())
            .unwrap();
        let base = crate::git_ops::default_branch(&repo).unwrap().unwrap();
        // The main workspace: its worktree IS the project root.
        db.lock()
            .insert_workspace("main-ws", "p1", &base, "", &base, Some(&repo.to_string_lossy()), "", None)
            .unwrap();
        // Switch the root checkout to a new branch.
        crate::git_ops::create_branch(&repo, "rootx", &base).unwrap();
        crate::git_ops::open_repo(&repo)
            .unwrap()
            .set_head("refs/heads/rootx")
            .unwrap();

        let (ws, outcome) = create(&db, "p1", &repo, "x", "x", "rootx", "", "").unwrap();
        assert_eq!(ws.id, "main-ws", "returned the main workspace, not a duplicate root row");
        assert_eq!(outcome, CreateOutcome::Existed);
        assert_eq!(db.lock().list_workspaces("p1").unwrap().len(), 1, "no second row for root");
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

    #[test]
    fn workspaces_with_colliding_slugs_get_distinct_dirs() {
        // `feat/x` and `feat-x` flatten to the same slug (`feat-x`). Before the
        // per-workspace id suffix they'd have shared one directory — and creating
        // the second could rm -rf the first. The unique dir must keep them apart.
        let root = test_repo();
        let repo = root.path().join("proj");
        let db = test_db();
        db.lock()
            .insert_project("p1", "Proj", &repo.to_string_lossy())
            .unwrap();

        let (a, _) = create(&db, "p1", &repo, "a", "a", "feat/x", "", "").unwrap();
        let (b, _) = create(&db, "p1", &repo, "b", "b", "feat-x", "", "").unwrap();

        let pa = a.worktree_path.clone().unwrap();
        let pb = b.worktree_path.clone().unwrap();
        assert_ne!(pa, pb, "colliding slugs must land in distinct directories");
        assert!(Path::new(&pa).join(".git").exists(), "first worktree is live");
        assert!(Path::new(&pb).join(".git").exists(), "second worktree is live");
        assert_eq!(db.lock().list_workspaces("p1").unwrap().len(), 2);
    }

    #[test]
    fn branch_ownership_tracks_who_created_it() {
        let root = test_repo();
        let repo = root.path().join("proj");
        let db = test_db();
        db.lock()
            .insert_project("p1", "Proj", &repo.to_string_lossy())
            .unwrap();

        // A brand-new branch → Octopush created it → delete may remove it.
        let (fresh, _) = create(&db, "p1", &repo, "a", "a", "brand-new", "", "").unwrap();
        assert!(
            db.lock().is_branch_created_by_octopush(&fresh.id).unwrap(),
            "a branch Octopush created is ours to delete"
        );

        // A pre-existing branch reused by a fresh worktree → NOT ours → delete must
        // never destroy the commits already on it.
        let base = crate::git_ops::default_branch(&repo).unwrap().unwrap();
        crate::git_ops::create_branch(&repo, "pre-existing", &base).unwrap();
        let (reused, outcome) =
            create(&db, "p1", &repo, "b", "b", "pre-existing", "", "").unwrap();
        assert_eq!(outcome, CreateOutcome::Created, "fresh worktree over an old branch");
        assert!(
            !db.lock().is_branch_created_by_octopush(&reused.id).unwrap(),
            "a reused branch is someone else's work — never delete it"
        );
    }

    #[test]
    fn restore_adopts_a_branch_checked_out_elsewhere_without_clobbering() {
        // An archived workspace's branch gets checked out somewhere else (a
        // teammate, another session, a Direct run) before it's restored. Restoring
        // must adopt that live checkout — never try to build a second one (git
        // forbids it) and never touch the user's files.
        let root = test_repo();
        let repo = root.path().join("proj");
        let db = test_db();
        db.lock()
            .insert_project("p1", "Proj", &repo.to_string_lossy())
            .unwrap();

        let (ws, _) = create(&db, "p1", &repo, "s", "s", "shared", "", "").unwrap();
        let orig = ws.worktree_path.clone().unwrap();
        // Archive: remove the managed worktree, keep the branch.
        crate::git_ops::delete_worktree(&repo, Path::new(&orig)).unwrap();
        std::fs::remove_dir_all(&orig).ok();
        db.lock().archive_workspace(&ws.id).unwrap();

        // Someone checks the branch out at an external path.
        let ext_dir = tempdir().unwrap();
        let ext = ext_dir.path().join("shared-elsewhere");
        let landed = crate::git_ops::create_worktree(&repo, "shared", &ext).unwrap();
        std::fs::write(landed.join("theirs.txt"), "keep\n").unwrap();

        // Restoring adopts the live checkout instead of clobbering it.
        let (restored, outcome) =
            create(&db, "p1", &repo, "s", "s", "shared", "", "").unwrap();
        assert_eq!(restored.id, ws.id);
        assert_eq!(outcome, CreateOutcome::Restored);
        assert_eq!(
            canonical_or(Path::new(restored.worktree_path.as_deref().unwrap())),
            canonical_or(&landed),
            "row points at the live external checkout"
        );
        assert!(
            !db.lock().is_workspace_managed(&restored.id).unwrap(),
            "an adopted checkout is not ours — delete must never rm it"
        );
        assert!(landed.join("theirs.txt").exists(), "external checkout untouched");
    }

    #[test]
    fn heal_leaves_a_present_worktree_and_its_uncommitted_work_alone() {
        // A present directory is never rebuilt or removed — it may hold uncommitted
        // work. Re-running create for a healthy workspace must preserve it verbatim.
        let root = test_repo();
        let repo = root.path().join("proj");
        let db = test_db();
        db.lock()
            .insert_project("p1", "Proj", &repo.to_string_lossy())
            .unwrap();

        let (ws, _) = create(&db, "p1", &repo, "w", "w", "wip", "", "").unwrap();
        let wt = ws.worktree_path.clone().unwrap();
        std::fs::write(Path::new(&wt).join("uncommitted.txt"), "precious\n").unwrap();

        let (again, outcome) = create(&db, "p1", &repo, "w", "w", "wip", "", "").unwrap();
        assert_eq!(again.id, ws.id);
        assert_eq!(outcome, CreateOutcome::Existed);
        assert_eq!(again.worktree_path.as_deref(), Some(wt.as_str()), "same dir");
        assert_eq!(
            std::fs::read_to_string(Path::new(&wt).join("uncommitted.txt")).unwrap(),
            "precious\n",
            "uncommitted work preserved"
        );
    }
}
