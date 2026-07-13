//! Routines — scheduled crews (Pro, `routines.scheduled`).
//!
//! A routine is a saved pipeline + a schedule. An in-app scheduler ticks every
//! 30s, fires the routines whose window has come due, and drives each via the
//! same guarded launch path a user's Begin uses — so a scheduled crew is a
//! detached crew, surviving the app quitting once it's running.
//!
//! Phase 1 fires only while the app runs; a window missed while the app was
//! closed catches up ONCE on the next tick (never N times — `next_due` jumps
//! to the next future slot). See the design record:
//! `docs/superpowers/plans/2026-07-13-routines-phase1-design.md`.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Local, TimeZone, Utc};

use crate::db::RoutineRow;
use crate::orchestrator::launch;
use crate::orchestrator::Orchestrator;

/// Scheduler cadence. Coarser than the detached bridge (a schedule resolves to
/// minutes, not seconds); one indexed SELECT per tick, nothing when no routine
/// is due.
const TICK_SECS: u64 = 30;

/// The two phase-1 schedule kinds.
pub const KIND_INTERVAL: &str = "interval";
pub const KIND_DAILY: &str = "daily";

/// Compute a routine's next fire as a UTC RFC3339 string, from its schedule and
/// a reference instant (`after`, in machine-local time). Pure — the scheduler
/// passes `Local::now()`, tests pass a fixed instant. `None` for an invalid
/// spec (a routine with no `next_due_at` is simply never due).
///
/// - `interval`: spec = whole seconds; next = `after + secs` (no drift accrual —
///   scheduling from the fire instant, not a fixed epoch, keeps catch-up to one).
/// - `daily`: spec = `HH:MM` machine-local; next = the next occurrence strictly
///   after `after`. Stored in UTC so SQL string comparison stays a valid time
///   comparison across DST offset changes.
pub fn next_due(kind: &str, spec: &str, after: DateTime<Local>) -> Option<String> {
    match kind {
        KIND_INTERVAL => {
            let secs: i64 = spec.trim().parse().ok()?;
            if secs <= 0 {
                return None;
            }
            Some((after + chrono::Duration::seconds(secs)).with_timezone(&Utc).to_rfc3339())
        }
        KIND_DAILY => {
            let (hh, mm) = parse_hhmm(spec)?;
            // Today's HH:MM local; if already passed, tomorrow's.
            let mut candidate = local_at(after, hh, mm)?;
            if candidate <= after {
                let tomorrow = after + chrono::Duration::days(1);
                candidate = local_at(tomorrow, hh, mm)?;
            }
            Some(candidate.with_timezone(&Utc).to_rfc3339())
        }
        _ => None,
    }
}

/// Validate a schedule spec at authoring time (clear error before it's stored).
pub fn validate_schedule(kind: &str, spec: &str) -> Result<(), String> {
    match kind {
        KIND_INTERVAL => {
            let secs: i64 = spec
                .trim()
                .parse()
                .map_err(|_| "interval must be a whole number of seconds".to_string())?;
            // Floor at a minute — a tighter cadence than the tick is meaningless
            // and would hammer the quota.
            if secs < 60 {
                return Err("interval must be at least 60 seconds".into());
            }
            Ok(())
        }
        KIND_DAILY => parse_hhmm(spec)
            .map(|_| ())
            .ok_or_else(|| "daily time must be HH:MM (24-hour)".to_string()),
        other => Err(format!("unknown schedule kind '{other}'")),
    }
}

fn parse_hhmm(spec: &str) -> Option<(u32, u32)> {
    let (h, m) = spec.trim().split_once(':')?;
    let hh: u32 = h.parse().ok()?;
    let mm: u32 = m.parse().ok()?;
    if hh < 24 && mm < 60 {
        Some((hh, mm))
    } else {
        None
    }
}

/// The local datetime at `date_of(reference)` + `HH:MM`. Resolves a DST gap/fold
/// to the earliest valid instant (a routine at a skipped/dup wall-clock time
/// still fires once, close to intent).
fn local_at(reference: DateTime<Local>, hh: u32, mm: u32) -> Option<DateTime<Local>> {
    let naive = reference
        .date_naive()
        .and_hms_opt(hh, mm, 0)?;
    match Local.from_local_datetime(&naive) {
        chrono::LocalResult::Single(dt) => Some(dt),
        chrono::LocalResult::Ambiguous(a, _) => Some(a),
        chrono::LocalResult::None => {
            // Spring-forward gap: nudge past it and take the resulting instant.
            Local.from_local_datetime(&(naive + chrono::Duration::hours(1))).earliest()
        }
    }
}

/// Compute a routine's next due from its own schedule, anchored at `now`.
fn next_due_for(r: &RoutineRow, now: DateTime<Local>) -> Option<String> {
    next_due(&r.schedule_kind, &r.schedule_spec, now)
}

impl Orchestrator {
    /// Spawn the background scheduler (one line beside `spawn_detached_bridge`
    /// in `lib.rs`). Idles cheaply — one indexed SELECT per tick — until a
    /// routine comes due.
    pub fn spawn_routine_scheduler(self: Arc<Self>) {
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(TICK_SECS)).await;
                self.routine_tick().await;
            }
        });
    }

    /// Fire a specific routine now (the "run now" affordance), regardless of
    /// schedule or enabled state — but through the identical guarded fire path.
    pub async fn run_routine_now(self: Arc<Self>, routine_id: &str) -> crate::error::AppResult<()> {
        let routine = self.db()
            .lock()
            .get_routine(routine_id)?
            .ok_or_else(|| crate::error::AppError::Other("routine not found".into()))?;
        self.fire_routine(&routine).await
    }

    async fn routine_tick(self: &Arc<Self>) {
        // Defense in depth: a plan downgrade silently stops firing (the
        // create/enable commands are also gated).
        if !crate::entitlement::Entitlement::current()
            .has_feature(crate::entitlement::feature::ROUTINES_SCHEDULED)
        {
            return;
        }
        let now = Utc::now().to_rfc3339();
        let due = match self.db().lock().list_due_routines(&now) {
            Ok(d) => d,
            Err(e) => {
                tracing::warn!(error = %e, "routine scheduler: list_due failed");
                return;
            }
        };
        for routine in due {
            if let Err(e) = self.fire_routine(&routine).await {
                tracing::warn!(routine = %routine.id, error = %e, "routine fire failed");
                // A per-routine failure must never kill the loop — advance its
                // window so a persistently-broken routine doesn't spin.
                let _ = self.advance_routine_window(&routine);
            }
        }
    }

    /// Advance a routine past its current due window without firing (skip).
    fn advance_routine_window(&self, r: &RoutineRow) -> crate::error::AppResult<()> {
        let next = next_due_for(r, Local::now());
        self.db().lock().set_routine_next_due(&r.id, next.as_deref())
    }

    /// Fire one due routine: resolve/create its workspace, create the run,
    /// record the window, then launch through the shared guarded path.
    async fn fire_routine(self: &Arc<Self>, r: &RoutineRow) -> crate::error::AppResult<()> {
        // Runaway guard (fresh mode): don't stack a new worktree while this
        // routine's previous crew is still active — skip this window.
        if r.workspace_mode == "fresh" {
            if let Some(prev) = &r.last_run_id {
                if let Some(run) = self.db().lock().get_run(prev)? {
                    if run.status == "running" || run.status == "paused" {
                        return self.advance_routine_window(r);
                    }
                }
            }
        }

        let workspace_id = match self.resolve_routine_workspace(r)? {
            Some(id) => id,
            // A busy fixed workspace (or a missing target) — skip this window.
            None => return self.advance_routine_window(r),
        };

        let overrides = parse_stage_overrides(r.stage_overrides.as_deref());
        let run_id = self.db().lock().create_run(
            &workspace_id,
            &r.pipeline_id,
            &r.task,
            r.reference_model.as_deref(),
            None,
            &overrides,
        )?;

        // Record the fire + advance the window BEFORE the launch's side effects,
        // so a crash or a double tick can't fire the same window twice.
        let next = next_due_for(r, Local::now());
        self.db()
            .lock()
            .mark_routine_fired(&r.id, &run_id, &Utc::now().to_rfc3339(), next.as_deref())?;

        // The single shared guarded launch (quota / parallel / lease / detached).
        if let Err(e) = launch::launch_run(self, self.db(), &run_id, r.budget_usd).await {
            tracing::warn!(routine = %r.id, run = %run_id, error = %e, "routine run refused at launch");
            // Delete the never-started draft (NOT abort — an aborted run counts
            // in the monthly meter and shows as a settled card; this one never ran).
            let _ = self.db().lock().delete_run(&run_id);
        }
        Ok(())
    }

    /// Resolve the workspace to run in. `Some(id)` to proceed, `None` to skip
    /// this window (fixed workspace missing or busy).
    fn resolve_routine_workspace(&self, r: &RoutineRow) -> crate::error::AppResult<Option<String>> {
        if r.workspace_mode == "fresh" {
            return self.create_fresh_routine_workspace(r).map(Some);
        }
        // Fixed mode.
        let Some(ws_id) = r.fixed_workspace_id.clone() else {
            return Err(crate::error::AppError::Other(
                "routine has no fixed workspace configured".into(),
            ));
        };
        // Skip if the workspace vanished or is busy (a fire would be refused by
        // has_concurrent_run — skip cleanly rather than create a doomed run).
        let db = self.db().lock();
        if db.get_workspace(&ws_id)?.is_none() || db.workspace_has_active_run(&ws_id)? {
            return Ok(None);
        }
        Ok(Some(ws_id))
    }

    /// Create a fresh worktree for this fire, on a UNIQUE branch (the routine's
    /// prefix + a timestamp + a short id) so `workspace::create`'s
    /// idempotency-on-branch yields a genuinely clean tree each time.
    fn create_fresh_routine_workspace(&self, r: &RoutineRow) -> crate::error::AppResult<String> {
        // (id, name, path)
        let project = self.db()
            .lock()
            .get_project_by_id(&r.project_id)?
            .ok_or_else(|| crate::error::AppError::Other("routine's project not found".into()))?;
        let project_path = project.2;
        let stamp = Local::now().format("%Y%m%d-%H%M%S");
        let short = uuid::Uuid::new_v4().to_string();
        let short = &short[..6];
        let prefix = r
            .branch_prefix
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .unwrap_or("routine");
        let branch = format!("{prefix}/{stamp}-{short}");
        let name = format!("{} · {stamp}", r.name);
        let base = r.base_branch.as_deref().unwrap_or("");
        let (ws, _outcome) = crate::workspace::create(
            self.db(),
            &r.project_id,
            Path::new(&project_path),
            &name,
            &r.task,
            &branch,
            base,
            "",
        )?;
        Ok(ws.id)
    }
}

/// Parse the stored `[[position, model], …]` JSON overrides into the shape
/// `create_run` wants. A malformed blob degrades to no overrides.
fn parse_stage_overrides(json: Option<&str>) -> Vec<(i64, String)> {
    let Some(json) = json else { return Vec::new() };
    serde_json::from_str::<Vec<(i64, String)>>(json).unwrap_or_default()
}
