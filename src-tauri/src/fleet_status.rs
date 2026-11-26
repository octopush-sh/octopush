//! The fleet's needs-you count, derived in Rust so the Dock badge and the menu
//! bar Octo (`menu_bar.rs`) never depend on the webview (main may be hidden).
//! Mirrors `needsYou` / `fleetCounts` in `src/lib/runStatus.ts`;
//! `src/lib/needsYou.fixtures.json` pins the two, so the badge, the menu bar
//! and the fleet chip can't disagree on crews. The badge and the menu bar
//! also count Talk conversations whose approval card waits on you (the
//! approval broker's `waiting`); the fleet chip stays the crews' own.

use crate::state::AppState;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use tauri::{AppHandle, Manager};

/// A burst of run events (a stage's cost ticks, a checkpoint, the run update
/// after it) settles into one badge refresh after this long.
const COALESCE_MS: u64 = 250;

/// Whether a run needs the director: `paused` covers every human-must-act
/// reason (gate, halted stage, budget park, director pause) — except a run
/// whose only waiting stages are Claude plan limits with an automatic resume
/// scheduled (`plan_waiting`, see [`plan_waiting`]): nobody has to decide,
/// so it is in flight (#731). A sibling's real halt or gate keeps it needs-you.
pub fn needs_you(status: &str, plan_waiting: bool) -> bool {
    status == "paused" && !plan_waiting
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct FleetStatus {
    /// Crews (Direct runs) that need you.
    pub needs_you: u32,
    /// Running, nobody waiting.
    pub in_flight: u32,
    /// Talk conversations whose approval card waits on you (one per
    /// conversation, however many cards it holds). Not part of [`derive`]:
    /// `refresh` reads it from the approval broker.
    pub talk: u32,
}

impl FleetStatus {
    /// Everything that needs you: crews and Talk conversations.
    pub fn waiting(&self) -> u32 {
        self.needs_you + self.talk
    }

    /// The Dock badge: the needs-you count, or none (cleared) at 0.
    pub fn badge(&self) -> Option<i64> {
        let n = self.waiting();
        (n > 0).then_some(i64::from(n))
    }
}

/// The conversations among Talk's waiting approval cards (oldest first in,
/// oldest first out): one entry per thread, its oldest card.
pub fn talk_conversations(waits: &[crate::chat_engine::ApprovalWait]) -> Vec<&crate::chat_engine::ApprovalWait> {
    let mut seen = std::collections::HashSet::new();
    waits.iter().filter(|w| seen.insert(w.thread_id.as_str())).collect()
}

/// The fleet split over `(status, plan_waiting)` pairs (see [`needs_you`]).
pub fn derive<'a>(runs: impl IntoIterator<Item = (&'a str, bool)>) -> FleetStatus {
    let mut fleet = FleetStatus::default();
    for (status, plan_waiting) in runs {
        if needs_you(status, plan_waiting) {
            fleet.needs_you += 1;
        } else if status == "running" || (status == "paused" && plan_waiting) {
            fleet.in_flight += 1;
        }
    }
    fleet
}

/// A run waits for its Claude plan with an automatic resume scheduled, and
/// nothing else in it waits for the director (`PlanWait::other_hold`: no
/// other failed stage, gate or question).
pub fn plan_waiting(run: &crate::db::RunRow) -> bool {
    run.plan_wait.as_ref().is_some_and(|w| calm_plan_wait(w.resume_at, w.other_hold))
}

/// Pure: a plan park is calm with a resume scheduled and no other hold.
/// Mirrors TS `isPlanWaiting` (pinned by `needsYou.fixtures.json`).
pub fn calm_plan_wait(resume_at: Option<i64>, other_hold: bool) -> bool {
    resume_at.is_some() && !other_hold
}

/// Whether a halted stage's error is a *transient* fault that Resume answers
/// (a rate limit, an overload, a 5xx inside an `API error` framing, a dropped
/// connection or a time-out, the relaunch's `interrupted` stamp, a Claude plan
/// limit) rather than a standing one: Mission Control's `stalled`. Never a
/// hook-deferred tool halt, whatever its stderr tail says. Mirrors TS
/// `isTransientHalt` (runStatus.ts); `src/lib/transientHalt.fixtures.json`
/// pins the two. Word boundaries are ASCII, as in JavaScript.
pub fn is_transient_halt(error: Option<&str>) -> bool {
    use crate::orchestrator::cli_runner::{is_deferred_tool_unavailable, is_plan_limit, is_tool_deferred};
    static TRANSIENT: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(concat!(
            r"(?-u:\b)rate[\s_-]?limit",
            r"|(?-u:\b)overloaded(?-u:\b)",
            r"|api error (429|529|50[0-4])(?-u:\b)",
            r"|(?-u:\b)request failed(?-u:\b)",
            r"|(?-u:\b)timed?\s?out(?-u:\b)|(?-u:\b)timeout(?-u:\b)",
            r"|(?-u:\b)connection (reset|closed|refused)(?-u:\b)|(?-u:\b)dns(?-u:\b)",
        ))
        .expect("transient halt pattern")
    });
    let Some(error) = error.filter(|e| !e.is_empty()) else {
        return false;
    };
    if is_tool_deferred(error) || is_deferred_tool_unavailable(error) {
        return false;
    }
    if is_plan_limit(error) {
        return true;
    }
    let e = error.to_lowercase();
    e.starts_with("interrupted") || TRANSIENT.is_match(&e)
}

/// Run events after which a run's status may have changed.
pub fn affects_badge(event: &str) -> bool {
    matches!(event, "run://checkpoint" | "run://stage-update" | "run://cost" | "run://error")
}

static PENDING: AtomicBool = AtomicBool::new(false);
/// Whether a badge failure was logged already: on a platform without a Dock
/// badge every refresh fails the same way, so it is logged once.
static BADGE_ERROR_LOGGED: AtomicBool = AtomicBool::new(false);
/// The count on the Dock now (0 = no badge).
static SHOWN: AtomicI64 = AtomicI64::new(0);

/// Refresh the badge shortly, off the caller's thread: emitters may hold the
/// db lock, and a burst of events needs only one read.
pub fn refresh_later(app: &AppHandle) {
    if PENDING.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(COALESCE_MS));
        PENDING.store(false, Ordering::Release);
        refresh(&app);
    });
}

/// Set the Dock badge to the needs-you count across every workspace (the same
/// runs the fleet chip counts), clearing it at 0, and hand the same read to
/// the menu bar Octo (`menu_bar::update`), so the two can't disagree.
pub fn refresh(app: &AppHandle) {
    // Talk's approval cards waiting on you, read before the db lock (the
    // broker never takes it while holding its own).
    let approvals = app.state::<AppState>().chat.approvals().waiting();
    let talk_waits = talk_conversations(&approvals);
    let (runs, parked, talk) = {
        let state = app.state::<AppState>();
        let db = state.db.lock();
        let runs = match db.list_active_runs() {
            Ok(runs) => runs,
            Err(e) => {
                tracing::warn!(error = %e, "fleet status: listing active runs failed");
                return;
            }
        };
        // What each crew waits on, only while the menu bar shows it.
        let detail = crate::menu_bar::wants_detail() && runs.iter().any(|r| needs_you(&r.status, plan_waiting(r)));
        let parked = if detail {
            db.list_parked_stages().unwrap_or_else(|e| {
                tracing::warn!(error = %e, "fleet status: listing parked stages failed");
                Vec::new()
            })
        } else {
            Vec::new()
        };
        // Which workspace each waiting conversation is in, by name, only
        // while the menu bar shows it.
        let talk: Vec<crate::menu_bar::TalkWaiting> = if crate::menu_bar::wants_detail() {
            talk_waits
                .iter()
                .map(|w| {
                    let name = db.get_workspace(&w.workspace_id).ok().flatten().map(|ws| ws.name);
                    crate::menu_bar::TalkWaiting::new(w, name)
                })
                .collect()
        } else {
            Vec::new()
        };
        (runs, parked, talk)
    };
    let mut fleet = derive(runs.iter().map(|r| (r.status.as_str(), plan_waiting(r))));
    fleet.talk = talk_waits.len() as u32;
    set_badge(app, fleet.badge());
    crate::menu_bar::update(app, fleet, &runs, &parked, talk);
}

/// The Dock badge, set only when the count changed.
fn set_badge(app: &AppHandle, badge: Option<i64>) {
    let count = badge.unwrap_or(0);
    if SHOWN.load(Ordering::Acquire) == count {
        return;
    }
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    match win.set_badge_count(badge) {
        Ok(()) => SHOWN.store(count, Ordering::Release),
        Err(e) => {
            if first_badge_error(&BADGE_ERROR_LOGGED) {
                tracing::warn!(error = %e, "fleet status: setting the Dock badge failed (logged once)");
            }
        }
    }
}

/// True only the first time it's called for `flag`.
fn first_badge_error(flag: &AtomicBool) -> bool {
    !flag.swap(true, Ordering::AcqRel)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn needs_you_matches_the_frontends_predicate_case_for_case() {
        let fixtures: serde_json::Value =
            serde_json::from_str(include_str!("../../src/lib/needsYou.fixtures.json")).expect("fixtures");
        let statuses = fixtures["statuses"].as_array().expect("statuses");
        assert_eq!(statuses.len(), 6, "every RunStatus is covered");
        for c in statuses {
            let status = c["status"].as_str().unwrap();
            assert_eq!(needs_you(status, false), c["needsYou"].as_bool().unwrap(), "{status}");
        }
        for c in fixtures["planWaiting"].as_array().expect("planWaiting") {
            let status = c["status"].as_str().unwrap();
            let waiting = c["planWaiting"].as_bool().unwrap();
            assert_eq!(needs_you(status, waiting), c["needsYou"].as_bool().unwrap(), "{status} {waiting}");
        }
    }

    #[test]
    fn a_plan_park_is_calm_only_when_nothing_else_waits() {
        let fixtures: serde_json::Value =
            serde_json::from_str(include_str!("../../src/lib/needsYou.fixtures.json")).expect("fixtures");
        let cases = fixtures["planWait"].as_array().expect("planWait");
        assert!(cases.iter().any(|c| c["otherHold"].as_bool() == Some(true)), "a sibling-hold case is pinned");
        for c in cases {
            let status = c["status"].as_str().unwrap();
            let calm = status == "paused" && calm_plan_wait(c["resumeAt"].as_i64(), c["otherHold"].as_bool().unwrap());
            assert_eq!(calm, c["planWaiting"].as_bool().unwrap(), "{c}");
            assert_eq!(needs_you(status, calm), c["needsYou"].as_bool().unwrap(), "{c}");
        }
    }

    #[test]
    fn fleet_split_and_badge_match_the_fleet_chip() {
        let fixtures: serde_json::Value =
            serde_json::from_str(include_str!("../../src/lib/needsYou.fixtures.json")).expect("fixtures");
        for f in fixtures["fleets"].as_array().expect("fleets") {
            let statuses: Vec<&str> =
                f["statuses"].as_array().unwrap().iter().map(|s| s.as_str().unwrap()).collect();
            let waiting: Vec<bool> = f["planWaiting"]
                .as_array()
                .map(|a| a.iter().map(|b| b.as_bool().unwrap()).collect())
                .unwrap_or_else(|| vec![false; statuses.len()]);
            let fleet = derive(statuses.iter().copied().zip(waiting.iter().copied()));
            assert_eq!(fleet.needs_you, f["needsYou"].as_u64().unwrap() as u32, "{statuses:?}");
            assert_eq!(fleet.in_flight, f["inFlight"].as_u64().unwrap() as u32, "{statuses:?}");
            assert_eq!(fleet.badge(), f["badge"].as_i64(), "{statuses:?}");
        }
    }

    #[test]
    fn transient_halts_match_the_frontends_predicate_case_for_case() {
        let fixtures: serde_json::Value =
            serde_json::from_str(include_str!("../../src/lib/transientHalt.fixtures.json")).expect("fixtures");
        let transient = fixtures["transient"].as_array().expect("transient");
        let standing = fixtures["notTransient"].as_array().expect("notTransient");
        assert!(transient.len() >= 10 && standing.len() >= 10, "both sides are covered");
        for c in transient {
            let e = c.as_str().unwrap();
            assert!(is_transient_halt(Some(e)), "{e}");
        }
        for c in standing {
            assert!(!is_transient_halt(c.as_str()), "{c}");
        }
    }

    #[test]
    fn a_talk_approval_counts_once_per_conversation_on_the_badge() {
        let wait = |thread: &str, command: &str, since_ms: i64| crate::chat_engine::ApprovalWait {
            workspace_id: "w".into(),
            thread_id: thread.into(),
            command: command.into(),
            since_ms,
        };
        // Oldest first, as the broker lists them: a sub-agent fan-out's two
        // cards in t1 are one conversation waiting on you.
        let waits = vec![wait("t1", "git push -f", 1), wait("t2", "rm -rf build", 2), wait("t1", "git reset --hard", 3)];
        let talk = talk_conversations(&waits);
        let commands: Vec<&str> = talk.iter().map(|w| w.command.as_str()).collect();
        assert_eq!(commands, ["git push -f", "rm -rf build"]);

        let mut fleet = derive([("paused", false), ("running", false)]);
        assert_eq!(fleet.badge(), Some(1));
        fleet.talk = talk.len() as u32;
        assert_eq!((fleet.waiting(), fleet.badge()), (3, Some(3)));
        // Talk alone still badges; nothing waiting clears it.
        assert_eq!(FleetStatus { talk: 1, ..FleetStatus::default() }.badge(), Some(1));
        assert_eq!(FleetStatus::default().badge(), None);
    }

    #[test]
    fn the_events_that_move_a_run_refresh_the_badge() {
        for e in ["run://checkpoint", "run://stage-update", "run://cost", "run://error"] {
            assert!(affects_badge(e), "{e}");
        }
        assert!(!affects_badge("run://log"));
    }

    #[test]
    fn a_badge_failure_is_logged_once() {
        let flag = AtomicBool::new(false);
        assert!(first_badge_error(&flag));
        assert!(!first_badge_error(&flag));
        assert!(!first_badge_error(&flag));
    }
}
