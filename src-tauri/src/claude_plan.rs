//! The Claude plan snapshot: the latest `rate_limit_event` window a
//! subscription-authenticated CLI stage reported, one per window kind, kept
//! in `app_meta` (`claude_plan:<kind>`) with the moment it was seen.
//!
//! A snapshot is what the CLI said at `seen_at` — never extrapolated. The
//! UI always shows its age. No outbound traffic and no credential reads: the
//! data is what Claude Code already streams to the stage.

use crate::db::Db;
use crate::error::AppResult;
use crate::orchestrator::cli_runner::PlanWindow;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Event name: a stage reported plan windows (mirrors `PLAN_EVENT` in
/// `src/lib/ipc.ts`). Payload `{ windows: PlanWindow[] }`.
pub const PLAN_EVENT: &str = "plan://updated";

const KEY_PREFIX: &str = "claude_plan:";

/// One window as last seen.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanSnapshot {
    #[serde(flatten)]
    pub window: PlanWindow,
    /// When the stage saw it, RFC3339 UTC.
    pub seen_at: String,
}

/// Merge `incoming` into the stored window of the same kind: a field the new
/// event left out (top-level `utilization` only appears past a threshold)
/// keeps its last known value while the window has not reset.
fn merge(prev: Option<&PlanWindow>, incoming: &PlanWindow) -> PlanWindow {
    let mut w = incoming.clone();
    if let Some(p) = prev {
        let same_window = p.resets_at.is_some() && p.resets_at == w.resets_at;
        if w.utilization.is_none() && same_window {
            w.utilization = p.utilization;
        }
        if w.resets_at.is_none() {
            w.resets_at = p.resets_at;
        }
    }
    w
}

/// Store the windows of one `rate_limit_event`, stamped `seen_at`.
pub fn record(db: &Db, windows: &[PlanWindow], seen_at: &str) -> AppResult<()> {
    let mut pairs = Vec::with_capacity(windows.len());
    for incoming in windows {
        let key = format!("{KEY_PREFIX}{}", incoming.kind);
        let prev: Option<PlanSnapshot> =
            db.meta_get(&key)?.and_then(|v| serde_json::from_str(&v).ok());
        let snap = PlanSnapshot {
            window: merge(prev.as_ref().map(|p| &p.window), incoming),
            seen_at: seen_at.to_string(),
        };
        pairs.push((key, serde_json::to_string(&snap)?));
    }
    db.meta_set_many(&pairs)
}

/// Every stored window, by kind. An unreadable row is skipped.
pub fn load(db: &Db) -> AppResult<Vec<PlanSnapshot>> {
    Ok(db
        .meta_list_prefix(KEY_PREFIX)?
        .into_iter()
        .filter_map(|(_, v)| serde_json::from_str(&v).ok())
        .collect())
}

/// The windows in a `PLAN_EVENT` payload (malformed entries dropped).
pub fn windows_from_payload(payload: &Value) -> Vec<PlanWindow> {
    payload
        .get("windows")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|w| serde_json::from_value(w.clone()).ok()).collect())
        .unwrap_or_default()
}
