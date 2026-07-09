//! Cross-machine run-history sync (Pro-real Part B / B1).
//!
//! A Pro user's TERMINAL Direct-run **metadata** is replicated to the Octopush
//! sync API so it shows up on every machine they sign in on (a read-only History
//! view). Terminal runs are immutable ⇒ append-only upsert by run id; the server
//! owns the row by the authenticated Clerk principal and never trusts the client
//! for ownership. Only metadata (task / status / cost / tokens / roles /
//! timestamps) is synced — never journals, diffs, artifacts, or prompts beyond
//! the run's own task. Everything here is **best-effort**: a failed sync never
//! affects the run itself.

use crate::db::Db;
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};

/// Production Octopush sync API (the same Vercel project as the billing webhook).
const SYNC_API_BASE: &str = "https://octopush-api.vercel.app";

/// Cap a single push batch to the server's documented limit.
pub(crate) const MAX_PUSH: usize = 500;

/// One synced run's metadata. This IS the wire + storage format — the server
/// stores the JSON blob verbatim, keyed by `run_id`, and the desktop's History
/// view renders it back. `snake_case` matches the server's `run_id`/`machine_id`
/// destructuring; every non-identity field is `#[serde(default)]` so an older
/// build can still parse a blob written by a newer one (forward-compat).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SyncRun {
    // `run_id` is the primary key — a blob without it is dropped on parse. Every
    // other field is `#[serde(default)]` so a blob written by a newer build (or a
    // slightly malformed one) still parses instead of dropping the whole run.
    pub run_id: String,
    #[serde(default)]
    pub machine_id: String,
    #[serde(default)]
    pub machine_name: Option<String>,
    #[serde(default)]
    pub workspace_name: Option<String>,
    #[serde(default)]
    pub task: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub cost_usd: f64,
    #[serde(default)]
    pub input_tokens: i64,
    #[serde(default)]
    pub output_tokens: i64,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub finished_at: Option<String>,
    #[serde(default)]
    pub stages: Vec<SyncStage>,
}

/// A compact per-stage summary — which role ran on which model, and its outcome.
/// Deliberately excludes artifacts, diffs, and feedback (kept out of the cloud).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SyncStage {
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub cost_usd: f64,
}

/// A friendly label for this machine ("MacBook Pro"), for "from …" attribution.
pub fn machine_name_label() -> String {
    sysinfo::System::host_name().unwrap_or_else(|| "Unknown machine".to_string())
}

/// Build a run's sync payload from the local DB (stages summed for tokens,
/// workspace name resolved, name attached). `machine_id` is resolved ONCE by the
/// caller and passed in — so a rare DB failure to mint it aborts the whole push
/// rather than sending rows with an empty (mis-attributing) machine id. Reads
/// only — the caller holds the DB lock for the duration.
pub fn build_run_payload(db: &Db, run: &crate::db::RunRow, machine_id: &str) -> SyncRun {
    let stages = db.list_run_stages(&run.id).unwrap_or_default();
    let input_tokens = stages.iter().map(|s| s.input_tokens).sum();
    let output_tokens = stages.iter().map(|s| s.output_tokens).sum();
    let workspace_name = db.get_workspace(&run.workspace_id).ok().flatten().map(|w| w.name);
    SyncRun {
        run_id: run.id.clone(),
        machine_id: machine_id.to_string(),
        machine_name: Some(machine_name_label()),
        workspace_name,
        task: run.task.clone(),
        status: run.status.clone(),
        cost_usd: run.cost_usd,
        input_tokens,
        output_tokens,
        created_at: run.created_at.clone(),
        finished_at: run.finished_at.clone(),
        stages: stages
            .iter()
            .map(|s| SyncStage {
                role: s.role.clone(),
                model: Some(s.agent_model.clone()),
                status: s.status.clone(),
                cost_usd: s.cost_usd,
            })
            .collect(),
    }
}

/// POST a batch of runs to the sync API. **Best-effort**: logs and returns on any
/// error (signed-out, network, non-2xx). A failed sync must never surface to the
/// run. The batch is capped at [`MAX_PUSH`]; the server upserts by run id so a
/// re-push of an already-synced terminal run is a harmless no-op.
pub async fn push_runs(client: &reqwest::Client, runs: Vec<SyncRun>) {
    if runs.is_empty() {
        return;
    }
    let Some(token) = crate::auth::current_access_token().await else {
        return; // signed out / no valid token → skip silently
    };
    let batch: Vec<SyncRun> = runs.into_iter().take(MAX_PUSH).collect();
    let count = batch.len();
    let body = serde_json::json!({ "runs": batch });
    let url = format!("{SYNC_API_BASE}/api/sync-runs");
    match client.post(&url).bearer_auth(token).json(&body).send().await {
        Ok(resp) if resp.status().is_success() => {
            tracing::debug!("history sync: pushed {count} run(s)");
        }
        Ok(resp) => tracing::warn!("history sync push failed: HTTP {}", resp.status()),
        Err(e) => tracing::warn!("history sync push error: {e}"),
    }
}

/// GET the signed-in user's full run history from the sync API. Parses leniently
/// — any blob this build can't read is skipped (forward/back compat) rather than
/// failing the whole pull.
pub async fn pull_runs(client: &reqwest::Client) -> AppResult<Vec<SyncRun>> {
    let token = crate::auth::current_access_token()
        .await
        .ok_or_else(|| AppError::Other("not signed in".into()))?;
    let url = format!("{SYNC_API_BASE}/api/sync-runs");
    let resp = client
        .get(&url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| AppError::Other(format!("history sync pull failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(AppError::Other(format!(
            "history sync pull failed: HTTP {}",
            resp.status()
        )));
    }
    #[derive(Deserialize)]
    struct PullResp {
        #[serde(default)]
        runs: Vec<serde_json::Value>,
    }
    let parsed: PullResp = resp
        .json()
        .await
        .map_err(|e| AppError::Other(format!("history sync pull decode failed: {e}")))?;
    let runs = parsed
        .runs
        .into_iter()
        .filter_map(|v| serde_json::from_value::<SyncRun>(v).ok())
        .collect();
    Ok(runs)
}
