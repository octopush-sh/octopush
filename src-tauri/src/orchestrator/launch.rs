//! `launch_run` — the single guarded path from a `draft`/paused run to a
//! driving crew.
//!
//! Both `commands::start_run` (user pressed Begin) and the routines scheduler
//! (a schedule came due) must apply the exact same gates — same-workspace
//! concurrency, the cross-process worker lease, the monthly Direct-run quota,
//! the parallel-runs entitlement, the budget, the durable first-run marker —
//! and the same detached-spawn-with-in-process-fallback discipline. Two copies
//! would drift (and the detached routing was hard-won); this is the one code
//! path they share. It returns the SAME errors `start_run` always has, so the
//! command is a thin delegate and the scheduler simply logs+skips on refusal.

use std::sync::Arc;

use parking_lot::Mutex;

use crate::db::Db;
use crate::error::{AppError, AppResult};

use super::Orchestrator;

/// Apply every start-time guard, then drive `run_id` (detached for Pro, with
/// an in-process fallback). `run_id` must already exist as a `draft`/paused
/// run (the caller created it). Errors are the canonical ones the frontend
/// already maps to the upgrade sheet (`UpgradeRequired`) or a toast.
pub async fn launch_run(
    orch: &Arc<Orchestrator>,
    db: &Arc<Mutex<Db>>,
    run_id: &str,
    budget_usd: Option<f64>,
) -> AppResult<()> {
    if orch.has_concurrent_run(run_id).await? {
        return Err(AppError::Other(
            "another run in this workspace is already executing".into(),
        ));
    }
    // A live detached worker already owns this run — the in-process `active`
    // set can't see across processes, so the lease is the guard here.
    if db.lock().worker_lease_fresh(run_id)? {
        return Err(AppError::Other(
            "this run is already executing in the background".into(),
        ));
    }
    // Entitlement gates (live). Pro is uncapped and may run many workspaces
    // concurrently; Free / signed-out is capped at FREE_DIRECT_RUNS_PER_MONTH and
    // may run only one at a time. (Same-workspace concurrency is blocked for
    // everyone above — git-worktree safety.) Both surface as UpgradeRequired.
    let detached_entitled;
    {
        let ent = crate::entitlement::Entitlement::current();
        detached_entitled = ent.has_feature(crate::entitlement::feature::RUNS_DETACHED);
        // Monthly Direct-run cap.
        let used = db.lock().count_started_runs_this_month()?;
        if let Err(denied) = ent.check_direct_run_quota(used) {
            return Err(AppError::UpgradeRequired {
                feature: denied.feature.to_string(),
                used: denied.used,
                limit: denied.limit,
            });
        }
        // Concurrency: Free runs one at a time; Pro (RUNS_PARALLEL) runs many.
        if !ent.has_feature(crate::entitlement::feature::RUNS_PARALLEL) {
            let active = db.lock().count_active_runs_excluding(run_id)?;
            if active >= 1 {
                return Err(AppError::UpgradeRequired {
                    feature: crate::entitlement::feature::RUNS_PARALLEL.to_string(),
                    used: active,
                    limit: 1,
                });
            }
        }
    }
    // Persist the optional spend cap before the drive starts. Only a finite
    // positive budget is meaningful; anything else stays NULL (no budget).
    if let Some(b) = budget_usd {
        if b.is_finite() && b > 0.0 {
            db.lock().set_run_budget(run_id, Some(b))?;
        }
    }
    // Durable first-run marker (survives workspace-delete cascades) — the
    // one-shot invite must never re-appear for a user who has run a crew.
    let _ = db.lock().mark_ever_ran();
    // Pro: hand the segment to a detached worker so the crew survives the app
    // quitting. Any spawn failure (missing sidecar in dev, exec error) falls
    // back to the in-process drive — detachment must never cost a run.
    if detached_entitled {
        match orch.spawn_detached_segment(run_id, false) {
            // Spawned OR AlreadyRunning: a worker owns the drive — never fall
            // back to in-process (that would double-drive one worktree).
            Ok(_) => return Ok(()),
            Err(e) => {
                tracing::warn!(run_id = %run_id, error = %e, "detached spawn failed — driving in-process");
            }
        }
    }
    Arc::clone(orch).start_run(run_id.to_string());
    Ok(())
}
