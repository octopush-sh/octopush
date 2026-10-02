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


/// The longest branch the app derives from a task. Mirrors the frontend's
/// `BRANCH_NAME_MAX` in `lib/branchName.ts`.
pub const BRANCH_NAME_MAX: usize = 60;
/// How many words of a task make it into a derived branch.
pub const BRANCH_WORDS: usize = 4;
/// The longest branch-derived part of a worktree directory name; `-<id8>`
/// follows. Mirrors the frontend's `DIR_SLUG_MAX`.
pub const DIR_SLUG_MAX: usize = 60;
/// Claude Code names a session's transcript directory after the worktree
/// path (`transcripts::project_dir_name`) and caps that name at this many
/// characters, appending a hash past it. A worktree path must stay within
/// it or the ledger cannot follow the session.
pub const CLAUDE_DIR_NAME_CAP: usize = 200;

/// Filler words dropped when deriving a branch from a task — the frontend's
/// `GENESIS_STOPWORDS`, kept identical so the MCP derives the branch the
/// wizard would.
const STOPWORDS: &[&str] = &[
    "a", "an", "the", "i", "me", "my", "we", "our", "you", "your", "it", "its",
    "this", "that", "these", "to", "of", "in", "into", "on", "for", "from", "and",
    "or", "with", "without", "so", "as", "at", "by", "is", "are", "be", "am",
    "build", "builds", "make", "makes", "create", "creates", "write", "develop",
    "want", "wants", "would", "like", "need", "needs", "please", "help", "let",
    "lets", "some", "new", "app", "apps", "application", "project", "program",
    "software", "tool", "thing", "something", "which", "can", "will", "should",
    "us",
];

/// Cut a `-`-joined slug to at most `max` characters on a word boundary —
/// never mid-word, never leaving a trailing dash; cut hard when no boundary
/// comes before the limit. Mirrors the frontend's `shortenSlug`.
pub fn shorten_slug(slug: &str, max: usize) -> String {
    if slug.chars().count() <= max {
        return slug.to_string();
    }
    let head: String = slug.chars().take(max).collect();
    let cut = match head.rfind('-') {
        Some(i) if i > 0 => head[..i].to_string(),
        _ => head,
    };
    cut.trim_end_matches('-').to_string()
}

/// Lowercase, then ASCII letters and digits only, at most 24 — the
/// frontend's `cleanToken`, in that order (`İstanbul` → `istanbul`).
fn clean_token(t: &str) -> String {
    t.to_lowercase().chars().filter(|c| c.is_ascii_alphanumeric()).take(24).collect()
}

/// The first `n` significant words of a text (filler dropped), or its first
/// `n` words when everything is filler. The frontend's `pickWords`.
fn pick_words(text: &str, n: usize) -> Vec<String> {
    let words: Vec<String> = text.split_whitespace().map(clean_token).filter(|t| !t.is_empty()).collect();
    let significant: Vec<String> = words.iter().filter(|w| !STOPWORDS.contains(&w.as_str())).cloned().collect();
    let picked = if significant.is_empty() { words } else { significant };
    picked.into_iter().take(n).collect()
}

/// `<KEY>-<up to four significant words>`, at most [`BRANCH_NAME_MAX`]
/// characters, cut on a word boundary and never inside the key. The key is
/// the one given or, only when the project has a Jira key, that project's
/// first key found in the task — a bare `UTF-8` is never a ticket. The key's
/// text is removed from the task before its words are picked, so it never
/// repeats, glued to punctuation or not. Empty when nothing is left — the
/// caller picks its fallback. Mirrors the frontend's `branchFromTask`;
/// `src/lib/branchName.fixtures.json` pins both to the same cases.
pub fn branch_from_task(task: &str, issue_key: Option<&str>, project_key: Option<&str>) -> String {
    let key = issue_key
        .map(str::to_string)
        .or_else(|| {
            let project = project_key?.trim();
            if project.is_empty() {
                return None;
            }
            crate::issue_tracker::detect_issue_key(task).filter(|k| k.starts_with(&format!("{project}-")))
        })
        .unwrap_or_default()
        .trim()
        .to_string();
    let text = if key.is_empty() { task.to_string() } else { remove_ignoring_case(task, &key) };
    let body = pick_words(&text, BRANCH_WORDS).join("-");
    if key.is_empty() {
        return shorten_slug(&body, BRANCH_NAME_MAX);
    }
    if body.is_empty() {
        return key;
    }
    let room = BRANCH_NAME_MAX.saturating_sub(key.len() + 1);
    let tail = if room > 0 { shorten_slug(&body, room) } else { String::new() };
    if tail.is_empty() { key } else { format!("{key}-{tail}") }
}

/// `text` with every occurrence of `needle` (any case) replaced by a space.
fn remove_ignoring_case(text: &str, needle: &str) -> String {
    let lower = text.to_lowercase();
    let needle_l = needle.to_lowercase();
    if needle_l.is_empty() || lower.len() != text.len() {
        // A lowercase that changes byte length cannot be mapped back; fall
        // back to a case-sensitive removal.
        return text.replace(needle, " ");
    }
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        if lower[i..].starts_with(&needle_l) {
            out.push(' ');
            i += needle_l.len();
        } else {
            let ch = text[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

/// `base`, or `base-2`, `base-3`, … — the first `is_taken` refuses. Two
/// tasks that share their first four words must not share a branch, or the
/// second mission would silently reuse the first one's workspace.
pub fn unique_branch(base: &str, is_taken: impl Fn(&str) -> bool) -> String {
    if !is_taken(base) {
        return base.to_string();
    }
    (2..1000)
        .map(|n| format!("{base}-{n}"))
        .find(|c| !is_taken(c))
        .unwrap_or_else(|| format!("{base}-{}", chrono::Utc::now().timestamp()))
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

/// Find an ACTIVE workspace in `project` whose worktree path resolves to `path`,
/// so adoption never registers a second row over a checkout that's already tracked
/// (e.g. the main worktree, or a workspace whose branch was switched in place).
///
/// Deliberately excludes archived rows: an archived workspace's worktree has been
/// removed, so a branch that is *currently* checked out at some path can't be that
/// archived workspace. Matching archived rows by path would resurrect an unrelated
/// workspace (for a different branch) when the user asked to create a new one —
/// the branch-based lookup in step 1 already restores an archived row for its OWN
/// branch.
fn workspace_at_path(
    db: &Mutex<Db>,
    project_id: &str,
    path: &Path,
) -> AppResult<Option<WorkspaceRow>> {
    let target = canonical_or(path);
    let d = db.lock();
    let rows = d.list_workspaces(project_id)?;
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
    let worktrees = project_path.parent().unwrap_or(project_path).join(".octopus-worktrees");
    let dir_name = worktree_dir_name_under(&worktrees, branch, workspace_id);
    let desired = worktrees.join(&dir_name);
    // create_worktree returns where the worktree ACTUALLY landed.
    let actual = crate::git_ops::create_worktree(project_path, branch, &desired)?;

    Ok((base, actual, created_branch))
}

/// The directory basename for a workspace's worktree: `<branch-slug>-<id8>`.
/// Unique per workspace by construction (the id suffix), filesystem-safe /
/// flat (the slug), and the slug never over [`DIR_SLUG_MAX`] — a typed branch
/// can be long, the directory is not. Mirrored on the frontend by
/// `worktreeDirName` + `shortenSlug` for the path preview.
fn worktree_dir_name(branch: &str, workspace_id: &str) -> String {
    worktree_dir_name_within(branch, workspace_id, DIR_SLUG_MAX)
}

fn worktree_dir_name_within(branch: &str, workspace_id: &str, slug_max: usize) -> String {
    let id8: String = workspace_id.chars().take(8).collect();
    let slug = shorten_slug(&crate::git_ops::slot_name_for(branch), slug_max);
    let slug = if slug.is_empty() { "workspace".to_string() } else { slug };
    format!("{slug}-{id8}")
}

/// [`worktree_dir_name`] fitted to where it will live: Claude Code names its
/// transcript directory after the whole worktree path, capped at 200
/// characters ([`CLAUDE_DIR_NAME_CAP`]), so under a deep parent the
/// slug gives way until the path fits — else the session's spend would be
/// unreadable. Never shorter than eight characters of slug.
fn worktree_dir_name_under(worktrees_dir: &Path, branch: &str, workspace_id: &str) -> String {
    // Claude Code records the physical cwd, so a symlinked parent counts at
    // its resolved length — whichever of the two is longer bounds the slug.
    let as_written = format!("{}/", worktrees_dir.to_string_lossy());
    let resolved = worktrees_dir
        .parent()
        .and_then(|p| std::fs::canonicalize(p).ok())
        .and_then(|p| worktrees_dir.file_name().map(|n| format!("{}/{}/", p.to_string_lossy(), n.to_string_lossy())));
    let base = [Some(as_written), resolved]
        .into_iter()
        .flatten()
        .map(|p| crate::transcripts::project_dir_name(&p).chars().count())
        .max()
        .unwrap_or(0);
    let room = CLAUDE_DIR_NAME_CAP.saturating_sub(base + 1 + 8);
    worktree_dir_name_within(branch, workspace_id, DIR_SLUG_MAX.min(room).max(8))
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

    let rebuilt = heal_worktree(db, project_path, &mut ws)?;

    if was_archived {
        let d = db.lock();
        d.restore_workspace(&ws.id)?;
        let restored = d.get_workspace(&ws.id)?.ok_or_else(|| {
            AppError::Other("workspace restored but could not be reloaded".into())
        })?;
        return Ok((restored, CreateOutcome::Restored));
    }

    // An active row whose worktree had vanished and was just rebuilt was *not*
    // returned unchanged — report Restored so the UI/MCP don't claim "already
    // existed, nothing to do" when a worktree was in fact materialised.
    let outcome = if rebuilt {
        CreateOutcome::Restored
    } else {
        CreateOutcome::Existed
    };
    Ok((ws, outcome))
}

/// Ensure `ws` points at a usable worktree, mutating the row (and DB) in place.
/// Returns `true` if it had to rebuild a worktree from scratch. Shared by
/// `reuse_or_restore` (create-time) and the `restore_workspace` command so both
/// heal a branch the same way. See `reuse_or_restore` for the cases. NEVER removes
/// a present directory.
pub fn heal_worktree(
    db: &Mutex<Db>,
    project_path: &Path,
    ws: &mut WorkspaceRow,
) -> AppResult<bool> {
    // The main workspace's worktree IS the project root: it always exists, is never
    // rebuilt, and must never be re-pointed at a linked checkout or disowned —
    // doing so would strip the root-protection that keeps delete/archive from ever
    // touching the project root. Leave it entirely alone.
    if ws
        .worktree_path
        .as_deref()
        .is_some_and(|w| same_path(Path::new(w), project_path))
    {
        return Ok(false);
    }

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
            // location and disown it (never rm on delete). We deliberately leave
            // the workspace's original managed directory (if any) on disk: it may
            // now hold uncommitted work on whatever branch it was switched to, so
            // removing it would be exactly the data loss this redesign eliminates.
            let d = db.lock();
            d.set_workspace_worktree_path(&ws.id, &here)?;
            d.set_workspace_managed(&ws.id, false)?;
            ws.worktree_path = Some(here);
        }
        return Ok(false);
    }

    // Case 2/3: not checked out anywhere. Rebuild only if the directory is entirely
    // gone; never touch a present one (a present-but-broken tree may still hold
    // uncommitted work — rebuilding would require rm-ing it, so we preserve it even
    // though the workspace stays broken until the user resolves it by hand).
    let wt = ws.worktree_path.clone();
    let gone = wt.as_deref().map(|w| !Path::new(w).exists()).unwrap_or(true);
    if gone {
        // Rebuild at this workspace's unique directory. The branch already exists,
        // so create_branch reuses it (created_branch is irrelevant here — we don't
        // change branch ownership on a heal). A rebuilt tree is ours → managed.
        let worktrees = project_path.parent().unwrap_or(project_path).join(".octopus-worktrees");
        let dir_name = worktree_dir_name_under(&worktrees, &ws.branch, &ws.id);
        let desired = worktrees.join(&dir_name);
        let actual = crate::git_ops::create_worktree(project_path, &ws.branch, &desired)?;
        let actual_str = actual.to_string_lossy().to_string();
        let d = db.lock();
        d.set_workspace_worktree_path(&ws.id, &actual_str)?;
        d.set_workspace_managed(&ws.id, true)?;
        ws.worktree_path = Some(actual_str);
        return Ok(true);
    }
    Ok(false)
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
    fn branch_from_task_satisfies_the_shared_cases_the_wizard_is_pinned_to() {
        let fixtures: serde_json::Value =
            serde_json::from_str(include_str!("../../src/lib/branchName.fixtures.json")).expect("fixtures");
        let cases = fixtures["cases"].as_array().expect("cases");
        assert!(cases.len() >= 10);
        for c in cases {
            let task = c["task"].as_str().unwrap();
            let key = c["key"].as_str();
            let project = c["projectKey"].as_str();
            let out = branch_from_task(task, key, project);
            assert_eq!(out, c["expect"].as_str().unwrap(), "{task} · key={key:?} · project={project:?}");
            assert!(out.len() <= BRANCH_NAME_MAX.max(key.map_or(0, str::len)), "{out}");
            assert!(!out.ends_with('-'));
        }
    }

    #[test]
    fn stopwords_are_the_frontends_word_for_word() {
        // The list is copied from `lib/genesis.ts`; this keeps the copy honest.
        let src = include_str!("../../src/lib/genesis.ts");
        let start = src.find("GENESIS_STOPWORDS = new Set([").expect("list") + "GENESIS_STOPWORDS = new Set([".len();
        let end = src[start..].find("])").expect("end") + start;
        let frontend: Vec<&str> = src[start..end].split('"').skip(1).step_by(2).collect();
        let mut ours: Vec<&str> = STOPWORDS.to_vec();
        let mut theirs: Vec<&str> = frontend;
        ours.sort_unstable();
        ours.dedup();
        theirs.sort_unstable();
        theirs.dedup();
        assert_eq!(ours, theirs);
    }

    #[test]
    fn unique_branch_suffixes_a_taken_name_with_the_first_free_number() {
        let taken = ["fix-login-form-validation", "fix-login-form-validation-2"];
        let is_taken = |b: &str| taken.contains(&b);
        assert_eq!(unique_branch("fix-login-form-validation", is_taken), "fix-login-form-validation-3");
        assert_eq!(unique_branch("free", is_taken), "free");
    }

    #[test]
    fn shorten_slug_cuts_on_a_dash_and_hard_only_without_one() {
        assert_eq!(shorten_slug("one-two-three", 9), "one-two");
        assert_eq!(shorten_slug("one-two-three", 13), "one-two-three");
        assert_eq!(shorten_slug("abcdefghijklmnop", 5), "abcde");
        assert_eq!(shorten_slug("one-two", 4), "one");
    }

    #[test]
    fn worktree_directory_names_are_capped_and_fit_claude_codes_limit() {
        let long_branch = format!("GUIDE-3753-{}", "word-".repeat(40));
        let name = worktree_dir_name(&long_branch, "abcdefgh-rest");
        assert!(name.len() <= DIR_SLUG_MAX + 9, "{name}");
        assert!(name.ends_with("-abcdefgh"));
        assert!(name.starts_with("GUIDE-3753-word-"));
        // A short branch is left alone.
        assert_eq!(worktree_dir_name("feat/foo", "12345678x"), "feat-foo-12345678");
        // Under a deep parent, the slug gives way so the sanitized path stays
        // within Claude Code's 200 characters. (A path that does not exist
        // cannot be canonicalized; its written form is the bound.)
        let deep_s = format!("/Users/j/{}/.octopus-worktrees", "deep/".repeat(28));
        let deep = Path::new(&deep_s);
        let fitted = worktree_dir_name_under(deep, &long_branch, "abcdefgh");
        let sanitized = crate::transcripts::project_dir_name(&format!("{}/{}", deep.to_string_lossy(), fitted));
        assert!(sanitized.chars().count() <= CLAUDE_DIR_NAME_CAP, "{sanitized}");
        assert!(fitted.len() < DIR_SLUG_MAX + 9, "shortened below the usual cap: {fitted}");
        assert!(fitted.ends_with("-abcdefgh"));
        // A parent so deep nothing fits still keeps up to eight characters of
        // slug, cut on a word boundary like any other.
        let absurd_s = format!("/{}/.octopus-worktrees", "x/".repeat(120));
        assert_eq!(worktree_dir_name_under(Path::new(&absurd_s), &long_branch, "abcdefgh"), "GUIDE-abcdefgh");
        // A symlinked parent counts at its resolved length.
        let tmp = tempfile::TempDir::new().unwrap();
        let real = tmp.path().join(format!("{}real", "very-long-directory-name/".repeat(4)));
        std::fs::create_dir_all(&real).unwrap();
        let link = tmp.path().join("s");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&real, &link).unwrap();
            let via_link = link.join(".octopus-worktrees");
            let fitted = worktree_dir_name_under(&via_link, &long_branch, "abcdefgh");
            let physical = format!("{}/.octopus-worktrees/{}", real.canonicalize().unwrap().to_string_lossy(), fitted);
            assert!(crate::transcripts::project_dir_name(&physical).chars().count() <= CLAUDE_DIR_NAME_CAP, "{physical}");
            // The short path through the link alone would have allowed the full slug.
            assert!(fitted.len() < DIR_SLUG_MAX + 9, "the resolved length bounded it: {fitted}");
        }
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

    #[test]
    fn destroy_gates_default_to_not_owned_for_a_missing_row() {
        // The delete gates key off these flags. For a row that no longer exists
        // (e.g. a double-fire delete), both must read "not ours" so we never rm a
        // path or `git branch -D` a branch a second time. Existing rows are
        // unaffected — the columns are NOT NULL DEFAULT 1.
        let db = test_db();
        assert!(!db.lock().is_workspace_managed("no-such-row").unwrap());
        assert!(!db.lock().is_branch_created_by_octopush("no-such-row").unwrap());
    }

    #[test]
    fn recreating_an_active_workspace_with_a_vanished_worktree_reports_restored() {
        // An ACTIVE workspace whose worktree vanished out-of-band (rm -rf) is
        // silently rebuilt on the next create — that's a real materialisation, so
        // it must report Restored, not Existed (which claims "nothing to do").
        let root = test_repo();
        let repo = root.path().join("proj");
        let db = test_db();
        db.lock()
            .insert_project("p1", "Proj", &repo.to_string_lossy())
            .unwrap();

        let (ws, _) = create(&db, "p1", &repo, "v", "v", "vanish", "", "").unwrap();
        let wt = ws.worktree_path.clone().unwrap();
        // Remove the worktree entirely, but leave the row ACTIVE (not archived).
        crate::git_ops::delete_worktree(&repo, Path::new(&wt)).unwrap();
        std::fs::remove_dir_all(&wt).ok();

        let (again, outcome) = create(&db, "p1", &repo, "v", "v", "vanish", "", "").unwrap();
        assert_eq!(again.id, ws.id, "same workspace, not a duplicate");
        assert_eq!(outcome, CreateOutcome::Restored, "a rebuilt worktree is a restoration");
        assert!(
            Path::new(again.worktree_path.as_deref().unwrap()).join(".git").exists(),
            "worktree rebuilt"
        );
    }

    #[test]
    fn create_does_not_resurrect_an_archived_workspace_by_path() {
        // An archived row for `old` happens to still record path Q, and the user
        // now has a DIFFERENT branch `new` checked out at Q. Asking to create `new`
        // must adopt it as its own workspace — never un-archive the unrelated `old`.
        let root = test_repo();
        let repo = root.path().join("proj");
        let db = test_db();
        db.lock()
            .insert_project("p1", "Proj", &repo.to_string_lossy())
            .unwrap();
        let base = crate::git_ops::default_branch(&repo).unwrap().unwrap();
        crate::git_ops::create_branch(&repo, "new", &base).unwrap();

        // A live checkout of `new` at Q.
        let q_dir = tempdir().unwrap();
        let q = q_dir.path().join("shared");
        let landed = crate::git_ops::create_worktree(&repo, "new", &q).unwrap();

        // An archived workspace for `old` that still points at Q.
        db.lock()
            .insert_workspace("old-ws", "p1", "old", "", "old", Some(&landed.to_string_lossy()), "", None)
            .unwrap();
        db.lock().archive_workspace("old-ws").unwrap();

        let (ws, outcome) = create(&db, "p1", &repo, "n", "n", "new", "", "").unwrap();
        assert_eq!(outcome, CreateOutcome::Adopted, "adopted `new`, not resurrected `old`");
        assert_ne!(ws.id, "old-ws", "did not hand back the archived `old` workspace");
        assert_eq!(ws.branch, "new");
        assert_eq!(
            db.lock().get_workspace("old-ws").unwrap().unwrap().status,
            "archived",
            "the unrelated `old` workspace stays archived"
        );
    }

    #[test]
    fn heal_never_repoints_or_disowns_the_main_workspace() {
        // The main workspace's worktree IS the project root. Even if its recorded
        // branch is checked out in a linked worktree elsewhere, healing must leave
        // it pointing at root and managed — otherwise delete could strip its
        // root-protection and try to `git branch -D` the default branch.
        let root = test_repo();
        let repo = root.path().join("proj");
        let db = test_db();
        db.lock()
            .insert_project("p1", "Proj", &repo.to_string_lossy())
            .unwrap();
        let base = crate::git_ops::default_branch(&repo).unwrap().unwrap();
        db.lock()
            .insert_workspace("main-ws", "p1", &base, "", &base, Some(&repo.to_string_lossy()), "", None)
            .unwrap();

        // Free the default branch from the root, then check it out in a linked
        // worktree so `live_worktree_on_branch(base)` points away from root.
        crate::git_ops::create_branch(&repo, "detour", &base).unwrap();
        crate::git_ops::open_repo(&repo).unwrap().set_head("refs/heads/detour").unwrap();
        let l_dir = tempdir().unwrap();
        crate::git_ops::create_worktree(&repo, &base, &l_dir.path().join("linked")).unwrap();

        let (ws, _) = create(&db, "p1", &repo, "m", "m", &base, "", "").unwrap();
        assert_eq!(ws.id, "main-ws");
        assert_eq!(
            canonical_or(Path::new(ws.worktree_path.as_deref().unwrap())),
            canonical_or(&repo),
            "main workspace still points at the project root"
        );
        assert!(
            db.lock().is_workspace_managed("main-ws").unwrap(),
            "main workspace not disowned"
        );
    }
}
