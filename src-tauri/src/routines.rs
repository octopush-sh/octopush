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
    /// The guarded launch refused the run (monthly quota, budget, parallel-runs
    /// gate, lease) — carries the refusal's first line so the toast/`last_outcome`
    /// name the real reason instead of a misleading "workspace busy".
    LaunchRefused(String),
}

impl SkipReason {
    /// A short human string for `last_outcome` and the run-now toast.
    pub fn label(&self) -> String {
        match self {
            SkipReason::Busy => "workspace busy".to_string(),
            SkipReason::ConditionNotMet => "condition not met".to_string(),
            SkipReason::ConditionError(msg) => format!("condition error: {msg}"),
            SkipReason::WorkspaceUnavailable => "workspace unavailable".to_string(),
            SkipReason::LaunchRefused(msg) => msg.clone(),
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

/// The outcome of resolving + guarding a fixed routine's workspace: ready to
/// fire (with its id + worktree path), or a reason to skip this window.
enum FixedResolve {
    Ready { id: String, worktree: Option<String> },
    Skip(SkipReason),
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
/// exit 0 ⇒ `Met`; non-zero ⇒ `NotMet`; spawn failure / timeout ⇒ `Error`.
///
/// The child is launched as its OWN process-group/session leader (`setsid`), so
/// on timeout the WHOLE group is killed — a pipeline like `gh … | grep -q .`
/// leaves no orphaned `gh` reparented past the tick. `kill_on_drop` is the
/// backstop.
pub async fn evaluate_condition(command: &str, cwd: &Path, timeout: Duration) -> ConditionEval {
    let mut cmd = tokio::process::Command::new("bash");
    cmd.arg("-lc")
        .arg(command)
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    // Own session/process group so a timeout can kill the whole pipeline, not
    // just `bash` (mirrors how the detached worker isolates its group).
    #[cfg(unix)]
    unsafe {
        // SAFETY: `setsid()` is async-signal-safe and is the only call made in
        // the forked child before exec.
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let mut child = match cmd.spawn() {
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
            // Timed out — kill the whole process group (not just `bash`), then
            // reap so no zombie lingers.
            kill_process_group(&mut child);
            let _ = child.wait().await;
            ConditionEval::Error(format!("condition timed out after {}s", timeout.as_secs()))
        }
    }
}

/// SIGKILL the child's entire process group. The child is a session leader
/// (`setsid` in `evaluate_condition`), so `-pid` addresses its group and reaps
/// any pipeline members with it. Falls back to killing just the child when the
/// group can't be addressed (no pid / non-Unix).
fn kill_process_group(child: &mut tokio::process::Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // SAFETY: kill(-pid, SIGKILL) signals the group `setsid` created for this
        // child; `pid` comes from the live child handle.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
        return;
    }
    let _ = child.start_kill();
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
    ///
    /// Schedule handling is asymmetric on purpose: if the routine's window is
    /// already OVERDUE (`next_due <= now`), consume it (advance to the next slot
    /// after now) so the next scheduler tick won't re-fire the SAME window — a
    /// manual fire on a due window must not become a double run/spend. A FUTURE
    /// window is left untouched (a manual test must not reschedule it).
    pub async fn run_routine_now(self: Arc<Self>, routine_id: &str) -> crate::error::AppResult<FireOutcome> {
        let routine = self.db()
            .lock()
            .get_routine(routine_id)?
            .ok_or_else(|| crate::error::AppError::Other("routine not found".into()))?;
        if let Some(due) = routine.next_due_at.as_deref() {
            if let Ok(due_dt) = DateTime::parse_from_rfc3339(due) {
                if due_dt.with_timezone(&Utc) <= Utc::now() {
                    let next = next_due_for(&routine, Local::now());
                    self.db().lock().set_routine_next_due(&routine.id, next.as_deref())?;
                }
            }
        }
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
            // Advance the window FIRST, synchronously (the crash-safe invariant:
            // a window fires at most once, even if the fire below crashes or the
            // next tick races — next_due is already past `now`, so it won't be
            // re-selected). Only the SCHEDULED path advances; `run_routine_now`
            // deliberately does NOT (a manual test must not touch the schedule).
            if let Err(e) = self.advance_routine_window(&routine) {
                tracing::warn!(routine = %routine.id, error = %e, "routine scheduler: advance failed — skipping this tick");
                continue;
            }
            // Fire DETACHED: a condition may take up to CONDITION_TIMEOUT, and
            // awaiting each fire here would serialize the tick and delay every
            // other due routine (and the next tick). The outcome is stamped for
            // legibility inside `fire_routine`.
            let orch = Arc::clone(self);
            tokio::spawn(async move {
                if let Err(e) = orch.fire_routine(&routine).await {
                    tracing::warn!(routine = %routine.id, error = %e, "routine fire failed");
                }
            });
        }
    }

    /// Advance a routine past its current due window without firing (skip).
    fn advance_routine_window(&self, r: &RoutineRow) -> crate::error::AppResult<()> {
        let next = next_due_for(r, Local::now());
        self.db().lock().set_routine_next_due(&r.id, next.as_deref())
    }

    /// Fire one routine, then record the evaluation outcome for legibility on
    /// EVERY path — dispatch, skip, OR a hard error — so a routine that keeps
    /// skipping (or erroring) shows it's alive ("condition not met · 2m ago")
    /// instead of looking never-evaluated. Both the scheduled tick and
    /// `run_routine_now` go through this wrapper, so both stamp.
    async fn fire_routine(self: &Arc<Self>, r: &RoutineRow) -> crate::error::AppResult<FireOutcome> {
        let result = self.fire_routine_inner(r).await;
        let label = match &result {
            Ok(outcome) => outcome.last_outcome_label(),
            Err(e) => format!("error: {e}"),
        };
        // Best-effort — a legibility write must never mask the fire's own result.
        let _ = self
            .db()
            .lock()
            .set_routine_fire_result(&r.id, &Utc::now().to_rfc3339(), &label);
        result
    }

    /// The fire itself, branched by workspace mode. `next_due` is NOT advanced
    /// here (the scheduled tick advances up front; `run_routine_now` must not
    /// touch the schedule). Returns whether a run was dispatched or the window
    /// skipped (with the reason).
    async fn fire_routine_inner(self: &Arc<Self>, r: &RoutineRow) -> crate::error::AppResult<FireOutcome> {
        if r.workspace_mode == "fresh" {
            self.fire_fresh(r).await
        } else {
            self.fire_fixed(r).await
        }
    }

    /// Fixed mode: resolve + guard the chosen workspace FIRST (so a deleted
    /// workspace still auto-disables and a busy one is labelled `Busy`, not run
    /// into), THEN evaluate the condition inside that healthy, idle worktree,
    /// THEN dispatch.
    async fn fire_fixed(self: &Arc<Self>, r: &RoutineRow) -> crate::error::AppResult<FireOutcome> {
        let (workspace_id, worktree) = match self.resolve_fixed_workspace(r)? {
            FixedResolve::Ready { id, worktree } => (id, worktree),
            FixedResolve::Skip(reason) => return Ok(FireOutcome::Skipped(reason)),
        };

        // Condition gate — cwd = the resolved worktree (a healthy dir; the
        // resolver already skipped a deleted/off-disk one). A workspace with no
        // worktree path can't host a condition ⇒ fail-safe ConditionError.
        // `fire_condition` is already trimmed/None (the DB normalizes on write).
        if let Some(command) = r.fire_condition.as_deref() {
            let eval = match &worktree {
                Some(path) => evaluate_condition(command, Path::new(path), CONDITION_TIMEOUT).await,
                None => ConditionEval::Error("routine's fixed workspace has no worktree".into()),
            };
            if let Some(skip) = self.condition_skip(r, eval) {
                return Ok(FireOutcome::Skipped(skip));
            }
        }

        self.dispatch_run(r, &workspace_id).await
    }

    /// Fresh mode: guard against stacking a worktree on the previous crew, THEN
    /// evaluate the condition at the project root (the fresh worktree doesn't
    /// exist yet), THEN create the worktree (only now — a skip creates none) and
    /// dispatch.
    async fn fire_fresh(self: &Arc<Self>, r: &RoutineRow) -> crate::error::AppResult<FireOutcome> {
        // Runaway guard: don't stack a new worktree while this routine's previous
        // crew is still active.
        if let Some(prev) = &r.last_run_id {
            if let Some(run) = self.db().lock().get_run(prev)? {
                if run.status == "running" || run.status == "paused" {
                    return Ok(FireOutcome::Skipped(SkipReason::Busy));
                }
            }
        }

        // Resolve the project ONCE — reused for the condition cwd AND the fresh
        // worktree (one SELECT per fire). A missing project is a hard error
        // (stamped + surfaced), consistent with a fixed routine's missing workspace.
        let project_path = self
            .db()
            .lock()
            .get_project_by_id(&r.project_id)?
            .ok_or_else(|| crate::error::AppError::Other("routine's project not found".into()))?
            .2;

        // Condition gate — cwd = the project root (the fresh worktree doesn't
        // exist yet). `fire_condition` is already trimmed/None (DB-normalized).
        if let Some(command) = r.fire_condition.as_deref() {
            let eval = evaluate_condition(command, Path::new(&project_path), CONDITION_TIMEOUT).await;
            if let Some(skip) = self.condition_skip(r, eval) {
                return Ok(FireOutcome::Skipped(skip));
            }
        }

        // Create the fresh worktree only now (a skipped condition created none).
        let workspace_id = self.create_fresh_routine_workspace(r, &project_path).await?;
        self.dispatch_run(r, &workspace_id).await
    }

    /// Map a condition evaluation to an optional skip reason (`None` ⇒ Met, fire
    /// on). Logs the fail-safe error path.
    fn condition_skip(&self, r: &RoutineRow, eval: ConditionEval) -> Option<SkipReason> {
        match eval {
            ConditionEval::Met => None,
            ConditionEval::NotMet => Some(SkipReason::ConditionNotMet),
            ConditionEval::Error(msg) => {
                tracing::warn!(routine = %r.id, error = %msg, "routine fire condition could not be evaluated — skipping");
                Some(SkipReason::ConditionError(msg))
            }
        }
    }

    /// Create the draft run, stamp it on the routine, and launch through the one
    /// shared guarded path (quota / parallel / lease / detached). A launch
    /// refusal deletes the never-started draft and skips.
    async fn dispatch_run(self: &Arc<Self>, r: &RoutineRow, workspace_id: &str) -> crate::error::AppResult<FireOutcome> {
        let overrides = parse_stage_overrides(r.stage_overrides.as_deref());
        let run_id = self.db().lock().create_run(
            workspace_id,
            &r.pipeline_id,
            &r.task,
            r.reference_model.as_deref(),
            None,
            &overrides,
        )?;

        self.db()
            .lock()
            .stamp_routine_run(&r.id, &run_id, &Utc::now().to_rfc3339())?;

        if let Err(e) = launch::launch_run(self, self.db(), &run_id, r.budget_usd).await {
            tracing::warn!(routine = %r.id, run = %run_id, error = %e, "routine run refused at launch");
            // Delete the never-started draft (NOT abort — an aborted run counts
            // in the monthly meter and shows as a settled card; this one never ran).
            let _ = self.db().lock().delete_run(&run_id);
            // Carry the refusal's real reason (quota / budget / parallel-runs /
            // lease) — NOT a misleading "workspace busy" on an idle workspace.
            let reason = e.to_string();
            let first_line = reason.lines().next().unwrap_or("launch refused").trim().to_string();
            return Ok(FireOutcome::Skipped(SkipReason::LaunchRefused(first_line)));
        }
        Ok(FireOutcome::Dispatched)
    }

    /// Resolve + guard a fixed routine's workspace: auto-disable on a deleted
    /// workspace, skip on busy / off-disk, else return the id + worktree path.
    /// Runs BEFORE the condition gate so the command never executes inside a
    /// deleted/busy worktree.
    fn resolve_fixed_workspace(&self, r: &RoutineRow) -> crate::error::AppResult<FixedResolve> {
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
            return Ok(FixedResolve::Skip(SkipReason::WorkspaceUnavailable));
        }
        // Busy is transient (a previous run is still going) — just skip.
        if busy {
            return Ok(FixedResolve::Skip(SkipReason::Busy));
        }
        // Worktree deleted off disk but the row survives — skip (firing into a
        // missing directory would hard-fail); don't disable, it may be restored.
        if let Some(path) = &worktree {
            if !std::path::Path::new(path).is_dir() {
                tracing::warn!(routine = %r.id, workspace = %ws_id, "routine's fixed worktree is missing on disk — skipping");
                return Ok(FixedResolve::Skip(SkipReason::WorkspaceUnavailable));
            }
        }
        Ok(FixedResolve::Ready { id: ws_id, worktree })
    }

    /// Create a fresh worktree for this fire, on a UNIQUE branch (the routine's
    /// prefix + a timestamp + a short id) so `workspace::create`'s
    /// idempotency-on-branch yields a genuinely clean tree each time. The git
    /// checkout runs on a blocking thread so a large-repo fire can't stall the
    /// async runtime (the DB mutex is not held across it).
    async fn create_fresh_routine_workspace(&self, r: &RoutineRow, project_path: &str) -> crate::error::AppResult<String> {
        let project_path = project_path.to_string();
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

/// Parse the stored `[[position, model], …]` JSON overrides into the shape
/// `create_run` wants. A malformed blob degrades to no overrides.
fn parse_stage_overrides(json: Option<&str>) -> Vec<(i64, String)> {
    let Some(json) = json else { return Vec::new() };
    serde_json::from_str::<Vec<(i64, String)>>(json).unwrap_or_default()
}
