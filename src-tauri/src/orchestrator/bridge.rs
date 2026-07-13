//! The detached-run bridge — the DB as the event transport.
//!
//! A detached run is driven by `octopush-run-worker` in another process,
//! whose orchestrator has a null live sink: nothing it does reaches this
//! app's WebView directly. But every meaningful signal is already PERSISTED
//! before (or instead of) being emitted — status and stages by the drive,
//! cost by `set_run_cost`, the journal by `PersistingSink` → `stage_log`.
//! This bridge watches leased runs on a ~1.2s tick and re-emits the exact
//! `run://*` events the in-process drive would have emitted, so the entire
//! frontend — runs tray, Mission Control, the live journal, crew
//! notifications — works for detached runs unchanged.
//!
//! It also repairs runs whose worker died mid-segment (stale heartbeat →
//! the standard interrupted/Resume flow plus a needs-you ping), and fires
//! the history sync when a detached run finishes while the app is open —
//! the worker itself never touches the keychain (see `Orchestrator::headless`).

use std::time::Duration;

use crate::error::AppResult;

use super::Orchestrator;

/// Bridge cadence. Fast enough that a detached run feels live (journal
/// entries land within about a second), slow enough to be invisible — a
/// handful of indexed SELECTs per tick, none when nothing is leased.
const TICK_MS: u64 = 1200;

/// On adopting an already-running lease (app relaunch mid-segment), replay at
/// most this many trailing journal rows of the current attempt — enough to
/// refill the live pane without flooding the WebView after a long absence.
const REPLAY_CAP: usize = 200;

/// Per-run bridge state: where the journal tail is, and the last snapshot
/// emitted (dedupes stage-update / cost events between ticks).
pub struct Watch {
    cursor: i64,
    status: String,
    cost_usd: f64,
    baseline_usd: f64,
    stage_sig: String,
    /// Set on adoption (a lease discovered rather than spawned by this
    /// process): replay the current attempt's journal tail once, so the live
    /// pane isn't empty after a relaunch.
    replay: bool,
}

impl Orchestrator {
    /// Spawn the background watcher. Called once at app setup; idles cheaply
    /// (one indexed SELECT per tick) whenever nothing is leased.
    pub fn spawn_detached_bridge(self: std::sync::Arc<Self>) {
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(TICK_MS)).await;
                if let Err(e) = self.bridge_tick() {
                    tracing::warn!(error = %e, "detached bridge tick failed");
                }
            }
        });
    }

    /// Called by the spawn path the moment a worker launches: start the
    /// journal tail at the CURRENT end of the run's log, so the first tick
    /// replays exactly the new segment's entries — no more, no less.
    pub(crate) fn prime_detached_watch(&self, run_id: &str) {
        let cursor = self.db.lock().last_run_log_id(run_id).unwrap_or(0);
        let Some((status, cost_usd, baseline_usd, stage_sig)) = self.run_snapshot(run_id) else {
            return;
        };
        self.bridge_watch.lock().insert(
            run_id.to_string(),
            Watch { cursor, status, cost_usd, baseline_usd, stage_sig, replay: false },
        );
    }

    fn bridge_tick(&self) -> AppResult<()> {
        // 1. Repair runs whose worker died mid-segment (stale heartbeat) —
        //    they land in the standard interrupted/Resume shape, and the
        //    checkpoint ping tells the director the crew stopped.
        let repaired = self.db.lock().reconcile_stale_leases()?;
        for run_id in &repaired {
            let _ = self.flush_log_tail(run_id);
            self.bridge_watch.lock().remove(run_id);
            self.emit_run_update(run_id);
            let stages = self.db.lock().list_run_stages(run_id)?;
            if let Some(s) = stages
                .iter()
                .find(|s| s.status == "failed" || s.status == "awaiting_checkpoint")
            {
                self.emit_checkpoint(run_id, &s.id, "decision");
            }
            tracing::warn!(run_id = %run_id, "detached worker died — run repaired");
        }

        let leased = self.db.lock().list_leased_run_ids()?;
        let watched: Vec<String> = self.bridge_watch.lock().keys().cloned().collect();

        // 2. Adopt leases this process didn't spawn (app relaunched while a
        //    worker was mid-flight).
        for run_id in &leased {
            if !watched.contains(run_id) {
                self.adopt_watch(run_id);
            }
        }

        // 3. Leases that ENDED since the last tick: the worker exited — flush
        //    the journal, emit the final state, announce the park/finish.
        for run_id in &watched {
            if !leased.contains(run_id) && !repaired.contains(run_id) {
                self.finish_watch(run_id)?;
            }
        }

        // 4. Live diff for every still-leased run.
        for run_id in &leased {
            self.tick_watch(run_id)?;
        }
        Ok(())
    }

    /// One live tick for a leased run: replay-on-adopt (once), tail the
    /// journal, and emit stage-update / cost only when something changed.
    fn tick_watch(&self, run_id: &str) -> AppResult<()> {
        let needs_replay = {
            let mut watches = self.bridge_watch.lock();
            match watches.get_mut(run_id) {
                Some(w) if w.replay => {
                    w.replay = false;
                    true
                }
                Some(_) => false,
                None => return Ok(()),
            }
        };
        if needs_replay {
            self.replay_current_attempt(run_id)?;
            // Advance the cursor past everything replay could have covered:
            // adopt seated the cursor at the log's end at the START of this
            // tick, but a foreign-process worker write can land between that
            // read and replay's stage-log read — such a row would then be
            // emitted twice (once by replay, once by the flush below on
            // `id > cursor`). Re-seating at the current MAX closes that gap.
            let max = self.db.lock().last_run_log_id(run_id).unwrap_or(0);
            if let Some(w) = self.bridge_watch.lock().get_mut(run_id) {
                w.cursor = w.cursor.max(max);
            }
        }
        self.flush_log_tail(run_id)?;

        let Some((status, cost_usd, baseline_usd, stage_sig)) = self.run_snapshot(run_id) else {
            return Ok(());
        };
        let (state_changed, cost_changed) = {
            let mut watches = self.bridge_watch.lock();
            let Some(w) = watches.get_mut(run_id) else { return Ok(()) };
            let state_changed = w.status != status || w.stage_sig != stage_sig;
            let cost_changed = w.cost_usd != cost_usd || w.baseline_usd != baseline_usd;
            w.status = status;
            w.stage_sig = stage_sig;
            w.cost_usd = cost_usd;
            w.baseline_usd = baseline_usd;
            (state_changed, cost_changed)
        };
        if state_changed {
            self.emit_run_update(run_id);
        }
        if cost_changed {
            self.emit_cost(run_id, cost_usd, baseline_usd);
        }
        Ok(())
    }

    /// The worker exited cleanly: flush what's left of the journal, drop the
    /// watch, and emit the segment's outcome — including the checkpoint ping
    /// an in-process drive would have fired at the park.
    fn finish_watch(&self, run_id: &str) -> AppResult<()> {
        self.flush_log_tail(run_id)?;
        self.bridge_watch.lock().remove(run_id);
        let Some(run) = self.db.lock().get_run(run_id)? else { return Ok(()) };
        // A worker that cleared its lease while the run was still `running`
        // did NOT settle it — its `drive_segment` returned a hard infra error
        // the null-sink worker couldn't surface (the in-process path emits
        // `run://error` here; the worker can't). Repair it into the
        // interrupted/Resume shape so it never sits "running" with no driver,
        // then fall through to announce the resulting park.
        let run = if run.status == "running" {
            self.db.lock().repair_interrupted_run(run_id)?;
            tracing::warn!(run_id = %run_id, "detached worker exited without settling — run repaired");
            match self.db.lock().get_run(run_id)? {
                Some(r) => r,
                None => return Ok(()),
            }
        } else {
            run
        };
        self.emit_run_update(run_id);
        self.emit_cost(run_id, run.cost_usd, run.baseline_usd);
        match run.status.as_str() {
            // The worker never syncs history (keychain is app-only); the
            // server upserts by run id, so a re-fire is harmless.
            "completed" | "aborted" => self.sync_run_history(run_id),
            "paused" => {
                let stages = self.db.lock().list_run_stages(run_id)?;
                if let Some(s) = stages
                    .iter()
                    .find(|s| s.status == "awaiting_checkpoint" || s.status == "failed")
                {
                    let reason = if self.director_pauses.lock().remove(run_id) {
                        "director"
                    } else {
                        "decision"
                    };
                    self.emit_checkpoint(run_id, &s.id, reason);
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// Start watching a lease this process didn't spawn. The cursor starts at
    /// the journal's current end (history is hydrated from `stage_log` by the
    /// UI, not replayed as events) — except the running stage's current
    /// attempt, which replays once so the live pane has its story.
    fn adopt_watch(&self, run_id: &str) {
        let cursor = self.db.lock().last_run_log_id(run_id).unwrap_or(0);
        let Some((status, cost_usd, baseline_usd, stage_sig)) = self.run_snapshot(run_id) else {
            return;
        };
        self.bridge_watch.lock().insert(
            run_id.to_string(),
            Watch { cursor, status, cost_usd, baseline_usd, stage_sig, replay: true },
        );
        tracing::info!(run_id = %run_id, "adopted a live detached run from a previous app session");
    }

    /// Replay the running stage's current attempt (entries after its last
    /// reset marker, capped) as live events, preceded by a reset so stale
    /// pane content clears.
    fn replay_current_attempt(&self, run_id: &str) -> AppResult<()> {
        let stages = self.db.lock().list_run_stages(run_id)?;
        let Some(running) = stages.iter().find(|s| s.status == "running") else {
            return Ok(());
        };
        let rows = self.db.lock().list_stage_log(&running.id)?;
        let after_marker = rows
            .iter()
            .rposition(|e| entry_is_reset(e))
            .map(|i| i + 1)
            .unwrap_or(0);
        let start = after_marker.max(rows.len().saturating_sub(REPLAY_CAP));
        self.raw_events.emit(
            crate::orchestrator::live::RUN_LOG_EVENT,
            serde_json::json!({ "runId": run_id, "stageId": running.id, "reset": true }),
        );
        for entry in &rows[start..] {
            self.emit_bridged_log(run_id, &running.id, entry);
        }
        Ok(())
    }

    /// Emit every journal row past the cursor and advance it.
    fn flush_log_tail(&self, run_id: &str) -> AppResult<()> {
        let Some(cursor) = self.bridge_watch.lock().get(run_id).map(|w| w.cursor) else {
            return Ok(());
        };
        let rows = self.db.lock().list_run_log_after(run_id, cursor)?;
        let Some(last) = rows.last().map(|r| r.0) else { return Ok(()) };
        for (_, stage_id, entry) in &rows {
            self.emit_bridged_log(run_id, stage_id, entry);
        }
        if let Some(w) = self.bridge_watch.lock().get_mut(run_id) {
            w.cursor = w.cursor.max(last);
        }
        Ok(())
    }

    /// Re-emit one persisted journal row as a live event — through the RAW
    /// sink: routing it through `PersistingSink` would write the entry to
    /// `stage_log` a second time.
    fn emit_bridged_log(&self, run_id: &str, stage_id: &str, entry_json: &str) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(entry_json) else { return };
        let payload = if v.get("kind").and_then(|k| k.as_str()) == Some("reset") {
            serde_json::json!({ "runId": run_id, "stageId": stage_id, "reset": true })
        } else {
            serde_json::json!({ "runId": run_id, "stageId": stage_id, "entry": v })
        };
        self.raw_events.emit(crate::orchestrator::live::RUN_LOG_EVENT, payload);
    }

    /// `(status, cost, baseline, stage signature)` — the change-detection
    /// snapshot. `None` when the run vanished.
    fn run_snapshot(&self, run_id: &str) -> Option<(String, f64, f64, String)> {
        let db = self.db.lock();
        let run = db.get_run(run_id).ok()??;
        let stages = db.list_run_stages(run_id).ok()?;
        drop(db);
        let sig = stages
            .iter()
            .map(|s| format!("{}:{}:{}", s.id, s.status, s.loop_iterations))
            .collect::<Vec<_>>()
            .join("|");
        Some((run.status, run.cost_usd, run.baseline_usd, sig))
    }
}

fn entry_is_reset(entry_json: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(entry_json)
        .ok()
        .and_then(|v| v.get("kind").and_then(|k| k.as_str()).map(|k| k == "reset"))
        .unwrap_or(false)
}
