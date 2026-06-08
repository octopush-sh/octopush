# Direct Mode — CLI Substrate (Plan 2b / Phase C-backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the CLI substrate so a pipeline stage can run headless **Claude Code** (`claude -p --output-format json`) inside the workspace's git worktree — replacing the `CliRunnerUnavailable` stub — with precise token/cost capture, clean error handling, and a seeded CLI-based template so it's usable end-to-end.

**Architecture:** A new `CliRunner` implements the existing `AgentRunner` trait. It reuses the pure prompt helpers (`system_prompt_for`/`user_input_for`/`artifact_kind_for`) already in `runner.rs`, spawns `claude -p` via `tokio::process::Command` (async, non-blocking) with `current_dir` set to the worktree, the role system prompt via `--append-system-prompt`, the task/artifact input via stdin, `--permission-mode bypassPermissions` + `--max-turns` for bounded autonomy, and `--output-format json`. The JSON is parsed by a **pure** function (`parse_cli_result`) into a `StageOutcome` (cost from the CLI's own `total_cost_usd`, tokens from `usage`). The orchestrator's `runner_for` routes `AgentSubstrate::Cli` to `CliRunner`. All parsing/arg-building logic is pure and unit-tested over recorded fixtures; the live spawn is exercised manually.

**Tech Stack:** Rust, `tokio::process::Command`, `serde`/`serde_json`, the existing orchestrator. Tests: `#[test]`/`#[tokio::test]` in `src-tauri/src/tests.rs`. Claude Code CLI `claude` v2.1.x must be installed + authenticated for live use (the runner detects its absence and fails the stage cleanly).

**Scope note:** Plan 2b of the Direct-mode spec (Phase C backend). Plan 2a (UI shell) is merged. **Out of scope (Plan 2c):** the UI to *select* the substrate/model per stage (today substrate lives in the pipeline/run data; 2b adds a seeded CLI template so it's reachable), embedding native surfaces in the focus pane, the live cost panel, and Codex as a second CLI.

**Safety rationale (recorded):** `--permission-mode bypassPermissions` lets the headless agent edit files and run commands without prompts (a headless `-p` run cannot answer prompts). This is bounded by (a) the **isolated git worktree** the stage runs in (spec §9: worktree isolation contains blast radius), (b) `--max-turns`, and (c) the **checkpoint after the stage** — the human gate. The stage's autonomy is intentional; the control point is the checkpoint, not mid-stage approval.

---

## File Structure

**New:**
- `src-tauri/src/orchestrator/cli_runner.rs` — `CliRunner` (impl `AgentRunner`), the slim CLI-output types, `build_cli_args` + `parse_cli_result` (pure, tested).

**Modified:**
- `src-tauri/src/orchestrator/mod.rs` — `pub mod cli_runner;`; route `AgentSubstrate::Cli` → `CliRunner` in `runner_for`.
- `src-tauri/src/orchestrator/runner.rs` — keep `CliRunnerUnavailable` (now unused by the orchestrator) OR delete it; this plan deletes it.
- `src-tauri/src/db.rs` — `seed_builtin_pipelines`: add a 4th builtin template that uses the `cli` substrate (so the substrate is reachable from the existing setup UI).
- `src-tauri/src/tests.rs` — new tests.

---

## Task 1: CLI output types + pure `parse_cli_result`

**Files:**
- Create: `src-tauri/src/orchestrator/cli_runner.rs`
- Modify: `src-tauri/src/orchestrator/mod.rs` (add `pub mod cli_runner;`)
- Test: `src-tauri/src/tests.rs`

- [ ] **Step 1: Declare the module + stub**

In `src-tauri/src/orchestrator/mod.rs`, add to the `pub mod` list (next to `pub mod runner;`):
```rust
pub mod cli_runner;
```
Create `src-tauri/src/orchestrator/cli_runner.rs` with just:
```rust
// implemented below
```

- [ ] **Step 2: Write the failing test**

In `src-tauri/src/tests.rs`, append:
```rust
#[cfg(test)]
mod cli_runner_tests {
    use crate::orchestrator::cli_runner::parse_cli_result;
    use crate::orchestrator::types::{ArtifactKind, StageStatus};

    const SUCCESS: &str = r#"{
        "type":"result","subtype":"success","is_error":false,
        "result":"Implemented the feature.","total_cost_usd":0.0123,
        "usage":{"input_tokens":1200,"output_tokens":340,
                 "cache_read_input_tokens":800,"cache_creation_input_tokens":100}
    }"#;

    const ERRORED: &str = r#"{
        "type":"result","subtype":"error_max_budget_usd","is_error":true,
        "result":"Budget exceeded.","total_cost_usd":5.0,
        "usage":{"input_tokens":10,"output_tokens":0,
                 "cache_read_input_tokens":0,"cache_creation_input_tokens":0}
    }"#;

    #[test]
    fn parses_success_into_done_outcome() {
        let outcome = parse_cli_result(SUCCESS, true, "implement").unwrap();
        assert_eq!(outcome.status, StageStatus::Done);
        assert_eq!(outcome.artifact.text, "Implemented the feature.");
        assert_eq!(outcome.artifact.kind, ArtifactKind::Diff); // implement -> Diff
        assert!(outcome.artifact.refs_worktree);
        assert_eq!(outcome.input_tokens, 1200);
        assert_eq!(outcome.output_tokens, 340);
        assert!((outcome.cost_usd - 0.0123).abs() < 1e-9);
        assert!(outcome.error.is_none());
    }

    #[test]
    fn is_error_flag_yields_failed_outcome() {
        let outcome = parse_cli_result(ERRORED, true, "implement").unwrap();
        assert_eq!(outcome.status, StageStatus::Failed);
        assert_eq!(outcome.error.as_deref(), Some("Budget exceeded."));
    }

    #[test]
    fn nonzero_exit_yields_failed_even_if_json_ok() {
        let outcome = parse_cli_result(SUCCESS, false, "plan").unwrap();
        assert_eq!(outcome.status, StageStatus::Failed);
    }

    #[test]
    fn unparseable_output_is_an_error() {
        assert!(parse_cli_result("not json", true, "plan").is_err());
    }
}
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd src-tauri && cargo test cli_runner_tests 2>&1 | head -20`
Expected: FAIL — `parse_cli_result` unresolved.

- [ ] **Step 4: Implement the types + parser**

Write `src-tauri/src/orchestrator/cli_runner.rs`:
```rust
//! CLI substrate: runs a stage via headless Claude Code (`claude -p`).
//!
//! All parsing/arg-building is pure and unit-tested; the live spawn lives in
//! `CliRunner::run`. The agent runs with `--permission-mode bypassPermissions`
//! inside the workspace's isolated git worktree (blast radius contained), bounded
//! by `--max-turns`, with the post-stage checkpoint as the human control point.

use crate::error::{AppError, AppResult};
use crate::orchestrator::runner::artifact_kind_for;
use crate::orchestrator::types::{ArtifactKind, StageArtifact, StageOutcome, StageStatus};
use serde::Deserialize;

const MAX_CLI_TURNS: u32 = 30;

/// The subset of `claude -p --output-format json` we consume. `#[serde(default)]`
/// keeps us resilient to the CLI adding/removing fields across versions; unknown
/// fields are ignored by serde.
#[derive(Deserialize, Debug, Default)]
struct CliResult {
    #[serde(default)]
    result: String,
    #[serde(default)]
    is_error: bool,
    #[serde(default)]
    total_cost_usd: f64,
    #[serde(default)]
    usage: CliUsage,
}

#[derive(Deserialize, Debug, Default)]
struct CliUsage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
}

/// Parse the CLI's stdout JSON into a `StageOutcome`. `exit_success` is the
/// process exit status; a non-zero exit OR `is_error: true` produces a Failed
/// outcome. Returns `Err` only when the output isn't parseable at all.
pub fn parse_cli_result(
    stdout: &str,
    exit_success: bool,
    role: &str,
) -> AppResult<StageOutcome> {
    let parsed: CliResult = serde_json::from_str(stdout.trim()).map_err(|e| {
        let preview: String = stdout.chars().take(300).collect();
        AppError::Other(format!("could not parse claude output: {e}; got: {preview}"))
    })?;

    if parsed.is_error || !exit_success {
        return Ok(StageOutcome {
            artifact: StageArtifact {
                kind: ArtifactKind::Note,
                text: String::new(),
                payload: None,
                refs_worktree: false,
            },
            input_tokens: parsed.usage.input_tokens,
            output_tokens: parsed.usage.output_tokens,
            cost_usd: parsed.total_cost_usd,
            status: StageStatus::Failed,
            tool_calls: vec![],
            error: Some(if parsed.result.is_empty() {
                "claude exited with an error".to_string()
            } else {
                parsed.result.clone()
            }),
        });
    }

    let kind = artifact_kind_for(role);
    let refs_worktree = matches!(kind, ArtifactKind::Diff | ArtifactKind::Tests);
    Ok(StageOutcome {
        artifact: StageArtifact {
            kind,
            text: parsed.result,
            payload: None,
            refs_worktree,
        },
        input_tokens: parsed.usage.input_tokens,
        output_tokens: parsed.usage.output_tokens,
        cost_usd: parsed.total_cost_usd,
        status: StageStatus::Done,
        tool_calls: vec![],
        error: None,
    })
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src-tauri && cargo test cli_runner_tests 2>&1 | tail -15`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/orchestrator/cli_runner.rs src-tauri/src/orchestrator/mod.rs src-tauri/src/tests.rs
git commit -m "feat(direct): claude CLI output parser (pure)"
```

---

## Task 2: Pure `build_cli_args`

**Files:**
- Modify: `src-tauri/src/orchestrator/cli_runner.rs`
- Test: `src-tauri/src/tests.rs`

- [ ] **Step 1: Write the failing test**

In `src-tauri/src/tests.rs`, append:
```rust
#[cfg(test)]
mod cli_args_tests {
    use crate::orchestrator::cli_runner::build_cli_args;

    #[test]
    fn args_include_model_format_and_permission() {
        let args = build_cli_args("claude-sonnet-4-6", "You are a planner.");
        assert!(args.contains(&"-p".to_string()));
        // --output-format json
        let i = args.iter().position(|a| a == "--output-format").unwrap();
        assert_eq!(args[i + 1], "json");
        // --model <model>
        let m = args.iter().position(|a| a == "--model").unwrap();
        assert_eq!(args[m + 1], "claude-sonnet-4-6");
        // --append-system-prompt <system>
        let s = args.iter().position(|a| a == "--append-system-prompt").unwrap();
        assert_eq!(args[s + 1], "You are a planner.");
        // bounded autonomy
        assert!(args.contains(&"--permission-mode".to_string()));
        assert!(args.contains(&"bypassPermissions".to_string()));
        assert!(args.contains(&"--max-turns".to_string()));
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd src-tauri && cargo test cli_args_tests 2>&1 | head -15`
Expected: FAIL — `build_cli_args` unresolved.

- [ ] **Step 3: Implement `build_cli_args`**

In `src-tauri/src/orchestrator/cli_runner.rs`, add (the user prompt is fed via stdin, NOT an arg, so it isn't built here):
```rust
/// Build the argv (after the program name) for a headless `claude -p` run.
/// The user prompt is supplied via stdin, not as an arg.
pub fn build_cli_args(model: &str, system_prompt: &str) -> Vec<String> {
    vec![
        "-p".to_string(),
        "--output-format".to_string(),
        "json".to_string(),
        "--model".to_string(),
        model.to_string(),
        "--append-system-prompt".to_string(),
        system_prompt.to_string(),
        "--permission-mode".to_string(),
        "bypassPermissions".to_string(),
        "--max-turns".to_string(),
        MAX_CLI_TURNS.to_string(),
    ]
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test cli_args_tests 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/orchestrator/cli_runner.rs src-tauri/src/tests.rs
git commit -m "feat(direct): build_cli_args for headless claude"
```

---

## Task 3: `CliRunner` (spawn + glue)

**Files:**
- Modify: `src-tauri/src/orchestrator/cli_runner.rs`
- Test: compile + the existing pure tests (the live spawn is verified manually)

- [ ] **Step 1: Implement `CliRunner`**

Append to `src-tauri/src/orchestrator/cli_runner.rs`:
```rust
use crate::orchestrator::runner::{system_prompt_for, user_input_for, AgentRunner, StageContext};
use crate::orchestrator::types::{StageArtifact as _Artifact, StageSpec};
use std::process::Stdio;
use tokio::io::AsyncWriteExt;

/// The CLI substrate: runs a stage by shelling out to headless Claude Code.
pub struct CliRunner;

#[async_trait::async_trait]
impl AgentRunner for CliRunner {
    async fn run(
        &self,
        stage: &StageSpec,
        input: &crate::orchestrator::types::StageArtifact,
        ctx: &StageContext,
    ) -> AppResult<StageOutcome> {
        let system = system_prompt_for(&stage.role);
        let user = user_input_for(&stage.role, &ctx.task, input, stage.feedback.as_deref());
        let args = build_cli_args(&stage.agent_model, &system);

        let mut child = match tokio::process::Command::new("claude")
            .args(&args)
            .current_dir(&ctx.workspace_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(failed_stage(
                    "Claude Code CLI (`claude`) was not found on PATH. Install it to use CLI stages.",
                ));
            }
            Err(e) => return Ok(failed_stage(&format!("failed to launch claude: {e}"))),
        };

        // Feed the prompt via stdin, then close it.
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(user.as_bytes()).await;
            // drop closes stdin
        }

        let output = match child.wait_with_output().await {
            Ok(o) => o,
            Err(e) => return Ok(failed_stage(&format!("claude process error: {e}"))),
        };

        let stdout = String::from_utf8_lossy(&output.stdout);
        match parse_cli_result(&stdout, output.status.success(), &stage.role) {
            Ok(outcome) => Ok(outcome),
            Err(_) => {
                // Unparseable: surface stderr if present, else stdout preview.
                let stderr = String::from_utf8_lossy(&output.stderr);
                let detail = if !stderr.trim().is_empty() {
                    stderr.chars().take(400).collect::<String>()
                } else {
                    stdout.chars().take(400).collect::<String>()
                };
                Ok(failed_stage(&format!("claude produced no parseable result: {detail}")))
            }
        }
    }
}

fn failed_stage(msg: &str) -> StageOutcome {
    StageOutcome {
        artifact: _Artifact {
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
        error: Some(msg.to_string()),
    }
}
```

(The `StageArtifact as _Artifact` import alias avoids a name clash if you prefer; if `StageArtifact` is already in scope from Task 1's `use`, just use `StageArtifact` directly and drop the alias. Make it compile cleanly — adjust imports as the compiler requires.)

- [ ] **Step 2: Compile**

Run: `cd src-tauri && cargo build 2>&1 | tail -15`
Expected: builds. `CliRunner` may be flagged unused until Task 4 wires it — that's an expected `dead_code` warning, not an error.

- [ ] **Step 3: Verify the pure tests still pass**

Run: `cd src-tauri && cargo test cli_runner_tests cli_args_tests 2>&1 | tail -12`
Expected: PASS (5 tests).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/orchestrator/cli_runner.rs
git commit -m "feat(direct): CliRunner spawns headless claude in the worktree"
```

---

## Task 4: Route `AgentSubstrate::Cli` to `CliRunner`

**Files:**
- Modify: `src-tauri/src/orchestrator/mod.rs`
- Modify: `src-tauri/src/orchestrator/runner.rs` (remove the now-dead `CliRunnerUnavailable`)
- Test: existing orchestrator tests (the MockRunner path is unaffected)

- [ ] **Step 1: Wire it in `runner_for`**

In `src-tauri/src/orchestrator/mod.rs`, the `runner_for` currently is:
```rust
    fn runner_for(&self, substrate: &AgentSubstrate) -> Box<dyn AgentRunner> {
        if self.test_runner.is_some() {
            unreachable!("runner_for must not be called when test_runner is set");
        }
        match substrate {
            AgentSubstrate::Api => Box::new(ApiRunner),
            AgentSubstrate::Cli => Box::new(CliRunnerUnavailable),
        }
    }
```
Change the import line `use crate::orchestrator::runner::{ApiRunner, CliRunnerUnavailable, AgentRunner, StageContext};` to drop `CliRunnerUnavailable` and add the CLI runner:
```rust
use crate::orchestrator::cli_runner::CliRunner;
use crate::orchestrator::runner::{ApiRunner, AgentRunner, StageContext};
```
And change the `Cli` arm:
```rust
            AgentSubstrate::Cli => Box::new(CliRunner),
```

- [ ] **Step 2: Remove the dead stub**

In `src-tauri/src/orchestrator/runner.rs`, delete the entire `CliRunnerUnavailable` struct and its `impl AgentRunner` block (it's no longer referenced). Confirm with `grep -rn CliRunnerUnavailable src-tauri/src` → no matches after deletion.

- [ ] **Step 3: Build + run the full suite**

Run: `cd src-tauri && cargo build 2>&1 | tail -8` (clean) and `cd src-tauri && cargo test 2>&1 | tail -12`
Expected: builds; all tests pass (the orchestrator tests use the MockRunner via `test_runner`, so they never hit `runner_for`/`CliRunner` — unaffected).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/orchestrator/mod.rs src-tauri/src/orchestrator/runner.rs
git commit -m "feat(direct): route CLI substrate to CliRunner"
```

---

## Task 5: Seed a CLI-based template

**Files:**
- Modify: `src-tauri/src/db.rs` (`seed_builtin_pipelines`)
- Test: `src-tauri/src/tests.rs`

> Makes the CLI substrate reachable from the existing PipelineSetup UI without a substrate-picker (that's Plan 2c). Idempotent seeding adds any builtin whose name isn't present, so existing DBs gain this template on next startup.

- [ ] **Step 1: Write the failing test**

In `src-tauri/src/tests.rs`, append:
```rust
#[cfg(test)]
mod cli_template_tests {
    use crate::db::Db;
    use tempfile::NamedTempFile;

    fn test_db() -> Db {
        let tmp = NamedTempFile::new().unwrap();
        Db::open(tmp.path()).unwrap()
    }

    #[test]
    fn seeds_a_cli_pipeline() {
        let db = test_db();
        db.seed_builtin_pipelines().unwrap();
        let p = db.list_pipelines().unwrap().into_iter()
            .find(|p| p.name == "Claude Code build").expect("CLI template seeded");
        let stages = db.get_pipeline_stages(&p.id).unwrap();
        // The implement stage runs on the CLI substrate with a claude model.
        let implement = stages.iter().find(|s| s.role == "implement").unwrap();
        assert_eq!(implement.substrate, "cli");
        assert!(implement.agent_model.contains("claude") || implement.agent_model == "sonnet");
        assert!(implement.checkpoint);
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd src-tauri && cargo test cli_template_tests 2>&1 | head -15`
Expected: FAIL — no "Claude Code build" pipeline.

- [ ] **Step 3: Add the template to `seed_builtin_pipelines`**

In `src-tauri/src/db.rs`, inside `seed_builtin_pipelines`, the `defs` array lists the builtin templates. Append a 4th entry to that array (same tuple shape `(name, description, &[(role, model, substrate, checkpoint)])`):
```rust
        (
            "Claude Code build",
            "Plan via API, then implement, review, and test with Claude Code (CLI).",
            &[
                ("plan", "claude-haiku-4-5", "api", false),
                ("implement", "claude-sonnet-4-6", "cli", true),
                ("code_review", "claude-haiku-4-5", "cli", true),
                ("test", "claude-haiku-4-5", "cli", true),
            ],
        ),
```
(Insert it as the last element of the `defs` slice, after "Plan & review". Keep the existing three unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test cli_template_tests 2>&1 | tail -10`
Expected: PASS.

- [ ] **Step 5: Verify the existing seed test still expects the right count**

The Plan-1 test `pipeline_crud_tests::seed_is_idempotent_and_lists_three` asserts `pipelines.len() == 3`. Adding a 4th builtin breaks it. Update that assertion: open `src-tauri/src/tests.rs`, find `assert_eq!(pipelines.len(), 3);` in `pipeline_crud_tests` and change it to `assert_eq!(pipelines.len(), 4);`. (The test's intent — idempotent seeding, no duplication on second call — is unchanged.)

- [ ] **Step 6: Run the full suite**

Run: `cd src-tauri && cargo test 2>&1 | tail -12`
Expected: all pass (incl. the updated count test and the new CLI template test).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/db.rs src-tauri/src/tests.rs
git commit -m "feat(direct): seed a Claude Code (CLI) build template"
```

---

## Task 6: Final build + suite

**Files:** none (verification)

- [ ] **Step 1: Full backend build + test**

Run: `cd src-tauri && cargo build 2>&1 | tail -8` (clean; no `CliRunnerUnavailable` references remain) and `cd src-tauri && cargo test 2>&1 | tail -12` (all pass).

- [ ] **Step 2: Confirm dead stub is gone**

Run: `grep -rn CliRunnerUnavailable src-tauri/src` → expect no output.

- [ ] **Step 3: Frontend untouched**

This plan changes only backend Rust. No frontend change is needed (the substrate pill already renders `cli` purple from Plan 2a). Optionally run `npm run typecheck 2>&1 | tail -3` to confirm nothing drifted.

---

## Self-Review

**Spec coverage (Phase C — CLI substrate):**
- `CliRunner` reuses leaf prompt helpers, spawns headless `claude -p --output-format json` in the worktree → Tasks 1–3. ✓
- Token usage + cost captured (cost from the CLI's own `total_cost_usd`; tokens from `usage`) → Task 1 `parse_cli_result`. ✓
- Missing/unauthenticated CLI surfaced as a failed stage (not a crash): binary-not-found → `failed_stage`; not-logged-in / unknown model → `is_error`/non-zero exit → Failed → the orchestrator pauses at a checkpoint with the message in `StageFocus` → Tasks 1, 3. ✓
- Bounded autonomy in the isolated worktree (`bypassPermissions` + `--max-turns`) → Task 2. ✓
- Routed via `runner_for`, replacing the stub → Task 4. ✓
- Reachable end-to-end (seeded CLI template) → Task 5. ✓

**Deferred (correctly out of 2b):** the per-stage substrate/model picker UI (Plan 2c), native-surface focus embedding, the live cost panel, Codex as a second CLI.

**Placeholder scan:** none. The `failed_stage` helper and the slim `#[serde(default)]` structs are intentional, complete implementations.

**Type consistency:** `parse_cli_result(stdout, exit_success, role) -> AppResult<StageOutcome>` is used the same way in `CliRunner::run` and the tests. `build_cli_args(model, system_prompt) -> Vec<String>` matches its test. `CliRunner` implements `AgentRunner` (`async fn run(&self, stage, input, ctx) -> AppResult<StageOutcome>`), matching the trait used by `runner_for`. `artifact_kind_for`/`system_prompt_for`/`user_input_for` are the existing pure helpers from `runner.rs`.

---

## Execution Handoff

(Filled in by the writing-plans flow after approval.)
