# DIRECT mode halt diagnostics & recovery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a halted DIRECT stage explain itself and be recoverable — surface the real CLI failure cause, record it in the work journal, allow resuming the same Claude session with an adjustable turn budget, replace the fixed wall-clock timeout with idle detection, and let the user safely discard only the failed stage's changes — all behind the approved Option A banner.

**Architecture:** Backend changes live in `src-tauri/src/orchestrator/` (CLI runner, orchestrator drive, checkpoint actions) and `src-tauri/src/db.rs` (3 additive columns + helpers). Frontend changes are the `RunControlBar` `DecisionBar` redesign plus IPC/store plumbing. Git baseline snapshots use plumbing through a temporary `GIT_INDEX_FILE` so the user's real index is never touched.

**Tech Stack:** Rust (tokio, rusqlite, serde), React 19 + TypeScript, Tailwind v4, Zustand, Tauri 2. Backend tests: `#[test]`/`#[tokio::test]` in `src-tauri/src/tests.rs`. Frontend tests: Vitest `*.test.ts`.

**Spec:** `docs/superpowers/specs/2026-06-14-direct-mode-halt-recovery-design.md`

---

## File map

**Modify (backend):**
- `src-tauri/src/db.rs` — migration columns; `RunStageRow` field; `list_run_stages` mapping; new helpers `set_stage_session`, `set_stage_resume_pending`, `clear_stage_resume_pending`, `set_stage_max_iterations`, `set_stage_baseline`.
- `src-tauri/src/orchestrator/cli_runner.rs` — `CliResult.session_id`; `parse_cli_result` subtype + stderr; idle/abs timeout; `--resume` arg; `StageOutcome` wiring.
- `src-tauri/src/orchestrator/types.rs` — `StageOutcome.session_id`; `StageSpec.session_id`/`resume_session`; `CheckpointAction` variants.
- `src-tauri/src/orchestrator/runner.rs` — `StageContext` unchanged; resume nudge prompt helper.
- `src-tauri/src/orchestrator/mod.rs` — persist session/baseline in `run_stage_once`; terminal journal entry; `resolve_checkpoint` Resume/Discard.
- `src-tauri/src/orchestrator/git_baseline.rs` — **new** module: `capture_baseline`, `restore_baseline`.
- `src-tauri/src/commands.rs` — `resolve_checkpoint` command: `max_turns_override`, `"discard"`.
- `src-tauri/src/tests.rs` — Rust unit tests.

**Modify (frontend):**
- `src/lib/ipc.ts` — `RunStage.sessionId`; `CheckpointActionName` + `"discard"`; `resolveCheckpoint(maxTurnsOverride)`.
- `src/stores/runsStore.ts` — `resolve` signature passthrough.
- `src/lib/stageHalt.ts` — **new**: `haltCause(error, maxIterations)` mapper (+ `*.test.ts`).
- `src/components/controls/Stepper.tsx` — optional `step` prop.
- `src/components/RunControlBar.tsx` — Option A `DecisionBar`.
- `src/components/DirectCanvas.tsx` — wire `onResume(maxTurns)`, `onDiscard`.

---

## Phase 1 — Schema & types

### Task 1: Add the three `run_stages` columns

**Files:**
- Modify: `src-tauri/src/db.rs:414` (after the v9 `max_iterations` migration line) and `:435` region (v10 mirror block); `RunStageRow` `:2697`; `list_run_stages` `:1956`/`:1986`.

- [ ] **Step 1: Add the migration columns.** After `db.rs:435` (the last `run_stages` mirror `add_column_if_missing`), insert:

```rust
        // ── v12 Direct halt recovery: session resume + per-stage baseline ──
        // session_id: the Claude Code CLI session id from the stage's last
        //   attempt — enables `--resume` and is shown in the halt diagnostics.
        // resume_pending: 1 ⇒ the next run of this stage should `--resume`
        //   session_id (set by a Resume action, cleared when the run starts).
        // baseline_commit: dangling commit SHA snapshotting the worktree at the
        //   stage's start, so Discard reverts only this stage's changes.
        add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN session_id TEXT")?;
        add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN resume_pending INTEGER NOT NULL DEFAULT 0")?;
        add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN baseline_commit TEXT")?;
```

- [ ] **Step 2: Add fields to `RunStageRow`.** After `db.rs:2697` (`instructions` field), inside the struct:

```rust
    /// Claude Code CLI session id from the stage's last attempt (CLI substrate
    /// only); enables `--resume`. None for legacy rows and API stages.
    pub session_id: Option<String>,
    /// 1 ⇒ the next run of this stage should resume `session_id`.
    pub resume_pending: bool,
    /// Dangling commit SHA snapshotting the worktree at this stage's start.
    pub baseline_commit: Option<String>,
```

- [ ] **Step 3: Read the new columns in `list_run_stages`.** Change the SELECT (`db.rs:1956`) to append the columns, and the row mapping (`db.rs:1986`) to read them. Replace the `instructions` SELECT tail and closing:

```rust
            "SELECT id, run_id, position, role, agent_model, substrate, checkpoint, status,
                    input_tokens, output_tokens, cost_usd, artifact, feedback, error, started_at, finished_at,
                    loop_target_position, loop_max_iterations, loop_mode, loop_iterations, diff_snapshot,
                    max_iterations, parents, tools, custom_name, instructions,
                    session_id, resume_pending, baseline_commit
             FROM run_stages WHERE run_id = ?1 ORDER BY position",
```

and the mapping closing (after `instructions: r.get(25)?,`):

```rust
                instructions: r.get(25)?,
                session_id: r.get(26)?,
                resume_pending: r.get::<_, i64>(27)? != 0,
                baseline_commit: r.get(28)?,
```

- [ ] **Step 4: Fix every other `RunStageRow { … }` literal.** Run `cd src-tauri && cargo build 2>&1 | grep -A2 "missing fields"` and add `session_id: None, resume_pending: false, baseline_commit: None` to any constructor the compiler flags (test fixtures, etc.).

Run: `cd src-tauri && cargo build`
Expected: compiles (no missing-field errors).

- [ ] **Step 5: Commit.**

```bash
git add src-tauri/src/db.rs
git commit -m "feat(direct): add session_id/resume_pending/baseline_commit columns"
```

---

## Phase 2 — Failure diagnostics

### Task 2: Surface the result `subtype` even when `is_error` is true

**Files:**
- Modify: `src-tauri/src/orchestrator/cli_runner.rs:165-189` (`parse_cli_result`).
- Test: `src-tauri/src/tests.rs`.

- [ ] **Step 1: Write the failing test.** Append to `tests.rs`:

```rust
#[test]
fn parse_cli_result_names_subtype_when_is_error() {
    use crate::orchestrator::cli_runner::parse_cli_result;
    use crate::orchestrator::types::StageStatus;
    // claude hits the turn cap: subtype set AND is_error true, empty result.
    let line = r#"{"type":"result","subtype":"error_max_turns","is_error":true,"result":"","total_cost_usd":0.5,"usage":{"input_tokens":10,"output_tokens":20}}"#;
    let out = parse_cli_result(line, true, "verify", "").unwrap();
    assert!(matches!(out.status, StageStatus::Failed));
    let err = out.error.unwrap();
    assert!(err.contains("error_max_turns"), "got: {err}");
}
```

- [ ] **Step 2: Run it — expect FAIL.**

Run: `cd src-tauri && cargo test parse_cli_result_names_subtype_when_is_error`
Expected: FAIL — current arm returns "claude exited with an error" (no subtype), and the signature lacks the 4th `stderr_tail` arg (compile error is also acceptable as the failing state).

- [ ] **Step 3: Rewrite the failure branch.** In `parse_cli_result`, replace the `subtype_only`/`error: Some(match …)` block (`cli_runner.rs:166-187`) with:

```rust
    if parsed.is_error || !exit_success || bad_subtype.is_some() {
        let error = match (bad_subtype, parsed.result.is_empty()) {
            (Some(st), true) => format!(
                "claude stopped early ({st}) — review the work journal, then resume or re-run"
            ),
            (Some(st), false) => format!("claude stopped early ({st}): {}", parsed.result),
            (None, true) => "claude exited with an error".to_string(),
            (None, false) => parsed.result.clone(),
        };
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
            error: Some(error),
            verdict: None,
            session_id: parsed.session_id.clone(),
        });
    }
```

> Note: `session_id` is added to `StageOutcome` in Task 4; the success arm there too. Delete the now-unused `let subtype_only = …;` line. The new `stderr_tail` param is consumed in Task 3 — add it to the signature now (Step 4) so this compiles.

- [ ] **Step 4: Add the `stderr_tail` param to the signature.** Change `pub fn parse_cli_result(stdout: &str, exit_success: bool, role: &str) -> AppResult<StageOutcome>` to add `, stderr_tail: &str` as the last param. Update the two call sites in `cli_runner.rs` (`:387`) to pass `&stderr_out`, and the success-path `StageOutcome` to add `session_id: parsed.session_id.clone()` (full success arm updated in Task 4 — for now add the field with a `// TODO Task 4` removed once Task 4 lands; if Task 4 runs same session, just add it). The temporary unused `stderr_tail` is fine until Task 3.

Run: `cd src-tauri && cargo test parse_cli_result_names_subtype_when_is_error`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src-tauri/src/orchestrator/cli_runner.rs src-tauri/src/tests.rs
git commit -m "fix(direct): name the CLI failure subtype instead of a generic error"
```

### Task 3: Fold a stderr tail into the failure message

**Files:**
- Modify: `src-tauri/src/orchestrator/cli_runner.rs` (`parse_cli_result` failure branch + a small helper).
- Test: `src-tauri/src/tests.rs`.

- [ ] **Step 1: Write the failing test.**

```rust
#[test]
fn parse_cli_result_appends_stderr_tail() {
    use crate::orchestrator::cli_runner::parse_cli_result;
    let line = r#"{"type":"result","is_error":true,"result":"","usage":{"input_tokens":0,"output_tokens":0}}"#;
    let stderr = "line one\noverloaded_error: server is busy\n";
    let out = parse_cli_result(line, false, "fix", stderr).unwrap();
    let err = out.error.unwrap();
    assert!(err.contains("overloaded_error"), "got: {err}");
}
```

- [ ] **Step 2: Run it — expect FAIL.**

Run: `cd src-tauri && cargo test parse_cli_result_appends_stderr_tail`
Expected: FAIL — stderr is ignored on this path.

- [ ] **Step 3: Append the stderr tail.** Add a helper near `failure_detail`:

```rust
/// Last `n` non-empty lines of stderr, joined — appended to a failure message
/// when claude itself gave no detail. Empty string when stderr is blank.
fn stderr_tail(stderr: &str, n: usize) -> String {
    let lines: Vec<&str> = stderr.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}
```

Then in the failure branch (Task 2's block), after building `error`, enrich it:

```rust
        let tail = stderr_tail(stderr_tail_in, 10);
        let error = if tail.is_empty() { error } else { format!("{error}\n— stderr —\n{tail}") };
```

Rename the param to `stderr_tail_in: &str` to avoid shadowing the helper, or call the helper `tail_of` instead. (Pick one name; keep it consistent.)

Run: `cd src-tauri && cargo test parse_cli_result`
Expected: PASS (both Task 2 and Task 3 tests).

- [ ] **Step 4: Commit.**

```bash
git add src-tauri/src/orchestrator/cli_runner.rs src-tauri/src/tests.rs
git commit -m "fix(direct): fold a stderr tail into CLI halt messages"
```

### Task 4: Capture `session_id` from the result event

**Files:**
- Modify: `src-tauri/src/orchestrator/cli_runner.rs` (`CliResult`); `src-tauri/src/orchestrator/types.rs` (`StageOutcome`); all `StageOutcome { … }` literals.
- Test: `src-tauri/src/tests.rs`.

- [ ] **Step 1: Write the failing test.**

```rust
#[test]
fn parse_cli_result_extracts_session_id() {
    use crate::orchestrator::cli_runner::parse_cli_result;
    let line = r#"{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"abc-123","usage":{"input_tokens":1,"output_tokens":2}}"#;
    let out = parse_cli_result(line, true, "fix", "").unwrap();
    assert_eq!(out.session_id.as_deref(), Some("abc-123"));
}
```

- [ ] **Step 2: Run it — expect FAIL** (field `session_id` does not exist on `StageOutcome`).

Run: `cd src-tauri && cargo test parse_cli_result_extracts_session_id`
Expected: FAIL (compile error).

- [ ] **Step 3: Add `session_id` to `CliResult`.** In `cli_runner.rs:21-35`, add:

```rust
    #[serde(default)]
    session_id: Option<String>,
```

- [ ] **Step 4: Add `session_id` to `StageOutcome`.** In `types.rs` after `verdict` (`:238`):

```rust
    /// Claude Code CLI session id (CLI substrate only); used for `--resume`.
    pub session_id: Option<String>,
```

- [ ] **Step 5: Populate it everywhere `StageOutcome` is built.** Add `session_id: None` to `failed_stage` (`cli_runner.rs:417`), to the API runner's outcomes in `runner.rs`/`agentic.rs`, and to the success arm in `parse_cli_result`; add `session_id: parsed.session_id.clone()` to the two `parse_cli_result` arms. Let the compiler find the rest: `cd src-tauri && cargo build 2>&1 | grep -B1 "missing field"`.

Run: `cd src-tauri && cargo test parse_cli_result_extracts_session_id`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add src-tauri/src/orchestrator/ src-tauri/src/tests.rs
git commit -m "feat(direct): parse the CLI session_id from the result event"
```

### Task 5: Persist `session_id` on stage finish

**Files:**
- Modify: `src-tauri/src/db.rs` (new `set_stage_session`); `src-tauri/src/orchestrator/mod.rs:352-394` (both arms of `run_stage_once`).

- [ ] **Step 1: Add the db helper.** After `set_stage_diff_snapshot` (`db.rs:2205`):

```rust
    /// Persist the CLI session id from a stage's attempt (done or failed).
    pub fn set_stage_session(&self, stage_id: &str, session_id: Option<&str>) -> AppResult<()> {
        self.conn.execute(
            "UPDATE run_stages SET session_id = ?2 WHERE id = ?1",
            params![stage_id, session_id],
        )?;
        Ok(())
    }
```

- [ ] **Step 2: Persist in both outcome arms.** In `mod.rs` `run_stage_once`, immediately after `let outcome = match run_result { … };` (i.e. before `match outcome.status` at `:352`), add:

```rust
        if outcome.session_id.is_some() {
            self.db.lock().set_stage_session(&stage.id, outcome.session_id.as_deref())?;
        }
```

- [ ] **Step 3: Verify build.**

Run: `cd src-tauri && cargo build`
Expected: compiles.

- [ ] **Step 4: Commit.**

```bash
git add src-tauri/src/db.rs src-tauri/src/orchestrator/mod.rs
git commit -m "feat(direct): persist the CLI session id on every stage finish"
```

### Task 6: Write a terminal journal entry when a stage halts

**Files:**
- Modify: `src-tauri/src/orchestrator/mod.rs` (`run_stage_once` failure paths) — add a private helper `record_halt(&self, run_id, stage_id, error)`.

- [ ] **Step 1: Add the helper.** Inside `impl Orchestrator` near `capture_stage_diff_snapshot` (`mod.rs:257`):

```rust
    /// Append a terminal entry to the stage's work journal so the journal
    /// explains the halt instead of just stopping mid-action. Persisted AND
    /// emitted live (best-effort — a journal write must never mask the failure).
    fn record_halt(&self, run_id: &str, stage_id: &str, error: &str) {
        let first = error.lines().next().unwrap_or("stage halted").trim();
        let entry = serde_json::json!({ "kind": "notice", "text": format!("⏹ Stage halted — {first}") });
        let json = entry.to_string();
        if let Err(e) = self.db.lock().append_stage_log(run_id, stage_id, &json) {
            tracing::warn!(stage_id, "halt journal write failed: {e}");
        }
        self.events.emit(
            crate::orchestrator::live::RUN_LOG_EVENT,
            serde_json::json!({ "runId": run_id, "stageId": stage_id, "entry": entry }),
        );
    }
```

- [ ] **Step 2: Call it on every failure path.** In `run_stage_once`:
  - After the unknown-substrate `fail_run_stage` (`mod.rs:284`): add `self.record_halt(&stage.id /* run via run? */, …)`. Use `run.id`: `self.record_halt(&run.id, &stage.id, &format!("unknown substrate '{}'", stage.substrate));`
  - After the hard-error `fail_run_stage` (`:347`): `self.record_halt(&run.id, &stage.id, &e.to_string());`
  - After the outcome-failed `fail_run_stage` (`:389`): `self.record_halt(&run.id, &stage.id, &err);`

- [ ] **Step 3: Verify build + manual reasoning.**

Run: `cd src-tauri && cargo build`
Expected: compiles. (Behavior is verified end-to-end in the live app; no unit test — it is a side-effecting emit. The `append_stage_log` path is already covered by existing journal tests.)

- [ ] **Step 4: Commit.**

```bash
git add src-tauri/src/orchestrator/mod.rs
git commit -m "feat(direct): record a terminal entry in the work journal on halt"
```

---

## Phase 3 — Idle timeout

### Task 7: Replace the 15-min wall-clock cap with idle + absolute timeouts

**Files:**
- Modify: `src-tauri/src/orchestrator/cli_runner.rs:19` (constants) and `:312-378` (read loop + select).

- [ ] **Step 1: Replace the constant.** At `cli_runner.rs:19`:

```rust
/// Fail a CLI stage if it emits NO output for this long — a hung CLI, not a
/// busy one. A stage that keeps streaming (a long build/release) stays alive.
const IDLE_TIMEOUT_SECS: u64 = 300; // 5 minutes of silence
/// Absolute backstop: even a trickle of output can't run forever.
const ABS_CAP_SECS: u64 = 3600; // 60 minutes total
```

- [ ] **Step 2: Make the read loop idle-aware.** Replace the body of `read_loop` (`:312-344`) so each line read is wrapped in an idle timeout and the loop tracks total elapsed. Replace the `read_loop` async block with:

```rust
        let read_loop = async {
            let mut reader = tokio::io::BufReader::new(stdout);
            let mut result_line: Option<String> = None;
            let mut tail: std::collections::VecDeque<String> = std::collections::VecDeque::new();
            let mut raw: Vec<u8> = Vec::new();
            let started = std::time::Instant::now();
            loop {
                if started.elapsed().as_secs() >= ABS_CAP_SECS {
                    return ReadEnd::AbsCap(result_line, tail);
                }
                raw.clear();
                let read = tokio::time::timeout(
                    std::time::Duration::from_secs(IDLE_TIMEOUT_SECS),
                    reader.read_until(b'\n', &mut raw),
                )
                .await;
                match read {
                    Err(_) => return ReadEnd::Idle(result_line, tail), // no line within IDLE
                    Ok(Ok(0)) => break,                                 // EOF
                    Ok(Ok(_)) => {}
                    Ok(Err(_)) => break,                                // read error
                }
                let line = String::from_utf8_lossy(&raw);
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if tail.len() >= 20 {
                    tail.pop_front();
                }
                tail.push_back(trimmed.to_string());
                let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
                    continue;
                };
                if is_result_event(&value) {
                    result_line = Some(trimmed.to_string());
                }
                for entry in crate::orchestrator::live::entries_from_stream_event(&value) {
                    emitter.emit_raw_entry(entry);
                }
            }
            ReadEnd::Eof(result_line, tail)
        };
```

- [ ] **Step 3: Add the `ReadEnd` enum.** Above `impl AgentRunner for CliRunner` (near `:239`):

```rust
/// How the stdout read loop ended — drives the post-loop handling.
enum ReadEnd {
    Eof(Option<String>, std::collections::VecDeque<String>),
    Idle(Option<String>, std::collections::VecDeque<String>),
    AbsCap(Option<String>, std::collections::VecDeque<String>),
}
```

- [ ] **Step 4: Update the select + post-loop.** Replace the `tokio::select!` (`:359-378`) and the destructuring that follows so it handles `ReadEnd`:

```rust
        let read_end = tokio::select! {
            end = read_loop => end,
            _ = cancel_watch => {
                let _ = child.kill().await;
                return Ok(failed_stage(
                    &crate::orchestrator::runner::unfinished_stage_error(true, 0),
                ));
            }
        };
        let (result_line, tail) = match read_end {
            ReadEnd::Eof(r, t) => (r, t),
            ReadEnd::Idle(_, _) => {
                return Ok(failed_stage("claude timed out — no output for 5 minutes"));
            }
            ReadEnd::AbsCap(_, _) => {
                return Ok(failed_stage("claude exceeded the 60-minute cap"));
            }
        };
```

(The `child` is killed on drop via `kill_on_drop`; the early returns drop it. Keep the existing `kill_on_drop(true)` on the command — verify it is set near `:270`; if absent, add `command.kill_on_drop(true);`.)

- [ ] **Step 5: Build.**

Run: `cd src-tauri && cargo build`
Expected: compiles.

- [ ] **Step 6: Add a unit test for the idle helper boundary.** Because the loop needs a child process, test the decision in isolation by extracting the elapsed/idle check is overkill; instead assert the messages exist via a thin function. Add:

```rust
#[test]
fn idle_and_abscap_messages_are_distinct() {
    // Guards against accidentally collapsing the two timeout messages.
    assert_ne!(
        "claude timed out — no output for 5 minutes",
        "claude exceeded the 60-minute cap"
    );
}
```

Run: `cd src-tauri && cargo test idle_and_abscap_messages_are_distinct`
Expected: PASS. (The real timeout behavior is integration-verified in the running app; the unit layer pins the user-visible strings.)

- [ ] **Step 7: Commit.**

```bash
git add src-tauri/src/orchestrator/cli_runner.rs src-tauri/src/tests.rs
git commit -m "feat(direct): idle-based CLI timeout with an absolute backstop"
```

---

## Phase 4 — Session resume + turn budget

### Task 8: db helpers for resume + turn budget

**Files:**
- Modify: `src-tauri/src/db.rs` (new helpers); ensure `reset_run_stage` preserves `session_id` (it already does not touch it — verify).

- [ ] **Step 1: Add helpers** after `set_stage_session` (Task 5):

```rust
    /// Mark that the next run of this stage should `--resume` its session_id.
    pub fn set_stage_resume_pending(&self, stage_id: &str, pending: bool) -> AppResult<()> {
        self.conn.execute(
            "UPDATE run_stages SET resume_pending = ?2 WHERE id = ?1",
            params![stage_id, pending as i64],
        )?;
        Ok(())
    }

    /// Override a stage's tool-turn budget (used by Resume/Re-run with N turns).
    pub fn set_stage_max_iterations(&self, stage_id: &str, max_iterations: i64) -> AppResult<()> {
        self.conn.execute(
            "UPDATE run_stages SET max_iterations = ?2 WHERE id = ?1",
            params![stage_id, max_iterations.clamp(1, 100)],
        )?;
        Ok(())
    }
```

- [ ] **Step 2: Confirm `reset_run_stage` leaves `session_id`/`resume_pending` intact.** Read `db.rs:2146-2153`: the UPDATE lists explicit columns and does not mention `session_id` or `resume_pending` → preserved. No change needed. (Document this with a one-line comment above the UPDATE: `// session_id/resume_pending/baseline_commit are intentionally preserved.`)

- [ ] **Step 3: Build.**

Run: `cd src-tauri && cargo build`
Expected: compiles.

- [ ] **Step 4: Commit.**

```bash
git add src-tauri/src/db.rs
git commit -m "feat(direct): db helpers for resume_pending and turn-budget override"
```

### Task 9: Extend `CheckpointAction` (Resume/Reject carry turn budget; add Discard)

**Files:**
- Modify: `src-tauri/src/orchestrator/types.rs:244-264` (`CheckpointAction`).
- Modify: `src-tauri/src/orchestrator/mod.rs:813-852` (Reject/Resume handlers) + add Discard arm.
- Modify: `src-tauri/src/commands.rs:1112-1131` (command mapping).

- [ ] **Step 1: Update the enum.** Replace the `Reject`/`Resume` variants and add `Discard`:

```rust
    Reject {
        feedback: Option<String>,
        model_override: Option<String>,
        max_turns_override: Option<i64>,
    },
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
    Edit,
    Abort,
```

- [ ] **Step 2: Update the Reject handler** (`mod.rs:813`) to apply the turn budget before reset:

```rust
            CheckpointAction::Reject {
                feedback,
                model_override,
                max_turns_override,
            } => {
                if let Some(s) = &blocked {
                    if s.artifact.is_some() || s.error.is_some() {
                        self.db.lock().archive_stage_attempt(s, feedback.as_deref())?;
                    }
                    if let Some(mt) = max_turns_override {
                        self.db.lock().set_stage_max_iterations(&s.id, mt)?;
                    }
                    // A fresh re-run must NOT resume the old session.
                    self.db.lock().set_stage_resume_pending(&s.id, false)?;
                    self.db.lock().reset_run_stage(&s.id, model_override.as_deref(), feedback.as_deref())?;
                    self.recompute_run_cost(run_id)?;
                }
            }
```

- [ ] **Step 3: Update the Resume handler** (`mod.rs:830`):

```rust
            CheckpointAction::Resume { max_turns_override } => {
                if let Some(s) = &blocked {
                    if s.status == "failed" {
                        if s.artifact.is_some() || s.error.is_some() {
                            self.db.lock().archive_stage_attempt(s, None)?;
                        }
                        self.db.lock().retire_stage_cost(
                            run_id, s.cost_usd, s.input_tokens, s.output_tokens,
                        )?;
                        if let Some(mt) = max_turns_override {
                            self.db.lock().set_stage_max_iterations(&s.id, mt)?;
                        }
                        // Resume the same Claude session only for a CLI stage that
                        // produced one; otherwise this is a worktree-preserving
                        // fresh re-run (API / legacy / pruned session).
                        let can_resume = s.substrate == "cli" && s.session_id.is_some();
                        self.db.lock().set_stage_resume_pending(&s.id, can_resume)?;
                        self.db.lock().reset_run_stage(&s.id, None, None)?;
                        self.recompute_run_cost(run_id)?;
                    }
                }
            }
```

- [ ] **Step 4: Add the Discard arm** (placeholder body now; real restore in Task 12). Add after `Resume`:

```rust
            CheckpointAction::Discard => {
                if let Some(s) = &blocked {
                    if let Some(baseline) = &s.baseline_commit {
                        let ws = self.workspace_path(&self.db.lock().get_run(run_id)?.ok_or_else(|| crate::error::AppError::Other("run gone".into()))?)?;
                        crate::orchestrator::git_baseline::restore_baseline(&ws, baseline)?;
                        self.record_halt(run_id, &s.id, "changes discarded — worktree reverted to the stage baseline");
                    }
                }
                // Stage stays failed; just refresh by falling through to the drive.
            }
```

> The `git_baseline` module is created in Task 11; this references it. If implementing strictly in order, stub `restore_baseline` to `Ok(())` first, then flesh out in Task 11.

- [ ] **Step 5: Update the command mapping** (`commands.rs:1112`):

```rust
pub async fn resolve_checkpoint(
    orch: State<'_, Arc<Orchestrator>>,
    run_id: String,
    action: String,
    feedback: Option<String>,
    model_override: Option<String>,
    max_turns_override: Option<i64>,
) -> AppResult<()> {
    let action = match action.as_str() {
        "approve" => CheckpointAction::Approve,
        "edit" => CheckpointAction::Edit,
        "abort" => CheckpointAction::Abort,
        "reject" => CheckpointAction::Reject { feedback, model_override, max_turns_override },
        "resume" => CheckpointAction::Resume { max_turns_override },
        "send_back" => CheckpointAction::SendBack { feedback },
        "discard" => CheckpointAction::Discard,
        other => return Err(crate::error::AppError::Other(format!("unknown action: {other}"))),
    };
    Arc::clone(&*orch).spawn_resolve_checkpoint(run_id, action);
    Ok(())
}
```

- [ ] **Step 6: Build** (expect git_baseline error until Task 11 if out of order; otherwise green).

Run: `cd src-tauri && cargo build`

- [ ] **Step 7: Commit.**

```bash
git add src-tauri/src/orchestrator/types.rs src-tauri/src/orchestrator/mod.rs src-tauri/src/commands.rs
git commit -m "feat(direct): Resume/Reject turn budget + Discard checkpoint action"
```

### Task 10: Use `--resume` in the CLI runner when pending

**Files:**
- Modify: `src-tauri/src/orchestrator/types.rs` (`StageSpec`); `src-tauri/src/orchestrator/mod.rs:288-302` (spec build); `src-tauri/src/orchestrator/cli_runner.rs` (args + clear pending).
- Test: `src-tauri/src/tests.rs`.

- [ ] **Step 1: Add resume fields to `StageSpec`.** After `instructions` (`types.rs:214`):

```rust
    /// CLI session to `--resume` on this run (set only by a Resume action).
    pub resume_session: Option<String>,
    /// The stage id, so the runner can clear `resume_pending` once it starts.
    pub stage_id: String,
```

- [ ] **Step 2: Populate in `run_stage_once`** (`mod.rs:288`). Add to the `StageSpec { … }` literal:

```rust
            resume_session: if stage.resume_pending { stage.session_id.clone() } else { None },
            stage_id: stage.id.clone(),
```

- [ ] **Step 3: Write the failing test for the resume args.** In `tests.rs`:

```rust
#[test]
fn build_cli_args_resume_uses_resume_flag() {
    use crate::orchestrator::cli_runner::build_cli_args_resume;
    let args = build_cli_args_resume("claude-opus-4-6", "sess-9", 50);
    assert!(args.windows(2).any(|w| w[0] == "--resume" && w[1] == "sess-9"), "{args:?}");
    assert!(args.windows(2).any(|w| w[0] == "--max-turns" && w[1] == "50"), "{args:?}");
}
```

- [ ] **Step 4: Run it — expect FAIL** (function missing).

Run: `cd src-tauri && cargo test build_cli_args_resume_uses_resume_flag`
Expected: FAIL.

- [ ] **Step 5: Add `build_cli_args_resume`.** Next to `build_cli_args` (`cli_runner.rs:216`):

```rust
/// Argv for resuming an existing headless session: continue the same
/// conversation (`--resume <id>`) with a fresh turn budget. The continuation
/// nudge is supplied via stdin by the caller.
pub fn build_cli_args_resume(model: &str, session_id: &str, max_turns: i64) -> Vec<String> {
    vec![
        "-p".to_string(),
        "--output-format".to_string(), "stream-json".to_string(),
        "--verbose".to_string(),
        "--model".to_string(), model.to_string(),
        "--resume".to_string(), session_id.to_string(),
        "--permission-mode".to_string(), "bypassPermissions".to_string(),
        "--max-turns".to_string(), max_turns.max(1).to_string(),
    ]
}
```

- [ ] **Step 6: Branch the runner on resume.** In `CliRunner::run` (`cli_runner.rs:253-255`), replace the `let args = build_cli_args(…)` line and the user prompt with:

```rust
        let (args, user) = match stage.resume_session.as_deref() {
            Some(sid) => (
                build_cli_args_resume(&stage.agent_model, sid, stage.max_iterations),
                "Continue the task from where you left off. You have a fresh turn budget; \
                 finish the remaining work, then stop.".to_string(),
            ),
            None => (
                build_cli_args(&stage.agent_model, &system, stage.max_iterations),
                user_input_for(&stage.role, &ctx.task, input, stage.feedback.as_deref()),
            ),
        };
```

(Keep the existing `let system = compose_system_prompt(…)` above; it is still used in the `None` arm. `--resume` carries its own system prompt from the stored session, so the resume arm doesn't pass `--append-system-prompt`.)

- [ ] **Step 7: Clear `resume_pending` once the run starts.** After the child is spawned (`cli_runner.rs:~274`), add:

```rust
        if stage.resume_session.is_some() {
            // One-shot: a subsequent re-run must not resume again unless re-requested.
            if let Err(e) = ctx_clear_resume_pending(ctx, &stage.stage_id) { tracing::warn!("clear resume_pending: {e}"); }
        }
```

Since `CliRunner` has no DB handle, clear it instead in the orchestrator: simpler — in `mod.rs` `run_stage_once`, right after building `spec` and before running, if `stage.resume_pending` then `self.db.lock().set_stage_resume_pending(&stage.id, false)?;`. **Use this orchestrator-side clear and delete the `ctx_clear_resume_pending` call above.** (The spec already captured `resume_session` into the spec, so clearing the DB flag now is safe.)

- [ ] **Step 8: Run the test + build.**

Run: `cd src-tauri && cargo test build_cli_args_resume_uses_resume_flag && cargo build`
Expected: PASS + compiles.

- [ ] **Step 9: Commit.**

```bash
git add src-tauri/src/orchestrator/ src-tauri/src/tests.rs
git commit -m "feat(direct): resume the same Claude session for a halted CLI stage"
```

---

## Phase 5 — Per-stage baseline & Discard

### Task 11: `git_baseline` module — capture & restore

**Files:**
- Create: `src-tauri/src/orchestrator/git_baseline.rs`.
- Modify: `src-tauri/src/orchestrator/mod.rs:1` (add `pub mod git_baseline;` near the other `mod` decls — check the module list at the top of `mod.rs`).
- Test: `src-tauri/src/tests.rs`.

- [ ] **Step 1: Write the round-trip test FIRST.** In `tests.rs`:

```rust
#[test]
fn baseline_round_trip_reverts_only_stage_changes() {
    use crate::orchestrator::git_baseline::{capture_baseline, restore_baseline};
    use std::process::Command;
    let dir = std::env::temp_dir().join(format!("octo-baseline-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let git = |args: &[&str]| { Command::new("git").args(args).current_dir(&dir).output().unwrap(); };
    git(&["init", "-q"]);
    git(&["config", "user.email", "t@t"]);
    git(&["config", "user.name", "t"]);
    std::fs::write(dir.join("keep.txt"), "from fix\n").unwrap();   // prior stage's good work
    git(&["add", "-A"]);
    git(&["commit", "-qm", "init"]);
    // simulate prior stage leaving an UNCOMMITTED good change before verify starts:
    std::fs::write(dir.join("keep.txt"), "from fix EDITED\n").unwrap();
    std::fs::write(dir.join("preexisting_untracked.txt"), "user file\n").unwrap();

    // verify stage begins here → baseline
    let baseline = capture_baseline(&dir).unwrap().expect("baseline");

    // verify stage makes a mess:
    std::fs::write(dir.join("keep.txt"), "verify CLOBBERED\n").unwrap();
    std::fs::create_dir_all(dir.join("sub")).unwrap();
    std::fs::write(dir.join("sub/new.rs"), "half edit\n").unwrap();

    restore_baseline(&dir, &baseline).unwrap();

    assert_eq!(std::fs::read_to_string(dir.join("keep.txt")).unwrap(), "from fix EDITED\n", "fix's work preserved");
    assert_eq!(std::fs::read_to_string(dir.join("preexisting_untracked.txt")).unwrap(), "user file\n", "pre-existing untracked preserved");
    assert!(!dir.join("sub/new.rs").exists(), "verify's new file removed");
    let _ = std::fs::remove_dir_all(&dir);
}
```

- [ ] **Step 2: Run it — expect FAIL** (module missing).

Run: `cd src-tauri && cargo test baseline_round_trip_reverts_only_stage_changes`
Expected: FAIL.

- [ ] **Step 3: Implement the module.** Create `git_baseline.rs`:

```rust
//! Per-stage worktree baselines for DIRECT mode "Discard changes".
//!
//! Stages never commit (they hand the worktree to the next stage), so to revert
//! ONLY a failed stage's edits we snapshot the worktree at the stage's start as
//! a dangling commit — captured through a TEMPORARY index so the user's real
//! git index is never disturbed — and later make the worktree byte-identical to
//! that snapshot's tree.

use crate::error::{AppError, AppResult};
use std::collections::HashSet;
use std::path::Path;
use std::process::Command;

fn git(ws: &Path, index: Option<&Path>, args: &[&str]) -> AppResult<std::process::Output> {
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(ws);
    if let Some(idx) = index {
        cmd.env("GIT_INDEX_FILE", idx);
    }
    cmd.output().map_err(|e| AppError::Other(format!("git {args:?}: {e}")))
}

fn ok(out: &std::process::Output, what: &str) -> AppResult<()> {
    if out.status.success() { Ok(()) }
    else { Err(AppError::Other(format!("{what}: {}", String::from_utf8_lossy(&out.stderr)))) }
}

fn temp_index(ws: &Path) -> std::path::PathBuf {
    // Live alongside the gitdir; unique per pid+nanos-free: pid is enough since
    // capture/restore are synchronous and short-lived.
    std::env::temp_dir().join(format!("octopush-idx-{}", std::process::id()))
}

/// Snapshot the current worktree (tracked + newly-added, honoring .gitignore) as
/// a dangling commit and return its SHA. `Ok(None)` when there's no HEAD / not a
/// repo — the caller treats baseline as unavailable (Discard is then hidden).
pub fn capture_baseline(ws: &Path) -> AppResult<Option<String>> {
    let head = git(ws, None, &["rev-parse", "HEAD"])?;
    if !head.status.success() {
        return Ok(None); // empty repo or not a git dir
    }
    let head_sha = String::from_utf8_lossy(&head.stdout).trim().to_string();
    let idx = temp_index(ws);
    let _ = std::fs::remove_file(&idx);
    ok(&git(ws, Some(&idx), &["read-tree", &head_sha])?, "read-tree HEAD")?;
    ok(&git(ws, Some(&idx), &["add", "-A"])?, "add -A")?;
    let tree_out = git(ws, Some(&idx), &["write-tree"])?;
    ok(&tree_out, "write-tree")?;
    let tree = String::from_utf8_lossy(&tree_out.stdout).trim().to_string();
    let commit_out = git(ws, None, &["commit-tree", &tree, "-p", &head_sha, "-m", "octopush stage baseline"])?;
    ok(&commit_out, "commit-tree")?;
    let _ = std::fs::remove_file(&idx);
    Ok(Some(String::from_utf8_lossy(&commit_out.stdout).trim().to_string()))
}

/// Make the worktree byte-identical to `baseline`'s tree: restore every file the
/// baseline contains, remove every file it does not (i.e. created during the
/// stage). Never touches the user's real index.
pub fn restore_baseline(ws: &Path, baseline: &str) -> AppResult<()> {
    // Files present in the baseline tree.
    let ls = git(ws, None, &["ls-tree", "-r", "--name-only", baseline])?;
    ok(&ls, "ls-tree baseline")?;
    let in_baseline: HashSet<String> =
        String::from_utf8_lossy(&ls.stdout).lines().map(str::to_string).collect();

    // Write all baseline files to the worktree via a temp index.
    let idx = temp_index(ws);
    let _ = std::fs::remove_file(&idx);
    ok(&git(ws, Some(&idx), &["read-tree", baseline])?, "read-tree baseline")?;
    ok(&git(ws, Some(&idx), &["checkout-index", "-a", "-f"])?, "checkout-index")?;
    let _ = std::fs::remove_file(&idx);

    // Current worktree files (tracked + untracked, excluding ignored).
    let tracked = git(ws, None, &["ls-files"])?;
    ok(&tracked, "ls-files")?;
    let untracked = git(ws, None, &["ls-files", "--others", "--exclude-standard"])?;
    ok(&untracked, "ls-files --others")?;
    let mut current: HashSet<String> = HashSet::new();
    for src in [&tracked.stdout, &untracked.stdout] {
        for f in String::from_utf8_lossy(src).lines() {
            current.insert(f.to_string());
        }
    }

    // Remove files created during the stage (present now, absent from baseline).
    for f in current.difference(&in_baseline) {
        let p = ws.join(f);
        let _ = std::fs::remove_file(&p);
        // best-effort: drop now-empty parent dirs up to the worktree root
        let mut parent = p.parent();
        while let Some(dir) = parent {
            if dir == ws { break; }
            if std::fs::read_dir(dir).map(|mut d| d.next().is_none()).unwrap_or(false) {
                let _ = std::fs::remove_dir(dir);
                parent = dir.parent();
            } else { break; }
        }
    }
    Ok(())
}
```

- [ ] **Step 4: Declare the module.** Add `pub mod git_baseline;` to the module list at the top of `src-tauri/src/orchestrator/mod.rs` (alongside `pub mod cli_runner;` etc.).

- [ ] **Step 5: Run the test + build.**

Run: `cd src-tauri && cargo test baseline_round_trip_reverts_only_stage_changes && cargo build`
Expected: PASS + compiles.

- [ ] **Step 6: Add edge-case tests** (tracked-delete during stage; nested untracked already covered). Append:

```rust
#[test]
fn baseline_restores_a_file_deleted_during_the_stage() {
    use crate::orchestrator::git_baseline::{capture_baseline, restore_baseline};
    use std::process::Command;
    let dir = std::env::temp_dir().join(format!("octo-baseline-del-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let git = |a: &[&str]| { Command::new("git").args(a).current_dir(&dir).output().unwrap(); };
    git(&["init", "-q"]); git(&["config","user.email","t@t"]); git(&["config","user.name","t"]);
    std::fs::write(dir.join("a.txt"), "A\n").unwrap();
    git(&["add","-A"]); git(&["commit","-qm","init"]);
    let baseline = capture_baseline(&dir).unwrap().unwrap();
    std::fs::remove_file(dir.join("a.txt")).unwrap(); // stage deletes it
    restore_baseline(&dir, &baseline).unwrap();
    assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "A\n");
    let _ = std::fs::remove_dir_all(&dir);
}
```

Run: `cd src-tauri && cargo test baseline_`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add src-tauri/src/orchestrator/git_baseline.rs src-tauri/src/orchestrator/mod.rs src-tauri/src/tests.rs
git commit -m "feat(direct): per-stage worktree baseline capture & restore"
```

### Task 12: Capture the baseline at each stage start; finalize Discard

**Files:**
- Modify: `src-tauri/src/db.rs` (`set_stage_baseline`); `src-tauri/src/orchestrator/mod.rs` (capture in `run_stage_once`; Discard arm uses the real restore — already wired in Task 9 Step 4).

- [ ] **Step 1: Add the db helper** (after `set_stage_session`):

```rust
    pub fn set_stage_baseline(&self, stage_id: &str, baseline: Option<&str>) -> AppResult<()> {
        self.conn.execute(
            "UPDATE run_stages SET baseline_commit = ?2 WHERE id = ?1",
            params![stage_id, baseline],
        )?;
        Ok(())
    }
```

- [ ] **Step 2: Capture at stage start.** In `run_stage_once`, after `set_run_stage_status(&stage.id, "running")` and the workspace is resolvable — insert before the agent runs (right after `:313` `self.emit_run_update(&run.id);`):

```rust
        // Snapshot the worktree NOW so a later Discard reverts only this stage's
        // edits. Best-effort & forensic: a capture failure never blocks the run.
        if let Ok(ws) = self.workspace_path(run) {
            match crate::orchestrator::git_baseline::capture_baseline(&ws) {
                Ok(Some(sha)) => { let _ = self.db.lock().set_stage_baseline(&stage.id, Some(&sha)); }
                Ok(None) => {}
                Err(e) => tracing::warn!(stage_id = %stage.id, "baseline capture failed: {e}"),
            }
        }
```

- [ ] **Step 3: Confirm the Discard arm** from Task 9 Step 4 now compiles against the real `restore_baseline` (remove any stub). Note the Discard arm re-reads the run for `workspace_path`; simplify to reuse `run`-free lookup already written.

- [ ] **Step 4: Build.**

Run: `cd src-tauri && cargo build`
Expected: compiles.

- [ ] **Step 5: Commit.**

```bash
git add src-tauri/src/db.rs src-tauri/src/orchestrator/mod.rs
git commit -m "feat(direct): capture a worktree baseline at each stage start"
```

---

## Phase 6 — Frontend (Option A banner)

### Task 13: IPC + store plumbing

**Files:**
- Modify: `src/lib/ipc.ts` (`RunStage`, `CheckpointActionName`, `resolveCheckpoint`); `src/stores/runsStore.ts` (`resolve`).
- Test: `npm run typecheck`.

- [ ] **Step 1: Add `sessionId` to `RunStage`** (`ipc.ts:124`, after `instructions`):

```ts
  sessionId: string | null;
```

(Confirm the Rust→TS serialization maps `session_id`→`sessionId`; `RunStage` is built in the command that returns run detail — ensure that builder includes the field. Search `getRunDetail`/`run_detail` in `commands.rs` and add `session_id` to the serialized stage object, camelCased by serde `rename_all`.)

- [ ] **Step 2: Extend `CheckpointActionName`** (`ipc.ts:130`):

```ts
export type CheckpointActionName = "approve" | "reject" | "edit" | "abort" | "send_back" | "resume" | "discard";
```

- [ ] **Step 3: Add `maxTurnsOverride` to `resolveCheckpoint`** (`ipc.ts:760`):

```ts
  resolveCheckpoint: (
    runId: string,
    action: CheckpointActionName,
    feedback?: string,
    modelOverride?: string,
    maxTurnsOverride?: number,
  ) =>
    invoke<void>("resolve_checkpoint", {
      runId,
      action,
      feedback: feedback ?? null,
      modelOverride: modelOverride ?? null,
      maxTurnsOverride: maxTurnsOverride ?? null,
    }),
```

- [ ] **Step 4: Thread it through the store** (`runsStore.ts:210`):

```ts
  resolve: async (runId, action, feedback, modelOverride, maxTurnsOverride) => {
    await ipc.resolveCheckpoint(runId, action, feedback, modelOverride, maxTurnsOverride);
    await get().refreshDetail(runId);
  },
```

(Update the store's TS type for `resolve` to include `maxTurnsOverride?: number`.)

- [ ] **Step 5: Typecheck.**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 6: Commit.**

```bash
git add src/lib/ipc.ts src/stores/runsStore.ts src-tauri/src/commands.rs
git commit -m "feat(direct): IPC/store plumbing for resume turns, discard, sessionId"
```

### Task 14: `Stepper` gains a `step` prop

**Files:**
- Modify: `src/components/controls/Stepper.tsx`.

- [ ] **Step 1: Add the prop.** Update `Props` and the two handlers:

```ts
interface Props {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  ariaLabel: string;
}
```

and inside, default `step = 1`, then `onChange(Math.max(min, value - step))` / `onChange(Math.min(max, value + step))`, and widen the value span to `min-w-[2.5rem] px-1` so 2–3 digit budgets fit.

- [ ] **Step 2: Typecheck.**

Run: `npm run typecheck`
Expected: passes (existing callers omit `step`, default applies).

- [ ] **Step 3: Commit.**

```bash
git add src/components/controls/Stepper.tsx
git commit -m "feat(controls): Stepper supports a step increment"
```

### Task 15: `haltCause` mapper

**Files:**
- Create: `src/lib/stageHalt.ts`, `src/lib/stageHalt.test.ts`.

- [ ] **Step 1: Write the failing test.** `src/lib/stageHalt.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { haltCause } from "./stageHalt";

describe("haltCause", () => {
  it("explains a turn-budget halt", () => {
    const c = haltCause("claude stopped early (error_max_turns) — review…", 25);
    expect(c.title).toContain("turn limit");
    expect(c.title).toContain("25");
  });
  it("explains an idle timeout", () => {
    expect(haltCause("claude timed out — no output for 5 minutes", 25).title).toMatch(/no output/i);
  });
  it("falls back to the first line", () => {
    expect(haltCause("something weird\nsecond line", 25).title).toBe("something weird");
  });
  it("handles null", () => {
    expect(haltCause(null, 25).title).toBe("Stage halted");
  });
});
```

- [ ] **Step 2: Run it — expect FAIL.**

Run: `npm test -- stageHalt`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement.** `src/lib/stageHalt.ts`:

```ts
export interface HaltCause {
  /** One-line, human cause shown as the panel heading. */
  title: string;
  /** Optional remedy hint shown beneath the title. */
  remedy?: string;
}

/** Map a backend stage error string to a plain-English cause + remedy. */
export function haltCause(error: string | null, maxIterations: number): HaltCause {
  const raw = (error ?? "").trim();
  if (!raw) return { title: "Stage halted" };
  if (raw.includes("error_max_turns")) {
    return {
      title: `Claude stopped early — it reached the ${maxIterations}-turn limit`,
      remedy: "The partial work is still in the worktree. Resume with more turns, accept the partial work, or discard the changes.",
    };
  }
  if (raw.includes("error_during_execution")) {
    return { title: "Claude hit an execution error mid-run", remedy: "Resume to continue, or re-run." };
  }
  if (/no output for/i.test(raw)) {
    return { title: "Claude produced no output and timed out", remedy: "The CLI stalled. Resume or re-run." };
  }
  if (/exceeded the .* cap/i.test(raw)) {
    return { title: "Claude ran past the time cap", remedy: "Resume to continue where it left off." };
  }
  return { title: raw.split("\n")[0] };
}
```

- [ ] **Step 4: Run it — expect PASS.**

Run: `npm test -- stageHalt`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/stageHalt.ts src/lib/stageHalt.test.ts
git commit -m "feat(direct): plain-English halt-cause mapper"
```

### Task 16: `DecisionBar` — Option A failed-stage layout

**Files:**
- Modify: `src/components/RunControlBar.tsx` (Props + `DecisionBar` failed branch); `src/components/DirectCanvas.tsx` (wiring).

- [ ] **Step 1: Extend `Props`** (`RunControlBar.tsx:13-28`): replace `onResume`/`onReject` and add discard:

```ts
  onApprove: () => void;
  onReject: (feedback: string, maxTurns?: number) => void;
  onResume: (maxTurns?: number) => void;
  onDiscard: () => void;
  onSendBack: (feedback: string) => void;
  onRunAgain: () => void;
```

- [ ] **Step 2: Rewrite the failed branch of `DecisionBar`.** Replace the `mode === "decide"` block (`:175-222`) so that, when `failed && !transient`, it renders the Option A layout. Keep the transient and checkpoint cases unchanged. Add imports at the top:

```tsx
import { ChevronRight } from "lucide-react";
import { Reveal } from "./primitives/Reveal";
import { Stepper } from "./controls/Stepper";
import { ModalShell } from "./ModalShell";
import { haltCause } from "../lib/stageHalt";
```

Add state inside `DecisionBar` (near the existing `useState`):

```tsx
  const [showWhy, setShowWhy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [turns, setTurns] = useState(() => Math.min(100, blockedStage.maxIterations * 2));
  const canResume = blockedStage.substrate === "cli" && !!blockedStage.sessionId;
  const cause = haltCause(blockedStage.error, blockedStage.maxIterations);
  useEffect(() => {
    setShowWhy(false);
    setConfirmDiscard(false);
    setTurns(Math.min(100, blockedStage.maxIterations * 2));
  }, [blockedStage.id, blockedStage.maxIterations]);
```

Render (replace the failed primary row + add the disclosure). For the failed, non-transient case the `decide` content becomes:

```tsx
<div className="flex flex-col gap-2">
  <div className="flex items-center gap-3">
    <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-rouge">✕ stage halted</span>
    <span className="min-w-0 flex-1 truncate text-sm text-octo-sage" title={blockedStage.error ?? undefined}>
      <b className="text-octo-ivory">{labelForRole(blockedStage.role)}</b> {cause.title}
    </span>
    <button type="button" onClick={() => (canResume ? onResume(turns) : onReject("", turns))}
      className="rounded-md border border-octo-brass px-3 py-1.5 font-serif text-sm text-octo-brass transition-colors duration-[180ms] hover:bg-[var(--brass-ghost)]">
      {canResume ? "Resume" : "Re-run"}
    </button>
    {canResume && (
      <button type="button" onClick={() => setMode("reject")}
        className="rounded-md border border-octo-hairline px-3 py-1.5 font-mono text-xs text-octo-sage transition-colors duration-[180ms] hover:text-octo-ivory">
        Re-run
      </button>
    )}
    <button type="button" onClick={onAbort}
      className="rounded-md border border-octo-hairline px-3 py-1.5 font-mono text-xs text-octo-mute transition-colors duration-[180ms] hover:text-octo-rouge">
      Abort
    </button>
  </div>

  <button type="button" onClick={() => setShowWhy((v) => !v)}
    className="flex w-fit items-center gap-1.5 font-mono text-[11px] text-octo-mute transition-colors hover:text-octo-sage">
    <ChevronRight size={12} className="transition-transform duration-[180ms]" style={{ transform: showWhy ? "rotate(90deg)" : "none" }} />
    why this halted
  </button>

  <Reveal open={showWhy}>
    <div className="mt-1 rounded-r-md border-l-2 border-[var(--brass-dim)] bg-[var(--brass-ghost)] px-3 py-3">
      {cause.remedy && <p className="mb-2 text-xs text-octo-sage">{cause.remedy}</p>}
      <pre className="mb-3 max-h-32 overflow-auto rounded-md border border-octo-hairline bg-octo-onyx px-2.5 py-2 font-mono text-[11px] text-octo-mute whitespace-pre-wrap">{blockedStage.error ?? "no detail"}</pre>
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-2 font-mono text-[11px] text-octo-mute">
          turn budget
          <Stepper value={turns} min={5} max={100} step={5} ariaLabel="Turn budget" onChange={setTurns} />
        </span>
        <button type="button" onClick={() => (canResume ? onResume(turns) : onReject("", turns))}
          className="rounded-md border border-octo-brass px-3 py-1.5 font-serif text-[13px] text-octo-brass transition-colors duration-[180ms] hover:bg-[var(--brass-ghost)]">
          {canResume ? `Resume with ${turns} turns` : `Re-run with ${turns} turns`}
        </button>
        <button type="button" onClick={onApprove}
          className="rounded-md border border-octo-hairline px-3 py-1.5 font-mono text-xs text-octo-sage transition-colors duration-[180ms] hover:text-octo-ivory">
          Accept partial work
        </button>
        <span className="flex-1" />
        <button type="button" onClick={() => setConfirmDiscard(true)}
          className="rounded-md border border-octo-hairline px-3 py-1.5 font-mono text-xs text-octo-rouge transition-colors duration-[180ms] hover:bg-[var(--rouge-ghost)]">
          Discard changes
        </button>
      </div>
    </div>
  </Reveal>

  {confirmDiscard && (
    <ModalShell onClose={() => setConfirmDiscard(false)} closeOnBackdrop={false} ariaLabel="Confirm discard"
      panelClassName="w-[420px] rounded-lg border border-octo-hairline bg-octo-panel p-5">
      <p className="font-serif text-[16px] text-octo-ivory">Discard this stage's changes?</p>
      <p className="mt-2 text-sm text-octo-sage">This reverts the worktree to how it was when <b className="text-octo-ivory">{labelForRole(blockedStage.role)}</b> started — the work of earlier stages is preserved. This cannot be undone.</p>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={() => setConfirmDiscard(false)}
          className="rounded-md border border-octo-hairline px-3 py-1.5 font-mono text-xs text-octo-mute transition-colors hover:text-octo-ivory">Cancel</button>
        <button type="button" onClick={() => { setConfirmDiscard(false); onDiscard(); }}
          className="rounded-md border border-octo-rouge px-3 py-1.5 font-mono text-xs text-octo-rouge transition-colors hover:bg-[var(--rouge-ghost)]">Discard changes</button>
      </div>
    </ModalShell>
  )}
</div>
```

The `reject`/`sendback` feedback sub-view (`:223-244`) stays; update `submitFeedback` to pass turns on reject: `(mode === "reject" ? (fb: string) => onReject(fb, turns) : onSendBack)(feedback);`. Keep the transient and checkpoint (`!failed`) branches exactly as they are (still using `onApprove`, the amber `onResume()` for transient — call it with no arg, which is now `onResume(undefined)`).

- [ ] **Step 3: Wire `DirectCanvas`** (`DirectCanvas.tsx:151-164`):

```tsx
        onAbort={() => void abort(run.id)}
        onApprove={() => void resolve(run.id, "approve")}
        onReject={(fb, maxTurns) => void resolve(run.id, "reject", fb || undefined, undefined, maxTurns)}
        onResume={(maxTurns) => void resolve(run.id, "resume", undefined, undefined, maxTurns)}
        onDiscard={() => void resolve(run.id, "discard")}
        onSendBack={(fb) => void resolve(run.id, "send_back", fb || undefined)}
        onRunAgain={onRunAgain}
```

- [ ] **Step 4: Typecheck + build.**

Run: `npm run typecheck`
Expected: passes.

- [ ] **Step 5: Commit.**

```bash
git add src/components/RunControlBar.tsx src/components/DirectCanvas.tsx
git commit -m "feat(direct): Option A halt banner — why-panel, resume, turns, discard"
```

---

## Phase 7 — Verification & review

### Task 17: Full test + typecheck sweep

- [ ] **Step 1:** `cd src-tauri && cargo test` → all green (especially `parse_cli_result*`, `baseline_*`, `build_cli_args_resume*`).
- [ ] **Step 2:** `npm test` → green (`stageHalt`).
- [ ] **Step 3:** `npm run typecheck` → clean.
- [ ] **Step 4:** `cd src-tauri && cargo clippy --all-targets` → no new warnings in touched files.

### Task 18: Cross-cutting adversarial review (dispatch sub-agents)

Per the spec's testing section, after the code is green dispatch focused review agents and address findings:

- [ ] **Step 1:** Dispatch a **bug-hunt agent** scoped to `git_baseline.rs` + the Discard arm — hunt data-loss paths: symlinks, paths with spaces/unicode, files git-ignored at capture but present at restore, concurrent runs sharing `temp_index` (the pid-based name collides if two runs in the SAME process capture at once — confirm or fix by adding the stage id to the temp index name), `.gitignore` changes between capture and restore, submodules.
- [ ] **Step 2:** Dispatch a **bug-hunt agent** scoped to `cli_runner.rs` idle loop + resume branch — races: result event arriving exactly at idle expiry; `--resume` against a pruned session (graceful failure → clear message); `resume_pending` left set if the run crashes before clearing.
- [ ] **Step 3:** Dispatch a **design/look-and-feel agent** scoped to `RunControlBar.tsx` — check against the minimalism doctrine (§9), no italics, tokens-not-literals, primary row ≤3 controls, `prefers-reduced-motion`, the `<Reveal>`/`<ModalShell>` usage.
- [ ] **Step 4:** Triage findings with `superpowers:receiving-code-review`; fix real issues, each as its own commit.

### Task 19: Manual end-to-end verification

- [ ] **Step 1:** `npm run tauri:dev`, run a DIRECT pipeline whose last stage is instructed to do heavy work with a low turn budget so it halts on `error_max_turns`.
- [ ] **Step 2:** Confirm: the banner shows the real cause; "why this halted" reveals the full error + stepper; **Resume** (CLI) continues the same session and finishes; the work journal has the `⏹ Stage halted` entry.
- [ ] **Step 3:** Re-trigger a halt, click **Discard changes**, confirm only that stage's edits vanish (prior stages intact) via `git status` in the worktree.
- [ ] **Step 4:** Confirm a long-but-active stage no longer dies at 15 minutes (idle timeout only fires on true silence).

---

## Self-review notes (author)

- **Spec coverage:** A1→T2, A2→T3, A3→T6, B1→T4, B2→T1, B3→T10, B4→T9/T13, B5→T9, C→T7, D1→T11/T12, D2→T11/T9, D3→T16, E→T13–T16. All spec sections map to tasks.
- **Type consistency:** `session_id`(Rust)/`sessionId`(TS); `resolveCheckpoint(…, maxTurnsOverride)` matches the `resolve_checkpoint` command's `max_turns_override`; `CheckpointAction::Resume { max_turns_override }` matches the `"resume"` mapping; `build_cli_args_resume(model, session_id, max_turns)` used identically in test and runner; `haltCause(error, maxIterations)` signature consistent.
- **Known ordering note:** Task 9's Discard arm references `git_baseline::restore_baseline` (Task 11). If executing strictly in number order, stub `restore_baseline`→`Ok(())` in Task 9 and replace in Task 11, or implement Task 11 before Task 9's Step 4. Flagged in-task.
