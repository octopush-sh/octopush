//! Direct-mode orchestration: pipelines, runs, agent runners, and the
//! checkpoint-driven run state machine.

pub mod agentic;
pub mod cost;
pub mod events;
pub mod runner;
pub mod types;

pub use types::*;

use crate::db::{Db, RunStageRow};
use crate::error::{AppError, AppResult};
use crate::orchestrator::events::EventSink;
use crate::orchestrator::runner::{AgentRunner, ApiRunner, CliRunnerUnavailable, StageContext};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

/// Drives runs: one stage at a time, pausing at checkpoints.
pub struct Orchestrator {
    db: Arc<Mutex<Db>>,
    events: Arc<dyn EventSink>,
    /// Test override: when set, every stage uses this runner regardless of substrate.
    test_runner: Option<Box<dyn AgentRunner>>,
    client: reqwest::Client,
    /// run_id -> already-running guard (enforces one active drive per run).
    active: Mutex<HashMap<String, ()>>,
}

impl Orchestrator {
    pub fn new(db: Arc<Mutex<Db>>, events: Arc<dyn EventSink>) -> Self {
        Self {
            db,
            events,
            test_runner: None,
            client: reqwest::Client::new(),
            active: Mutex::new(HashMap::new()),
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
            client: reqwest::Client::new(),
            active: Mutex::new(HashMap::new()),
        }
    }

    fn runner_for(&self, substrate: &AgentSubstrate) -> Box<dyn AgentRunner> {
        if self.test_runner.is_some() {
            // Tests route through `run_stage_once`, which uses `self.test_runner`.
            unreachable!("runner_for must not be called when test_runner is set");
        }
        match substrate {
            AgentSubstrate::Api => Box::new(ApiRunner),
            AgentSubstrate::Cli => Box::new(CliRunnerUnavailable),
        }
    }

    fn emit_run_update(&self, run_id: &str) {
        if let Ok(Some(run)) = self.db.lock().get_run(run_id) {
            self.events.emit(
                "run://stage-update",
                serde_json::json!({ "runId": run_id, "run": run }),
            );
        }
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

    fn workspace_path(&self, run: &crate::db::RunRow) -> AppResult<PathBuf> {
        let path: Option<String> = self.db.lock().conn_ref_path(&run.workspace_id)?;
        path.map(PathBuf::from)
            .ok_or_else(|| AppError::Other("workspace has no worktree_path".into()))
    }

    /// Execute one stage and persist its outcome + cost/baseline.
    async fn run_stage_once(
        &self,
        run: &crate::db::RunRow,
        stage: &RunStageRow,
    ) -> AppResult<StageStatus> {
        let substrate = match AgentSubstrate::from_db(&stage.substrate) {
            Some(s) => s,
            None => {
                self.db.lock().fail_run_stage(
                    &stage.id,
                    &format!("unknown substrate '{}'", stage.substrate),
                )?;
                return Ok(StageStatus::Failed);
            }
        };
        let spec = StageSpec {
            position: stage.position,
            role: stage.role.clone(),
            agent_model: stage.agent_model.clone(),
            substrate,
            checkpoint: stage.checkpoint,
            feedback: stage.feedback.clone(),
        };

        // Input artifact = the previous done stage's artifact, or a seed Note from the task.
        let input = self.previous_artifact(&run.id, stage.position, &run.task)?;

        self.db.lock().set_run_stage_status(&stage.id, "running")?;
        self.emit_run_update(&run.id);

        // Build the context and run the agent. ANY hard error here (missing worktree,
        // unresolved provider, unavailable CLI substrate) is converted into a failed
        // stage so the run converges to a clean paused/recoverable state instead of
        // stranding the stage in "running".
        let run_result: AppResult<StageOutcome> = async {
            let ctx = StageContext {
                workspace_path: self.workspace_path(run)?,
                task: run.task.clone(),
                client: self.client.clone(),
            };
            match &self.test_runner {
                Some(r) => r.run(&spec, &input, &ctx).await,
                None => self.runner_for(&spec.substrate).run(&spec, &input, &ctx).await,
            }
        }
        .await;

        let outcome = match run_result {
            Ok(o) => o,
            Err(e) => {
                self.db.lock().fail_run_stage(&stage.id, &e.to_string())?;
                return Ok(StageStatus::Failed);
            }
        };

        match outcome.status {
            StageStatus::Done => {
                let artifact_json = serde_json::to_string(&outcome.artifact)?;
                self.db.lock().complete_run_stage(
                    &stage.id,
                    "done",
                    outcome.input_tokens as i64,
                    outcome.output_tokens as i64,
                    outcome.cost_usd,
                    Some(&artifact_json),
                )?;
                self.recompute_run_cost(&run.id)?;
                Ok(StageStatus::Done)
            }
            _ => {
                let err = outcome.error.unwrap_or_else(|| "stage failed".into());
                self.db.lock().fail_run_stage(&stage.id, &err)?;
                Ok(StageStatus::Failed)
            }
        }
    }

    fn previous_artifact(
        &self,
        run_id: &str,
        position: i64,
        task: &str,
    ) -> AppResult<StageArtifact> {
        let stages = self.db.lock().list_run_stages(run_id)?;
        let prev = stages
            .iter()
            .filter(|s| s.position < position && s.artifact.is_some())
            .max_by_key(|s| s.position);
        if let Some(p) = prev {
            if let Some(json) = &p.artifact {
                if let Ok(a) = serde_json::from_str::<StageArtifact>(json) {
                    return Ok(a);
                }
            }
        }
        Ok(StageArtifact {
            kind: ArtifactKind::Note,
            text: task.to_string(),
            payload: None,
            refs_worktree: false,
        })
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
        let mut cost = 0.0;
        let mut baseline = 0.0;
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
        // Enforce single active drive.
        {
            let mut active = self.active.lock();
            if active.contains_key(run_id) {
                return Err(AppError::Other("run is already executing".into()));
            }
            active.insert(run_id.to_string(), ());
        }
        let result = self.drive_inner(run_id).await;
        self.active.lock().remove(run_id);
        result
    }

    async fn drive_inner(&self, run_id: &str) -> AppResult<RunStatus> {
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

            let stage = stage.clone();
            let status = self.run_stage_once(&run, &stage).await?;
            self.emit_run_update(run_id);

            match status {
                StageStatus::Failed => {
                    self.db.lock().set_run_status(run_id, "paused", false)?;
                    self.emit_checkpoint(run_id, &stage.id);
                    return Ok(RunStatus::Paused);
                }
                StageStatus::Done if stage.checkpoint => {
                    self.db
                        .lock()
                        .set_run_stage_status(&stage.id, "awaiting_checkpoint")?;
                    self.db.lock().set_run_status(run_id, "paused", false)?;
                    self.emit_checkpoint(run_id, &stage.id);
                    return Ok(RunStatus::Paused);
                }
                _ => { /* continue to next stage */ }
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

        match action {
            CheckpointAction::Abort => {
                self.db.lock().set_run_status(run_id, "aborted", true)?;
                self.emit_run_update(run_id);
                return Ok(RunStatus::Aborted);
            }
            CheckpointAction::Approve | CheckpointAction::Edit => {
                if let Some(s) = &blocked {
                    if s.status == "awaiting_checkpoint" {
                        self.db.lock().set_run_stage_status(&s.id, "done")?;
                    } else {
                        // A failed stage cannot be approved; treat as no-op pause.
                        return Ok(RunStatus::Paused);
                    }
                }
            }
            CheckpointAction::Reject {
                feedback,
                model_override,
            } => {
                if let Some(s) = &blocked {
                    self.db.lock().reset_run_stage(
                        &s.id,
                        model_override.as_deref(),
                        feedback.as_deref(),
                    )?;
                    self.recompute_run_cost(run_id)?;
                }
            }
        }

        self.run_to_pause(run_id).await
    }

    pub async fn abort_run(&self, run_id: &str) -> AppResult<()> {
        self.db.lock().set_run_status(run_id, "aborted", true)?;
        self.emit_run_update(run_id);
        Ok(())
    }

    /// Spawn the drive as a background task (production entry point).
    pub fn start_run(self: Arc<Self>, run_id: String) {
        tokio::spawn(async move {
            if let Err(e) = self.run_to_pause(&run_id).await {
                tracing::error!(run_id = %run_id, error = %e, "run drive failed");
            }
        });
    }
}
