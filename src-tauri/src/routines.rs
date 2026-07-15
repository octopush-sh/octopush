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

use std::path::{Path, PathBuf};
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

/// How long a routine's `fire_condition` may run before it's treated as a
/// (skip-inducing) error. Bounds the command so a hung check can never stall the
/// 30s scheduler tick.
const CONDITION_TIMEOUT: Duration = Duration::from_secs(30);

/// The two phase-1 schedule kinds.
pub const KIND_INTERVAL: &str = "interval";
pub const KIND_DAILY: &str = "daily";

/// Why a fire skipped its window (each existing skip site maps onto one). Serde
/// carries a machine token + a human `reason` string for the ipc/toast.
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum SkipReason {
    /// The target workspace already has a live run (or the launch was refused).
    Busy,
    /// The `fire_condition` command exited non-zero — nothing to do this window.
    ConditionNotMet,
    /// The `fire_condition` couldn't be evaluated (spawn failure / timeout) —
    /// fail-SAFE: skip rather than fire blindly, and surface why.
    ConditionError(String),
    /// The workspace couldn't be resolved (deleted / off-disk / unconfigured).
    WorkspaceUnavailable,
}

impl SkipReason {
    /// A short human string for `last_outcome` and the run-now toast.
    pub fn label(&self) -> String {
        match self {
            SkipReason::Busy => "workspace busy".to_string(),
            SkipReason::ConditionNotMet => "condition not met".to_string(),
            SkipReason::ConditionError(msg) => format!("condition error: {msg}"),
            SkipReason::WorkspaceUnavailable => "workspace unavailable".to_string(),
        }
    }
}

/// Whether a routine fire actually dispatched a run (vs. skipped the window).
/// Lets `run_routine_now` report honestly instead of always celebrating a
/// dispatch, and drives the legibility `last_outcome`.
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum FireOutcome {
    Dispatched,
    Skipped(SkipReason),
}

impl FireOutcome {
    /// The string stamped into `last_outcome` on every evaluation.
    pub fn last_outcome_label(&self) -> String {
        match self {
            FireOutcome::Dispatched => "dispatched".to_string(),
            FireOutcome::Skipped(reason) => reason.label(),
        }
    }

    /// The flattened, serde-friendly shape the frontend renders:
    /// `{ outcome: "dispatched" | "skipped", reason?: <human string> }`.
    pub fn view(&self) -> FireOutcomeView {
        match self {
            FireOutcome::Dispatched => FireOutcomeView {
                outcome: "dispatched",
                reason: None,
            },
            FireOutcome::Skipped(reason) => FireOutcomeView {
                outcome: "skipped",
                reason: Some(reason.label()),
            },
        }
    }
}

/// The ipc shape for a fire outcome — `run_routine_now` returns this so "Run
/// now" can report honestly (dispatched, or "skipped · condition not met").
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FireOutcomeView {
    /// "dispatched" | "skipped".
    pub outcome: &'static str,
    /// The human skip reason, present only for a skip.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// The result of evaluating a routine's `fire_condition` command.
#[derive(Debug, PartialEq, Eq)]
pub enum ConditionEval {
    /// exit 0 — fire.
    Met,
    /// non-zero exit — skip this window (nothing to do).
    NotMet,
    /// couldn't evaluate (spawn failure or timeout) — skip, fail-safe.
    Error(String),
}

/// Run a routine's `fire_condition` shell command in `cwd`, bounded by `timeout`.
/// A login shell (`bash -lc`) so the user's PATH + `gh` auth are present — the
/// SAME trust model as a run's `run_command` (their command, their machine).
/// exit 0 ⇒ `Met`; non-zero ⇒ `NotMet`; spawn failure / timeout ⇒ `Error`
/// (the child is killed on timeout so it can't linger past the tick).
pub async fn evaluate_condition(command: &str, cwd: &Path, timeout: Duration) -> ConditionEval {
    let mut child = match tokio::process::Command::new("bash")
        .arg("-lc")
        .arg(command)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(child) => child,
        Err(e) => return ConditionEval::Error(format!("could not launch condition: {e}")),
    };
    match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) => {
            if status.success() {
                ConditionEval::Met
            } else {
                ConditionEval::NotMet
            }
        }
        Ok(Err(e)) => ConditionEval::Error(format!("condition wait failed: {e}")),
        Err(_) => {
            // Timed out — kill the child so a hung command can't outlive the tick.
            let _ = child.start_kill();
            ConditionEval::Error(format!("condition timed out after {}s", timeout.as_secs()))
        }
    }
}

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

/// Cross-field validation at authoring time. Phase-1 rule: a `fresh`-workspace
/// routine must be `daily`. A fresh fire creates a NEW worktree, and phase 1
/// has no auto-reaper — a sub-daily `fresh` cadence (e.g. every minute) would
/// generate worktrees without bound. Daily caps it to one/day (the accepted
/// no-reaper tradeoff) and matches fresh's natural "a clean PR each morning"
/// shape. Frequent-fresh returns with the retention reaper in phase 2.
pub fn validate_routine(workspace_mode: &str, schedule_kind: &str) -> Result<(), String> {
    if workspace_mode == "fresh" && schedule_kind != KIND_DAILY {
        return Err(
            "a fresh-workspace routine must run daily — a new worktree per run needs a daily cadence (frequent fresh runs arrive with automatic cleanup)".into(),
        );
    }
    Ok(())
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
    pub async fn run_routine_now(self: Arc<Self>, routine_id: &str) -> crate::error::AppResult<FireOutcome> {
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

    /// Fire one due routine, then record the evaluation outcome for legibility.
    /// Every tick (dispatch OR skip) stamps `last_checked_at`/`last_outcome` so a
    /// routine that keeps skipping shows it's alive ("checked 2m ago · condition
    /// not met") instead of looking dead.
    async fn fire_routine(self: &Arc<Self>, r: &RoutineRow) -> crate::error::AppResult<FireOutcome> {
        let outcome = self.fire_routine_inner(r).await?;
        // Best-effort — a legibility write must never fail an otherwise-good fire.
        let _ = self.db().lock().set_routine_fire_result(
            &r.id,
            &Utc::now().to_rfc3339(),
            &outcome.last_outcome_label(),
        );
        Ok(outcome)
    }

    /// The fire itself: advance the window first (so a crash mid-fire can never
    /// re-fire it), gate on the optional `fire_condition`, then resolve/create
    /// the workspace, create the run, stamp it, and launch through the shared
    /// guarded path. Returns whether a run was dispatched or the window skipped.
    async fn fire_routine_inner(self: &Arc<Self>, r: &RoutineRow) -> crate::error::AppResult<FireOutcome> {
        // Advance the schedule window BEFORE any side effect (worktree, run):
        // a window must fire at most once, even if the work below crashes or a
        // second tick races. A skip below just consumes this window cleanly.
        let next = next_due_for(r, Local::now());
        self.db().lock().set_routine_next_due(&r.id, next.as_deref())?;

        // Runaway guard (fresh mode): don't stack a new worktree while this
        // routine's previous crew is still active — skip this (already-advanced)
        // window.
        if r.workspace_mode == "fresh" {
            if let Some(prev) = &r.last_run_id {
                if let Some(run) = self.db().lock().get_run(prev)? {
                    if run.status == "running" || run.status == "paused" {
                        return Ok(FireOutcome::Skipped(SkipReason::Busy));
                    }
                }
            }
        }

        // Pre-fire condition gate — AFTER the busy check, BEFORE resolving the
        // workspace, so a skip never materialises a fresh worktree and spends
        // zero tokens. exit 0 ⇒ fire; non-zero ⇒ skip; can't evaluate ⇒ skip
        // (fail-safe, surfaced via last_outcome).
        if let Some(command) = normalize_condition(r.fire_condition.as_deref()) {
            let cwd = self.resolve_condition_cwd(r)?;
            let eval = match cwd {
                Some(dir) => evaluate_condition(&command, &dir, CONDITION_TIMEOUT).await,
                None => ConditionEval::Error("could not resolve the routine's workspace".into()),
            };
            match eval {
                ConditionEval::Met => {}
                ConditionEval::NotMet => return Ok(FireOutcome::Skipped(SkipReason::ConditionNotMet)),
                ConditionEval::Error(msg) => {
                    tracing::warn!(routine = %r.id, error = %msg, "routine fire condition could not be evaluated — skipping");
                    return Ok(FireOutcome::Skipped(SkipReason::ConditionError(msg)));
                }
            }
        }

        let workspace_id = match self.resolve_routine_workspace(r).await? {
            Some(id) => id,
            // A busy fixed workspace (or a missing/off-disk target) — skip.
            None => return Ok(FireOutcome::Skipped(SkipReason::WorkspaceUnavailable)),
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

        // Stamp the run onto the routine (the window was already advanced above).
        self.db()
            .lock()
            .stamp_routine_run(&r.id, &run_id, &Utc::now().to_rfc3339())?;

        // The single shared guarded launch (quota / parallel / lease / detached).
        if let Err(e) = launch::launch_run(self, self.db(), &run_id, r.budget_usd).await {
            tracing::warn!(routine = %r.id, run = %run_id, error = %e, "routine run refused at launch");
            // Delete the never-started draft (NOT abort — an aborted run counts
            // in the monthly meter and shows as a settled card; this one never ran).
            let _ = self.db().lock().delete_run(&run_id);
            return Ok(FireOutcome::Skipped(SkipReason::Busy));
        }
        Ok(FireOutcome::Dispatched)
    }

    /// The directory a routine's `fire_condition` runs in: the fixed workspace's
    /// worktree, or the project root for fresh mode (the fresh worktree doesn't
    /// exist yet at gate time). `None` when a fixed workspace can't be resolved
    /// (deleted / no path) — the caller treats that as a `ConditionError`.
    fn resolve_condition_cwd(&self, r: &RoutineRow) -> crate::error::AppResult<Option<PathBuf>> {
        if r.workspace_mode == "fresh" {
            let project = self.db().lock().get_project_by_id(&r.project_id)?;
            return Ok(project.map(|(_, _, path)| PathBuf::from(path)));
        }
        // Fixed mode — the chosen workspace's worktree path.
        let Some(ws_id) = r.fixed_workspace_id.clone() else {
            return Ok(None);
        };
        let path = self
            .db()
            .lock()
            .get_workspace(&ws_id)?
            .and_then(|w| w.worktree_path);
        Ok(path.map(PathBuf::from))
    }

    /// Resolve the workspace to run in. `Some(id)` to proceed, `None` to skip
    /// this window (fixed workspace missing/off-disk or busy).
    async fn resolve_routine_workspace(&self, r: &RoutineRow) -> crate::error::AppResult<Option<String>> {
        if r.workspace_mode == "fresh" {
            return self.create_fresh_routine_workspace(r).await.map(Some);
        }
        // Fixed mode.
        let Some(ws_id) = r.fixed_workspace_id.clone() else {
            return Err(crate::error::AppError::Other(
                "routine has no fixed workspace configured".into(),
            ));
        };
        // Read the workspace once (drop the guard before any re-lock below —
        // the mutex is non-reentrant).
        let (exists, busy, worktree) = {
            let db = self.db().lock();
            match db.get_workspace(&ws_id)? {
                None => (false, false, None),
                Some(ws) => (true, db.workspace_has_active_run(&ws_id)?, ws.worktree_path),
            }
        };
        // The target workspace was DELETED — the routine can never run again.
        // Auto-disable it (surfaces as paused in the UI) rather than skipping
        // every window forever with no signal.
        if !exists {
            tracing::warn!(routine = %r.id, workspace = %ws_id, "routine's fixed workspace no longer exists — disabling the routine");
            self.db()
                .lock()
                .set_routine_enabled(&r.id, false, r.next_due_at.as_deref())?;
            return Ok(None);
        }
        // Busy is transient (a previous run is still going) — just skip.
        if busy {
            return Ok(None);
        }
        // Worktree deleted off disk but the row survives — skip (firing into a
        // missing directory would hard-fail); don't disable, it may be restored.
        match worktree {
            Some(path) if !std::path::Path::new(&path).is_dir() => {
                tracing::warn!(routine = %r.id, workspace = %ws_id, "routine's fixed worktree is missing on disk — skipping");
                Ok(None)
            }
            _ => Ok(Some(ws_id)),
        }
    }

    /// Create a fresh worktree for this fire, on a UNIQUE branch (the routine's
    /// prefix + a timestamp + a short id) so `workspace::create`'s
    /// idempotency-on-branch yields a genuinely clean tree each time. The git
    /// checkout runs on a blocking thread so a large-repo fire can't stall the
    /// async runtime (the DB mutex is not held across it).
    async fn create_fresh_routine_workspace(&self, r: &RoutineRow) -> crate::error::AppResult<String> {
        // (id, name, path)
        let project = self.db()
            .lock()
            .get_project_by_id(&r.project_id)?
            .ok_or_else(|| crate::error::AppError::Other("routine's project not found".into()))?;
        let project_path = project.2;
        let stamp = Local::now().format("%Y%m%d-%H%M%S");
        let short = uuid::Uuid::new_v4().to_string();
        let short = short[..6].to_string();
        let prefix = r
            .branch_prefix
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .unwrap_or("routine")
            .to_string();
        let branch = format!("{prefix}/{stamp}-{short}");
        let name = format!("{} · {stamp}", r.name);
        let base = r.base_branch.as_deref().unwrap_or("").to_string();
        let db = self.db().clone();
        let project_id = r.project_id.clone();
        let task = r.task.clone();
        let ws = tokio::task::spawn_blocking(move || {
            crate::workspace::create(
                &db,
                &project_id,
                Path::new(&project_path),
                &name,
                &task,
                &branch,
                &base,
                "",
            )
            .map(|(ws, _outcome)| ws)
        })
        .await
        .map_err(|e| crate::error::AppError::Other(format!("worktree task panicked: {e}")))?;
        ws.map(|w| w.id)
    }
}

/// Trim a stored `fire_condition`, treating a blank one as absent (always fire).
/// Defensive — the DB layer already normalizes on write, but a NULL vs empty
/// string must both read as "no condition".
fn normalize_condition(raw: Option<&str>) -> Option<String> {
    raw.map(str::trim)
        .filter(|c| !c.is_empty())
        .map(str::to_string)
}

/// Parse the stored `[[position, model], …]` JSON overrides into the shape
/// `create_run` wants. A malformed blob degrades to no overrides.
fn parse_stage_overrides(json: Option<&str>) -> Vec<(i64, String)> {
    let Some(json) = json else { return Vec::new() };
    serde_json::from_str::<Vec<(i64, String)>>(json).unwrap_or_default()
}
