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

    // Prove the claim. Zero rows affected ⇒ a newer reserve superseded this
    // nonce ⇒ yield silently — the successor owns the run.
    let pid = std::process::id() as i64;
    match db.lock().confirm_worker_lease(&args.run_id, &args.nonce, pid) {
        Ok(true) => {}
        _ => std::process::exit(0),
    }

    let orch = Arc::new(Orchestrator::new_headless(
        Arc::clone(&db),
        Arc::new(NullSink),
    ));

    // Heartbeat + control poll: beat the lease (~1s — well inside the 45s
    // freshness window), and translate the cross-process request flags into
    // the orchestrator's in-memory ones. Zero changes to the substrates —
    // they already poll their cancel flag on a 500ms cadence.
    {
        let db = Arc::clone(&db);
        let orch = Arc::clone(&orch);
        let run_id = args.run_id.clone();
        let nonce = args.nonce.clone();
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
        });
    }

    let result = orch.drive_segment(&args.run_id, args.budget_override).await;

    // Release the claim (nonce-guarded: a successor's lease is never touched).
    let _ = db.lock().clear_worker_lease(&args.run_id, &args.nonce);

    // If the app is gone, the bridge can't announce the outcome — post a
    // native notification so a park or finish is never silent.
    let app_alive = args
        .app_pid
        .map(|p| p > 0 && unsafe { libc::kill(p, 0) } == 0)
        .unwrap_or(false);
    if !app_alive {
        if let Ok(status) = &result {
            let task = db
                .lock()
                .get_run(&args.run_id)
                .ok()
                .flatten()
                .map(|r| r.task)
                .unwrap_or_default();
            let headline = match status {
                RunStatus::Completed => Some((
                    "Crew finished",
                    format!("{} — open Octopush for the story.", trim_task(&task)),
                )),
                RunStatus::Paused => Some((
                    "The crew needs you",
                    format!("{} — open Octopush to decide.", trim_task(&task)),
                )),
                // Aborted is the director's own hand — never news.
                _ => None,
            };
            if let Some((title, body)) = headline {
                notify_native(title, &body);
            }
        }
    }

    if let Err(e) = result {
        eprintln!("octopush-run-worker: drive failed: {e}");
        std::process::exit(1);
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
