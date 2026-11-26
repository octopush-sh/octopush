//! "Notify me elsewhere" (#964) at the orchestrator's existing attention
//! points: the `run://checkpoint` a "decision" park emits (gate, question,
//! halted stage) and the run's completion. Both run in the app's own drive
//! and in `octopush-run-worker`, which drives with this same orchestrator,
//! so a detached crew reaches the webhook with the app closed. The bridge
//! relays a worker's parks without sending them again (`relay_checkpoint`).
//!
//! Off ⇒ nothing here reads the database or touches the network: every entry
//! point asks [`notify_elsewhere::configured_url`] first.

use std::sync::Arc;

use crate::notify_elsewhere::{self, Event};
use crate::orchestrator::live::RUN_LOG_EVENT;

use super::Orchestrator;

/// The event a "decision" park stands for, from the parked stage's row
/// (pure). A stage a Claude plan limit stopped waits for the director (its
/// automatic resume is off, capped or used up, or the budget is spent) and
/// is no failure, for a Routine either: it can still finish once resumed.
/// Any other failed stage halted the run; a stage awaiting its checkpoint
/// with questions asked the director; any other awaiting stage holds a gate
/// (a checkpoint, a review loop's decision, a budget park, a secret hold). A
/// Routine's failure is reported as the Routine's.
pub(crate) fn park_event(stage_status: &str, asked: bool, plan_limited: bool, routine: bool) -> Option<Event> {
    match stage_status {
        "failed" if plan_limited => Some(Event::PlanLimit),
        "failed" if routine => Some(Event::RoutineFailed),
        "failed" => Some(Event::RunFailed),
        "awaiting_checkpoint" if asked => Some(Event::DirectorQuestion),
        "awaiting_checkpoint" => Some(Event::CheckpointGate),
        _ => None,
    }
}

impl Orchestrator {
    /// A checkpoint just fired for `stage_id`. Only a `decision` park needs
    /// the director; `director` (their own pause) and `plan_limit` (resumes
    /// on its own) send nothing.
    pub(crate) fn notify_elsewhere_park(&self, run_id: &str, stage_id: &str, reason: &str) {
        if reason != "decision" || notify_elsewhere::configured_url().is_none() {
            return;
        }
        let stage = self
            .db
            .lock()
            .list_run_stages(run_id)
            .ok()
            .and_then(|stages| stages.into_iter().find(|s| s.id == stage_id));
        let Some(stage) = stage else { return };
        let asked = stage.blocked_questions.as_deref().is_some_and(|q| !q.trim().is_empty());
        let plan_limited = stage.error.as_deref().is_some_and(crate::orchestrator::cli_runner::is_plan_limit);
        let routine = self.db.lock().routine_name_for_run(run_id).ok().flatten();
        if let Some(event) = park_event(&stage.status, asked, plan_limited, routine.is_some()) {
            self.send_elsewhere(run_id, stage_id, event, routine);
        }
    }

    /// A run just completed. Only a Routine's completion is sent: a crew the
    /// director started finishing is not a decision.
    pub(crate) fn notify_elsewhere_completed(&self, run_id: &str) {
        if notify_elsewhere::configured_url().is_none() {
            return;
        }
        let Some(routine) = self.db.lock().routine_name_for_run(run_id).ok().flatten() else {
            return;
        };
        let last = self
            .db
            .lock()
            .list_run_stages(run_id)
            .ok()
            .and_then(|stages| stages.into_iter().max_by_key(|s| s.position));
        if let Some(stage) = last {
            self.send_elsewhere(run_id, &stage.id, Event::RoutineFinished, Some(routine));
        }
    }

    /// Send `event` for this run in the background. A failure becomes one
    /// quiet notice in the stage's journal; the run never waits for it. For a
    /// Routine's run, `mission` carries the Routine's name: a fresh-mode
    /// Routine's workspace has no mission, and the name is what the director
    /// knows the Routine by.
    fn send_elsewhere(&self, run_id: &str, stage_id: &str, event: Event, routine: Option<String>) {
        let (mission_title, project) = self.mission_and_project(run_id);
        let mission = routine.filter(|r| !r.trim().is_empty()).unwrap_or(mission_title);
        let events = Arc::clone(&self.events);
        let (run, stage) = (run_id.to_string(), stage_id.to_string());
        notify_elsewhere::dispatch(notify_elsewhere::payload(event, &mission, &project), move |why| {
            events.emit(
                RUN_LOG_EVENT,
                serde_json::json!({
                    "runId": run,
                    "stageId": stage,
                    "entry": { "kind": "notice", "text": format!("Notify me elsewhere didn't send: {why}.") },
                }),
            );
        });
    }

    /// The names the message carries: the workspace's mission title (the
    /// start of its task) and the project's name. Nothing else about the run,
    /// its workspace or its repo.
    fn mission_and_project(&self, run_id: &str) -> (String, String) {
        let db = self.db.lock();
        let Some(ws) = db
            .get_run(run_id)
            .ok()
            .flatten()
            .and_then(|run| db.get_workspace(&run.workspace_id).ok().flatten())
        else {
            return (String::new(), String::new());
        };
        let mission = db.mission_for_workspace(&ws.id).ok().flatten().map(|m| m.title).unwrap_or_default();
        let project = db.get_project_by_id(&ws.project_id).ok().flatten().map(|(_, name, _)| name).unwrap_or_default();
        (mission, project)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_park_maps_to_its_event() {
        // (status, asked, plan limited, routine) → event
        let rows = [
            ("awaiting_checkpoint", false, false, false, Some(Event::CheckpointGate)),
            ("awaiting_checkpoint", true, false, false, Some(Event::DirectorQuestion)),
            ("failed", false, false, false, Some(Event::RunFailed)),
            // A plan limit that waits for the director is no failure.
            ("failed", false, true, false, Some(Event::PlanLimit)),
            // A Routine's gate and question are the director's like any
            // other; its plan limit is a wait, not "Routine failed" (it can
            // still finish once resumed); any other failure is the Routine's.
            ("awaiting_checkpoint", false, false, true, Some(Event::CheckpointGate)),
            ("awaiting_checkpoint", true, false, true, Some(Event::DirectorQuestion)),
            ("failed", false, true, true, Some(Event::PlanLimit)),
            ("failed", false, false, true, Some(Event::RoutineFailed)),
        ];
        for (status, asked, plan, routine, want) in rows {
            assert_eq!(park_event(status, asked, plan, routine), want, "{status} {asked} {plan} {routine}");
        }
        for quiet in ["pending", "running", "done", ""] {
            assert_eq!(park_event(quiet, false, false, false), None, "{quiet}");
            assert_eq!(park_event(quiet, false, true, true), None, "{quiet}");
        }
    }
}
