//! `octopush-run-worker` — drives ONE segment of a Direct run, detached from
//! the app.
//!
//! Spawned by Octopush (Pro, `runs.detached`) in its own session (`setsid`),
//! so the segment — and the `claude` CLI child inside it — survives the app
//! quitting. It is deliberately NOT a daemon: it opens the same SQLite store,
//! confirms its worker lease, drives the run to its next natural pause or
//! completion with the same `Orchestrator` the app uses, clears the lease,
//! and exits. The app's bridge re-emits the persisted progress as live
//! events; if the app is gone when the segment ends, a native notification
//! announces the outcome instead.
//!
//! Boundaries (see `docs/superpowers/plans/2026-07-12-detached-runs-phase1-design.md`):
//! - never runs DB migrations (the spawning app, same binary version, already did);
//! - never reads the keychain (entitlement was the spawner's decision;
//!   history sync is the app's job — `Orchestrator::new_headless`);
//! - stops driving the moment it loses its lease (superseded or repaired).

use std::sync::Arc;
use std::time::Duration;

use octopush_lib::db::Db;
use octopush_lib::orchestrator::events::EventSink;
use octopush_lib::orchestrator::types::RunStatus;
use octopush_lib::orchestrator::plan_wait::{self, PlanClaim};
use octopush_lib::orchestrator::Orchestrator;
use parking_lot::Mutex;

/// The worker's orchestrator has no live channel — the app's bridge replays
/// from the DB. (`PersistingSink` still journals every entry to `stage_log`.)
struct NullSink;
impl EventSink for NullSink {
    fn emit(&self, _event: &str, _payload: serde_json::Value) {}
}

struct Args {
    run_id: String,
    nonce: String,
    app_pid: Option<i32>,
    budget_override: bool,
}

fn parse_args() -> Option<Args> {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some("drive") {
        return None;
    }
    let run_id = args.next().filter(|a| !a.starts_with("--"))?;
    let mut nonce = None;
    let mut app_pid = None;
    let mut budget_override = false;
    while let Some(a) = args.next() {
        match a.as_str() {
            "--nonce" => nonce = args.next(),
            "--app-pid" => app_pid = args.next().and_then(|v| v.parse().ok()),
            "--budget-override" => budget_override = true,
            _ => return None,
        }
    }
    Some(Args { run_id, nonce: nonce?, app_pid, budget_override })
}

#[tokio::main]
async fn main() {
    let Some(args) = parse_args() else {
        eprintln!(
            "usage: octopush-run-worker drive <run_id> --nonce <nonce> [--app-pid <pid>] [--budget-override]"
        );
        std::process::exit(2);
    };

    let db = match Db::open_without_migrations(&Db::default_path()) {
        Ok(db) => Arc::new(Mutex::new(db)),
        Err(e) => {
            eprintln!("octopush-run-worker: failed to open the Octopush database: {e}");
            std::process::exit(1);
        }
    };

    // Prove the claim. `Ok(false)` = a newer reserve superseded this nonce →
    // yield silently, the successor owns the run. `Err` = a transient DB
    // error (e.g. SQLITE_BUSY racing the app's reserve write): retry a few
    // times before giving up, because a silent yield here would strand the
    // lease `reserve` just wrote for the full freshness window (~45s) with no
    // in-process fallback (the spawning command already returned Ok). If the
    // DB stays unreachable, best-effort clear the lease so recovery doesn't
    // wait out that window, then exit non-zero.
    let pid = std::process::id() as i64;
    let mut confirmed = false;
    for attempt in 0..5 {
        match db.lock().confirm_worker_lease(&args.run_id, &args.nonce, pid) {
            Ok(true) => {
                confirmed = true;
                break;
            }
            Ok(false) => std::process::exit(0), // superseded — not our run
            Err(_) if attempt < 4 => {}          // transient — retry
            Err(e) => {
                eprintln!("octopush-run-worker: could not confirm lease: {e}");
                let _ = db.lock().clear_worker_lease(&args.run_id, &args.nonce);
                std::process::exit(1);
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    if !confirmed {
        std::process::exit(1);
    }

    let orch = Arc::new(Orchestrator::new_headless(
        Arc::clone(&db),
        Arc::new(NullSink),
    ));

    // Drive segments. A segment that parks at a Claude plan limit with an
    // automatic resume scheduled doesn't end the worker: it waits (holding no
    // lease) for the window to reset, claims the resume — unless the app's
    // scheduler or the director got there first — and drives again. So an
    // overnight crew resumes itself even with Octopush closed (#731).
    let mut budget_override = args.budget_override;
    let result = loop {
        let heartbeat = spawn_heartbeat(Arc::clone(&db), Arc::clone(&orch), args.run_id.clone(), args.nonce.clone());
        let result = orch.drive_segment(&args.run_id, budget_override).await;
        heartbeat.abort();

        // Release the claim (nonce-guarded: a successor's lease is never touched).
        let _ = db.lock().clear_worker_lease(&args.run_id, &args.nonce);

        // Only a park where the plan is ALL that waits is waited for here: a
        // sibling's halt, gate or question needs the director now, so that
        // ends the worker with "The crew needs you" (the app's scheduler
        // still resumes the plan stages once the director has decided).
        let plan_resume_at = match &result {
            Ok(RunStatus::Paused) => {
                db.lock().get_run(&args.run_id).ok().flatten().as_ref().and_then(plan_wait::worker_plan_wait)
            }
            _ => None,
        };
        let Some(resume_at) = plan_resume_at else {
            announce(&db, &args, &result);
            break result;
        };
        if !app_alive(args.app_pid) {
            let now = chrono::Utc::now().timestamp();
            let task = run_task(&db, &args.run_id);
            notify_native(
                "Paused by your Claude plan",
                &format!("{} — resumes at {}.", trim_task(&task), plan_wait::clock_label(resume_at, now)),
            );
        }
        match wait_for_plan_reset(&db, &orch, &args.run_id).await {
            WaitEnd::Drive(over) => {
                // Drive the next segment under our own lease again.
                match retake_lease(&db, &args.run_id, &args.nonce).await {
                    Lease::Ours => {}
                    // Someone else owns it now; the resume is already applied
                    // and that driver will run it.
                    Lease::Theirs => break Ok(RunStatus::Paused),
                    // The database stayed unreachable: the resume is applied
                    // but nobody drives it. Say so instead of going quiet.
                    Lease::Unreachable => {
                        let result = Ok(RunStatus::Paused);
                        announce(&db, &args, &result);
                        break result;
                    }
                }
                if !app_alive(args.app_pid) {
                    let task = run_task(&db, &args.run_id);
                    notify_native("Crew resumed", &format!("{} — your Claude plan window reset.", trim_task(&task)));
                }
                budget_override = over;
            }
            // The run now waits for the director (its budget is spent, or the
            // database stayed unreadable): never exit silently.
            WaitEnd::NeedsYou => {
                let result = Ok(RunStatus::Paused);
                announce(&db, &args, &result);
                break result;
            }
            // Resumed elsewhere, aborted, or nothing left held: nothing to say.
            WaitEnd::Gone => break Ok(RunStatus::Paused),
        }
    };

    if let Err(e) = result {
        eprintln!("octopush-run-worker: drive failed: {e}");
        std::process::exit(1);
    }
}

/// Taking the worker lease back after a plan wait.
#[derive(Debug, PartialEq, Eq)]
enum Lease {
    Ours,
    /// Another driver holds the run.
    Theirs,
    /// The database kept failing.
    Unreachable,
}

/// Reserve and confirm the lease again, riding out transient database
/// errors (a busy database is not "someone else owns it").
async fn retake_lease(db: &Arc<Mutex<Db>>, run_id: &str, nonce: &str) -> Lease {
    let pid = std::process::id() as i64;
    for attempt in 1..=LEASE_RETRIES {
        let step = db
            .lock()
            .reserve_worker_lease(run_id, nonce)
            .and_then(|ok| if ok { db.lock().confirm_worker_lease(run_id, nonce, pid) } else { Ok(false) });
        match step {
            Ok(true) => return Lease::Ours,
            Ok(false) => return Lease::Theirs,
            Err(e) => {
                eprintln!("octopush-run-worker: retaking the lease failed ({attempt}): {e}");
                tokio::time::sleep(db_backoff(attempt)).await;
            }
        }
    }
    Lease::Unreachable
}

/// Attempts [`retake_lease`] makes before giving up (about a minute).
const LEASE_RETRIES: u32 = 8;

/// [`plan_wait::needs_director`] on the run's current rows (`false` when
/// they can't be read: the caller has nothing reliable to announce).
fn paused_with_hold(db: &Arc<Mutex<Db>>, run_id: &str) -> bool {
    let Ok(Some(run)) = db.lock().get_run(run_id) else {
        return false;
    };
    let Ok(stages) = db.lock().list_run_stages(run_id) else {
        return false;
    };
    plan_wait::needs_director(&run, &stages)
}

/// How often a waiting worker re-reads the clock and the run. Wall-clock
/// polling, not one long sleep: a Mac asleep through the reset must still
/// resume soon after it wakes.
const PLAN_WAIT_POLL: Duration = Duration::from_secs(15);

/// How a worker's wait for a plan reset ended.
#[derive(Debug, PartialEq, Eq)]
enum WaitEnd {
    /// The Resume is applied: drive the next segment with this budget override.
    Drive(bool),
    /// The run waits for the director now: announce it.
    NeedsYou,
    /// Nothing left for this worker: the app or the director resumed it, or
    /// the run was aborted, deleted, or holds no stage any more.
    Gone,
}

/// Consecutive database errors a waiting worker rides out (with backoff up
/// to [`PLAN_WAIT_POLL`], about 15 minutes in all) before it hands the run to
/// the director instead of waiting blind.
const MAX_DB_RETRIES: u32 = 60;

/// The pause after the `n`th consecutive database error: 1 s, doubling, at
/// most [`PLAN_WAIT_POLL`].
fn db_backoff(n: u32) -> Duration {
    Duration::from_secs(1u64 << n.min(4)).min(PLAN_WAIT_POLL)
}

/// Wait until the run's automatic plan resume is due, then claim and apply
/// it. A transient database error (a busy database) is retried with backoff,
/// never read as a lost claim; a Resume that failed to apply is scheduled
/// again by the claim and waited for.
async fn wait_for_plan_reset(db: &Arc<Mutex<Db>>, orch: &Arc<Orchestrator>, run_id: &str) -> WaitEnd {
    let mut errors = 0u32;
    fn on_error(errors: &mut u32, e: &dyn std::fmt::Display) -> Option<Duration> {
        *errors += 1;
        eprintln!("octopush-run-worker: plan wait: database error ({errors}): {e}");
        (*errors <= MAX_DB_RETRIES).then(|| db_backoff(*errors))
    }
    loop {
        let run = match db.lock().get_run(run_id) {
            Ok(Some(r)) => r,
            Ok(None) => return WaitEnd::Gone,
            Err(e) => match on_error(&mut errors, &e) {
                Some(pause) => {
                    tokio::time::sleep(pause).await;
                    continue;
                }
                None => return WaitEnd::NeedsYou,
            },
        };
        if run.status != "paused" {
            return WaitEnd::Gone;
        }
        // No automatic resume any more (turned off, or handed to the
        // director): a run still holding a stage needs you.
        let Some(resume_at) = run.plan_wait.and_then(|w| w.resume_at) else {
            return if paused_with_hold(db, run_id) { WaitEnd::NeedsYou } else { WaitEnd::Gone };
        };
        if chrono::Utc::now().timestamp() < resume_at {
            errors = 0;
            tokio::time::sleep(PLAN_WAIT_POLL).await;
            continue;
        }
        match orch.claim_plan_resume(run_id) {
            Ok(PlanClaim::Resumed { budget_override }) => return WaitEnd::Drive(budget_override),
            Ok(PlanClaim::NeedsYou) => return WaitEnd::NeedsYou,
            // Resumed elsewhere is gone; still paused with a stage held (the
            // plan stages were resolved but a sibling waits) needs you.
            Ok(PlanClaim::NotClaimed) => {
                return if paused_with_hold(db, run_id) { WaitEnd::NeedsYou } else { WaitEnd::Gone };
            }
            Ok(PlanClaim::Retry) => tokio::time::sleep(PLAN_WAIT_POLL).await,
            Err(e) => match on_error(&mut errors, &e) {
                Some(pause) => tokio::time::sleep(pause).await,
                None => return WaitEnd::NeedsYou,
            },
        }
    }
}

/// Heartbeat + control poll for one segment: beat the lease (~1s — well
/// inside the 45s freshness window), and translate the cross-process request
/// flags into the orchestrator's in-memory ones. Zero changes to the
/// substrates — they already poll their cancel flag on a 500ms cadence.
fn spawn_heartbeat(
    db: Arc<Mutex<Db>>,
    orch: Arc<Orchestrator>,
    run_id: String,
    nonce: String,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut pause_seen = false;
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let owned = db.lock().beat_worker_lease(&run_id, &nonce).unwrap_or(false);
            if !owned {
                // Lost the lease (superseded, or repaired from outside):
                // stop driving as fast as the cancel check allows.
                let _ = orch.stop_current_stage(&run_id);
                return;
            }
            match db.lock().read_worker_controls(&run_id) {
                Ok(Some((status, stop, pause))) => {
                    if status == "aborted" || stop {
                        let _ = orch.stop_current_stage(&run_id);
                        if stop {
                            let _ = db.lock().set_stop_requested(&run_id, false);
                        }
                    }
                    if pause && !pause_seen {
                        pause_seen = true;
                        orch.request_pause(&run_id);
                        let _ = db.lock().set_pause_requested(&run_id, false);
                    }
                }
                Ok(None) => {
                    // Run vanished (workspace deleted under the worker).
                    let _ = orch.stop_current_stage(&run_id);
                    return;
                }
                Err(_) => {} // transient (busy DB) — next tick
            }
        }
    })
}

fn app_alive(app_pid: Option<i32>) -> bool {
    app_pid.map(|p| p > 0 && unsafe { libc::kill(p, 0) } == 0).unwrap_or(false)
}

fn run_task(db: &Arc<Mutex<Db>>, run_id: &str) -> String {
    db.lock().get_run(run_id).ok().flatten().map(|r| r.task).unwrap_or_default()
}

/// If the app is gone, the bridge can't announce the outcome — post a native
/// notification so a park or finish is never silent.
fn announce(db: &Arc<Mutex<Db>>, args: &Args, result: &Result<RunStatus, octopush_lib::error::AppError>) {
    if app_alive(args.app_pid) {
        return;
    }
    if let Ok(status) = result {
        let task = run_task(db, &args.run_id);
        let headline = match status {
            RunStatus::Completed => Some(("Crew finished", format!("{} — open Octopush for the story.", trim_task(&task)))),
            RunStatus::Paused => Some(("The crew needs you", format!("{} — open Octopush to decide.", trim_task(&task)))),
            // Aborted is the director's own hand — never news.
            _ => None,
        };
        if let Some((title, body)) = headline {
            notify_native(title, &body);
        }
    }
}

fn trim_task(task: &str) -> String {
    let t = task.trim();
    if t.chars().count() <= 70 {
        t.to_string()
    } else {
        let mut s: String = t.chars().take(70).collect();
        s.push('…');
        s
    }
}

/// Best-effort native notification via `osascript` — no app framework, no
/// keychain, no permission plumbing. Quotes/backslashes are STRIPPED, not
/// escaped: the text is a headline, not data, and AppleScript string
/// escaping is exactly the kind of injection surface a task title (which an
/// agent may have authored) must never reach.
#[cfg(target_os = "macos")]
fn notify_native(title: &str, body: &str) {
    let clean = |s: &str| s.replace(['"', '\\', '\r', '\n'], " ");
    let script = format!(
        "display notification \"{}\" with title \"{}\"",
        clean(body),
        clean(title)
    );
    let _ = std::process::Command::new("osascript")
        .arg("-e")
        .arg(script)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

#[cfg(not(target_os = "macos"))]
fn notify_native(_title: &str, _body: &str) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn db_errors_back_off_up_to_the_poll() {
        assert_eq!(db_backoff(1), Duration::from_secs(2));
        assert!(db_backoff(2) > db_backoff(1));
        assert_eq!(db_backoff(30), PLAN_WAIT_POLL, "capped at the poll");
        // The retries span minutes, not one blip.
        let total: Duration = (1..=MAX_DB_RETRIES).map(db_backoff).sum();
        assert!(total >= Duration::from_secs(10 * 60), "{total:?}");
    }
}
