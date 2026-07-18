//! Mission lifecycle — the single shared code path for creating and pairing
//! missions, used by both the Tauri command layer and the `octopush-mcp` binary
//! (mirrors the role of [`crate::workspace`]). A mission is a thread of intent;
//! isolation is a property it chooses on two axes (git-state × execution). The
//! worktree stops being the unit and becomes one value of the git-state axis.

use crate::db::{Db, MissionRow, WorkspaceRow};
use crate::error::{AppError, AppResult};

/// The intent taxonomy. `build`/`fix` are code missions (worktree default);
/// `review`/`probe`/`design`/`perf`/`ops` arrive with later movements but the
/// enum is validated from day one so the data model never holds a stray value.
pub const INTENTS: &[&str] = &["build", "fix", "review", "probe", "design", "perf", "ops"];
/// The git-state isolation axis.
pub const GIT_ISOLATIONS: &[&str] = &["worktree", "readonly", "ephemeral", "pr"];
/// The execution isolation axis (`cloud` reserved until M5).
pub const EXEC_ISOLATIONS: &[&str] = &["none", "sandbox", "container", "cloud"];
/// The mission status vocabulary.
pub const STATUSES: &[&str] = &["active", "done", "archived"];

/// Validate a caller-supplied mission status (the `update_mission` command uses
/// this before persisting, so a bad string can't slip a mission out of the
/// active set without the archived-at bookkeeping the archive path maintains).
pub fn validate_status(status: &str) -> AppResult<()> {
    if !STATUSES.contains(&status) {
        return Err(AppError::Other(format!("unknown mission status '{status}'")));
    }
    Ok(())
}

/// Validate the intent + git-isolation axes a caller may pass (execution
/// isolation is always `none` at creation time). `create_workspace` calls this
/// BEFORE creating any workspace/worktree, so a bad axis can't strand an
/// orphaned workspace with no mission.
pub fn validate_axes(intent: &str, git_isolation: &str) -> AppResult<()> {
    validate(intent, git_isolation, "none")
}

/// Validate the execution-isolation axis (the wizard's Execution choice, applied
/// to the mission after pairing). Kept separate from `validate_axes` so its
/// callers are unaffected.
pub fn validate_exec(exec_isolation: &str) -> AppResult<()> {
    if !EXEC_ISOLATIONS.contains(&exec_isolation) {
        return Err(AppError::Other(format!("unknown exec isolation '{exec_isolation}'")));
    }
    Ok(())
}

fn validate(intent: &str, git_isolation: &str, exec_isolation: &str) -> AppResult<()> {
    if !INTENTS.contains(&intent) {
        return Err(AppError::Other(format!("unknown mission intent '{intent}'")));
    }
    if !GIT_ISOLATIONS.contains(&git_isolation) {
        return Err(AppError::Other(format!("unknown git isolation '{git_isolation}'")));
    }
    if !EXEC_ISOLATIONS.contains(&exec_isolation) {
        return Err(AppError::Other(format!("unknown exec isolation '{exec_isolation}'")));
    }
    Ok(())
}

/// Create a mission. Validates the two isolation axes; the writer-uniqueness
/// invariant (never two active missions writing one checkout) is enforced by the
/// partial unique index and surfaced as a legible error from `insert_mission`.
#[allow(clippy::too_many_arguments)]
pub fn create(
    db: &Db,
    project_id: &str,
    intent: &str,
    title: &str,
    git_isolation: &str,
    exec_isolation: &str,
    workspace_id: Option<&str>,
    linked_issue_key: Option<&str>,
) -> AppResult<MissionRow> {
    validate(intent, git_isolation, exec_isolation)?;
    // One workspace, one isolation mode. A workspace may host several active
    // missions (readonly review/probe share a checkout), but they must ALL agree
    // on git_isolation — because execution confinement is resolved from
    // `active_mission_for_workspace` (any active mission), so a mix of readonly +
    // writer missions on one checkout could let a readonly agent resolve as a
    // writer and modify the checkout. Reject the mix at the source.
    if let Some(ws) = workspace_id {
        if let Some(other) = db.conflicting_active_isolation(ws, git_isolation)? {
            return Err(AppError::Other(format!(
                "this workspace already has an active '{other}' mission — a checkout can't mix \
                 '{other}' and '{git_isolation}' isolation (start '{intent}' in its own workspace)"
            )));
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    db.insert_mission(
        &id,
        workspace_id,
        project_id,
        intent,
        title,
        "active",
        linked_issue_key,
        git_isolation,
        exec_isolation,
        "{}",
    )?;
    db.get_mission(&id)?
        .ok_or_else(|| AppError::Other("mission vanished right after insert".into()))
}

/// Idempotent pairing for a code workspace: return the existing active mission
/// if one already owns the workspace, else create one with the given `intent`
/// and `git_isolation` (the wizard's Step-1 intent + isolation choice).
/// Guarantees the invariant "no workspace without a mission" from day one, and
/// stays a no-op when a workspace is reused/restored/adopted (create is
/// idempotent on `(project_id, branch)` upstream, so callers may call this on
/// every outcome).
pub fn ensure_for_workspace(
    db: &Db,
    ws: &WorkspaceRow,
    intent: &str,
    git_isolation: &str,
) -> AppResult<MissionRow> {
    if let Some(existing) = db.active_mission_for_workspace(&ws.id)? {
        // Honor the wizard's latest choice on reuse: re-running the wizard for
        // an existing branch (a collision the UI surfaces) with a different
        // intent/isolation updates the mission in place, so the picked values
        // are never silently discarded. Idempotent when nothing changed.
        if existing.intent != intent || existing.git_isolation != git_isolation {
            db.update_mission_axes(&existing.id, intent, git_isolation)?;
            return Ok(db.get_mission(&existing.id)?.unwrap_or(existing));
        }
        return Ok(existing);
    }
    let title = if ws.task.trim().is_empty() { ws.name.as_str() } else { ws.task.as_str() };
    create(
        db,
        &ws.project_id,
        intent,
        title,
        git_isolation,
        "none",
        Some(&ws.id),
        ws.linked_issue_key.as_deref(),
    )
}
