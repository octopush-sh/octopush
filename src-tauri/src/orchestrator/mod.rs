//! Direct-mode orchestration: pipelines, runs, agent runners, and the
//! checkpoint-driven run state machine.

pub mod agentic;
pub mod cli_runner;
pub mod cost;
pub mod events;
pub mod git_baseline;
pub mod live;
pub mod persist;
pub mod roles;
pub mod runner;
pub mod types;

pub use types::*;

use crate::db::{Db, RunStageRow};
use crate::error::{AppError, AppResult};
use crate::orchestrator::events::EventSink;
use crate::orchestrator::cli_runner::CliRunner;
use crate::orchestrator::runner::{ApiRunner, AgentRunner, StageContext};
use parking_lot::Mutex;
use std::path::PathBuf;
use std::sync::Arc;

/// Max bytes of worktree diff persisted per stage snapshot.
pub(crate) const DIFF_SNAPSHOT_CAP_BYTES: usize = 512 * 1024;

/// Cap diff text at [`DIFF_SNAPSHOT_CAP_BYTES`], truncating on a char boundary
/// and appending a visible marker.
pub(crate) fn cap_diff(text: &str) -> String {
    if text.len() <= DIFF_SNAPSHOT_CAP_BYTES {
        return text.to_string();
    }
    let mut end = DIFF_SNAPSHOT_CAP_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… (diff truncated)", &text[..end])
}

/// The transitive ancestors of the stage at `position`, following the recorded
/// `parents` (flow-edge) links. Excludes `position` itself. Cycle-safe (the
/// `seen` set bounds the walk) even though saved graphs are acyclic.
pub(crate) fn ancestors_of(
    stages: &[crate::db::RunStageRow],
    position: i64,
) -> std::collections::HashSet<i64> {
    use std::collections::{HashMap, HashSet, VecDeque};
    let parents: HashMap<i64, &Vec<i64>> =
        stages.iter().map(|s| (s.position, &s.parents)).collect();
    let mut seen: HashSet<i64> = HashSet::new();
    let mut queue: VecDeque<i64> = VecDeque::new();
    if let Some(ps) = parents.get(&position) {
        queue.extend(ps.iter().copied());
    }
    while let Some(p) = queue.pop_front() {
        if !seen.insert(p) {
            continue;
        }
        if let Some(ps) = parents.get(&p) {
            queue.extend(ps.iter().copied());
        }
    }
    seen
}

/// Drives runs: one stage at a time, pausing at checkpoints.
pub struct Orchestrator {
    db: Arc<Mutex<Db>>,
    events: Arc<dyn EventSink>,
    /// Test override: when set, every stage uses this runner regardless of substrate.
    test_runner: Option<Box<dyn AgentRunner>>,
    client: reqwest::Client,
    /// Set of run_ids with an in-flight drive (enforces one active drive per run).
    active: Mutex<std::collections::HashSet<String>>,
    /// Per-run cancel flags for the stage currently in flight. A FRESH flag is
    /// installed by `run_stage_once` before each stage and removed after it, so
    /// a stop only ever lands on the stage the director is watching.
    cancels: Mutex<std::collections::HashMap<String, Arc<std::sync::atomic::AtomicBool>>>,
    /// Run ids the director asked to pause. Consumed at the next stage boundary:
    /// the next pending stage is parked (awaiting_checkpoint) exactly like the
    /// budget gate, so the existing approve-a-parked-stage path resumes it.
    pause_requests: Mutex<std::collections::HashSet<String>>,
}

impl Orchestrator {
    pub fn new(db: Arc<Mutex<Db>>, events: Arc<dyn EventSink>) -> Self {
        // Mirror run://log entries into stage_log so journals survive reloads.
        let events: Arc<dyn EventSink> = Arc::new(
            crate::orchestrator::persist::PersistingSink::new(events, Arc::clone(&db)),
        );
        Self {
            db,
            events,
            test_runner: None,
            client: crate::chat_engine::shared_http_client().clone(),
            active: Mutex::new(std::collections::HashSet::new()),
            cancels: Mutex::new(std::collections::HashMap::new()),
            pause_requests: Mutex::new(std::collections::HashSet::new()),
        }
    }

    /// Test constructor: force a specific runner for every stage.
    pub fn new_with_runner(
        db: Arc<Mutex<Db>>,
        events: Arc<dyn EventSink>,
        runner: Box<dyn AgentRunner>,
    ) -> Self {
        Self {
            db,
            events,
            test_runner: Some(runner),
            client: crate::chat_engine::shared_http_client().clone(),
            active: Mutex::new(std::collections::HashSet::new()),
            cancels: Mutex::new(std::collections::HashMap::new()),
            pause_requests: Mutex::new(std::collections::HashSet::new()),
        }
    }

    fn runner_for(&self, substrate: &AgentSubstrate) -> Box<dyn AgentRunner> {
        if self.test_runner.is_some() {
            // Tests route through `run_stage_once`, which uses `self.test_runner`.
            unreachable!("runner_for must not be called when test_runner is set");
        }
        match substrate {
            AgentSubstrate::Api => Box::new(ApiRunner),
            AgentSubstrate::Cli => Box::new(CliRunner),
        }
    }

    fn emit_run_update(&self, run_id: &str) {
        // Bind before emitting: the db guard must be dropped before `emit`
        // (PersistingSink takes the same lock inside `emit`).
        let run = self.db.lock().get_run(run_id);
        match run {
            Ok(Some(run)) => self.events.emit(
                "run://stage-update",
                serde_json::json!({ "runId": run_id, "run": run }),
            ),
            Ok(None) => tracing::warn!(run_id = %run_id, "emit_run_update: run not found"),
            Err(e) => tracing::error!(run_id = %run_id, error = %e, "emit_run_update: get_run failed"),
        }
    }

    /// Fire-and-forget: replicate a just-terminal run's metadata to the cloud so
    /// it appears in the user's cross-machine History (Pro-real Part B / B1b).
    /// No-op unless the user is Pro with `history.sync`. **Never blocks the run** —
    /// builds the payload under a short DB lock, then spawns the network push, so
    /// an abort still feels instant. The server upserts by run id, so a re-fire on
    /// an already-terminal run (e.g. abort of an aborted run) is a harmless no-op.
    fn sync_run_history(&self, run_id: &str) {
        if !crate::entitlement::Entitlement::current()
            .has_feature(crate::entitlement::feature::HISTORY_SYNC)
        {
            return;
        }
        let payload = {
            let db = self.db.lock();
            match db.get_run(run_id) {
                Ok(Some(run)) => crate::sync::build_run_payload(&db, &run),
                _ => return,
            }
        };
        let client = self.client.clone();
        tokio::spawn(async move {
            crate::sync::push_runs(&client, vec![payload]).await;
        });
    }

    fn emit_cost(&self, run_id: &str, cost: f64, baseline: f64) {
        self.events.emit(
            "run://cost",
            serde_json::json!({ "runId": run_id, "costUsd": cost, "baselineUsd": baseline }),
        );
    }

    fn emit_checkpoint(&self, run_id: &str, stage_id: &str) {
        self.events.emit(
            "run://checkpoint",
            serde_json::json!({ "runId": run_id, "stageId": stage_id }),
        );
    }

    /// A just-completed stage that should pause for a human loop decision: it
    /// carries gated loop config with a target and a positive cap. (Auto mode
    /// is Plan L3.)
    fn stage_has_gated_loop(stage: &crate::db::RunStageRow) -> bool {
        stage.loop_target_position.is_some()
            && stage.loop_max_iterations > 0
            && stage.loop_mode.as_deref().and_then(crate::orchestrator::types::LoopMode::from_db)
                == Some(crate::orchestrator::types::LoopMode::Gated)
    }

    /// A just-completed stage that should be driven automatically by its verdict
    /// (auto mode): carries auto loop config with a target and a positive cap.
    fn stage_has_auto_loop(stage: &crate::db::RunStageRow) -> bool {
        stage.loop_target_position.is_some()
            && stage.loop_max_iterations > 0
            && stage.loop_mode.as_deref().and_then(crate::orchestrator::types::LoopMode::from_db)
                == Some(crate::orchestrator::types::LoopMode::Auto)
    }

    /// Reset the contiguous [target..=review] range to pending (re-running the
    /// target + intervening stages with `feedback` on the target), retiring the
    /// erased cost and bumping the loop counter. Shared by gated SendBack and the
    /// auto loop. Caller guarantees `review` has a valid `loop_target_position`
    /// strictly before `review.position` and iterations remaining.
    fn loop_back(&self, run_id: &str, review: &crate::db::RunStageRow, feedback: Option<&str>) -> AppResult<()> {
        let target_pos = review.loop_target_position.expect("loop_back requires a target");
        let stages = self.db.lock().list_run_stages(run_id)?;
        // In an authored graph the [target..=review] position window can span a
        // sibling branch that doesn't feed the review; resetting it would wipe
        // valid, unrelated work. Restrict the re-run to the review's own lineage
        // (its ancestors) plus the review itself. A legacy linear run has no
        // recorded parents (ancestors are empty), so it keeps the original
        // full-contiguous reset — every stage in the window is on the path.
        let authored = stages.iter().any(|s| !s.parents.is_empty());
        let on_path = if authored { Some(ancestors_of(&stages, review.position)) } else { None };
        for s in &stages {
            let in_window = s.position >= target_pos && s.position <= review.position;
            let feeds_review = match &on_path {
                Some(anc) => s.id == review.id || anc.contains(&s.position),
                None => true,
            };
            if in_window && feeds_review {
                // Archive the attempt before the reset wipes it. Pending/unstarted
                // stages (no artifact, no error) aren't attempts. The feedback that
                // closed the iteration is recorded on the review row only.
                if s.artifact.is_some() || s.error.is_some() {
                    let cf = if s.id == review.id { feedback } else { None };
                    self.db.lock().archive_stage_attempt(s, cf)?;
                }
                self.db.lock().retire_stage_cost(run_id, s.cost_usd, s.input_tokens, s.output_tokens)?;
                let fb = if s.position == target_pos { feedback } else { None };
                self.db.lock().reset_run_stage(&s.id, None, fb)?;
            }
        }
        self.db.lock().increment_loop_iteration(&review.id)?;
        self.recompute_run_cost(run_id)?;
        Ok(())
    }

    /// Salvage the model's narration from a halted stage's CURRENT journal
    /// segment (text entries after the last reset marker). A halted plan/review
    /// stage never persisted an artifact, but its journal usually carries the
    /// partial work — without this, "Accept & continue" would hand the next
    /// stage an empty stub and the pipeline would lose everything the stage
    /// said before the halt. Best-effort: `None` when nothing useful exists.
    fn salvage_journal_text(&self, stage_id: &str) -> Option<String> {
        let raw = self.db.lock().list_stage_log(stage_id).ok()?;
        let mut texts: Vec<String> = Vec::new();
        for entry in &raw {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(entry) else { continue };
            match v.get("kind").and_then(|k| k.as_str()) {
                // A reset marks the start of a fresh attempt — drop older narration.
                Some("reset") => texts.clear(),
                Some("text") => {
                    if let Some(t) = v.get("text").and_then(|t| t.as_str()) {
                        if !t.trim().is_empty() {
                            texts.push(t.to_string());
                        }
                    }
                }
                _ => {}
            }
        }
        if texts.is_empty() {
            return None;
        }
        Some(crate::orchestrator::runner::cap_section(&texts.join("\n")))
    }

    fn workspace_path(&self, run: &crate::db::RunRow) -> AppResult<PathBuf> {
        let path: Option<String> = self.db.lock().conn_ref_path(&run.workspace_id)?;
        path.map(PathBuf::from)
            .ok_or_else(|| AppError::Other("workspace has no worktree_path".into()))
    }

    /// Best-effort: persist the worktree diff onto a just-finished stage, so the
    /// focus pane can show the worktree as THIS stage left it instead of the
    /// live (still-mutating) one. The snapshot is forensic, never load-bearing —
    /// any capture failure is logged and swallowed, and an empty diff is skipped.
    fn capture_stage_diff_snapshot(&self, run: &crate::db::RunRow, stage_id: &str) {
        let result: AppResult<()> = (|| {
            let path = self.workspace_path(run)?;
            let diff = crate::git_ops::get_diff_text(&path, false)?;
            let capped = cap_diff(&diff);
            if !capped.is_empty() {
                self.db.lock().set_stage_diff_snapshot(stage_id, &capped)?;
            }
            Ok(())
        })();
        if let Err(e) = result {
            tracing::warn!(stage_id = %stage_id, "diff snapshot capture failed: {e}");
        }
    }

    /// Append a terminal entry to the stage's work journal so the journal
    /// explains the halt instead of just stopping mid-action. Persisted AND
    /// emitted live (best-effort — a journal write must never mask the failure).
    fn record_halt(&self, run_id: &str, stage_id: &str, error: &str) {
        let first = error.lines().next().unwrap_or("stage halted").trim();
        let entry = serde_json::json!({ "kind": "notice", "text": format!("⏹ Stage halted — {first}") });
        let json = entry.to_string();
        if let Err(e) = self.db.lock().append_stage_log(run_id, stage_id, &json) {
            tracing::warn!(stage_id = %stage_id, "halt journal write failed: {e}");
        }
        self.events.emit(
            crate::orchestrator::live::RUN_LOG_EVENT,
            serde_json::json!({ "runId": run_id, "stageId": stage_id, "entry": entry }),
        );
    }

    /// Execute one stage and persist its outcome + cost/baseline.
    async fn run_stage_once(
        &self,
        run: &crate::db::RunRow,
        stage: &RunStageRow,
    ) -> AppResult<(StageStatus, Option<ReviewVerdict>)> {
        let substrate = match AgentSubstrate::from_db(&stage.substrate) {
            Some(s) => s,
            None => {
                self.db.lock().fail_run_stage(
                    &stage.id,
                    &format!("unknown substrate '{}'", stage.substrate),
                )?;
                self.record_halt(&run.id, &stage.id, &format!("unknown substrate '{}'", stage.substrate));
                return Ok((StageStatus::Failed, None));
            }
        };
        let role_def = match self.db.lock().get_role(&stage.role) {
            Ok(Some(rd)) => rd,
            Ok(None) => {
                let msg = format!("unknown role '{}'", stage.role);
                let _ = self.db.lock().fail_run_stage(&stage.id, &msg);
                self.record_halt(&run.id, &stage.id, &msg);
                return Ok((StageStatus::Failed, None));
            }
            Err(_) => {
                let msg = format!("could not resolve role '{}'", stage.role);
                let _ = self.db.lock().fail_run_stage(&stage.id, &msg);
                self.record_halt(&run.id, &stage.id, &msg);
                return Ok((StageStatus::Failed, None));
            }
        };
        let spec = StageSpec {
            position: stage.position,
            role: stage.role.clone(),
            agent_model: stage.agent_model.clone(),
            substrate,
            checkpoint: stage.checkpoint,
            feedback: stage.feedback.clone(),
            loop_target: stage.loop_target_position,
            loop_max: stage.loop_max_iterations,
            loop_mode: stage.loop_mode.as_deref().and_then(crate::orchestrator::types::LoopMode::from_db),
            loop_iterations: stage.loop_iterations,
            max_iterations: stage.max_iterations,
            tools: stage.tools.clone(),
            instructions: stage.instructions.clone(),
            resume_session: if stage.resume_pending { stage.session_id.clone() } else { None },
            stage_id: stage.id.clone(),
            role_prompt: role_def.prompt_body,
            role_environment: role_def.environment,
            artifact_kind: role_def.artifact_kind,
        };

        // Clear resume_pending once the run starts so a second re-run is always fresh.
        if stage.resume_pending {
            self.db.lock().set_stage_resume_pending(&stage.id, false)?;
        }

        // Input dossier = the freshest artifact of each kind from earlier stages.
        let input = self.assemble_stage_input(&run.id, stage.position)?;

        self.db.lock().set_run_stage_status(&stage.id, "running")?;
        // Reset any prior live log for this stage (re-runs reuse the same id).
        self.events.emit(
            crate::orchestrator::live::RUN_LOG_EVENT,
            serde_json::json!({ "runId": run.id, "stageId": stage.id, "reset": true }),
        );
        self.emit_run_update(&run.id);

        // Snapshot the worktree NOW so a later Discard reverts only this stage's
        // edits. Best-effort & forensic: a capture failure never blocks the run.
        if let Ok(ws) = self.workspace_path(run) {
            match crate::orchestrator::git_baseline::capture_baseline(&ws) {
                Ok(Some(sha)) => { let _ = self.db.lock().set_stage_baseline(&stage.id, Some(&sha)); }
                Ok(None) => {}
                Err(e) => tracing::warn!(stage_id = %stage.id, "baseline capture failed: {e}"),
            }
        }

        // Install a FRESH cancel flag for this run before the stage starts —
        // `stop_current_stage`/`abort_run` set it to interrupt in-flight work.
        let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
        self.cancels.lock().insert(run.id.clone(), Arc::clone(&cancel));

        // Build the context and run the agent. ANY hard error here (missing worktree,
        // unresolved provider, unavailable CLI substrate) is converted into a failed
        // stage so the run converges to a clean paused/recoverable state instead of
        // stranding the stage in "running".
        let run_result: AppResult<StageOutcome> = async {
            let ctx = StageContext {
                workspace_path: self.workspace_path(run)?,
                task: run.task.clone(),
                client: self.client.clone(),
                events: Arc::clone(&self.events),
                run_id: run.id.clone(),
                stage_id: stage.id.clone(),
                cancel,
            };
            match &self.test_runner {
                Some(r) => r.run(&spec, &input, &ctx).await,
                None => self.runner_for(&spec.substrate).run(&spec, &input, &ctx).await,
            }
        }
        .await;

        // The stage is no longer in flight — a stop after this point is a no-op.
        self.cancels.lock().remove(&run.id);

        let outcome = match run_result {
            Ok(o) => o,
            Err(e) => {
                let err_str = e.to_string();
                self.db.lock().fail_run_stage(&stage.id, &err_str)?;
                self.record_halt(&run.id, &stage.id, &err_str);
                return Ok((StageStatus::Failed, None));
            }
        };

        match outcome.status {
            StageStatus::Done => {
                // Always persist on Done: Some updates to the new session, None
                // clears any stale one (a completed stage is never resumed).
                self.db.lock().set_stage_session(&stage.id, outcome.session_id.as_deref())?;
                let verdict = outcome.verdict.clone();
                let artifact_json = serde_json::to_string(&outcome.artifact)?;
                self.db.lock().complete_run_stage(
                    &stage.id,
                    "done",
                    outcome.input_tokens as i64,
                    outcome.output_tokens as i64,
                    outcome.cost_usd,
                    Some(&artifact_json),
                )?;
                // Snapshot only code-bearing artifacts: snapshotting every
                // stage would duplicate the cumulative diff (up to 512KB) onto
                // plan/review rows that produced no code.
                if outcome.artifact.refs_worktree {
                    self.capture_stage_diff_snapshot(run, &stage.id);
                }
                self.recompute_run_cost(&run.id)?;
                Ok((StageStatus::Done, verdict))
            }
            _ => {
                // Persist session_id when Some: on a normal failure with a session
                // we want to keep it so the user can Resume. When None (e.g. an
                // idle/cancel stop that produced no session) we leave the existing
                // id intact — it may still be valid for a future Resume.
                if outcome.session_id.is_some() {
                    self.db.lock().set_stage_session(&stage.id, outcome.session_id.as_deref())?;
                }
                // Read before outcome.error is (partially) moved below.
                let outcome_no_new_session = outcome.session_id.is_none();
                let err = outcome.error.unwrap_or_else(|| "stage failed".into());
                // Persist whatever usage the failed attempt burned (e.g. an
                // iteration-capped agentic loop) so run cost stays truthful,
                // then mark the failure. Reset-on-rerun retires it as usual.
                if outcome.cost_usd > 0.0 || outcome.input_tokens > 0 || outcome.output_tokens > 0 {
                    self.db.lock().complete_run_stage(
                        &stage.id,
                        "failed",
                        outcome.input_tokens as i64,
                        outcome.output_tokens as i64,
                        outcome.cost_usd,
                        None,
                    )?;
                    self.recompute_run_cost(&run.id)?;
                }
                self.db.lock().fail_run_stage(&stage.id, &err)?;
                self.record_halt(&run.id, &stage.id, &err);
                // A resume attempt that produced no new session likely hit a
                // dead/expired session — clear it so the next recovery re-runs
                // fresh instead of looping on `--resume <dead id>`.
                if stage.resume_pending && outcome_no_new_session {
                    let _ = self.db.lock().set_stage_session(&stage.id, None);
                }
                // A failed stage may still have touched the worktree — keep the
                // evidence (best-effort; empty diffs are skipped internally).
                self.capture_stage_diff_snapshot(run, &stage.id);
                Ok((StageStatus::Failed, None))
            }
        }
    }

    /// Assemble a stage's input dossier: for each artifact kind, the FRESHEST
    /// artifact produced by an earlier stage (later positions supersede earlier
    /// ones of the same kind), in pipeline order — plus a one-line breadcrumb of
    /// the whole run. This is what fixes the one-hop shadowing problem: with
    /// Plan → Plan review → Implement, the implementer now receives BOTH the
    /// refined plan (kind Plan) and the review's verdict (kind Review), instead
    /// of only whatever ran immediately before it. Token cost stays bounded:
    /// one section per kind at most, each capped at render time, and superseded
    /// or looped-over attempts (artifact = NULL after a reset) never ride along.
    fn assemble_stage_input(&self, run_id: &str, position: i64) -> AppResult<StageInput> {
        let stages = self.db.lock().list_run_stages(run_id)?;

        // Which earlier stages feed THIS one? With an authored graph, a stage's
        // working context is its transitive ancestors — the branch that leads
        // to it — so a sibling branch never leaks into its prompt and a join
        // node sees the freshest artifacts from its upstream branches. A legacy
        // run (NO stage records any `parents`) falls back to "every earlier
        // stage", preserving the original linear behavior byte-for-byte.
        //
        // The authored/legacy choice is made once at the RUN level, not per
        // stage: in an authored graph a parentless node is a genuine ENTRY and
        // must feed from nothing, never from "everything before it" — otherwise
        // a second independent root would silently inherit the first root's
        // branch. The breadcrumb below still maps the whole run for orientation.
        let authored = stages.iter().any(|s| !s.parents.is_empty());
        let ancestor_filter: Option<std::collections::HashSet<i64>> =
            if authored { Some(ancestors_of(&stages, position)) } else { None };
        let feeds = |p: i64| match &ancestor_filter {
            Some(set) => set.contains(&p),
            None => p < position,
        };

        // Freshest artifact per kind among the stages that feed `position`.
        // `stages` is position-ordered, so a plain overwrite keeps the latest.
        // The worktree flag is OR'd across ALL feeding artifacts, not just
        // retained sections — an empty-text code artifact still means "changes
        // on disk". NOTE: the dossier is bounded to one section per kind, so a
        // join fed by two same-kind branches (e.g. two reviews) keeps only the
        // later one — the deliberate token-cost ceiling, not a per-branch fan-in.
        let mut latest: std::collections::HashMap<&'static str, InputSection> =
            std::collections::HashMap::new();
        let mut refs_worktree = false;
        for s in stages.iter().filter(|s| feeds(s.position)) {
            let Some(json) = &s.artifact else { continue };
            let Ok(a) = serde_json::from_str::<StageArtifact>(json) else { continue };
            refs_worktree |= a.refs_worktree;
            // An empty-text artifact must never EVICT an older, non-empty
            // section of the same kind (e.g. a fix stage whose final message
            // was empty would otherwise erase implement's summary).
            if a.text.trim().is_empty() {
                continue;
            }
            let key = match a.kind {
                ArtifactKind::Plan => "plan",
                ArtifactKind::Review => "review",
                ArtifactKind::Tests => "tests",
                ArtifactKind::Diff => "diff",
                ArtifactKind::Note => "note",
            };
            latest.insert(
                key,
                InputSection {
                    kind: a.kind,
                    role: s.role.clone(),
                    position: s.position,
                    text: a.text,
                    refs_worktree: a.refs_worktree,
                },
            );
        }
        let mut sections: Vec<InputSection> = latest.into_values().collect();
        sections.sort_by_key(|s| s.position);

        // One-line orientation: the full pipeline with statuses, current marked.
        let breadcrumb = stages
            .iter()
            .map(|s| {
                let glyph = if s.position == position {
                    "← current stage"
                } else {
                    match s.status.as_str() {
                        "done" => "done",
                        "failed" => "halted",
                        _ => "ahead",
                    }
                };
                format!("{} ({})", s.role.replace('_', " "), glyph)
            })
            .collect::<Vec<_>>()
            .join(" → ");

        Ok(StageInput { breadcrumb, sections, refs_worktree })
    }

    /// Sum stage costs; recompute the baseline by re-pricing each stage's tokens
    /// at the reference model; persist + emit.
    fn recompute_run_cost(&self, run_id: &str) -> AppResult<()> {
        let stages = self.db.lock().list_run_stages(run_id)?;
        let run = self
            .db
            .lock()
            .get_run(run_id)?
            .ok_or_else(|| AppError::Other("run vanished".into()))?;
        let reference = run
            .reference_model
            .clone()
            .or_else(crate::orchestrator::cost::pick_reference_model);
        let (retired_cost, retired_in, retired_out) = self.db.lock().get_retired_cost(run_id)?;
        let mut cost = retired_cost;
        let mut baseline = 0.0;
        if let Some(ref_model) = &reference {
            baseline += crate::orchestrator::cost::baseline_cost(
                ref_model,
                retired_in as u64,
                retired_out as u64,
            );
        }
        for s in &stages {
            cost += s.cost_usd;
            if let Some(ref_model) = &reference {
                baseline += crate::orchestrator::cost::baseline_cost(
                    ref_model,
                    s.input_tokens as u64,
                    s.output_tokens as u64,
                );
            }
        }
        // If no premium reference exists, baseline = cost (savings $0, shown honestly).
        if reference.is_none() || baseline < cost {
            baseline = cost;
        }
        self.db.lock().set_run_cost(run_id, cost, baseline)?;
        self.emit_cost(run_id, cost, baseline);
        Ok(())
    }

    /// Drive the run from its first non-done stage until it pauses, completes,
    /// or aborts. Returns the resulting run status.
    pub async fn run_to_pause(&self, run_id: &str) -> AppResult<RunStatus> {
        self.run_to_pause_with(run_id, false).await
    }

    /// `skip_budget_once` lets the FIRST pending stage of this drive start past
    /// the budget gate — set only when the user just approved a budget pause
    /// (conscious override). The gate re-arms for every following stage.
    async fn run_to_pause_with(&self, run_id: &str, skip_budget_once: bool) -> AppResult<RunStatus> {
        // Enforce single active drive.
        {
            let mut active = self.active.lock();
            if active.contains(run_id) {
                return Err(AppError::Other("run is already executing".into()));
            }
            active.insert(run_id.to_string());
        }
        let result = self.drive_inner(run_id, skip_budget_once).await;
        self.active.lock().remove(run_id);
        result
    }

    /// Park a pending stage behind a checkpoint because spend reached the run
    /// budget: stage → awaiting_checkpoint, run → paused, a notice in the
    /// stage's journal, and the checkpoint event.
    fn pause_for_budget(&self, run_id: &str, stage_id: &str, cost: f64, budget: f64) -> AppResult<()> {
        self.db.lock().set_run_stage_status(stage_id, "awaiting_checkpoint")?;
        self.db.lock().set_run_status(run_id, "paused", false)?;
        self.events.emit(
            crate::orchestrator::live::RUN_LOG_EVENT,
            serde_json::json!({
                "runId": run_id,
                "stageId": stage_id,
                "entry": {
                    "kind": "notice",
                    "text": format!("budget reached — ${cost:.2} of ${budget:.2} spent"),
                },
            }),
        );
        self.emit_run_update(run_id);
        self.emit_checkpoint(run_id, stage_id);
        Ok(())
    }

    /// Ask a running run to pause at its next stage boundary. Consumed once, in
    /// `drive_inner`. A no-op if the run isn't driving (the flag is harmless).
    pub fn request_pause(&self, run_id: &str) {
        self.pause_requests.lock().insert(run_id.to_string());
    }

    /// Park the next pending stage because the director asked to pause — same
    /// shape as the budget gate, so the existing "approve a never-started parked
    /// stage" resume path releases it with no new checkpoint logic.
    fn pause_for_director(&self, run_id: &str, stage_id: &str) -> AppResult<()> {
        self.db.lock().set_run_stage_status(stage_id, "awaiting_checkpoint")?;
        self.db.lock().set_run_status(run_id, "paused", false)?;
        self.events.emit(
            crate::orchestrator::live::RUN_LOG_EVENT,
            serde_json::json!({
                "runId": run_id,
                "stageId": stage_id,
                "entry": { "kind": "notice", "text": "paused by the director" },
            }),
        );
        self.emit_run_update(run_id);
        self.emit_checkpoint(run_id, stage_id);
        Ok(())
    }

    async fn drive_inner(&self, run_id: &str, mut skip_budget_once: bool) -> AppResult<RunStatus> {
        let run0 = self
            .db
            .lock()
            .get_run(run_id)?
            .ok_or_else(|| AppError::Other("run not found".into()))?;
        match run0.status.as_str() {
            "completed" => return Ok(RunStatus::Completed),
            "aborted" => return Ok(RunStatus::Aborted),
            _ => {}
        }
        self.db.lock().set_run_status(run_id, "running", false)?;
        self.emit_run_update(run_id);

        // Resolve + persist the reference model once per run (avoids a per-stage disk
        // read in recompute_run_cost). Only when the run doesn't already have one.
        if run0.reference_model.is_none() {
            if let Some(m) = crate::orchestrator::cost::pick_reference_model() {
                self.db.lock().set_run_reference_model(run_id, &m)?;
            }
        }

        loop {
            let run = self
                .db
                .lock()
                .get_run(run_id)?
                .ok_or_else(|| AppError::Other("run not found".into()))?;
            if run.status == "aborted" {
                return Ok(RunStatus::Aborted);
            }
            let stages = self.db.lock().list_run_stages(run_id)?;
            let next = stages.iter().find(|s| s.status != "done");
            let Some(stage) = next else {
                self.db.lock().set_run_status(run_id, "completed", true)?;
                self.emit_run_update(run_id);
                self.sync_run_history(run_id);
                return Ok(RunStatus::Completed);
            };
            // Only "pending" stages run; anything else (awaiting_checkpoint / failed)
            // means we're already blocked — restore the persisted paused status, since
            // entry set it to "running".
            if stage.status != "pending" {
                self.db.lock().set_run_status(run_id, "paused", false)?;
                self.emit_run_update(run_id);
                return Ok(RunStatus::Paused);
            }

            // Budget gate: a pending stage must not START once spend has
            // reached the run's budget (stages are atomic — no mid-stage
            // interruption). Approving the resulting checkpoint releases the
            // parked stage past the gate once; it re-arms for the next stage.
            if let Some(budget) = run.budget_usd {
                if !skip_budget_once && budget > 0.0 && run.cost_usd >= budget {
                    self.pause_for_budget(run_id, &stage.id, run.cost_usd, budget)?;
                    return Ok(RunStatus::Paused);
                }
            }
            skip_budget_once = false; // only the drive's first stage may bypass

            // Director pause: park this next pending stage at the boundary (same
            // mechanism as the budget gate). Approving the parked stage resumes.
            if self.pause_requests.lock().remove(run_id) {
                self.pause_for_director(run_id, &stage.id)?;
                return Ok(RunStatus::Paused);
            }

            let stage = stage.clone();
            let (status, verdict) = self.run_stage_once(&run, &stage).await?;
            self.emit_run_update(run_id);

            // An abort issued WHILE the stage was in flight wins over whatever
            // the stage produced — never downgrade the terminal aborted status
            // back to paused-for-recovery.
            let aborted_mid_stage = self
                .db
                .lock()
                .get_run(run_id)?
                .map(|r| r.status == "aborted")
                .unwrap_or(false);
            if aborted_mid_stage {
                return Ok(RunStatus::Aborted);
            }

            match status {
                StageStatus::Failed => {
                    self.db.lock().set_run_status(run_id, "paused", false)?;
                    self.emit_checkpoint(run_id, &stage.id);
                    return Ok(RunStatus::Paused);
                }
                StageStatus::Done => {
                    // Auto-loop verdict decision runs BEFORE gated/checkpoint pause.
                    if Self::stage_has_auto_loop(&stage) {
                        let remaining = stage.loop_iterations < stage.loop_max_iterations;
                        match verdict {
                            Some(ReviewVerdict::Pass) => {
                                // Fall through to checkpoint/continue below.
                            }
                            Some(ReviewVerdict::ChangesRequested) if remaining => {
                                // Re-read the freshly-persisted stage to get the artifact.
                                let fresh_stages = self.db.lock().list_run_stages(run_id)?;
                                let fresh = fresh_stages.iter().find(|s| s.id == stage.id);
                                let findings = fresh
                                    .and_then(|s| s.artifact.as_deref())
                                    .and_then(|j| serde_json::from_str::<serde_json::Value>(j).ok())
                                    .and_then(|v| v.get("text").and_then(|t| t.as_str()).map(str::to_string));
                                self.loop_back(run_id, &stage, findings.as_deref())?;
                                self.emit_run_update(run_id);
                                continue;
                            }
                            _ => {
                                // ChangesRequested at cap, or unparseable verdict → gate.
                                self.db.lock().set_run_stage_status(&stage.id, "awaiting_checkpoint")?;
                                self.db.lock().set_run_status(run_id, "paused", false)?;
                                self.emit_checkpoint(run_id, &stage.id);
                                return Ok(RunStatus::Paused);
                            }
                        }
                    }
                    // Existing gated/checkpoint handling (also handles auto Pass fall-through).
                    if stage.checkpoint || Self::stage_has_gated_loop(&stage) {
                        self.db
                            .lock()
                            .set_run_stage_status(&stage.id, "awaiting_checkpoint")?;
                        self.db.lock().set_run_status(run_id, "paused", false)?;
                        self.emit_checkpoint(run_id, &stage.id);
                        return Ok(RunStatus::Paused);
                    }
                    // else continue to next stage
                }
                _ => { /* other statuses — continue to next stage */ }
            }
        }
    }

    /// Resolve a checkpoint and continue driving.
    pub async fn resolve_checkpoint(
        &self,
        run_id: &str,
        action: CheckpointAction,
    ) -> AppResult<RunStatus> {
        let stages = self.db.lock().list_run_stages(run_id)?;
        let blocked = stages
            .iter()
            .find(|s| s.status == "awaiting_checkpoint" || s.status == "failed")
            .cloned();

        // Approving a budget-parked stage (it never ran) is a conscious
        // override: the re-drive lets that stage start past the budget gate.
        let mut budget_override = false;

        match action {
            CheckpointAction::Abort => {
                self.db.lock().set_run_status(run_id, "aborted", true)?;
                self.emit_run_update(run_id);
                self.sync_run_history(run_id);
                return Ok(RunStatus::Aborted);
            }
            CheckpointAction::Approve | CheckpointAction::Edit => {
                if let Some(s) = &blocked {
                    if s.status == "awaiting_checkpoint" {
                        if s.started_at.is_none() && s.artifact.is_none() {
                            // Budget-parked: the stage never ran. Release it to
                            // pending so it actually executes (past the gate).
                            self.db.lock().set_run_stage_status(&s.id, "pending")?;
                            budget_override = true;
                        } else {
                            self.db.lock().set_run_stage_status(&s.id, "done")?;
                        }
                    } else {
                        // A FAILED stage: approving accepts the partial work.
                        // Synthesize an honest artifact so the next stage has an
                        // input and runs against the worktree as the halted agent
                        // left it — the following review stage catches any gaps
                        // and loops back (the pipeline-native recovery).
                        let kind = self.db.lock().get_role(&s.role)
                            .ok().flatten()
                            .map(|rd| rd.artifact_kind)
                            .unwrap_or(ArtifactKind::Diff);
                        let refs_worktree = matches!(kind, ArtifactKind::Diff | ArtifactKind::Tests);
                        let reason = s
                            .error
                            .as_deref()
                            .and_then(|e| e.lines().next())
                            .map(str::trim)
                            .filter(|l| !l.is_empty())
                            .unwrap_or("stage halted");
                        // Salvage the halted attempt's narration so the next
                        // stage inherits the partial work, not an empty stub.
                        let text = match self.salvage_journal_text(&s.id) {
                            Some(salvaged) => format!(
                                "(accepted by the director after a halt: {reason})\n\nWhat the stage had produced before the halt:\n{salvaged}"
                            ),
                            None => format!("(accepted by the director after a halt: {reason})"),
                        };
                        let artifact = StageArtifact {
                            kind,
                            text,
                            payload: None,
                            refs_worktree,
                        };
                        let json = serde_json::to_string(&artifact)?;
                        // Preserve the failed attempt's spend — only status/artifact change.
                        self.db.lock().complete_run_stage(
                            &s.id,
                            "done",
                            s.input_tokens,
                            s.output_tokens,
                            s.cost_usd,
                            Some(&json),
                        )?;
                    }
                }
            }
            CheckpointAction::Reject {
                feedback,
                model_override,
                max_turns_override,
            } => {
                if let Some(s) = &blocked {
                    // Archive the rejected attempt before the reset wipes it.
                    if s.artifact.is_some() || s.error.is_some() {
                        self.db.lock().archive_stage_attempt(s, feedback.as_deref())?;
                    }
                    if let Some(mt) = max_turns_override {
                        self.db.lock().set_stage_max_iterations(&s.id, mt)?;
                    }
                    self.db.lock().set_stage_resume_pending(&s.id, false)?;
                    self.db.lock().reset_run_stage(
                        &s.id,
                        model_override.as_deref(),
                        feedback.as_deref(),
                    )?;
                    self.recompute_run_cost(run_id)?;
                }
            }
            CheckpointAction::Resume { max_turns_override } => {
                // Recover a transient/infra halt: re-run the SAME stage without
                // treating its output as wrong. Only a failed stage can resume —
                // an awaiting_checkpoint stage isn't a failure, so this is a no-op
                // there. The prior attempt is archived (evidence) and its spend
                // retired so the cost meter stays truthful, then the stage resets
                // to pending and the drive re-runs it. The worktree is untouched,
                // so a code stage picks up from the files already on disk.
                // For a CLI stage with a session id, resume_pending is set so the
                // next run uses `--resume` to continue the same Claude session.
                if let Some(s) = &blocked {
                    if s.status == "failed" {
                        if s.artifact.is_some() || s.error.is_some() {
                            self.db.lock().archive_stage_attempt(s, None)?;
                        }
                        self.db.lock().retire_stage_cost(
                            run_id,
                            s.cost_usd,
                            s.input_tokens,
                            s.output_tokens,
                        )?;
                        if let Some(mt) = max_turns_override {
                            self.db.lock().set_stage_max_iterations(&s.id, mt)?;
                        }
                        let can_resume = s.substrate == "cli" && s.session_id.is_some();
                        self.db.lock().set_stage_resume_pending(&s.id, can_resume)?;
                        self.db.lock().reset_run_stage(&s.id, None, None)?;
                        self.recompute_run_cost(run_id)?;
                    }
                }
            }
            CheckpointAction::Discard => {
                // Revert the worktree to the failed stage's baseline commit,
                // dropping only the changes this stage introduced. The stage
                // stays failed and the run stays paused at the same checkpoint
                // (drive_inner sees the failed stage and returns Paused immediately).
                if let Some(s) = &blocked {
                    if let Some(baseline) = s.baseline_commit.clone() {
                        let run = self.db.lock().get_run(run_id)?
                            .ok_or_else(|| crate::error::AppError::Other("run not found".into()))?;
                        let ws = self.workspace_path(&run)?;
                        match crate::orchestrator::git_baseline::restore_baseline(&ws, &baseline) {
                            Ok(()) => self.record_halt(run_id, &s.id, "changes discarded — worktree reverted to the stage baseline"),
                            Err(e) => self.record_halt(run_id, &s.id, &format!("discard failed — {e}")),
                        }
                    }
                }
            }
            CheckpointAction::SendBack { feedback } => {
                if let Some(review) = &blocked {
                    // Only a review parked at its checkpoint can be sent back. A failed
                    // stage is recovered via Reject/re-run, not SendBack → no-op here.
                    // A budget-parked stage (never started: no started_at, no artifact)
                    // has produced nothing to send back — leave it parked; Approve is
                    // the only override and Reject re-parks.
                    let budget_parked = review.started_at.is_none() && review.artifact.is_none();
                    if review.status == "awaiting_checkpoint" && !budget_parked {
                        let can_loop = match review.loop_target_position {
                            Some(target_pos) => {
                                target_pos < review.position
                                    && review.loop_iterations < review.loop_max_iterations
                            }
                            None => false,
                        };
                        if can_loop {
                            // Forward the review's findings to the target (the reset is
                            // about to erase them), with the user's note appended.
                            let findings = review
                                .artifact
                                .as_deref()
                                .and_then(|j| serde_json::from_str::<serde_json::Value>(j).ok())
                                .and_then(|v| {
                                    v.get("text").and_then(|t| t.as_str()).map(str::to_string)
                                })
                                .filter(|t| !t.trim().is_empty());
                            let note = feedback
                                .as_deref()
                                .map(str::trim)
                                .filter(|n| !n.is_empty());
                            let composed = match (findings, note) {
                                (Some(f), Some(n)) => Some(format!("{f}\n\nDirector's note: {n}")),
                                (Some(f), None) => Some(f),
                                (None, Some(n)) => Some(n.to_string()),
                                (None, None) => None,
                            };
                            self.loop_back(run_id, review, composed.as_deref())?;
                        } else {
                            // No usable loop (no/invalid target or cap reached) → accept the review.
                            self.db.lock().set_run_stage_status(&review.id, "done")?;
                        }
                    }
                }
            }
        }

        self.run_to_pause_with(run_id, budget_override).await
    }

    /// Signal the run's in-flight stage (if any) to stop. The substrate halts
    /// at its next cancel check; the stage lands as failed in the existing
    /// halt-recovery flow. No-op when nothing is in flight.
    pub fn stop_current_stage(&self, run_id: &str) -> AppResult<()> {
        if let Some(flag) = self.cancels.lock().get(run_id) {
            flag.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        Ok(())
    }

    pub async fn abort_run(&self, run_id: &str) -> AppResult<()> {
        self.db.lock().set_run_status(run_id, "aborted", true)?;
        // Aborting must kill in-flight work, not just mark the DB: the drive
        // loop only checks the status BETWEEN stages.
        self.stop_current_stage(run_id)?;
        self.emit_run_update(run_id);
        self.sync_run_history(run_id);
        Ok(())
    }

    /// Returns `true` when another run in the same workspace is currently
    /// `running` or `paused` (i.e. executing or suspended mid-run).
    ///
    /// `draft`, `completed`, and `aborted` statuses are never considered
    /// executing. A run is never considered concurrent with itself.
    pub async fn has_concurrent_run(&self, run_id: &str) -> AppResult<bool> {
        let db = self.db.lock();
        let Some(run) = db.get_run(run_id)? else { return Ok(false) };
        drop(db);
        let peers = self.db.lock().list_runs(&run.workspace_id)?;
        let blocked = peers.iter().any(|r| {
            r.id != run_id
                && (r.status == "running" || r.status == "paused")
        });
        Ok(blocked)
    }

    /// Spawn the drive as a background task (production entry point).
    pub fn start_run(self: Arc<Self>, run_id: String) {
        tokio::spawn(async move {
            if let Err(e) = self.run_to_pause(&run_id).await {
                tracing::error!(run_id = %run_id, error = %e, "run drive failed");
                self.events.emit(
                    "run://error",
                    serde_json::json!({ "runId": run_id, "error": e.to_string() }),
                );
            }
        });
    }

    /// Spawn a checkpoint resolution in the background, emitting run://error on failure.
    pub fn spawn_resolve_checkpoint(self: Arc<Self>, run_id: String, action: CheckpointAction) {
        tokio::spawn(async move {
            if let Err(e) = self.resolve_checkpoint(&run_id, action).await {
                tracing::error!(run_id = %run_id, error = %e, "resolve_checkpoint failed");
                self.events.emit(
                    "run://error",
                    serde_json::json!({ "runId": run_id, "error": e.to_string() }),
                );
            }
        });
    }
}
