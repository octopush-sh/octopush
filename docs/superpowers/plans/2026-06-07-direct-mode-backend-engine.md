# Direct Mode — Backend Engine (Phase A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the backend orchestration engine for Direct mode — pipelines, runs, a uniform `AgentRunner` abstraction with an API substrate, a checkpoint-driven state machine, cost/baseline accounting, and the IPC surface — with **no UI** and no CLI substrate yet.

**Architecture:** A new `orchestrator` module owns run execution. Pipelines and runs are persisted in five new SQLite tables. The orchestrator drives a run as a background `tokio` task that, between stages, persists state and either pauses at a checkpoint or continues. Each stage is executed through the `AgentRunner` trait; the only implementation in this phase is `ApiRunner`, which reuses the existing chat tool-loop **leaf helpers** (`build_llm_tools`, `execute_tool`, `resolve_provider`) via a new headless `run_agentic_loop`. Tauri events (`run://…`) report progress through an `EventSink` indirection so the engine is unit-testable without a Tauri `AppHandle`.

**Tech Stack:** Rust, Tauri 2, `rusqlite` (SQLite, WAL), `tokio`, `async-trait`, `reqwest`, `parking_lot::Mutex`, `serde`, `uuid`, `tracing`. Tests: built-in `#[test]` in `src-tauri/src/tests.rs`, `tempfile` for throwaway DBs, `serial_test` available.

**Scope note (decomposition):** This is Plan 1 of 2 for the Direct-mode spec (`docs/superpowers/specs/2026-06-07-direct-mode-agent-orchestration-design.md`). Plan 1 = backend engine (this document). Plan 2 = the Direct mode UI + CLI substrate + cost surfacing + polish, built on the IPC surface defined here.

**Design decision (recorded):** The spec (§4) proposes extracting a headless core from `chat_engine::send_agentic` and making `send_agentic` a thin wrapper. We instead **reuse the already-standalone leaf helpers** and add a *separate* headless `run_agentic_loop`, leaving `send_agentic` untouched. Rationale: the chat path is fragile (11+ prior fix commits per CLAUDE.md) and its loop is entangled with chat-only concerns (DB history, streaming, file-edit attribution). Reusing the leaf helpers keeps tools/execution/provider-resolution DRY while containing regression risk. Collapsing the two loop bodies is a possible future cleanup, not Phase A work.

---

## File Structure

**New files:**
- `src-tauri/src/orchestrator/mod.rs` — module root; re-exports; the `Orchestrator` struct and run-driving state machine.
- `src-tauri/src/orchestrator/types.rs` — domain types: `StageArtifact`, `ArtifactKind`, `AgentSubstrate`, `StageStatus`, `RunStatus`, `StageSpec`, `StageOutcome`, `ToolCallLog`, `CheckpointAction`.
- `src-tauri/src/orchestrator/agentic.rs` — `run_agentic_loop` (headless tool-loop) + `AgenticResult`.
- `src-tauri/src/orchestrator/runner.rs` — `AgentRunner` trait, `StageContext`, `ApiRunner`, the pure prompt/artifact helpers, and (test-only) `MockRunner`.
- `src-tauri/src/orchestrator/cost.rs` — `stage_cost`, `baseline_cost`, `pick_reference_model`.
- `src-tauri/src/orchestrator/events.rs` — `EventSink` trait + `TauriEventSink`.

**Modified files:**
- `src-tauri/src/chat_engine.rs` — make three leaf helpers `pub(crate)`.
- `src-tauri/src/db.rs` — five new tables in `migrate()`; new row structs + CRUD methods; builtin-pipeline seeding.
- `src-tauri/src/lib.rs` — declare `mod orchestrator;`, register new commands, `.manage()` the `Orchestrator`, seed builtins in `setup`.
- `src-tauri/src/commands.rs` — new Tauri commands for pipelines/runs/checkpoints.
- `src-tauri/src/state.rs` — no change required (Orchestrator is a separate managed state); see Task 9.
- `src-tauri/src/tests.rs` — new test modules.
- `src/lib/ipc.ts` — typed wrappers + types for the new commands/events (the contract Plan 2 builds on).

---

## Task 1: Domain types

**Files:**
- Create: `src-tauri/src/orchestrator/types.rs`
- Create: `src-tauri/src/orchestrator/mod.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod orchestrator;`)
- Test: `src-tauri/src/tests.rs`

- [ ] **Step 1: Create the module root**

Create `src-tauri/src/orchestrator/mod.rs`:

```rust
//! Direct-mode orchestration: pipelines, runs, agent runners, and the
//! checkpoint-driven run state machine.

pub mod agentic;
pub mod cost;
pub mod events;
pub mod runner;
pub mod types;

pub use types::*;
```

(The `Orchestrator` struct is added to this file in Task 7. The `pub mod` lines for files not yet created will fail to compile until their tasks run — create empty stubs now to keep the tree compiling.)

Create empty stubs so the module compiles:

`src-tauri/src/orchestrator/agentic.rs`, `cost.rs`, `events.rs`, `runner.rs` — each containing only:

```rust
// implemented in a later task
```

- [ ] **Step 2: Declare the module**

In `src-tauri/src/lib.rs`, add alongside the other top-level `mod` declarations (near `mod chat_engine;`):

```rust
mod orchestrator;
```

- [ ] **Step 3: Write the failing test**

In `src-tauri/src/tests.rs`, append a new module:

```rust
#[cfg(test)]
mod orchestrator_types_tests {
    use crate::orchestrator::types::*;

    #[test]
    fn status_strings_round_trip() {
        for s in [
            StageStatus::Pending,
            StageStatus::Running,
            StageStatus::AwaitingCheckpoint,
            StageStatus::Done,
            StageStatus::Failed,
        ] {
            assert_eq!(StageStatus::from_db(s.as_db()), Some(s.clone()));
        }
        for s in [
            RunStatus::Draft,
            RunStatus::Running,
            RunStatus::Paused,
            RunStatus::Completed,
            RunStatus::Aborted,
            RunStatus::Failed,
        ] {
            assert_eq!(RunStatus::from_db(s.as_db()), Some(s.clone()));
        }
        assert_eq!(StageStatus::from_db("nonsense"), None);
    }

    #[test]
    fn artifact_serializes_camel_case() {
        let a = StageArtifact {
            kind: ArtifactKind::Plan,
            text: "do the thing".into(),
            payload: None,
            refs_worktree: false,
        };
        let json = serde_json::to_string(&a).unwrap();
        assert!(json.contains("\"kind\":\"plan\""));
        assert!(json.contains("\"refsWorktree\":false"));
    }

    #[test]
    fn substrate_strings() {
        assert_eq!(AgentSubstrate::Api.as_db(), "api");
        assert_eq!(AgentSubstrate::from_db("cli"), Some(AgentSubstrate::Cli));
    }
}
```

- [ ] **Step 4: Run it to verify it fails**

Run: `cd src-tauri && cargo test orchestrator_types_tests 2>&1 | head -30`
Expected: FAIL — `types` is empty, `StageStatus` etc. unresolved.

- [ ] **Step 5: Implement the types**

Write `src-tauri/src/orchestrator/types.rs`:

```rust
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
}

/// A single tool invocation, captured for the run-event log.
#[derive(Serialize, Deserialize, Clone, Debug)]
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
}

/// What the user chose at a checkpoint.
#[derive(Clone, Debug)]
pub enum CheckpointAction {
    Approve,
    Reject {
        feedback: Option<String>,
        model_override: Option<String>,
    },
    /// Artifact was edited out-of-band; continue.
    Edit,
    Abort,
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd src-tauri && cargo test orchestrator_types_tests 2>&1 | tail -15`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/orchestrator src-tauri/src/lib.rs src-tauri/src/tests.rs
git commit -m "feat(direct): orchestrator domain types"
```

---

## Task 2: Headless agentic loop

**Files:**
- Modify: `src-tauri/src/chat_engine.rs` (export leaf helpers)
- Create: `src-tauri/src/orchestrator/agentic.rs`
- Test: `src-tauri/src/tests.rs`

- [ ] **Step 1: Export the leaf helpers from chat_engine**

In `src-tauri/src/chat_engine.rs`, change the visibility of the three standalone helpers from private to `pub(crate)` (signatures unchanged):

```rust
pub(crate) fn build_llm_tools() -> Vec<LlmTool> {
```
```rust
pub(crate) fn execute_tool(workspace_path: &Path, name: &str, input: &serde_json::Value) -> String {
```
```rust
pub(crate) fn resolve_provider(model: &str) -> AppResult<(Box<dyn LlmProvider>, String, Option<String>)> {
```

- [ ] **Step 2: Write the failing test**

In `src-tauri/src/tests.rs`, append:

```rust
#[cfg(test)]
mod agentic_loop_tests {
    use crate::orchestrator::agentic::run_agentic_loop;
    use crate::providers::{
        LlmProvider, LlmRequest, LlmResponse, LlmStopReason, LlmToolUse,
    };
    use parking_lot::Mutex;

    /// A provider that returns a scripted sequence of responses.
    struct ScriptedProvider {
        responses: Mutex<Vec<LlmResponse>>,
    }

    #[async_trait::async_trait]
    impl LlmProvider for ScriptedProvider {
        async fn complete(
            &self,
            _api_base: &str,
            _api_key: Option<&str>,
            _req: &LlmRequest,
            _client: &reqwest::Client,
        ) -> crate::error::AppResult<LlmResponse> {
            Ok(self.responses.lock().remove(0))
        }
    }

    #[tokio::test]
    async fn runs_tool_then_returns_final_text() {
        let tmp = tempfile::tempdir().unwrap();
        // 1st response: call list_files. 2nd: final text, end turn.
        let provider = ScriptedProvider {
            responses: Mutex::new(vec![
                LlmResponse {
                    text: String::new(),
                    tool_uses: vec![LlmToolUse {
                        id: "t1".into(),
                        name: "list_files".into(),
                        input: serde_json::json!({ "path": "." }),
                    }],
                    stop_reason: LlmStopReason::ToolUse,
                    input_tokens: 100,
                    output_tokens: 10,
                    cache_read_tokens: 0,
                    cache_creation_tokens: 0,
                },
                LlmResponse {
                    text: "All done.".into(),
                    tool_uses: vec![],
                    stop_reason: LlmStopReason::EndTurn,
                    input_tokens: 50,
                    output_tokens: 5,
                    cache_read_tokens: 0,
                    cache_creation_tokens: 0,
                },
            ]),
        };
        let client = reqwest::Client::new();
        let result = run_agentic_loop(
            &provider,
            "http://unused",
            None,
            &client,
            "test-model",
            "you are a test",
            "do something",
            tmp.path(),
            25,
        )
        .await
        .unwrap();

        assert_eq!(result.text, "All done.");
        assert_eq!(result.input_tokens, 150);
        assert_eq!(result.output_tokens, 15);
        assert_eq!(result.tool_calls.len(), 1);
        assert_eq!(result.tool_calls[0].name, "list_files");
    }
}
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd src-tauri && cargo test agentic_loop_tests 2>&1 | head -30`
Expected: FAIL — `run_agentic_loop` and `AgenticResult` unresolved.

- [ ] **Step 4: Implement run_agentic_loop**

Write `src-tauri/src/orchestrator/agentic.rs`:

```rust
//! Headless agentic tool-loop. Reuses the chat-engine leaf helpers
//! (`build_llm_tools`, `execute_tool`) but, unlike `chat_engine::send_agentic`,
//! it persists nothing and emits no events — it just runs and returns a result.

use crate::chat_engine::{build_llm_tools, execute_tool};
use crate::error::AppResult;
use crate::orchestrator::types::ToolCallLog;
use crate::providers::{
    LlmContent, LlmMessage, LlmProvider, LlmRequest, LlmRole, LlmStopReason, LlmToolResult,
};
use std::path::Path;

/// Aggregate result of a headless agentic run.
#[derive(Clone, Debug, Default)]
pub struct AgenticResult {
    pub text: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    pub tool_calls: Vec<ToolCallLog>,
}

/// Run the tool-use loop against `provider` until it returns a final answer
/// (or `max_iterations` is hit). Tools execute in `workspace_path`.
#[allow(clippy::too_many_arguments)]
pub async fn run_agentic_loop(
    provider: &dyn LlmProvider,
    api_base: &str,
    api_key: Option<&str>,
    client: &reqwest::Client,
    model: &str,
    system: &str,
    initial_user: &str,
    workspace_path: &Path,
    max_iterations: usize,
) -> AppResult<AgenticResult> {
    let tools = build_llm_tools();
    let mut messages: Vec<LlmMessage> = vec![LlmMessage {
        role: LlmRole::User,
        content: LlmContent::Text(initial_user.to_string()),
    }];
    let mut out = AgenticResult::default();

    for _ in 0..max_iterations {
        let req = LlmRequest {
            model: model.to_string(),
            max_tokens: 32768,
            system: system.to_string(),
            messages: messages.clone(),
            tools: tools.clone(),
        };
        let resp = provider.complete(api_base, api_key, &req, client).await?;
        out.input_tokens += resp.input_tokens;
        out.output_tokens += resp.output_tokens;
        out.cache_read_tokens += resp.cache_read_tokens;
        out.cache_creation_tokens += resp.cache_creation_tokens;

        let is_final =
            resp.stop_reason != LlmStopReason::ToolUse || resp.tool_uses.is_empty();

        // Truncation during tool use: feed back errors and retry (mirrors send_agentic).
        if matches!(resp.stop_reason, LlmStopReason::MaxTokens) && !resp.tool_uses.is_empty() {
            messages.push(LlmMessage {
                role: LlmRole::Assistant,
                content: LlmContent::AssistantWithTools {
                    text: resp.text.clone(),
                    tool_uses: resp.tool_uses.clone(),
                },
            });
            let errs: Vec<LlmToolResult> = resp
                .tool_uses
                .iter()
                .map(|u| LlmToolResult {
                    tool_use_id: u.id.clone(),
                    content: "ERROR: response truncated at max_tokens; retry with smaller output."
                        .into(),
                    is_error: true,
                })
                .collect();
            messages.push(LlmMessage {
                role: LlmRole::User,
                content: LlmContent::ToolResults(errs),
            });
            continue;
        }

        if is_final {
            out.text = resp.text.trim().to_string();
            return Ok(out);
        }

        // Record the assistant tool-use turn.
        messages.push(LlmMessage {
            role: LlmRole::Assistant,
            content: LlmContent::AssistantWithTools {
                text: resp.text.clone(),
                tool_uses: resp.tool_uses.clone(),
            },
        });

        // Execute each tool, collect results + log.
        let mut results: Vec<LlmToolResult> = Vec::new();
        for u in &resp.tool_uses {
            let result = execute_tool(workspace_path, &u.name, &u.input);
            out.tool_calls.push(ToolCallLog {
                name: u.name.clone(),
                input: u.input.clone(),
                result: result.clone(),
            });
            results.push(LlmToolResult {
                tool_use_id: u.id.clone(),
                content: result,
                is_error: false,
            });
        }
        messages.push(LlmMessage {
            role: LlmRole::User,
            content: LlmContent::ToolResults(results),
        });
    }

    out.text = format!("(agentic loop hit {max_iterations} iterations without finishing)");
    Ok(out)
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src-tauri && cargo test agentic_loop_tests 2>&1 | tail -15`
Expected: PASS.

- [ ] **Step 6: Verify chat tests still pass (no regression)**

Run: `cd src-tauri && cargo test chat 2>&1 | tail -15`
Expected: PASS (existing chat-related tests unaffected; only visibility of helpers changed).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/chat_engine.rs src-tauri/src/orchestrator/agentic.rs src-tauri/src/tests.rs
git commit -m "feat(direct): headless agentic loop reusing chat leaf helpers"
```

---

## Task 3: AgentRunner trait, prompt helpers, ApiRunner

**Files:**
- Create: `src-tauri/src/orchestrator/runner.rs`
- Test: `src-tauri/src/tests.rs`

- [ ] **Step 1: Write the failing test (pure helpers)**

In `src-tauri/src/tests.rs`, append:

```rust
#[cfg(test)]
mod runner_helpers_tests {
    use crate::orchestrator::runner::{artifact_kind_for, system_prompt_for, user_input_for};
    use crate::orchestrator::types::{ArtifactKind, StageArtifact};

    #[test]
    fn role_maps_to_artifact_kind() {
        assert_eq!(artifact_kind_for("plan"), ArtifactKind::Plan);
        assert_eq!(artifact_kind_for("plan_review"), ArtifactKind::Review);
        assert_eq!(artifact_kind_for("code_review"), ArtifactKind::Review);
        assert_eq!(artifact_kind_for("implement"), ArtifactKind::Diff);
        assert_eq!(artifact_kind_for("test"), ArtifactKind::Tests);
        assert_eq!(artifact_kind_for("anything-else"), ArtifactKind::Note);
    }

    #[test]
    fn system_prompt_is_role_specific() {
        assert!(system_prompt_for("plan").to_lowercase().contains("plan"));
        assert!(system_prompt_for("implement").to_lowercase().contains("implement"));
    }

    #[test]
    fn user_input_includes_task_and_prior_artifact() {
        let prior = StageArtifact {
            kind: ArtifactKind::Plan,
            text: "Step 1: do X".into(),
            payload: None,
            refs_worktree: false,
        };
        let input = user_input_for("implement", "Build feature Y", &prior, None);
        assert!(input.contains("Build feature Y"));
        assert!(input.contains("Step 1: do X"));

        let with_fb = user_input_for("implement", "Build Y", &prior, Some("be more careful"));
        assert!(with_fb.contains("be more careful"));
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd src-tauri && cargo test runner_helpers_tests 2>&1 | head -30`
Expected: FAIL — `runner` items unresolved.

- [ ] **Step 3: Implement runner.rs**

Write `src-tauri/src/orchestrator/runner.rs`:

```rust
//! The `AgentRunner` abstraction and its API-substrate implementation.

use crate::chat_engine::resolve_provider;
use crate::error::{AppError, AppResult};
use crate::orchestrator::agentic::run_agentic_loop;
use crate::orchestrator::types::{ArtifactKind, StageArtifact, StageOutcome, StageSpec, StageStatus};
use std::path::PathBuf;

const MAX_STAGE_ITERATIONS: usize = 25;

/// Everything a runner needs to execute one stage, beyond the `StageSpec`.
pub struct StageContext {
    pub workspace_path: PathBuf,
    /// The original run task (seed for stage 1, context for later stages).
    pub task: String,
    pub client: reqwest::Client,
}

/// Uniform execution contract — both API and (future) CLI substrates implement it.
#[async_trait::async_trait]
pub trait AgentRunner: Send + Sync {
    async fn run(
        &self,
        stage: &StageSpec,
        input: &StageArtifact,
        ctx: &StageContext,
    ) -> AppResult<StageOutcome>;
}

/// Map a stage role to the kind of artifact it produces.
pub fn artifact_kind_for(role: &str) -> ArtifactKind {
    match role {
        "plan" => ArtifactKind::Plan,
        "plan_review" | "code_review" | "critique" | "verify" => ArtifactKind::Review,
        "implement" | "fix" | "repro" | "refine" => ArtifactKind::Diff,
        "test" => ArtifactKind::Tests,
        _ => ArtifactKind::Note,
    }
}

/// Role-specific system prompt.
pub fn system_prompt_for(role: &str) -> String {
    match role {
        "plan" => "You are a senior engineer. Produce a concise, concrete implementation plan \
            for the task. Do not write code; describe the steps, files, and approach.",
        "plan_review" | "critique" => "You are a critical reviewer. Review the proposed plan for \
            gaps, risks, and better approaches. Be specific and concise.",
        "implement" | "fix" => "You are a skilled engineer. Implement the plan by editing files in \
            the workspace using your tools. Make the changes; do not just describe them.",
        "code_review" | "verify" => "You are a code reviewer. Inspect the current changes in the \
            workspace and report concrete issues. Do not modify files.",
        "test" => "You are a test engineer. Write unit tests for the recent changes using your \
            tools to create the test files. Run them if a test command is obvious.",
        "repro" => "You are a debugger. Reproduce the reported issue and describe the root cause.",
        "refine" => "You are an editor. Refine and finalize the plan based on the prior review.",
        _ => "You are a helpful engineering assistant working in the project workspace.",
    }
    .to_string()
}

/// Build the user message that seeds a stage from the task + the prior artifact.
pub fn user_input_for(
    role: &str,
    task: &str,
    prior: &StageArtifact,
    feedback: Option<&str>,
) -> String {
    let mut s = format!("Task: {task}\n\n");
    if !prior.text.trim().is_empty() {
        let label = match prior.kind {
            ArtifactKind::Plan => "Plan from the previous stage",
            ArtifactKind::Review => "Review findings from the previous stage",
            ArtifactKind::Tests => "Tests from the previous stage",
            ArtifactKind::Diff => "Summary of changes from the previous stage",
            ArtifactKind::Note => "Context",
        };
        s.push_str(&format!("{label}:\n{}\n\n", prior.text));
    }
    if prior.refs_worktree {
        s.push_str("The current code changes are present in the workspace; inspect them with your tools.\n\n");
    }
    if let Some(fb) = feedback {
        s.push_str(&format!("Reviewer feedback to address this time:\n{fb}\n\n"));
    }
    let _ = role; // role currently only affects system prompt; reserved for future shaping
    s
}

/// The API substrate: runs a stage through the in-app LLM tool-loop.
pub struct ApiRunner;

#[async_trait::async_trait]
impl AgentRunner for ApiRunner {
    async fn run(
        &self,
        stage: &StageSpec,
        input: &StageArtifact,
        ctx: &StageContext,
    ) -> AppResult<StageOutcome> {
        let (provider, api_base, api_key) = resolve_provider(&stage.agent_model)?;
        let system = system_prompt_for(&stage.role);
        let user = user_input_for(&stage.role, &ctx.task, input, stage.feedback.as_deref());

        let result = run_agentic_loop(
            provider.as_ref(),
            &api_base,
            api_key.as_deref(),
            &ctx.client,
            &stage.agent_model,
            &system,
            &user,
            &ctx.workspace_path,
            MAX_STAGE_ITERATIONS,
        )
        .await;

        match result {
            Ok(r) => {
                let cost = crate::orchestrator::cost::stage_cost(
                    &stage.agent_model,
                    r.input_tokens,
                    r.output_tokens,
                );
                let kind = artifact_kind_for(&stage.role);
                let refs_worktree = matches!(kind, ArtifactKind::Diff | ArtifactKind::Tests);
                Ok(StageOutcome {
                    artifact: StageArtifact {
                        kind,
                        text: r.text,
                        payload: None,
                        refs_worktree,
                    },
                    input_tokens: r.input_tokens,
                    output_tokens: r.output_tokens,
                    cost_usd: cost,
                    status: StageStatus::Done,
                    tool_calls: r.tool_calls,
                    error: None,
                })
            }
            Err(e) => Ok(StageOutcome {
                artifact: StageArtifact {
                    kind: ArtifactKind::Note,
                    text: String::new(),
                    payload: None,
                    refs_worktree: false,
                },
                input_tokens: 0,
                output_tokens: 0,
                cost_usd: 0.0,
                status: StageStatus::Failed,
                tool_calls: vec![],
                error: Some(e.to_string()),
            }),
        }
    }
}

/// Placeholder for the CLI substrate — implemented in Plan 2 (Phase C).
pub struct CliRunnerUnavailable;

#[async_trait::async_trait]
impl AgentRunner for CliRunnerUnavailable {
    async fn run(
        &self,
        _stage: &StageSpec,
        _input: &StageArtifact,
        _ctx: &StageContext,
    ) -> AppResult<StageOutcome> {
        Err(AppError::Other(
            "CLI substrate is not available yet (coming in a later phase)".into(),
        ))
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test runner_helpers_tests 2>&1 | tail -15`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/orchestrator/runner.rs src-tauri/src/tests.rs
git commit -m "feat(direct): AgentRunner trait + ApiRunner + prompt helpers"
```

---

## Task 4: Cost & baseline

**Files:**
- Create: `src-tauri/src/orchestrator/cost.rs`
- Test: `src-tauri/src/tests.rs`

- [ ] **Step 1: Write the failing test**

In `src-tauri/src/tests.rs`, append:

```rust
#[cfg(test)]
mod cost_tests {
    use crate::orchestrator::cost::{baseline_cost, stage_cost};

    #[test]
    fn stage_cost_matches_token_engine() {
        // claude-opus-4-6: $15/M input, $75/M output.
        let c = stage_cost("claude-opus-4-6", 1_000_000, 100_000);
        assert!((c - (15.0 + 7.5)).abs() < 0.01);
    }

    #[test]
    fn baseline_uses_reference_prices_on_actual_tokens() {
        // Same tokens, premium reference model → baseline >= actual for a cheaper model.
        let actual = stage_cost("claude-haiku-4-5", 1_000_000, 100_000);
        let base = baseline_cost("claude-opus-4-6", 1_000_000, 100_000);
        assert!(base > actual);
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd src-tauri && cargo test cost_tests 2>&1 | head -30`
Expected: FAIL — `cost` items unresolved.

- [ ] **Step 3: Implement cost.rs**

Write `src-tauri/src/orchestrator/cost.rs`:

```rust
//! Per-stage cost and the all-premium baseline used to show savings.

use crate::provider_router::ProviderRouter;

/// Actual cost of a stage given its model and token counts.
pub fn stage_cost(model: &str, input_tokens: u64, output_tokens: u64) -> f64 {
    crate::token_engine::compute_cost(model, input_tokens, output_tokens, 0, 0)
}

/// Baseline cost: the same token counts priced at the reference (premium) model.
pub fn baseline_cost(reference_model: &str, input_tokens: u64, output_tokens: u64) -> f64 {
    crate::token_engine::compute_cost(reference_model, input_tokens, output_tokens, 0, 0)
}

/// Pick the premium reference model: highest blended (input+output) price among
/// enabled providers. Returns `None` if no models are configured.
pub fn pick_reference_model() -> Option<String> {
    let router = ProviderRouter::load().ok()?;
    router
        .list_models()
        .into_iter()
        .max_by(|a, b| {
            let pa = a.model.input_cost_per_m + a.model.output_cost_per_m;
            let pb = b.model.input_cost_per_m + b.model.output_cost_per_m;
            pa.partial_cmp(&pb).unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|m| m.model.id)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test cost_tests 2>&1 | tail -15`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/orchestrator/cost.rs src-tauri/src/tests.rs
git commit -m "feat(direct): stage cost + premium baseline"
```

---

## Task 5: Database schema (five tables)

**Files:**
- Modify: `src-tauri/src/db.rs` (`migrate()` — extend the `execute_batch` CREATE TABLE block)
- Test: `src-tauri/src/tests.rs`

- [ ] **Step 1: Write the failing test**

In `src-tauri/src/tests.rs`, append:

```rust
#[cfg(test)]
mod direct_schema_tests {
    use crate::db::Db;
    use tempfile::NamedTempFile;

    fn test_db() -> Db {
        let tmp = NamedTempFile::new().unwrap();
        Db::open(tmp.path()).unwrap()
    }

    #[test]
    fn new_tables_exist() {
        let db = test_db();
        let conn = db.conn_ref();
        for table in ["pipelines", "pipeline_stages", "runs", "run_stages", "run_events"] {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(count, 1, "table {table} should exist");
        }
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd src-tauri && cargo test direct_schema_tests 2>&1 | head -30`
Expected: FAIL — tables not found (count 0).

- [ ] **Step 3: Add the tables to migrate()**

In `src-tauri/src/db.rs`, inside `migrate()`, append the following CREATE TABLE statements to the existing `self.conn.execute_batch(r#" ... "#)?;` block (just before the closing `"#`, after the `file_edits` index):

```sql
            CREATE TABLE IF NOT EXISTS pipelines (
                id           TEXT PRIMARY KEY,
                name         TEXT NOT NULL,
                description  TEXT NOT NULL DEFAULT '',
                is_builtin   INTEGER NOT NULL DEFAULT 0,
                created_at   TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS pipeline_stages (
                id            TEXT PRIMARY KEY,
                pipeline_id   TEXT NOT NULL,
                position      INTEGER NOT NULL,
                role          TEXT NOT NULL,
                agent_model   TEXT NOT NULL,
                substrate     TEXT NOT NULL,
                checkpoint    INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY(pipeline_id) REFERENCES pipelines(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_pipeline_stages_pipeline
                ON pipeline_stages(pipeline_id, position);

            CREATE TABLE IF NOT EXISTS runs (
                id               TEXT PRIMARY KEY,
                workspace_id     TEXT NOT NULL,
                pipeline_id      TEXT NOT NULL,
                task             TEXT NOT NULL DEFAULT '',
                status           TEXT NOT NULL,
                cost_usd         REAL NOT NULL DEFAULT 0,
                baseline_usd     REAL NOT NULL DEFAULT 0,
                reference_model  TEXT,
                linked_issue_key TEXT,
                created_at       TEXT NOT NULL,
                finished_at      TEXT,
                FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_runs_workspace
                ON runs(workspace_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS run_stages (
                id            TEXT PRIMARY KEY,
                run_id        TEXT NOT NULL,
                position      INTEGER NOT NULL,
                role          TEXT NOT NULL,
                agent_model   TEXT NOT NULL,
                substrate     TEXT NOT NULL,
                checkpoint    INTEGER NOT NULL DEFAULT 0,
                status        TEXT NOT NULL DEFAULT 'pending',
                input_tokens  INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                cost_usd      REAL NOT NULL DEFAULT 0,
                artifact      TEXT,
                feedback      TEXT,
                error         TEXT,
                started_at    TEXT,
                finished_at   TEXT,
                FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_run_stages_run
                ON run_stages(run_id, position);

            CREATE TABLE IF NOT EXISTS run_events (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id      TEXT NOT NULL,
                timestamp   TEXT NOT NULL,
                kind        TEXT NOT NULL,
                payload     TEXT NOT NULL DEFAULT '{}',
                FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_run_events_run
                ON run_events(run_id, id);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test direct_schema_tests 2>&1 | tail -15`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db.rs src-tauri/src/tests.rs
git commit -m "feat(direct): pipelines/runs schema (5 tables)"
```

---

## Task 6: DB row structs + pipeline CRUD + builtin seeding

**Files:**
- Modify: `src-tauri/src/db.rs` (append row structs + `impl Db` methods)
- Test: `src-tauri/src/tests.rs`

- [ ] **Step 1: Write the failing test**

In `src-tauri/src/tests.rs`, append:

```rust
#[cfg(test)]
mod pipeline_crud_tests {
    use crate::db::Db;
    use tempfile::NamedTempFile;

    fn test_db() -> Db {
        let tmp = NamedTempFile::new().unwrap();
        Db::open(tmp.path()).unwrap()
    }

    #[test]
    fn seed_is_idempotent_and_lists_three() {
        let db = test_db();
        db.seed_builtin_pipelines().unwrap();
        db.seed_builtin_pipelines().unwrap(); // second call must not duplicate
        let pipelines = db.list_pipelines().unwrap();
        assert_eq!(pipelines.len(), 3);

        let feature = pipelines.iter().find(|p| p.name == "Feature Factory").unwrap();
        let stages = db.get_pipeline_stages(&feature.id).unwrap();
        assert_eq!(stages.len(), 5);
        assert_eq!(stages[0].position, 0);
        assert_eq!(stages[0].role, "plan");
        // implement/code_review/test default to checkpoint=on, plan/plan_review off.
        let implement = stages.iter().find(|s| s.role == "implement").unwrap();
        assert!(implement.checkpoint);
        let plan = stages.iter().find(|s| s.role == "plan").unwrap();
        assert!(!plan.checkpoint);
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd src-tauri && cargo test pipeline_crud_tests 2>&1 | head -30`
Expected: FAIL — methods/structs unresolved.

- [ ] **Step 3: Implement row structs + methods**

In `src-tauri/src/db.rs`, ensure `use uuid::Uuid;` is present at the top (add it if missing). Then append, inside the existing `impl Db { ... }` block (before its closing brace), the row structs and methods. Place the structs at module level (outside `impl Db`), near the other `*Row` structs:

```rust
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PipelineRow {
    pub id: String,
    pub name: String,
    pub description: String,
    pub is_builtin: bool,
    pub created_at: String,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PipelineStageRow {
    pub id: String,
    pub pipeline_id: String,
    pub position: i64,
    pub role: String,
    pub agent_model: String,
    pub substrate: String,
    pub checkpoint: bool,
}
```

Inside `impl Db`:

```rust
pub fn list_pipelines(&self) -> AppResult<Vec<PipelineRow>> {
    let mut stmt = self.conn.prepare(
        "SELECT id, name, description, is_builtin, created_at FROM pipelines ORDER BY is_builtin DESC, name",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(PipelineRow {
            id: r.get(0)?,
            name: r.get(1)?,
            description: r.get(2)?,
            is_builtin: r.get::<_, i64>(3)? != 0,
            created_at: r.get(4)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

pub fn get_pipeline_stages(&self, pipeline_id: &str) -> AppResult<Vec<PipelineStageRow>> {
    let mut stmt = self.conn.prepare(
        "SELECT id, pipeline_id, position, role, agent_model, substrate, checkpoint
         FROM pipeline_stages WHERE pipeline_id = ?1 ORDER BY position",
    )?;
    let rows = stmt.query_map(params![pipeline_id], |r| {
        Ok(PipelineStageRow {
            id: r.get(0)?,
            pipeline_id: r.get(1)?,
            position: r.get(2)?,
            role: r.get(3)?,
            agent_model: r.get(4)?,
            substrate: r.get(5)?,
            checkpoint: r.get::<_, i64>(6)? != 0,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

pub fn insert_pipeline(
    &self,
    name: &str,
    description: &str,
    is_builtin: bool,
) -> AppResult<String> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    self.conn.execute(
        "INSERT INTO pipelines (id, name, description, is_builtin, created_at)
         VALUES (?1,?2,?3,?4,?5)",
        params![id, name, description, is_builtin as i64, now],
    )?;
    Ok(id)
}

pub fn insert_pipeline_stage(
    &self,
    pipeline_id: &str,
    position: i64,
    role: &str,
    agent_model: &str,
    substrate: &str,
    checkpoint: bool,
) -> AppResult<String> {
    let id = Uuid::new_v4().to_string();
    self.conn.execute(
        "INSERT INTO pipeline_stages (id, pipeline_id, position, role, agent_model, substrate, checkpoint)
         VALUES (?1,?2,?3,?4,?5,?6,?7)",
        params![id, pipeline_id, position, role, agent_model, substrate, checkpoint as i64],
    )?;
    Ok(id)
}

/// Insert the three curated pipelines if they are not already present.
/// Idempotent: keyed on the builtin name.
pub fn seed_builtin_pipelines(&self) -> AppResult<()> {
    // (name, description, [(role, model, substrate, checkpoint)])
    let defs: &[(&str, &str, &[(&str, &str, &str, bool)])] = &[
        (
            "Feature Factory",
            "Full build: plan, review, implement, review, test.",
            &[
                ("plan", "claude-haiku-4-5", "api", false),
                ("plan_review", "claude-haiku-4-5", "api", false),
                ("implement", "claude-sonnet-4-6", "api", true),
                ("code_review", "claude-haiku-4-5", "api", true),
                ("test", "claude-haiku-4-5", "api", true),
            ],
        ),
        (
            "Bugfix relay",
            "Reproduce, fix, verify. Lean and fast.",
            &[
                ("repro", "claude-haiku-4-5", "api", false),
                ("fix", "claude-sonnet-4-6", "api", true),
                ("verify", "claude-haiku-4-5", "api", true),
            ],
        ),
        (
            "Plan & review",
            "Thinking only — no code is written.",
            &[
                ("plan", "claude-sonnet-4-6", "api", false),
                ("critique", "claude-haiku-4-5", "api", false),
                ("refine", "claude-sonnet-4-6", "api", true),
            ],
        ),
    ];

    for (name, desc, stages) in defs {
        let exists: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM pipelines WHERE name = ?1 AND is_builtin = 1",
            params![name],
            |r| r.get(0),
        )?;
        if exists > 0 {
            continue;
        }
        let pid = self.insert_pipeline(name, desc, true)?;
        for (i, (role, model, substrate, checkpoint)) in stages.iter().enumerate() {
            self.insert_pipeline_stage(&pid, i as i64, role, model, substrate, *checkpoint)?;
        }
    }
    Ok(())
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test pipeline_crud_tests 2>&1 | tail -15`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db.rs src-tauri/src/tests.rs
git commit -m "feat(direct): pipeline CRUD + builtin template seeding"
```

---

## Task 7: DB run CRUD

**Files:**
- Modify: `src-tauri/src/db.rs`
- Test: `src-tauri/src/tests.rs`

- [ ] **Step 1: Write the failing test**

In `src-tauri/src/tests.rs`, append:

```rust
#[cfg(test)]
mod run_crud_tests {
    use crate::db::Db;
    use tempfile::NamedTempFile;

    fn test_db() -> Db {
        let tmp = NamedTempFile::new().unwrap();
        Db::open(tmp.path()).unwrap()
    }

    // Minimal project+workspace so the runs FK is satisfied.
    fn seed_workspace(db: &Db) -> String {
        let now = chrono::Utc::now().to_rfc3339();
        db.conn_ref()
            .execute(
                "INSERT INTO projects (id,name,path,created_at,last_opened) VALUES ('p1','P','/tmp/p',?1,?1)",
                [&now],
            )
            .unwrap();
        db.conn_ref()
            .execute(
                "INSERT INTO workspaces (id,project_id,name,branch,created_at,last_active)
                 VALUES ('w1','p1','W','main',?1,?1)",
                [&now],
            )
            .unwrap();
        "w1".to_string()
    }

    #[test]
    fn create_run_copies_stages_and_lists() {
        let db = test_db();
        let ws = seed_workspace(&db);
        db.seed_builtin_pipelines().unwrap();
        let pipelines = db.list_pipelines().unwrap();
        let ff = pipelines.iter().find(|p| p.name == "Feature Factory").unwrap();

        let run_id = db
            .create_run(&ws, &ff.id, "build the thing", Some("claude-opus-4-6"), None)
            .unwrap();

        let run = db.get_run(&run_id).unwrap().unwrap();
        assert_eq!(run.status, "draft");
        assert_eq!(run.task, "build the thing");

        let stages = db.list_run_stages(&run_id).unwrap();
        assert_eq!(stages.len(), 5);
        assert_eq!(stages[0].status, "pending");

        let runs = db.list_runs(&ws).unwrap();
        assert_eq!(runs.len(), 1);
    }

    #[test]
    fn complete_stage_persists_outcome_and_status() {
        let db = test_db();
        let ws = seed_workspace(&db);
        db.seed_builtin_pipelines().unwrap();
        let ff = db.list_pipelines().unwrap().into_iter().find(|p| p.name == "Feature Factory").unwrap();
        let run_id = db.create_run(&ws, &ff.id, "t", None, None).unwrap();
        let stages = db.list_run_stages(&run_id).unwrap();
        let first = &stages[0];

        db.complete_run_stage(&first.id, "done", 100, 20, 0.5, Some("{\"kind\":\"plan\",\"text\":\"x\"}"))
            .unwrap();
        let reloaded = db.list_run_stages(&run_id).unwrap();
        assert_eq!(reloaded[0].status, "done");
        assert_eq!(reloaded[0].input_tokens, 100);
        assert!((reloaded[0].cost_usd - 0.5).abs() < 1e-9);

        db.set_run_status(&run_id, "completed", true).unwrap();
        assert_eq!(db.get_run(&run_id).unwrap().unwrap().status, "completed");
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd src-tauri && cargo test run_crud_tests 2>&1 | head -30`
Expected: FAIL — methods unresolved.

- [ ] **Step 3: Implement run row structs + methods**

In `src-tauri/src/db.rs`, add module-level row structs near the others:

```rust
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunRow {
    pub id: String,
    pub workspace_id: String,
    pub pipeline_id: String,
    pub task: String,
    pub status: String,
    pub cost_usd: f64,
    pub baseline_usd: f64,
    pub reference_model: Option<String>,
    pub linked_issue_key: Option<String>,
    pub created_at: String,
    pub finished_at: Option<String>,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RunStageRow {
    pub id: String,
    pub run_id: String,
    pub position: i64,
    pub role: String,
    pub agent_model: String,
    pub substrate: String,
    pub checkpoint: bool,
    pub status: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost_usd: f64,
    pub artifact: Option<String>,
    pub feedback: Option<String>,
    pub error: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}
```

Inside `impl Db`:

```rust
/// Create a run and copy the pipeline's stages into `run_stages` (a private copy
/// so later edits to the template don't mutate run history).
pub fn create_run(
    &self,
    workspace_id: &str,
    pipeline_id: &str,
    task: &str,
    reference_model: Option<&str>,
    linked_issue_key: Option<&str>,
) -> AppResult<String> {
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    self.conn.execute(
        "INSERT INTO runs (id, workspace_id, pipeline_id, task, status, reference_model, linked_issue_key, created_at)
         VALUES (?1,?2,?3,?4,'draft',?5,?6,?7)",
        params![id, workspace_id, pipeline_id, task, reference_model, linked_issue_key, now],
    )?;
    let stages = self.get_pipeline_stages(pipeline_id)?;
    for s in &stages {
        let sid = Uuid::new_v4().to_string();
        self.conn.execute(
            "INSERT INTO run_stages (id, run_id, position, role, agent_model, substrate, checkpoint, status)
             VALUES (?1,?2,?3,?4,?5,?6,?7,'pending')",
            params![sid, id, s.position, s.role, s.agent_model, s.substrate, s.checkpoint as i64],
        )?;
    }
    Ok(id)
}

pub fn get_run(&self, run_id: &str) -> AppResult<Option<RunRow>> {
    self.conn
        .query_row(
            "SELECT id, workspace_id, pipeline_id, task, status, cost_usd, baseline_usd,
                    reference_model, linked_issue_key, created_at, finished_at
             FROM runs WHERE id = ?1",
            params![run_id],
            |r| {
                Ok(RunRow {
                    id: r.get(0)?,
                    workspace_id: r.get(1)?,
                    pipeline_id: r.get(2)?,
                    task: r.get(3)?,
                    status: r.get(4)?,
                    cost_usd: r.get(5)?,
                    baseline_usd: r.get(6)?,
                    reference_model: r.get(7)?,
                    linked_issue_key: r.get(8)?,
                    created_at: r.get(9)?,
                    finished_at: r.get(10)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
}

pub fn list_runs(&self, workspace_id: &str) -> AppResult<Vec<RunRow>> {
    let mut stmt = self.conn.prepare(
        "SELECT id, workspace_id, pipeline_id, task, status, cost_usd, baseline_usd,
                reference_model, linked_issue_key, created_at, finished_at
         FROM runs WHERE workspace_id = ?1 ORDER BY created_at DESC",
    )?;
    let rows = stmt.query_map(params![workspace_id], |r| {
        Ok(RunRow {
            id: r.get(0)?,
            workspace_id: r.get(1)?,
            pipeline_id: r.get(2)?,
            task: r.get(3)?,
            status: r.get(4)?,
            cost_usd: r.get(5)?,
            baseline_usd: r.get(6)?,
            reference_model: r.get(7)?,
            linked_issue_key: r.get(8)?,
            created_at: r.get(9)?,
            finished_at: r.get(10)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

pub fn list_run_stages(&self, run_id: &str) -> AppResult<Vec<RunStageRow>> {
    let mut stmt = self.conn.prepare(
        "SELECT id, run_id, position, role, agent_model, substrate, checkpoint, status,
                input_tokens, output_tokens, cost_usd, artifact, feedback, error, started_at, finished_at
         FROM run_stages WHERE run_id = ?1 ORDER BY position",
    )?;
    let rows = stmt.query_map(params![run_id], |r| {
        Ok(RunStageRow {
            id: r.get(0)?,
            run_id: r.get(1)?,
            position: r.get(2)?,
            role: r.get(3)?,
            agent_model: r.get(4)?,
            substrate: r.get(5)?,
            checkpoint: r.get::<_, i64>(6)? != 0,
            status: r.get(7)?,
            input_tokens: r.get(8)?,
            output_tokens: r.get(9)?,
            cost_usd: r.get(10)?,
            artifact: r.get(11)?,
            feedback: r.get(12)?,
            error: r.get(13)?,
            started_at: r.get(14)?,
            finished_at: r.get(15)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

pub fn set_run_status(&self, run_id: &str, status: &str, finished: bool) -> AppResult<()> {
    if finished {
        let now = Utc::now().to_rfc3339();
        self.conn.execute(
            "UPDATE runs SET status = ?2, finished_at = ?3 WHERE id = ?1",
            params![run_id, status, now],
        )?;
    } else {
        self.conn.execute(
            "UPDATE runs SET status = ?2 WHERE id = ?1",
            params![run_id, status],
        )?;
    }
    Ok(())
}

pub fn set_run_cost(&self, run_id: &str, cost_usd: f64, baseline_usd: f64) -> AppResult<()> {
    self.conn.execute(
        "UPDATE runs SET cost_usd = ?2, baseline_usd = ?3 WHERE id = ?1",
        params![run_id, cost_usd, baseline_usd],
    )?;
    Ok(())
}

pub fn set_run_stage_status(&self, stage_id: &str, status: &str) -> AppResult<()> {
    let now = Utc::now().to_rfc3339();
    // Stamp started_at the first time it goes running.
    self.conn.execute(
        "UPDATE run_stages SET status = ?2,
            started_at = COALESCE(started_at, CASE WHEN ?2 = 'running' THEN ?3 ELSE started_at END)
         WHERE id = ?1",
        params![stage_id, status, now],
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn complete_run_stage(
    &self,
    stage_id: &str,
    status: &str,
    input_tokens: i64,
    output_tokens: i64,
    cost_usd: f64,
    artifact_json: Option<&str>,
) -> AppResult<()> {
    let now = Utc::now().to_rfc3339();
    self.conn.execute(
        "UPDATE run_stages
         SET status = ?2, input_tokens = ?3, output_tokens = ?4, cost_usd = ?5,
             artifact = ?6, finished_at = ?7
         WHERE id = ?1",
        params![stage_id, status, input_tokens, output_tokens, cost_usd, artifact_json, now],
    )?;
    Ok(())
}

pub fn fail_run_stage(&self, stage_id: &str, error: &str) -> AppResult<()> {
    let now = Utc::now().to_rfc3339();
    self.conn.execute(
        "UPDATE run_stages SET status = 'failed', error = ?2, finished_at = ?3 WHERE id = ?1",
        params![stage_id, error, now],
    )?;
    Ok(())
}

/// Reset a stage to pending (for re-run), optionally overriding its model and
/// recording reviewer feedback. Clears the prior artifact/error/finish time.
pub fn reset_run_stage(
    &self,
    stage_id: &str,
    model_override: Option<&str>,
    feedback: Option<&str>,
) -> AppResult<()> {
    if let Some(model) = model_override {
        self.conn.execute(
            "UPDATE run_stages SET agent_model = ?2 WHERE id = ?1",
            params![stage_id, model],
        )?;
    }
    self.conn.execute(
        "UPDATE run_stages
         SET status = 'pending', artifact = NULL, error = NULL, finished_at = NULL,
             input_tokens = 0, output_tokens = 0, cost_usd = 0, feedback = ?2
         WHERE id = ?1",
        params![stage_id, feedback],
    )?;
    Ok(())
}

pub fn set_run_stage_artifact(&self, stage_id: &str, artifact_json: &str) -> AppResult<()> {
    self.conn.execute(
        "UPDATE run_stages SET artifact = ?2 WHERE id = ?1",
        params![stage_id, artifact_json],
    )?;
    Ok(())
}

pub fn insert_run_event(&self, run_id: &str, kind: &str, payload_json: &str) -> AppResult<()> {
    let now = Utc::now().to_rfc3339();
    self.conn.execute(
        "INSERT INTO run_events (run_id, timestamp, kind, payload) VALUES (?1,?2,?3,?4)",
        params![run_id, now, kind, payload_json],
    )?;
    Ok(())
}

/// Sum of completed-stage costs and baselines for a run.
pub fn run_cost_totals(&self, run_id: &str) -> AppResult<(f64, f64)> {
    let cost: f64 = self
        .conn
        .query_row(
            "SELECT COALESCE(SUM(cost_usd),0) FROM run_stages WHERE run_id = ?1",
            params![run_id],
            |r| r.get(0),
        )
        .unwrap_or(0.0);
    Ok((cost, 0.0)) // baseline filled by the orchestrator (needs token re-pricing)
}
```

`.optional()` comes from `rusqlite::OptionalExtension`, already imported in `db.rs`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test run_crud_tests 2>&1 | tail -20`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/db.rs src-tauri/src/tests.rs
git commit -m "feat(direct): run + run_stage CRUD"
```

---

## Task 8: EventSink + Orchestrator state machine

**Files:**
- Create: `src-tauri/src/orchestrator/events.rs`
- Modify: `src-tauri/src/orchestrator/mod.rs` (add the `Orchestrator`)
- Test: `src-tauri/src/tests.rs`

- [ ] **Step 1: Implement the EventSink indirection**

Write `src-tauri/src/orchestrator/events.rs`:

```rust
//! Event emission indirection so the orchestrator is testable without a Tauri AppHandle.

use serde_json::Value;

pub trait EventSink: Send + Sync {
    fn emit(&self, event: &str, payload: Value);
}

/// Production sink — forwards to the Tauri frontend.
pub struct TauriEventSink {
    pub app: tauri::AppHandle,
}

impl EventSink for TauriEventSink {
    fn emit(&self, event: &str, payload: Value) {
        use tauri::Emitter;
        let _ = self.app.emit(event, payload);
    }
}
```

- [ ] **Step 2: Write the failing test (a CollectingSink + MockRunner)**

In `src-tauri/src/tests.rs`, append:

```rust
#[cfg(test)]
mod orchestrator_tests {
    use crate::db::Db;
    use crate::orchestrator::events::EventSink;
    use crate::orchestrator::runner::{AgentRunner, StageContext};
    use crate::orchestrator::types::*;
    use crate::orchestrator::Orchestrator;
    use parking_lot::Mutex;
    use serde_json::Value;
    use std::sync::Arc;
    use tempfile::NamedTempFile;

    struct CollectingSink {
        events: Mutex<Vec<String>>,
    }
    impl EventSink for CollectingSink {
        fn emit(&self, event: &str, _payload: Value) {
            self.events.lock().push(event.to_string());
        }
    }

    /// A runner that always succeeds with a canned artifact.
    struct MockRunner;
    #[async_trait::async_trait]
    impl AgentRunner for MockRunner {
        async fn run(
            &self,
            stage: &StageSpec,
            _input: &StageArtifact,
            _ctx: &StageContext,
        ) -> crate::error::AppResult<StageOutcome> {
            Ok(StageOutcome {
                artifact: StageArtifact {
                    kind: ArtifactKind::Note,
                    text: format!("did {}", stage.role),
                    payload: None,
                    refs_worktree: false,
                },
                input_tokens: 10,
                output_tokens: 2,
                cost_usd: 0.01,
                status: StageStatus::Done,
                tool_calls: vec![],
                error: None,
            })
        }
    }

    fn db_with_workspace() -> (Arc<Mutex<Db>>, String) {
        let tmp = NamedTempFile::new().unwrap();
        let db = Db::open(tmp.path()).unwrap();
        let now = chrono::Utc::now().to_rfc3339();
        db.conn_ref().execute(
            "INSERT INTO projects (id,name,path,created_at,last_opened) VALUES ('p1','P','/tmp/p',?1,?1)",
            [&now]).unwrap();
        db.conn_ref().execute(
            "INSERT INTO workspaces (id,project_id,name,branch,worktree_path,created_at,last_active)
             VALUES ('w1','p1','W','main','/tmp',?1,?1)", [&now]).unwrap();
        db.seed_builtin_pipelines().unwrap();
        (Arc::new(Mutex::new(db)), "w1".to_string())
    }

    #[tokio::test]
    async fn run_pauses_at_first_checkpoint_then_completes() {
        let (db, ws) = db_with_workspace();
        let ff = db.lock().list_pipelines().unwrap().into_iter()
            .find(|p| p.name == "Feature Factory").unwrap();
        let run_id = db.lock().create_run(&ws, &ff.id, "build it", None, None).unwrap();

        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Orchestrator::new_with_runner(
            Arc::clone(&db),
            sink.clone(),
            Box::new(MockRunner),
        );

        // Drive to the first pause. Feature Factory: plan(no cp), plan_review(no cp),
        // implement(cp) -> should pause after implement.
        let status = orch.run_to_pause(&run_id).await.unwrap();
        assert_eq!(status, RunStatus::Paused);
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(stages[0].status, "done");           // plan
        assert_eq!(stages[1].status, "done");           // plan_review
        assert_eq!(stages[2].status, "awaiting_checkpoint"); // implement
        assert_eq!(stages[3].status, "pending");        // code_review

        // Approve the implement checkpoint -> runs code_review, pauses there (cp on).
        let status = orch
            .resolve_checkpoint(&run_id, CheckpointAction::Approve)
            .await
            .unwrap();
        assert_eq!(status, RunStatus::Paused);
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(stages[2].status, "done");
        assert_eq!(stages[3].status, "awaiting_checkpoint"); // code_review

        // Approve code_review -> test pauses (cp on).
        orch.resolve_checkpoint(&run_id, CheckpointAction::Approve).await.unwrap();
        // Approve test (last stage) -> completed.
        let status = orch.resolve_checkpoint(&run_id, CheckpointAction::Approve).await.unwrap();
        assert_eq!(status, RunStatus::Completed);
        assert_eq!(db.lock().get_run(&run_id).unwrap().unwrap().status, "completed");

        // Cost accumulated across 5 stages * 0.01.
        let run = db.lock().get_run(&run_id).unwrap().unwrap();
        assert!((run.cost_usd - 0.05).abs() < 1e-6);
    }

    #[tokio::test]
    async fn reject_reruns_same_stage() {
        let (db, ws) = db_with_workspace();
        let pr = db.lock().list_pipelines().unwrap().into_iter()
            .find(|p| p.name == "Plan & review").unwrap();
        let run_id = db.lock().create_run(&ws, &pr.id, "think", None, None).unwrap();
        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Orchestrator::new_with_runner(Arc::clone(&db), sink, Box::new(MockRunner));

        // plan(no cp), critique(no cp), refine(cp) -> pause at refine.
        let status = orch.run_to_pause(&run_id).await.unwrap();
        assert_eq!(status, RunStatus::Paused);
        // Reject refine with feedback -> it returns to pending, then re-runs and pauses again.
        let status = orch.resolve_checkpoint(&run_id, CheckpointAction::Reject {
            feedback: Some("tighten it".into()),
            model_override: None,
        }).await.unwrap();
        assert_eq!(status, RunStatus::Paused);
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(stages[2].role, "refine");
        assert_eq!(stages[2].status, "awaiting_checkpoint"); // re-ran, awaiting again
        assert_eq!(stages[2].feedback.as_deref(), Some("tighten it"));
    }

    #[tokio::test]
    async fn abort_stops_the_run() {
        let (db, ws) = db_with_workspace();
        let ff = db.lock().list_pipelines().unwrap().into_iter()
            .find(|p| p.name == "Feature Factory").unwrap();
        let run_id = db.lock().create_run(&ws, &ff.id, "x", None, None).unwrap();
        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Orchestrator::new_with_runner(Arc::clone(&db), sink, Box::new(MockRunner));
        orch.run_to_pause(&run_id).await.unwrap();
        let status = orch.resolve_checkpoint(&run_id, CheckpointAction::Abort).await.unwrap();
        assert_eq!(status, RunStatus::Aborted);
        assert_eq!(db.lock().get_run(&run_id).unwrap().unwrap().status, "aborted");
    }
}
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd src-tauri && cargo test orchestrator_tests 2>&1 | head -30`
Expected: FAIL — `Orchestrator` unresolved.

- [ ] **Step 4: Implement the Orchestrator**

Append to `src-tauri/src/orchestrator/mod.rs`:

```rust
use crate::db::{Db, RunStageRow};
use crate::error::{AppError, AppResult};
use crate::orchestrator::events::EventSink;
use crate::orchestrator::runner::{ApiRunner, CliRunnerUnavailable, AgentRunner, StageContext};
use crate::orchestrator::types::*;
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
            self.events
                .emit("run://stage-update", serde_json::json!({ "runId": run_id, "run": run }));
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
        let spec = StageSpec {
            position: stage.position,
            role: stage.role.clone(),
            agent_model: stage.agent_model.clone(),
            substrate: AgentSubstrate::from_db(&stage.substrate)
                .unwrap_or(AgentSubstrate::Api),
            checkpoint: stage.checkpoint,
            feedback: stage.feedback.clone(),
        };

        // Input artifact = the previous done stage's artifact, or a seed Note from the task.
        let input = self.previous_artifact(&run.id, stage.position, &run.task)?;

        self.db.lock().set_run_stage_status(&stage.id, "running")?;
        self.emit_run_update(&run.id);

        let ctx = StageContext {
            workspace_path: self.workspace_path(run)?,
            task: run.task.clone(),
            client: self.client.clone(),
        };

        let outcome = match &self.test_runner {
            Some(r) => r.run(&spec, &input, &ctx).await?,
            None => self.runner_for(&spec.substrate).run(&spec, &input, &ctx).await?,
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
        let run = self.db.lock().get_run(run_id)?
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
        self.db.lock().set_run_status(run_id, "running", false)?;
        self.emit_run_update(run_id);

        loop {
            let run = self.db.lock().get_run(run_id)?
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
            // Only "pending" stages run; anything else means we're blocked.
            if stage.status != "pending" {
                return Ok(RunStatus::Paused);
            }

            let status = self.run_stage_once(&run, stage).await?;
            self.emit_run_update(run_id);

            match status {
                StageStatus::Failed => {
                    self.db.lock().set_run_status(run_id, "paused", false)?;
                    self.emit_checkpoint(run_id, &stage.id);
                    return Ok(RunStatus::Paused);
                }
                StageStatus::Done if stage.checkpoint => {
                    self.db.lock().set_run_stage_status(&stage.id, "awaiting_checkpoint")?;
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
```

- [ ] **Step 5: Add the `conn_ref_path` DB helper used by `workspace_path`**

In `src-tauri/src/db.rs`, inside `impl Db`:

```rust
/// The worktree path for a workspace (None if not yet created).
pub fn conn_ref_path(&self, workspace_id: &str) -> AppResult<Option<String>> {
    self.conn
        .query_row(
            "SELECT worktree_path FROM workspaces WHERE id = ?1",
            params![workspace_id],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()
        .map(|opt| opt.flatten())
        .map_err(Into::into)
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd src-tauri && cargo test orchestrator_tests 2>&1 | tail -25`
Expected: PASS (3 tests).

- [ ] **Step 7: Run the whole suite (no regressions)**

Run: `cd src-tauri && cargo test 2>&1 | tail -25`
Expected: PASS (all tests).

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/orchestrator src-tauri/src/db.rs src-tauri/src/tests.rs
git commit -m "feat(direct): orchestrator state machine with checkpoints"
```

---

## Task 9: IPC commands + state registration

**Files:**
- Modify: `src-tauri/src/commands.rs` (new commands)
- Modify: `src-tauri/src/lib.rs` (manage `Orchestrator`, seed builtins, register commands)
- Test: `cargo build` (compile) + manual smoke is deferred to Plan 2

- [ ] **Step 1: Add the commands**

In `src-tauri/src/commands.rs`, add (near the chat commands). Note: the `Orchestrator` is its own Tauri-managed state (`State<'_, Arc<Orchestrator>>`).

```rust
use crate::orchestrator::types::CheckpointAction;
use crate::orchestrator::Orchestrator;
use std::sync::Arc;

#[tauri::command]
pub async fn list_pipelines(
    state: State<'_, AppState>,
) -> AppResult<Vec<serde_json::Value>> {
    let db = state.db.lock();
    let pipelines = db.list_pipelines()?;
    let mut out = Vec::new();
    for p in pipelines {
        let stages = db.get_pipeline_stages(&p.id)?;
        out.push(serde_json::json!({ "pipeline": p, "stages": stages }));
    }
    Ok(out)
}

#[tauri::command]
pub async fn get_pipeline(
    state: State<'_, AppState>,
    pipeline_id: String,
) -> AppResult<serde_json::Value> {
    let db = state.db.lock();
    let stages = db.get_pipeline_stages(&pipeline_id)?;
    Ok(serde_json::json!({ "stages": stages }))
}

#[tauri::command]
pub async fn create_run(
    state: State<'_, AppState>,
    workspace_id: String,
    pipeline_id: String,
    task: String,
    reference_model: Option<String>,
    linked_issue_key: Option<String>,
) -> AppResult<String> {
    state.db.lock().create_run(
        &workspace_id,
        &pipeline_id,
        &task,
        reference_model.as_deref(),
        linked_issue_key.as_deref(),
    )
}

#[tauri::command]
pub async fn start_run(
    orch: State<'_, Arc<Orchestrator>>,
    run_id: String,
) -> AppResult<()> {
    Arc::clone(&orch).start_run(run_id);
    Ok(())
}

#[tauri::command]
pub async fn get_run(
    state: State<'_, AppState>,
    run_id: String,
) -> AppResult<serde_json::Value> {
    let db = state.db.lock();
    let run = db.get_run(&run_id)?;
    let stages = db.list_run_stages(&run_id)?;
    Ok(serde_json::json!({ "run": run, "stages": stages }))
}

#[tauri::command]
pub async fn list_runs(
    state: State<'_, AppState>,
    workspace_id: String,
) -> AppResult<Vec<crate::db::RunRow>> {
    state.db.lock().list_runs(&workspace_id)
}

#[tauri::command]
pub async fn resolve_checkpoint(
    orch: State<'_, Arc<Orchestrator>>,
    run_id: String,
    action: String,
    feedback: Option<String>,
    model_override: Option<String>,
) -> AppResult<()> {
    let action = match action.as_str() {
        "approve" => CheckpointAction::Approve,
        "edit" => CheckpointAction::Edit,
        "abort" => CheckpointAction::Abort,
        "reject" => CheckpointAction::Reject { feedback, model_override },
        other => return Err(crate::error::AppError::Other(format!("unknown action: {other}"))),
    };
    let orch = Arc::clone(&orch);
    let run_id2 = run_id.clone();
    // Drive in the background; the frontend reacts to run:// events.
    tokio::spawn(async move {
        if let Err(e) = orch.resolve_checkpoint(&run_id2, action).await {
            tracing::error!(run_id = %run_id2, error = %e, "resolve_checkpoint failed");
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn abort_run(
    orch: State<'_, Arc<Orchestrator>>,
    run_id: String,
) -> AppResult<()> {
    Arc::clone(&orch).abort_run(&run_id).await
}

#[tauri::command]
pub async fn estimate_run_cost(
    state: State<'_, AppState>,
    pipeline_id: String,
) -> AppResult<serde_json::Value> {
    // Heuristic per-role token estimate (refined later from history).
    fn est_tokens(role: &str) -> (u64, u64) {
        match role {
            "implement" | "fix" => (12_000, 6_000),
            "plan" | "refine" => (4_000, 1_500),
            "code_review" | "plan_review" | "critique" | "verify" | "repro" => (8_000, 1_000),
            "test" => (6_000, 2_000),
            _ => (4_000, 1_000),
        }
    }
    let db = state.db.lock();
    let stages = db.get_pipeline_stages(&pipeline_id)?;
    let reference = crate::orchestrator::cost::pick_reference_model();
    let mut cost = 0.0;
    let mut baseline = 0.0;
    for s in &stages {
        let (i, o) = est_tokens(&s.role);
        cost += crate::orchestrator::cost::stage_cost(&s.agent_model, i, o);
        if let Some(ref_model) = &reference {
            baseline += crate::orchestrator::cost::baseline_cost(ref_model, i, o);
        }
    }
    if reference.is_none() || baseline < cost {
        baseline = cost;
    }
    Ok(serde_json::json!({ "estimateUsd": cost, "baselineUsd": baseline }))
}
```

- [ ] **Step 2: Manage the Orchestrator + seed builtins in lib.rs**

In `src-tauri/src/lib.rs`, after `.manage(app_state)` and `.manage(perf::PerfState::new())`, the Orchestrator needs the `AppHandle` (for `TauriEventSink`) and the `Db` (from `AppState`). Build it in `.setup(...)` where the `AppHandle` is available, and manage it there:

In the `.setup(|app| { ... })` closure, before `Ok(())`:

```rust
            // Direct-mode orchestrator: seed builtin pipelines + register engine.
            {
                let state = app.state::<AppState>();
                if let Err(e) = state.db.lock().seed_builtin_pipelines() {
                    tracing::error!(error = %e, "failed to seed builtin pipelines");
                }
                let sink = std::sync::Arc::new(orchestrator::events::TauriEventSink {
                    app: app.handle().clone(),
                });
                let orch = std::sync::Arc::new(orchestrator::Orchestrator::new(
                    std::sync::Arc::clone(&state.db),
                    sink,
                ));
                app.manage(orch);
            }
```

(`app.manage(...)` inside setup is the supported way to register state that needs the `AppHandle`.)

- [ ] **Step 3: Register the commands**

In the `tauri::generate_handler![ ... ]` list in `src-tauri/src/lib.rs`, add after the `// Chat` block:

```rust
            // Direct mode (orchestration)
            commands::list_pipelines,
            commands::get_pipeline,
            commands::create_run,
            commands::start_run,
            commands::get_run,
            commands::list_runs,
            commands::resolve_checkpoint,
            commands::abort_run,
            commands::estimate_run_cost,
```

- [ ] **Step 4: Compile**

Run: `cd src-tauri && cargo build 2>&1 | tail -25`
Expected: builds with no errors. (Warnings about unused `start_run`/`abort_run` paths are acceptable.)

- [ ] **Step 5: Run the full test suite**

Run: `cd src-tauri && cargo test 2>&1 | tail -25`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(direct): IPC commands + orchestrator registration"
```

---

## Task 10: Frontend IPC contract (types + wrappers)

**Files:**
- Modify: `src/lib/ipc.ts` (typed wrappers + types — the contract Plan 2 builds on)
- Test: `npm run typecheck`

> No UI is built in this plan. This task only adds the typed IPC surface and the event-name constants so Plan 2 has a stable contract. The wrappers mirror the existing `invoke`-wrapper style in `ipc.ts`.

- [ ] **Step 1: Add types + wrappers**

In `src/lib/ipc.ts`, append (matching the file's existing `invoke<...>()` wrapper pattern):

```typescript
// ─── Direct mode (orchestration) ──────────────────────────────────

export type AgentSubstrate = "api" | "cli";
export type RunStatus =
  | "draft" | "running" | "paused" | "completed" | "aborted" | "failed";
export type RunStageStatus =
  | "pending" | "running" | "awaiting_checkpoint" | "done" | "failed";

export interface PipelineStage {
  id: string;
  pipelineId: string;
  position: number;
  role: string;
  agentModel: string;
  substrate: AgentSubstrate;
  checkpoint: boolean;
}
export interface Pipeline {
  id: string;
  name: string;
  description: string;
  isBuiltin: boolean;
  createdAt: string;
}
export interface PipelineWithStages {
  pipeline: Pipeline;
  stages: PipelineStage[];
}
export interface Run {
  id: string;
  workspaceId: string;
  pipelineId: string;
  task: string;
  status: RunStatus;
  costUsd: number;
  baselineUsd: number;
  referenceModel: string | null;
  linkedIssueKey: string | null;
  createdAt: string;
  finishedAt: string | null;
}
export interface RunStage {
  id: string;
  runId: string;
  position: number;
  role: string;
  agentModel: string;
  substrate: AgentSubstrate;
  checkpoint: boolean;
  status: RunStageStatus;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  artifact: string | null;
  feedback: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}
export interface RunDetail {
  run: Run | null;
  stages: RunStage[];
}
export type CheckpointActionName = "approve" | "reject" | "edit" | "abort";

export const listPipelines = () =>
  invoke<PipelineWithStages[]>("list_pipelines");

export const createRun = (
  workspaceId: string,
  pipelineId: string,
  task: string,
  referenceModel?: string,
  linkedIssueKey?: string,
) =>
  invoke<string>("create_run", {
    workspaceId,
    pipelineId,
    task,
    referenceModel: referenceModel ?? null,
    linkedIssueKey: linkedIssueKey ?? null,
  });

export const startRun = (runId: string) =>
  invoke<void>("start_run", { runId });

export const getRun = (runId: string) =>
  invoke<RunDetail>("get_run", { runId });

export const listRuns = (workspaceId: string) =>
  invoke<Run[]>("list_runs", { workspaceId });

export const resolveCheckpoint = (
  runId: string,
  action: CheckpointActionName,
  feedback?: string,
  modelOverride?: string,
) =>
  invoke<void>("resolve_checkpoint", {
    runId,
    action,
    feedback: feedback ?? null,
    modelOverride: modelOverride ?? null,
  });

export const abortRun = (runId: string) =>
  invoke<void>("abort_run", { runId });

export const estimateRunCost = (pipelineId: string) =>
  invoke<{ estimateUsd: number; baselineUsd: number }>("estimate_run_cost", {
    pipelineId,
  });

/** Tauri event names emitted by the orchestrator. */
export const RUN_EVENTS = {
  stageUpdate: "run://stage-update",
  cost: "run://cost",
  checkpoint: "run://checkpoint",
  log: "run://log",
} as const;
```

> If `ipc.ts` does not already export a shared `invoke` wrapper, use the same import the rest of the file uses (`import { invoke } from "@tauri-apps/api/core";`) — match the existing file, do not introduce a new pattern.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck 2>&1 | tail -20`
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/ipc.ts
git commit -m "feat(direct): frontend IPC contract for orchestration"
```

---

## Self-Review

**Spec coverage (Phase A items from `…-design.md`):**
- §3 control model / state machine → Tasks 1, 8 (StageStatus/RunStatus, drive loop, checkpoint pause). ✓
- §3 four checkpoint actions → Task 8 `resolve_checkpoint` (Approve/Reject/Edit/Abort). ✓
- §4 `AgentRunner` + `StageArtifact` + headless loop → Tasks 1, 2, 3. ✓
- §4 `ApiRunner` reuses chat helpers → Tasks 2, 3. ✓
- §5.1 background task + one-active-per-run → Task 8 (`start_run` spawn, `active` guard). ✓
- §5.2 cost + premium baseline (blended, enabled providers, $0 honest) → Tasks 4, 8 `recompute_run_cost`. ✓
- §5.3 five tables → Task 5; row copy into run_stages → Task 7 `create_run`. ✓
- §5.4 IPC commands + `task` on createRun + `run://` events → Tasks 9, 10. ✓
- §8 MVP: API substrate only, CLI deferred → Task 3 `CliRunnerUnavailable`. ✓
- §8 three curated templates with default checkpoints → Task 6 seeding. ✓

**Deferred to Plan 2 (correctly out of scope here):** Direct mode UI, CLI substrate, live cost panel, motion, design-system spec update, `update_run_stage_artifact` UI flow (the DB method `set_run_stage_artifact` exists; the command/edit-surface lands with the UI).

**Placeholder scan:** No "TBD"/"handle errors"/"similar to Task N". `CliRunnerUnavailable` is an intentional, fully-implemented stub returning a clear error (not a placeholder).

**Type consistency:** `StageStatus`/`RunStatus` use `as_db`/`from_db` everywhere; DB stores text matching those. `complete_run_stage(status, input, output, cost, artifact_json)` signature matches its call in `run_stage_once`. `resolve_checkpoint(run_id, action)` (engine) vs the Tauri command `resolve_checkpoint(run_id, action: String, …)` are distinct layers — the command maps the string to `CheckpointAction`. `create_run` arg order (`workspace_id, pipeline_id, task, reference_model, linked_issue_key`) is identical in DB method, command, and `ipc.ts` wrapper.

---

## Execution Handoff

(Filled in by the brainstorming/writing-plans flow after the plan is approved.)
