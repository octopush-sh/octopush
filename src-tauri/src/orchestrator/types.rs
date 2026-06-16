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

impl ArtifactKind {
    pub fn as_db(&self) -> &'static str {
        match self { Self::Plan => "plan", Self::Review => "review", Self::Tests => "tests", Self::Diff => "diff", Self::Note => "note" }
    }
    pub fn from_db(s: &str) -> Option<Self> {
        match s { "plan" => Some(Self::Plan), "review" => Some(Self::Review), "tests" => Some(Self::Tests), "diff" => Some(Self::Diff), "note" => Some(Self::Note), _ => None }
    }
}

/// Whether a role leaves the worktree dirty for the next stage (the default) or
/// is allowed to perform git/external side-effects (commit/push/release).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum RoleEnvironment { Worktree, Action }
impl RoleEnvironment {
    pub fn as_db(&self) -> &'static str { match self { Self::Worktree => "worktree", Self::Action => "action" } }
    pub fn from_db(s: &str) -> Option<Self> { match s { "worktree" => Some(Self::Worktree), "action" => Some(Self::Action), _ => None } }
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

/// One labeled section of a stage's input dossier: an earlier stage's
/// artifact, tagged with where it came from so the prompt can attribute it.
#[derive(Clone, Debug, PartialEq)]
pub struct InputSection {
    pub kind: ArtifactKind,
    /// Role of the stage that produced this artifact (e.g. "plan").
    pub role: String,
    /// Pipeline position of the producing stage (0-based).
    pub position: i64,
    pub text: String,
    /// True when the producing artifact's real output lives in the worktree.
    pub refs_worktree: bool,
}

/// The assembled input for a stage. Instead of only the immediately-previous
/// artifact (which let a review's findings SHADOW the plan it reviewed), a
/// stage receives the freshest artifact of EACH kind produced before it —
/// so Implement sees both the refined plan and the review's verdict, and
/// Code review can check the changes against the plan. Token cost stays
/// bounded: at most one section per artifact kind, each capped, and
/// superseded artifacts (older attempts, looped-over stages) never ride along.
#[derive(Clone, Debug, Default)]
pub struct StageInput {
    /// One-line map of the whole pipeline with statuses — cheap orientation
    /// so the agent knows where it stands and what comes after it.
    pub breadcrumb: String,
    /// Freshest artifact per kind, in pipeline (position) order.
    pub sections: Vec<InputSection>,
    /// True when any included artifact's real output is the worktree diff.
    pub refs_worktree: bool,
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
    /// Tool allowlist over the workspace tools. `None` ⇒ the full set; `Some`
    /// restricts the agent (e.g. a review stage to read-only). API substrate
    /// only — the CLI substrate owns its own tools.
    pub tools: Option<Vec<String>>,
    /// Free-form instructions appended to the archetype's system prompt — the
    /// pipeline author's per-stage shaping.
    pub instructions: Option<String>,
    /// CLI session to `--resume` on this run (set only by a Resume action).
    pub resume_session: Option<String>,
    /// The stage id, so the runner can clear `resume_pending` once it starts.
    pub stage_id: String,
    /// Resolved from the role's definition at spec-build time.
    pub role_prompt: String,
    pub role_environment: crate::orchestrator::types::RoleEnvironment,
    pub artifact_kind: crate::orchestrator::types::ArtifactKind,
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
    /// The CLI session ID from the `type:"result"` event, when the CLI substrate
    /// was used. `None` for API-substrate stages.
    pub session_id: Option<String>,
}

/// What the user chose at a checkpoint.
#[derive(Clone, Debug)]
pub enum CheckpointAction {
    Approve,
    Reject {
        feedback: Option<String>,
        model_override: Option<String>,
        max_turns_override: Option<i64>,
    },
    /// Route work back to the review stage's `loop_target` (re-run the target +
    /// intervening stages with the reviewer's findings), bounded by the cap.
    SendBack {
        feedback: Option<String>,
    },
    /// Recover a halted stage. For a CLI stage with a session id, the re-run
    /// `--resume`s that session; otherwise it is a fresh re-run (worktree
    /// preserved). `max_turns_override` raises the tool-turn budget.
    Resume {
        max_turns_override: Option<i64>,
    },
    /// Revert the worktree to the failed stage's baseline (drop only this
    /// stage's changes). The stage stays failed; the checkpoint stays open.
    Discard,
    /// Artifact was edited out-of-band; continue.
    Edit,
    Abort,
}
