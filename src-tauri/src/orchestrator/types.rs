//! Domain types shared across the orchestrator.

use serde::{Deserialize, Serialize};

/// What a stage produced. Tagged so the focus pane / "edit by hand" know the shape.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ArtifactKind {
    Plan,
    Review,
    Tests,
    Diff,
    Note,
}

/// The structured output one stage hands to the next.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StageArtifact {
    pub kind: ArtifactKind,
    /// Human-readable body (the plan, the findings, a summary for code stages).
    pub text: String,
    /// Optional structured detail (e.g. review findings as a list).
    #[serde(default)]
    pub payload: Option<serde_json::Value>,
    /// True for code stages whose real output is the worktree diff (read on demand).
    #[serde(default)]
    pub refs_worktree: bool,
}

/// How a stage executes.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum AgentSubstrate {
    /// In-app via the LLM provider (chat tool-loop helpers).
    Api,
    /// Headless external CLI agent. Not implemented in Phase A.
    Cli,
}

impl AgentSubstrate {
    pub fn as_db(&self) -> &'static str {
        match self {
            AgentSubstrate::Api => "api",
            AgentSubstrate::Cli => "cli",
        }
    }
    pub fn from_db(s: &str) -> Option<Self> {
        match s {
            "api" => Some(AgentSubstrate::Api),
            "cli" => Some(AgentSubstrate::Cli),
            _ => None,
        }
    }
}

/// A review stage's structured pass/changes-requested signal (auto mode).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ReviewVerdict {
    Pass,
    ChangesRequested,
}

/// How a review stage's loop-back behaves. Persisted as text in
/// `*_stages.loop_mode`; absent/unknown ⇒ no loop (linear).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum LoopMode {
    Gated,
    Auto,
}

impl LoopMode {
    pub fn as_db(&self) -> &'static str {
        match self {
            LoopMode::Gated => "gated",
            LoopMode::Auto => "auto",
        }
    }
    pub fn from_db(s: &str) -> Option<Self> {
        match s {
            "gated" => Some(LoopMode::Gated),
            "auto" => Some(LoopMode::Auto),
            _ => None,
        }
    }
}

/// Per-stage lifecycle status (persisted as text in `run_stages.status`).
#[derive(Clone, Debug, PartialEq)]
pub enum StageStatus {
    Pending,
    Running,
    AwaitingCheckpoint,
    Done,
    Failed,
}

impl StageStatus {
    pub fn as_db(&self) -> &'static str {
        match self {
            StageStatus::Pending => "pending",
            StageStatus::Running => "running",
            StageStatus::AwaitingCheckpoint => "awaiting_checkpoint",
            StageStatus::Done => "done",
            StageStatus::Failed => "failed",
        }
    }
    pub fn from_db(s: &str) -> Option<Self> {
        match s {
            "pending" => Some(StageStatus::Pending),
            "running" => Some(StageStatus::Running),
            "awaiting_checkpoint" => Some(StageStatus::AwaitingCheckpoint),
            "done" => Some(StageStatus::Done),
            "failed" => Some(StageStatus::Failed),
            _ => None,
        }
    }
}

/// Run-level status (persisted as text in `runs.status`).
#[derive(Clone, Debug, PartialEq)]
pub enum RunStatus {
    Draft,
    Running,
    Paused,
    Completed,
    Aborted,
    Failed,
}

impl RunStatus {
    pub fn as_db(&self) -> &'static str {
        match self {
            RunStatus::Draft => "draft",
            RunStatus::Running => "running",
            RunStatus::Paused => "paused",
            RunStatus::Completed => "completed",
            RunStatus::Aborted => "aborted",
            RunStatus::Failed => "failed",
        }
    }
    pub fn from_db(s: &str) -> Option<Self> {
        match s {
            "draft" => Some(RunStatus::Draft),
            "running" => Some(RunStatus::Running),
            "paused" => Some(RunStatus::Paused),
            "completed" => Some(RunStatus::Completed),
            "aborted" => Some(RunStatus::Aborted),
            "failed" => Some(RunStatus::Failed),
            _ => None,
        }
    }
}

/// The runtime spec a runner needs to execute one stage.
#[derive(Clone, Debug)]
pub struct StageSpec {
    pub position: i64,
    pub role: String,
    pub agent_model: String,
    pub substrate: AgentSubstrate,
    pub checkpoint: bool,
    /// Optional human feedback from a prior rejection of this stage.
    pub feedback: Option<String>,
    /// Loop config (gated mode in L1): where to return to, the cap, the mode,
    /// and how many loop-backs have already happened.
    pub loop_target: Option<i64>,
    pub loop_max: i64,
    pub loop_mode: Option<LoopMode>,
    pub loop_iterations: i64,
    /// Per-stage tool-turn budget: the agentic loop's iteration cap (API) and
    /// `--max-turns` (CLI). Validated 1..=100 at save time; default 25.
    pub max_iterations: i64,
}

/// A single tool invocation, captured for the run-event log.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallLog {
    pub name: String,
    pub input: serde_json::Value,
    pub result: String,
}

/// What a runner returns for one stage.
#[derive(Clone, Debug)]
pub struct StageOutcome {
    pub artifact: StageArtifact,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: f64,
    /// Either `Done` or `Failed`.
    pub status: StageStatus,
    pub tool_calls: Vec<ToolCallLog>,
    /// Present when `status == Failed`.
    pub error: Option<String>,
    /// Parsed `VERDICT:` sentinel from a review stage's output (auto mode only).
    pub verdict: Option<ReviewVerdict>,
}

/// What the user chose at a checkpoint.
#[derive(Clone, Debug)]
pub enum CheckpointAction {
    Approve,
    Reject {
        feedback: Option<String>,
        model_override: Option<String>,
    },
    /// Route work back to the review stage's `loop_target` (re-run the target +
    /// intervening stages with the reviewer's findings), bounded by the cap.
    SendBack {
        feedback: Option<String>,
    },
    /// Artifact was edited out-of-band; continue.
    Edit,
    Abort,
}
