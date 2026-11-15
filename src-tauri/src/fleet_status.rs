//! The fleet's needs-you count, derived in Rust so the Dock badge never depends
//! on the webview (main may be hidden). Mirrors `needsYou` / `fleetCounts` in
//! `src/lib/runStatus.ts`; `src/lib/needsYou.fixtures.json` pins the two, so
//! the badge and the fleet chip can't disagree.

use crate::state::AppState;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use tauri::{AppHandle, Manager};

/// A burst of run events (a stage's cost ticks, a checkpoint, the run update
/// after it) settles into one badge refresh after this long.
const COALESCE_MS: u64 = 250;

/// Whether a run needs the director: `paused` covers every human-must-act
/// reason (gate, halted stage, budget park, director pause).
pub fn needs_you(status: &str) -> bool {
    status == "paused"
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct FleetStatus {
    pub needs_you: u32,
    /// Running, nobody waiting.
    pub in_flight: u32,
}

impl FleetStatus {
    /// The Dock badge: the needs-you count, or none (cleared) at 0.
    pub fn badge(&self) -> Option<i64> {
        (self.needs_you > 0).then_some(i64::from(self.needs_you))
    }
}

pub fn derive<'a>(statuses: impl IntoIterator<Item = &'a str>) -> FleetStatus {
    let mut fleet = FleetStatus::default();
    for status in statuses {
        if needs_you(status) {
            fleet.needs_you += 1;
        } else if status == "running" {
            fleet.in_flight += 1;
        }
    }
    fleet
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
/// runs the fleet chip counts), clearing it at 0.
pub fn refresh(app: &AppHandle) {
    let runs = match app.state::<AppState>().db.lock().list_active_runs() {
        Ok(runs) => runs,
        Err(e) => {
            tracing::warn!(error = %e, "fleet status: listing active runs failed");
            return;
        }
    };
    let badge = derive(runs.iter().map(|r| r.status.as_str())).badge();
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
            assert_eq!(needs_you(status), c["needsYou"].as_bool().unwrap(), "{status}");
        }
    }

    #[test]
    fn fleet_split_and_badge_match_the_fleet_chip() {
        let fixtures: serde_json::Value =
            serde_json::from_str(include_str!("../../src/lib/needsYou.fixtures.json")).expect("fixtures");
        for f in fixtures["fleets"].as_array().expect("fleets") {
            let statuses: Vec<&str> =
                f["statuses"].as_array().unwrap().iter().map(|s| s.as_str().unwrap()).collect();
            let fleet = derive(statuses.iter().copied());
            assert_eq!(fleet.needs_you, f["needsYou"].as_u64().unwrap() as u32, "{statuses:?}");
            assert_eq!(fleet.in_flight, f["inFlight"].as_u64().unwrap() as u32, "{statuses:?}");
            assert_eq!(fleet.badge(), f["badge"].as_i64(), "{statuses:?}");
        }
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
