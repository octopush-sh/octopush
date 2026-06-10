//! `PersistingSink` — an `EventSink` decorator that mirrors every `run://log`
//! entry into the `stage_log` table, so stage journals survive app reloads
//! and loop-back resets (a reset becomes a `{"kind":"reset"}` marker row).

use crate::db::Db;
use crate::orchestrator::events::EventSink;
use crate::orchestrator::live::RUN_LOG_EVENT;
use parking_lot::Mutex;
use serde_json::Value;
use std::sync::Arc;

/// Wraps the orchestrator's sink; persists `run://log` payloads, forwards everything.
///
/// CAUTION: `emit` takes the db lock — no emit call site may hold it (today all
/// orchestrator db usages are short one-liner `self.db.lock().x()?` calls; keep it that way).
pub struct PersistingSink {
    inner: Arc<dyn EventSink>,
    db: Arc<Mutex<Db>>,
}

impl PersistingSink {
    pub fn new(inner: Arc<dyn EventSink>, db: Arc<Mutex<Db>>) -> Self {
        Self { inner, db }
    }
}

impl EventSink for PersistingSink {
    fn emit(&self, event: &str, payload: Value) {
        if event == RUN_LOG_EVENT {
            let run_id = payload.get("runId").and_then(Value::as_str);
            let stage_id = payload.get("stageId").and_then(Value::as_str);
            if let (Some(run_id), Some(stage_id)) = (run_id, stage_id) {
                let entry = if payload.get("reset").and_then(Value::as_bool) == Some(true) {
                    Some(r#"{"kind":"reset"}"#.to_string())
                } else {
                    payload.get("entry").map(Value::to_string)
                };
                if let Some(entry) = entry {
                    // Persistence must never break the run — ignore failures.
                    let _ = self.db.lock().append_stage_log(run_id, stage_id, &entry);
                }
            }
        }
        self.inner.emit(event, payload);
    }
}
