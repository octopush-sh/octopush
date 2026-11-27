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
/// `test` tests a ticket in a disposable checkout and ships nothing (#1238).
pub const INTENTS: &[&str] = &["build", "fix", "review", "probe", "design", "perf", "ops", "test"];
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

/// Whether a mission of this intent delivers its work (pushes, opens pull
/// requests, publishes). The others read, or test, and hand back findings.
pub fn delivers(intent: &str) -> bool {
    matches!(intent, "build" | "fix" | "design" | "ops")
}

/// Whether a mission ships nothing (#1238): it may write, build and run in
/// its checkout, but Octopush refuses what would change something elsewhere
/// ([`crate::permissions::PolicyCtx::ships_nothing`]). Derived from the two
/// stored axes and never stored, so it can't disagree with the intent. A
/// `readonly` mission is stricter still (Plan only), so it isn't counted.
pub fn ships_nothing(intent: &str, git_isolation: &str) -> bool {
    !delivers(intent) && git_isolation != "readonly"
}

/// Whether moving a mission from one pair of axes to another loosens it. A
/// mission's posture only gets stricter: a read-only one stays read-only
/// (#1235), and one that ships nothing never becomes one that delivers.
pub fn loosens(intent: &str, git_isolation: &str, to_intent: &str, to_git_isolation: &str) -> bool {
    (git_isolation == "readonly" && to_git_isolation != "readonly") || (ships_nothing(intent, git_isolation) && delivers(to_intent))
}

fn validate(intent: &str, git_isolation: &str, exec_isolation: &str) -> AppResult<()> {
    if !INTENTS.contains(&intent) {
        return Err(AppError::Other(format!("unknown mission intent '{intent}'")));
    }
    if !GIT_ISOLATIONS.contains(&git_isolation) {
        return Err(AppError::Other(format!("unknown git isolation '{git_isolation}'")));
    }
    // New missions only: a row stored before this rule keeps loading, and a
    // non-delivering one on a writer checkout reads as ship-nothing.
    if intent == "test" && git_isolation != "ephemeral" {
        return Err(AppError::Other(format!(
            "a 'test' mission runs in a throwaway checkout, so its git isolation must be 'ephemeral' (got '{git_isolation}')"
        )));
    }
    if !delivers(intent) && matches!(git_isolation, "worktree" | "pr") {
        return Err(AppError::Other(format!(
            "a '{intent}' mission delivers nothing, so its git isolation must be 'readonly' or 'ephemeral' (got '{git_isolation}')"
        )));
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
            // Every re-pair comes through here (the app's wizard and the MCP
            // binary's `create_workspace`), so none can lift a posture.
            if loosens(&existing.intent, &existing.git_isolation, intent, git_isolation) {
                return Err(AppError::Other(format!(
                    "this workspace's mission is '{}' on '{}', and a mission can only get stricter, so it can't \
                     become '{intent}' on '{git_isolation}'. Start that mission on a branch of its own.",
                    existing.intent, existing.git_isolation
                )));
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Every (intent, git-state) pair: whether it delivers, whether it ships
    /// nothing, and whether a new mission may take it.
    #[test]
    fn the_posture_of_every_intent_and_git_state() {
        for intent in INTENTS {
            for git in GIT_ISOLATIONS {
                let delivering = matches!(*intent, "build" | "fix" | "design" | "ops");
                assert_eq!(delivers(intent), delivering, "{intent}");
                assert_eq!(ships_nothing(intent, git), !delivering && *git != "readonly", "{intent} on {git}");
                let allowed = match *intent {
                    "test" => *git == "ephemeral",
                    _ if delivering => true,
                    _ => matches!(*git, "readonly" | "ephemeral"),
                };
                let result = validate_axes(intent, git);
                assert_eq!(result.is_ok(), allowed, "{intent} on {git}: {result:?}");
                if let Err(e) = result {
                    assert!(e.to_string().contains(&format!("'{intent}' mission")), "the error names the intent: {e}");
                }
            }
        }
        assert!(ships_nothing("test", "ephemeral") && !ships_nothing("build", "ephemeral"));
    }

    /// A row `octopush-mcp` could store before the rule (`review` on its own
    /// worktree) still loads, and reads as ship-nothing: it only narrows.
    #[test]
    fn a_stored_review_on_a_worktree_reads_as_ship_nothing() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let db = Db::open(tmp.path()).unwrap();
        db.insert_project("p1", "P", "/tmp/octo-mission-posture").unwrap();
        db.insert_mission("m1", None, "p1", "review", "Old review", "active", None, "worktree", "none", "{}").unwrap();
        let m = db.get_mission("m1").unwrap().expect("the old row loads");
        assert!(ships_nothing(&m.intent, &m.git_isolation));
        assert!(create(&db, "p1", "review", "New review", "worktree", "none", None, None).is_err(), "a new one is refused");
    }

    /// Re-pairing a workspace's mission only ever makes it stricter, on the
    /// one path the app's wizard and `octopush-mcp`'s `create_workspace` share.
    #[test]
    fn a_re_pair_never_loosens_a_mission() {
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let db = Db::open(tmp.path()).unwrap();
        db.insert_project("p1", "P", "/tmp/octo-mission-repair").unwrap();
        let refused = [
            (("review", "readonly"), ("build", "worktree")),
            (("probe", "readonly"), ("test", "ephemeral")),
            (("perf", "readonly"), ("fix", "pr")),
            (("test", "ephemeral"), ("build", "worktree")),
            (("test", "ephemeral"), ("fix", "ephemeral")),
            (("review", "worktree"), ("build", "worktree")),
        ];
        let allowed = [
            (("build", "worktree"), ("fix", "worktree")),
            (("build", "worktree"), ("test", "ephemeral")),
            (("test", "ephemeral"), ("review", "readonly")),
            (("test", "ephemeral"), ("review", "ephemeral")),
        ];
        for (i, ((from_i, from_g), (to_i, to_g))) in refused.iter().chain(allowed.iter()).enumerate() {
            let ws = format!("w{i}");
            db.insert_workspace(&ws, "p1", &ws, "t", &format!("b{i}"), None, "", None).unwrap();
            db.insert_mission(&format!("m{i}"), Some(ws.as_str()), "p1", from_i, "t", "active", None, from_g, "none", "{}").unwrap();
            let row = db.get_workspace(&ws).unwrap().unwrap();
            let result = ensure_for_workspace(&db, &row, to_i, to_g);
            let m = db.active_mission_for_workspace(&ws).unwrap().unwrap();
            if i < refused.len() {
                let err = result.expect_err(&format!("{from_i}/{from_g} → {to_i}/{to_g}")).to_string();
                assert!(err.contains("can only get stricter"), "{err}");
                assert_eq!((m.intent.as_str(), m.git_isolation.as_str()), (*from_i, *from_g), "the mission is untouched");
            } else {
                result.unwrap();
                assert_eq!((m.intent.as_str(), m.git_isolation.as_str()), (*to_i, *to_g));
            }
        }
        // A read-only mission stays sandboxed with no write roots.
        let m = db.active_mission_for_workspace("w0").unwrap().unwrap();
        assert_eq!(crate::orchestrator::sandbox::sandbox_write_roots(&m.git_isolation, &m.exec_isolation, "/ws"), Some(vec![]));
        // The app's command pairs through the same function.
        assert!(include_str!("commands.rs").contains("crate::mission::ensure_for_workspace(&db, &ws, intent, git_isolation)?;"));
    }
}
