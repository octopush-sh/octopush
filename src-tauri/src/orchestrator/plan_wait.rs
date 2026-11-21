//! Claude plan limit park (#731, part C of #299).
//!
//! A Claude Code stage on a Pro/Max plan that hits a plan window stops with
//! a `rejected` `rate_limit_event` (`cli_runner::apply_plan_limit`). The
//! drive does not treat that as a failure to decide on: the stage keeps its
//! spend and session, the run pauses at the batch boundary (never mid-stage),
//! and an automatic Resume is scheduled for the window's `resetsAt` plus a
//! margin and a small jitter. The schedule is persisted on the `runs` row, so
//! it survives an app restart: the app's scheduler tick (beside Routines)
//! resumes it, and a detached worker that parked it waits and resumes it
//! itself while the app is closed. Both claim it with one compare-and-set
//! (`Db::claim_plan_resume`), so exactly one of them resumes.
//!
//! The resume goes through the ordinary Resume path (same stage, same
//! dossier, `--resume` of the same session), so every checkpoint still holds.
//! Automatic resumes are capped ([`AUTO_RESUME_CAP`]); a run whose budget is
//! spent, or whose window resets too far off, waits for the director.

use std::sync::Arc;

use chrono::{Local, TimeZone, Utc};

use crate::error::AppResult;
use crate::orchestrator::cli_runner::{is_plan_limit, plan_window_name, PlanLimit};
use crate::orchestrator::types::CheckpointAction;
use crate::orchestrator::Orchestrator;

/// Automatic resumes allowed before the run waits for the director. The
/// count resets when the director acts or a stage finishes.
pub const AUTO_RESUME_CAP: i64 = 3;
/// Seconds after `resetsAt` before resuming: the window needs a moment to
/// actually reopen.
pub const RESUME_MARGIN_SECS: i64 = 90;
/// Up to this many extra seconds, so several parked crews don't all resume
/// in the same second.
pub const RESUME_JITTER_SECS: i64 = 60;
/// A window that resets further off than this is not waited for
/// automatically (a weekly window is at most 7 days away).
pub const MAX_WAIT_SECS: i64 = 8 * 86_400;

/// Why a plan-parked run waits for the director instead of resuming itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DirectorReason {
    /// [`AUTO_RESUME_CAP`] automatic resumes already ran into the wall.
    CapReached,
    /// The run's budget is spent: resuming would spend past it.
    BudgetSpent,
    /// The window resets more than [`MAX_WAIT_SECS`] away.
    TooFar,
}

/// What to do with a run a plan limit just parked.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParkDecision {
    /// Resume automatically at this epoch second.
    Resume { at: i64 },
    /// Wait for the director.
    Director(DirectorReason),
}

/// Pure: the park decision. `jitter` is clamped to `0..=RESUME_JITTER_SECS`.
/// A reset already in the past resumes from `now` (plus the margin).
pub fn park_decision(resets_at: i64, now: i64, resume_count: i64, budget_spent: bool, jitter: i64) -> ParkDecision {
    if budget_spent {
        return ParkDecision::Director(DirectorReason::BudgetSpent);
    }
    if resume_count >= AUTO_RESUME_CAP {
        return ParkDecision::Director(DirectorReason::CapReached);
    }
    if resets_at - now > MAX_WAIT_SECS {
        return ParkDecision::Director(DirectorReason::TooFar);
    }
    ParkDecision::Resume { at: resets_at.max(now) + RESUME_MARGIN_SECS + jitter.clamp(0, RESUME_JITTER_SECS) }
}

/// A random jitter in `0..=RESUME_JITTER_SECS`.
fn jitter() -> i64 {
    (uuid::Uuid::new_v4().as_u128() % (RESUME_JITTER_SECS as u128 + 1)) as i64
}

/// `19:40` within a day of `now`, else `Tue 19:40`, in this Mac's clock.
pub fn clock_label(epoch: i64, now: i64) -> String {
    let Some(t) = Local.timestamp_opt(epoch, 0).single() else {
        return String::new();
    };
    if epoch - now < 86_400 {
        t.format("%H:%M").to_string()
    } else {
        t.format("%a %H:%M").to_string()
    }
}

/// What claiming a due automatic plan resume came to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlanClaim {
    /// The Resume is applied: drive the next segment.
    Resumed { budget_override: bool },
    /// Nothing to do here: another process claimed it, the director acted or
    /// turned it off, or the parked stages were resolved another way.
    NotClaimed,
    /// The run now waits for the director (its budget is spent): say so.
    NeedsYou,
    /// Applying the Resume failed; the automatic resume is scheduled again
    /// shortly ([`RETRY_SECS`]), so keep waiting.
    Retry,
}

/// After a Resume that couldn't be applied, try again this many seconds later.
/// Also how long a claim holds the park before it is due again (a claimant
/// that dies between the claim and the apply never loses the resume).
pub const RETRY_SECS: i64 = 60;

/// Consecutive claims that couldn't be applied, by the app and a detached
/// worker alike (`runs.plan_retry_count`), before the run stops retrying on
/// its own and waits for the director. The director acting starts it over.
pub const MAX_PLAN_RETRIES: i64 = 10;

/// Whether every stage waiting for a decision is a Claude plan limit: only
/// then is a run with a scheduled resume calm. A sibling's real halt, a gate
/// or a question still needs the director (and the beacon).
pub fn only_plan_holds(stages: &[crate::db::RunStageRow]) -> bool {
    let mut any = false;
    for s in stages {
        match s.status.as_str() {
            "failed" if s.error.as_deref().is_some_and(is_plan_limit) => any = true,
            "failed" | "awaiting_checkpoint" => return false,
            _ => {}
        }
    }
    any
}

/// A detached worker whose segment ended paused waits for the plan's reset
/// itself only when an automatic resume is scheduled AND nothing else in the
/// run waits for the director; returns when that resume is due. Otherwise
/// (a sibling's halt, gate or question) the worker announces "The crew needs
/// you" and exits: the app's scheduler resumes the plan stages later.
pub fn worker_plan_wait(run: &crate::db::RunRow) -> Option<i64> {
    if run.status != "paused" {
        return None;
    }
    run.plan_wait.as_ref().filter(|w| !w.other_hold).and_then(|w| w.resume_at)
}

/// Whether a paused run holds a stage only the director can move on: a
/// halt, a gate, a question, or a plan stage with no automatic resume left.
/// A worker that stops waiting on such a run must announce it.
pub fn needs_director(run: &crate::db::RunRow, stages: &[crate::db::RunStageRow]) -> bool {
    if run.status != "paused" {
        return false;
    }
    let scheduled = run.plan_wait.as_ref().is_some_and(|w| w.resume_at.is_some());
    stages.iter().any(|s| match s.status.as_str() {
        "awaiting_checkpoint" => true,
        "failed" => !(scheduled && s.error.as_deref().is_some_and(is_plan_limit)),
        _ => false,
    })
}

/// Pure: stages still to run and none waiting for a decision (no halt, gate
/// or question). On a paused run with no driver, nothing moves it on its own.
pub fn stalled(stages: &[crate::db::RunStageRow]) -> bool {
    stages.iter().any(|s| s.status == "pending")
        && !stages.iter().any(|s| matches!(s.status.as_str(), "failed" | "awaiting_checkpoint" | "running"))
}

/// The drive's budget gate, exactly: a budget of `0` (or less) is no budget.
fn budget_spent(run: &crate::db::RunRow) -> bool {
    run.budget_usd.is_some_and(|b| b > 0.0 && run.cost_usd >= b)
}

impl Orchestrator {
    /// Park `run_id` after `stage_id` hit a Claude plan limit: persist the
    /// wait and, unless the director must decide, schedule the automatic
    /// resume. Journals what will happen. Returns whether a resume is
    /// scheduled.
    pub(crate) fn park_for_plan(&self, run_id: &str, stage_id: &str, limit: &PlanLimit) -> AppResult<bool> {
        let now = Utc::now().timestamp();
        let Some(run) = self.db.lock().get_run(run_id)? else {
            return Ok(false);
        };
        let count = self.db.lock().plan_resume_count(run_id)?;
        // Several stages of one batch can hit different windows: the run may
        // only resume once the LATEST of them resets, so keep that one.
        let (window_key, resets_at) = match &run.plan_wait {
            Some(w) if w.resets_at > limit.resets_at => (w.window.clone(), w.resets_at),
            _ => (limit.window.clone(), limit.resets_at),
        };
        let decision = park_decision(resets_at, now, count, budget_spent(&run), jitter());
        let window = plan_window_name(&window_key);
        let resets = clock_label(resets_at, now);
        let (resume_at, notice) = match decision {
            ParkDecision::Resume { at } => (
                Some(at),
                format!("Paused by your Claude plan · resumes at {}", clock_label(at, now)),
            ),
            ParkDecision::Director(DirectorReason::CapReached) => (
                None,
                format!(
                    "Paused by your Claude plan again · {AUTO_RESUME_CAP} automatic resumes already ran, \
                     so it waits for you (the {window} resets at {resets})"
                ),
            ),
            ParkDecision::Director(DirectorReason::BudgetSpent) => (
                None,
                format!("Paused by your Claude plan · the run's budget is spent, so it waits for you (the {window} resets at {resets})"),
            ),
            ParkDecision::Director(DirectorReason::TooFar) => (
                None,
                format!("Paused by your Claude plan · the {window} resets at {resets}, too far off to wait for, so it waits for you"),
            ),
        };
        self.db.lock().set_run_plan_wait(run_id, &window_key, resets_at, resume_at)?;
        self.journal_notice(run_id, stage_id, &notice);
        self.emit_run_update(run_id);
        Ok(resume_at.is_some())
    }

    /// The `run://checkpoint` reason for a failed `stage`: `plan_limit` when
    /// that stage hit a plan limit, an automatic resume is scheduled and no
    /// other stage of the run waits for a decision (nobody needs to decide),
    /// else `decision`.
    pub(crate) fn park_reason(&self, run_id: &str, stage: &crate::db::RunStageRow) -> &'static str {
        let stages = self.db.lock().list_run_stages(run_id).unwrap_or_default();
        let error = stages.iter().find(|s| s.id == stage.id).and_then(|s| s.error.clone()).or_else(|| stage.error.clone());
        let plan_stage = error.as_deref().is_some_and(is_plan_limit);
        let scheduled = self
            .db
            .lock()
            .get_run(run_id)
            .ok()
            .flatten()
            .and_then(|r| r.plan_wait)
            .is_some_and(|w| w.resume_at.is_some());
        let only_plan = only_plan_holds(&stages);
        if plan_stage && scheduled && only_plan {
            "plan_limit"
        } else {
            "decision"
        }
    }

    /// Claim and apply the automatic resume of a plan-parked run whose time
    /// has come: every plan-limited stage of the run resumes (see
    /// [`PlanClaim`] for the outcomes).
    pub fn claim_plan_resume(&self, run_id: &str) -> AppResult<PlanClaim> {
        let now = Utc::now().timestamp();
        // Read the park before the claim, so a Resume that fails to apply can
        // be scheduled again.
        let Some(before) = self.db.lock().get_run(run_id)?.and_then(|r| r.plan_wait) else {
            return Ok(PlanClaim::NotClaimed);
        };
        // The claim keeps the park due again at `now + RETRY_SECS` until the
        // apply ends it: a failure (or a crash) here never loses the resume.
        let claimed_at = now + RETRY_SECS;
        if !self.db.lock().claim_plan_resume(run_id, now, claimed_at)? {
            return Ok(PlanClaim::NotClaimed);
        }
        match self.apply_claimed_plan_resume(run_id, claimed_at) {
            Ok(PlanClaim::Retry) | Err(_) => {
                // Counted on the row: every process that claims it shares
                // the cap, and a restart doesn't reset it.
                let tries = self.db.lock().bump_plan_retry_count(run_id).unwrap_or_else(|e| {
                    tracing::warn!(run_id = %run_id, error = %e, "plan resume: counting the retry failed");
                    0
                });
                if tries >= MAX_PLAN_RETRIES {
                    // Retrying blind forever helps nobody: hand it over.
                    let _ = self.db.lock().reset_plan_retry_count(run_id);
                    if !self.restore_park(run_id, &before, None, claimed_at) {
                        // The director changed the park meanwhile: theirs stands.
                        self.emit_run_update(run_id);
                        return Ok(PlanClaim::NotClaimed);
                    }
                    if let Some(s) = self.first_plan_stage(run_id) {
                        self.journal_notice(
                            run_id,
                            &s,
                            &format!("Couldn't resume automatically after {MAX_PLAN_RETRIES} tries · resume when you're ready"),
                        );
                        self.emit_run_update(run_id);
                        self.emit_checkpoint(run_id, &s, "decision");
                    } else {
                        self.emit_run_update(run_id);
                    }
                    return Ok(PlanClaim::NeedsYou);
                }
                // Put the park back, due again shortly, the claim uncounted —
                // unless the director changed it meanwhile (turned the
                // automatic resume off): theirs stands.
                let restored = self.restore_park(run_id, &before, Some(now + RETRY_SECS), claimed_at);
                self.emit_run_update(run_id);
                Ok(if restored { PlanClaim::Retry } else { PlanClaim::NotClaimed })
            }
            Ok(claim) => {
                let _ = self.db.lock().reset_plan_retry_count(run_id);
                Ok(claim)
            }
        }
    }

    /// Put a claimed park back (best effort, retried: the apply may have
    /// cleared it). If every write fails the claim's own `RETRY_SECS` hold
    /// still stands unless the apply got as far as clearing the park. Only
    /// the claim's own park (`claimed_at`) is restored: a director's cancel
    /// meanwhile is never undone. Returns `false` only when the park was left
    /// alone because it changed hands (a write error still reads `true`: the
    /// claim's hold keeps it due).
    fn restore_park(&self, run_id: &str, before: &crate::db::PlanWait, resume_at: Option<i64>, claimed_at: i64) -> bool {
        for attempt in 0..3 {
            match self.db.lock().restore_plan_resume(run_id, &before.window, before.resets_at, resume_at, claimed_at) {
                Ok(restored) => return restored,
                Err(e) => tracing::warn!(run_id = %run_id, attempt, error = %e, "plan resume: restoring the park failed"),
            }
            std::thread::sleep(std::time::Duration::from_millis(100 << attempt));
        }
        true
    }

    /// The first stage of `run_id` stopped by a Claude plan limit.
    fn first_plan_stage(&self, run_id: &str) -> Option<String> {
        self.db
            .lock()
            .list_run_stages(run_id)
            .ok()?
            .into_iter()
            .find(|s| s.status == "failed" && s.error.as_deref().is_some_and(is_plan_limit))
            .map(|s| s.id)
    }

    /// The part of [`Self::claim_plan_resume`] after the claim: resume, or
    /// hand the run to the director. `Retry` (or an error) means the caller
    /// schedules the resume again.
    pub(crate) fn apply_claimed_plan_resume(&self, run_id: &str, claimed_at: i64) -> AppResult<PlanClaim> {
        let Some(run) = self.db.lock().get_run(run_id)? else {
            return Ok(PlanClaim::NotClaimed);
        };
        // The director turned the automatic resume off after the claim (the
        // schedule is no longer the claim's): the run stays parked for them.
        if run.plan_wait.as_ref().and_then(|w| w.resume_at) != Some(claimed_at) {
            return Ok(PlanClaim::NotClaimed);
        }
        let stages = self.db.lock().list_run_stages(run_id)?;
        let Some(stage) = stages
            .iter()
            .find(|s| s.status == "failed" && s.error.as_deref().is_some_and(is_plan_limit))
            .cloned()
        else {
            // The parked stage was resolved another way: nothing to resume.
            self.db.lock().clear_run_plan_wait(run_id)?;
            self.emit_run_update(run_id);
            // ...but a Resume that was applied only in part (the stages reset
            // to pending, then the apply failed) leaves a paused run that
            // nobody drives. Say so instead of going quiet.
            if self.stalled_without_driver(&run, &stages) {
                if let Some(s) = stages.iter().find(|s| s.status == "pending") {
                    self.journal_notice(
                        run_id,
                        &s.id,
                        "Claude plan window reset · the resume didn't finish, so it waits for you",
                    );
                }
                return Ok(PlanClaim::NeedsYou);
            }
            return Ok(PlanClaim::NotClaimed);
        };
        if budget_spent(&run) {
            // Never resume a run whose budget is spent: it waits for you (the
            // claim left the park due again; take that back).
            self.db.lock().cancel_plan_resume(run_id)?;
            self.journal_notice(
                run_id,
                &stage.id,
                "Claude plan window reset · the run's budget is spent, so it waits for you",
            );
            self.emit_run_update(run_id);
            self.emit_checkpoint(run_id, &stage.id, "decision");
            return Ok(PlanClaim::NeedsYou);
        }
        let count = self.db.lock().plan_resume_count(run_id)?;
        // Resume on the plan-limited stage resumes every plan-limited stage
        // of the run (`apply_checkpoint_action`).
        match self.resolve_checkpoint_apply_only(
            run_id,
            Some(&stage.id),
            CheckpointAction::Resume { max_turns_override: None },
        ) {
            Ok(Some(budget_override)) => {
                self.journal_notice(
                    run_id,
                    &stage.id,
                    &format!("Claude plan window reset · resuming (automatic resume {count} of {AUTO_RESUME_CAP})"),
                );
                Ok(PlanClaim::Resumed { budget_override })
            }
            Ok(None) => Ok(PlanClaim::NotClaimed),
            Err(e) => {
                tracing::warn!(run_id = %run_id, error = %e, "plan resume: applying Resume failed; scheduled again");
                Ok(PlanClaim::Retry)
            }
        }
    }

    /// A paused run with stages still to run, none waiting for a decision,
    /// and no driver: neither a drive in this process nor a live worker.
    fn stalled_without_driver(&self, run: &crate::db::RunRow, stages: &[crate::db::RunStageRow]) -> bool {
        run.status == "paused"
            && stalled(stages)
            && !self.active.lock().contains(&run.id)
            && !self.db.lock().worker_lease_fresh(&run.id).unwrap_or(true)
    }

    /// The director turned off this run's automatic resume: it stays parked
    /// and waits for a manual Resume. Silent (`director`): it's their own hand.
    pub fn cancel_plan_resume(&self, run_id: &str) -> AppResult<()> {
        if !self.db.lock().cancel_plan_resume(run_id)? {
            return Ok(());
        }
        // The director acted: failed claims before this no longer count.
        self.db.lock().reset_plan_retry_count(run_id)?;
        let stage = self
            .db
            .lock()
            .list_run_stages(run_id)?
            .into_iter()
            .find(|s| s.status == "failed" && s.error.as_deref().is_some_and(is_plan_limit));
        if let Some(s) = stage {
            self.journal_notice(run_id, &s.id, "Automatic resume turned off · resume when you're ready");
            self.emit_run_update(run_id);
            self.emit_checkpoint(run_id, &s.id, "director");
        } else {
            self.emit_run_update(run_id);
        }
        Ok(())
    }

    /// App side, on the scheduler tick: resume every plan-parked run whose
    /// time has come — detached for Pro, in-process otherwise (the same
    /// substrate a director's Resume would use). Never fails the tick.
    pub(crate) fn plan_resume_tick(self: &Arc<Self>) {
        let now = Utc::now().timestamp();
        let due = match self.db.lock().list_due_plan_resumes(now) {
            Ok(d) => d,
            Err(e) => {
                tracing::warn!(error = %e, "plan resume: listing due runs failed");
                return;
            }
        };
        for run_id in due {
            match self.claim_plan_resume(&run_id) {
                Ok(PlanClaim::Resumed { budget_override }) => self.drive_resumed(run_id, budget_override),
                // The app is up: the checkpoint and run events already tell the
                // director; a retry is picked up by a later tick.
                Ok(PlanClaim::NotClaimed | PlanClaim::NeedsYou | PlanClaim::Retry) => {}
                Err(e) => tracing::warn!(run_id = %run_id, error = %e, "plan resume failed"),
            }
        }
    }

    /// Drive a run whose Resume is applied on the run's own substrate: a
    /// detached worker for a detached run (`runs.detached`), with the
    /// in-process fallback `commands::dispatch_checkpoint` uses, else
    /// in-process.
    ///
    /// Why `runs.detached` and not the entitlement `dispatch_checkpoint`
    /// checks: this resume has no director behind it, so it must keep the run
    /// on the substrate it was STARTED on. `detached` is set at spawn and
    /// permanent for the run; the entitlement can have changed since.
    fn drive_resumed(self: &Arc<Self>, run_id: String, budget_override: bool) {
        let detached = self.db.lock().get_run(&run_id).ok().flatten().is_some_and(|r| r.detached);
        if detached {
            match self.spawn_detached_segment(&run_id, budget_override) {
                Ok(_) => return,
                Err(e) => {
                    tracing::warn!(run_id = %run_id, error = %e, "detached spawn failed — driving in-process");
                }
            }
        }
        Arc::clone(self).spawn_drive(run_id, budget_override);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_793_540_000;

    #[test]
    fn schedules_after_the_reset_with_margin_and_bounded_jitter() {
        let resets = NOW + 3_600;
        assert_eq!(park_decision(resets, NOW, 0, false, 0), ParkDecision::Resume { at: resets + 90 });
        assert_eq!(park_decision(resets, NOW, 0, false, 42), ParkDecision::Resume { at: resets + 132 });
        // Jitter is clamped either way.
        assert_eq!(park_decision(resets, NOW, 0, false, 10_000), ParkDecision::Resume { at: resets + 150 });
        assert_eq!(park_decision(resets, NOW, 0, false, -5), ParkDecision::Resume { at: resets + 90 });
    }

    #[test]
    fn a_reset_already_past_resumes_from_now() {
        assert_eq!(park_decision(NOW - 600, NOW, 1, false, 0), ParkDecision::Resume { at: NOW + 90 });
    }

    #[test]
    fn the_cap_hands_the_run_to_the_director() {
        let resets = NOW + 60;
        assert!(matches!(park_decision(resets, NOW, AUTO_RESUME_CAP - 1, false, 0), ParkDecision::Resume { .. }));
        assert_eq!(
            park_decision(resets, NOW, AUTO_RESUME_CAP, false, 0),
            ParkDecision::Director(DirectorReason::CapReached)
        );
    }

    #[test]
    fn a_spent_budget_never_resumes() {
        assert_eq!(park_decision(NOW + 60, NOW, 0, true, 0), ParkDecision::Director(DirectorReason::BudgetSpent));
    }

    #[test]
    fn a_window_too_far_off_waits_for_the_director() {
        assert!(matches!(park_decision(NOW + 7 * 86_400, NOW, 0, false, 0), ParkDecision::Resume { .. }));
        assert_eq!(
            park_decision(NOW + MAX_WAIT_SECS + 1, NOW, 0, false, 0),
            ParkDecision::Director(DirectorReason::TooFar)
        );
    }

    #[test]
    fn jitter_stays_in_range() {
        for _ in 0..200 {
            let j = jitter();
            assert!((0..=RESUME_JITTER_SECS).contains(&j), "{j}");
        }
    }
}
