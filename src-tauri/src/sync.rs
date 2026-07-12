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

// ─── B2: the heavy per-run detail (journals · artifacts · diffs) ────────────

/// Caps applied when BUILDING a detail payload (the server backstops at 1.5MB
/// per blob). Journals dominate volume, so they get per-stage entry AND byte
/// budgets; artifacts and diffs are head+tail capped like dossier sections.
const JOURNAL_ENTRIES_PER_STAGE: usize = 200;
const JOURNAL_BYTES_PER_STAGE: usize = 48_000;
const ARTIFACT_CAP_CHARS: usize = 16_000;
const DIFF_CAP_CHARS: usize = 96_000;

/// One synced run's full story: per-stage journals, artifact texts, and diff
/// snapshots. Pushed ONCE when the run turns terminal; fetched lazily when the
/// user opens the run in History on another machine. Same wire discipline as
/// [`SyncRun`]: snake_case, `run_id` is the only required field, everything
/// else `#[serde(default)]` for forward/back compat. Rendered as INERT TEXT.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SyncRunDetail {
    pub run_id: String,
    #[serde(default)]
    pub stages: Vec<SyncStageDetail>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SyncStageDetail {
    #[serde(default)]
    pub position: i64,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub cost_usd: f64,
    #[serde(default)]
    pub error: Option<String>,
    /// The stage artifact's human-readable text (plan/review/summary), capped.
    #[serde(default)]
    pub artifact: Option<String>,
    /// The persisted work journal — LiveEntry-shaped JSON values plus
    /// `{kind:"reset"}` markers, passed through verbatim (capped). The
    /// receiving view renders known kinds as inert text and skips the rest.
    #[serde(default)]
    pub journal: Vec<serde_json::Value>,
    /// The worktree diff snapshot as this stage left it, capped.
    #[serde(default)]
    pub diff: Option<String>,
}

/// Head+tail cap on char boundaries — intent and conclusions survive,
/// boilerplate middles drop (the dossier `cap_section` convention).
fn cap_str(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let head_budget = max * 3 / 4;
    let tail_budget = max - head_budget;
    let mut head_end = head_budget.min(s.len());
    while !s.is_char_boundary(head_end) {
        head_end -= 1;
    }
    let mut tail_start = s.len() - tail_budget;
    while !s.is_char_boundary(tail_start) {
        tail_start += 1;
    }
    format!(
        "{}\n… [truncated for sync — beginning and end preserved] …\n{}",
        &s[..head_end],
        &s[tail_start..]
    )
}

/// One journal entry's own text budget. Entries are persisted UNCAPPED (a
/// plan/report stage's final message can exceed the whole per-stage budget),
/// so without a per-entry cap one oversized newest line would empty the
/// journal (the budget loop broke on it before admitting anything).
const JOURNAL_ENTRY_TEXT_CAP: usize = 6_000;

/// Serialized whole-payload budget, under the server's 1.5MB backstop with
/// headroom for JSON string-escaping inflation. Enforced by degradation
/// (oldest diffs drop first, then oldest journals) — a many-stage run must
/// arrive trimmed, never be 413'd into silent loss.
const DETAIL_TOTAL_BUDGET: usize = 1_200_000;

/// Build ONE stage's detail from its row + raw journal lines. Pure — no DB
/// access — so the caller can read each stage's journal under its own short
/// lock and do all the string work outside (the global DB mutex must stay
/// short: every live run://log line of every other run takes it).
pub fn build_stage_detail(s: &crate::db::RunStageRow, raw_log: Vec<String>) -> SyncStageDetail {
    // Journal: newest entries win the budget (the tail explains the outcome);
    // oversized text entries are truncated rather than sinking the whole
    // journal; malformed lines are skipped WITHOUT consuming an entry slot.
    let mut journal: Vec<serde_json::Value> = Vec::new();
    let mut bytes = 0usize;
    for line in raw_log.iter().rev() {
        if journal.len() >= JOURNAL_ENTRIES_PER_STAGE {
            break;
        }
        let Ok(mut v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue; // malformed — skip, don't burn an entry slot
        };
        // Cap the entry's own text so no single line can dominate (or, worse,
        // exceed) the per-stage budget.
        if let Some(text) = v.get("text").and_then(|t| t.as_str()) {
            if text.len() > JOURNAL_ENTRY_TEXT_CAP {
                let capped = cap_str(text, JOURNAL_ENTRY_TEXT_CAP);
                v["text"] = serde_json::Value::String(capped);
            }
        }
        let size = v.to_string().len();
        if bytes + size > JOURNAL_BYTES_PER_STAGE {
            break; // older entries only from here — the budget is spent
        }
        bytes += size;
        journal.push(v);
    }
    journal.reverse(); // back to chronological order

    // Artifact: the human-readable text inside the StageArtifact JSON;
    // a legacy/opaque artifact falls back to its raw (capped) form.
    let artifact = s.artifact.as_deref().map(|json| {
        let text = serde_json::from_str::<crate::orchestrator::types::StageArtifact>(json)
            .map(|a| a.text)
            .unwrap_or_else(|_| json.to_string());
        cap_str(&text, ARTIFACT_CAP_CHARS)
    });

    SyncStageDetail {
        position: s.position,
        role: s.role.clone(),
        model: Some(s.agent_model.clone()),
        status: s.status.clone(),
        cost_usd: s.cost_usd,
        error: s.error.as_deref().map(|e| cap_str(e, 2_000)),
        artifact,
        journal,
        diff: s.diff_snapshot.as_deref().map(|d| cap_str(d, DIFF_CAP_CHARS)),
    }
}

/// Enforce the whole-payload budget by degradation, never by silent loss at
/// the server: drop diffs oldest-first, then journals oldest-first, then
/// artifacts oldest-first. The story survives trimmed; the 413 path is only
/// ever a backstop for a hostile client.
pub fn enforce_detail_budget(detail: &mut SyncRunDetail) {
    fn size(d: &SyncRunDetail) -> usize {
        serde_json::to_string(d).map(|s| s.len()).unwrap_or(usize::MAX)
    }
    if size(detail) <= DETAIL_TOTAL_BUDGET {
        return;
    }
    for i in 0..detail.stages.len() {
        if detail.stages[i].diff.take().is_some() && size(detail) <= DETAIL_TOTAL_BUDGET {
            return;
        }
    }
    for i in 0..detail.stages.len() {
        detail.stages[i].journal.clear();
        if size(detail) <= DETAIL_TOTAL_BUDGET {
            return;
        }
    }
    for i in 0..detail.stages.len() {
        if detail.stages[i].artifact.take().is_some() && size(detail) <= DETAIL_TOTAL_BUDGET {
            return;
        }
    }
}

/// POST a run's detail blob. **Best-effort** — logs and returns on any error;
/// the run (and its already-pushed metadata) are never affected.
pub async fn push_run_detail(client: &reqwest::Client, detail: SyncRunDetail) {
    let Some(token) = crate::auth::current_access_token().await else {
        return; // signed out → skip silently
    };
    let body = serde_json::json!({ "run_id": detail.run_id, "data": detail });
    let url = format!("{SYNC_API_BASE}/api/sync-run-detail");
    match client.post(&url).bearer_auth(token).json(&body).send().await {
        Ok(resp) if resp.status().is_success() => {
            tracing::debug!("history sync: pushed run detail");
        }
        Ok(resp) => tracing::warn!("history sync detail push failed: HTTP {}", resp.status()),
        Err(e) => tracing::warn!("history sync detail push error: {e}"),
    }
}

/// GET one run's detail. `Ok(None)` when the server has none (a run synced
/// before B2, or whose detail push failed) — the view says so honestly.
pub async fn pull_run_detail(
    client: &reqwest::Client,
    run_id: &str,
) -> AppResult<Option<SyncRunDetail>> {
    let token = crate::auth::current_access_token()
        .await
        .ok_or_else(|| AppError::Other("not signed in".into()))?;
    let url = format!("{SYNC_API_BASE}/api/sync-run-detail");
    let resp = client
        .get(&url)
        .query(&[("run_id", run_id)])
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| AppError::Other(format!("history detail fetch failed: {e}")))?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(AppError::Other(format!(
            "history detail fetch failed: HTTP {}",
            resp.status()
        )));
    }
    #[derive(Deserialize)]
    struct DetailResp {
        detail: serde_json::Value,
    }
    let parsed: DetailResp = resp
        .json()
        .await
        .map_err(|e| AppError::Other(format!("history detail decode failed: {e}")))?;
    // Lenient parse — an unreadable blob is "no detail", not a hard failure.
    Ok(serde_json::from_value::<SyncRunDetail>(parsed.detail).ok())
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
