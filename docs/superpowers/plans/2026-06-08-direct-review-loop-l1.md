# Review Feedback Loop — Plan L1 (data model + gated orchestrator) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a `code_review`/`verify` stage that carries loop config route work back to a prior stage via a human-gated "Send back" checkpoint action, with a bounded iteration cap and correct cost accounting — backward-compatible (no loop config ⇒ today's linear behavior).

**Architecture:** Loop config (`loop_target_position`, `loop_max_iterations`, `loop_mode`) lives on both `pipeline_stages` (template) and `run_stages` (run copy), plus a runtime `loop_iterations` counter on the review stage's `run_stages` row. The backward edge reuses the existing `reset_run_stage` over a contiguous `[target..=review]` range + the existing lowest-`pending`-first drive in `drive_inner` — **no new traversal primitive**. A new `CheckpointAction::SendBack` performs the reset; a gated-loop review stage pauses at `awaiting_checkpoint` so the human can choose Send-back vs Approve. Looped-away cost is retired onto the `runs` row so `recompute_run_cost` stops under-counting (also fixes today's Reject undercount). This plan is **gated mode only**; the structured verdict + auto loop are Plan L3.

**Tech Stack:** Rust (rusqlite/SQLite, tokio), the existing `orchestrator/` module. No frontend in L1.

---

## Scope & file map

- `src-tauri/src/db.rs` — migration (10 new columns), `PipelineStageRow`/`RunStageRow` structs, `get_pipeline_stages`, `insert_pipeline_stage`, `create_run`, `list_run_stages`, new `increment_loop_iteration` + `retire_stage_cost` + `get_retired_cost`.
- `src-tauri/src/orchestrator/types.rs` — `LoopMode` enum, `StageSpec` loop fields, `CheckpointAction::SendBack`.
- `src-tauri/src/orchestrator/mod.rs` — `run_stage_once` (build loop fields onto `StageSpec`), `drive_inner` (gated-loop pause), `resolve_checkpoint` (`SendBack` range reset + cap + cost retire), `recompute_run_cost` (add retired cost/baseline).
- `src-tauri/src/commands.rs` — `resolve_checkpoint` command maps `"send_back"`.
- `src-tauri/src/tests.rs` — tests per task.

Out of scope (later plans): the `VERDICT:` sentinel + auto mode (L3), all frontend/`CheckpointBar` (L2), template loop defaults + backfill (L4).

---

### Task 1: Migration + LoopMode + pipeline_stages loop config (template read/write)

**Files:**
- Modify: `src-tauri/src/db.rs` (migration block ~289; `PipelineStageRow` ~1792; `get_pipeline_stages` ~1374; `insert_pipeline_stage` ~1409; `seed_builtin_pipelines` call site ~1484)
- Modify: `src-tauri/src/orchestrator/types.rs` (after `AgentSubstrate`, ~55)
- Test: `src-tauri/src/tests.rs`

- [ ] **Step 1: Write the failing test**

Add this test **inside the existing `mod run_crud_tests`** in `src-tauri/src/tests.rs` (it already defines the `test_db()` and `seed_workspace()` helpers this plan reuses):

```rust
    #[test]
    fn pipeline_stage_loop_config_roundtrips() {
        let db = test_db();
        let pid = db.insert_pipeline("P", "d", false).unwrap();
        // Linear stage (no loop) + a review stage that loops back to position 0.
        db.insert_pipeline_stage(&pid, 0, "implement", "m", "api", false, None, 0, None).unwrap();
        db.insert_pipeline_stage(&pid, 1, "code_review", "m", "api", true, Some(0), 2, Some("gated")).unwrap();

        let stages = db.get_pipeline_stages(&pid).unwrap();
        assert_eq!(stages[0].loop_target_position, None);
        assert_eq!(stages[0].loop_max_iterations, 0);
        assert_eq!(stages[0].loop_mode, None);
        assert_eq!(stages[1].loop_target_position, Some(0));
        assert_eq!(stages[1].loop_max_iterations, 2);
        assert_eq!(stages[1].loop_mode.as_deref(), Some("gated"));
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test --lib review_loop_pipeline_tests 2>&1 | tail -20`
Expected: FAIL to compile — `insert_pipeline_stage` takes 6 args not 9, and `PipelineStageRow` has no `loop_target_position`.

- [ ] **Step 3: Add the migration columns**

In `src-tauri/src/db.rs`, in `migrate()`, after the last existing `add_column_if_missing(...)` call (the block ending ~line 289), append:

```rust
        // ── v5 Direct review feedback loop (Plan L1) ───────────────
        // Loop config on the *review* stage: where to return to, how many
        // times, and how (gated/auto). NULL target ⇒ linear (today's behavior).
        add_column_if_missing(&self.conn, "ALTER TABLE pipeline_stages ADD COLUMN loop_target_position INTEGER")?;
        add_column_if_missing(&self.conn, "ALTER TABLE pipeline_stages ADD COLUMN loop_max_iterations INTEGER NOT NULL DEFAULT 0")?;
        add_column_if_missing(&self.conn, "ALTER TABLE pipeline_stages ADD COLUMN loop_mode TEXT")?;
        add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN loop_target_position INTEGER")?;
        add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN loop_max_iterations INTEGER NOT NULL DEFAULT 0")?;
        add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN loop_mode TEXT")?;
        add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN loop_iterations INTEGER NOT NULL DEFAULT 0")?;
        // Cost of stages retired by a loop-back / reject, so the meter doesn't
        // under-count re-run work (Option A in the spec).
        add_column_if_missing(&self.conn, "ALTER TABLE runs ADD COLUMN retired_cost_usd REAL NOT NULL DEFAULT 0")?;
        add_column_if_missing(&self.conn, "ALTER TABLE runs ADD COLUMN retired_input_tokens INTEGER NOT NULL DEFAULT 0")?;
        add_column_if_missing(&self.conn, "ALTER TABLE runs ADD COLUMN retired_output_tokens INTEGER NOT NULL DEFAULT 0")?;
```

- [ ] **Step 4: Add the `LoopMode` enum**

In `src-tauri/src/orchestrator/types.rs`, after the `AgentSubstrate` impl (~line 55), add:

```rust
/// How a review stage's loop-back behaves. Persisted as text in
/// `*_stages.loop_mode`; absent/unknown ⇒ no loop (linear).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum LoopMode {
    /// Pause at a checkpoint; the human chooses Send-back vs Approve.
    Gated,
    /// Orchestrator loops automatically until pass or cap (Plan L3).
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
```

- [ ] **Step 5: Add the three fields to `PipelineStageRow` + read them in `get_pipeline_stages`**

In `src-tauri/src/db.rs`, extend `PipelineStageRow` (~1792):

```rust
pub struct PipelineStageRow {
    pub id: String,
    pub pipeline_id: String,
    pub position: i64,
    pub role: String,
    pub agent_model: String,
    pub substrate: String,
    pub checkpoint: bool,
    pub loop_target_position: Option<i64>,
    pub loop_max_iterations: i64,
    pub loop_mode: Option<String>,
}
```

Update `get_pipeline_stages` (~1374) SELECT + row build:

```rust
    pub fn get_pipeline_stages(&self, pipeline_id: &str) -> AppResult<Vec<PipelineStageRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, pipeline_id, position, role, agent_model, substrate, checkpoint,
                    loop_target_position, loop_max_iterations, loop_mode
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
                loop_target_position: r.get(7)?,
                loop_max_iterations: r.get(8)?,
                loop_mode: r.get(9)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }
```

- [ ] **Step 6: Extend `insert_pipeline_stage` to accept + write loop config**

Replace `insert_pipeline_stage` (~1409):

```rust
    #[allow(clippy::too_many_arguments)]
    pub fn insert_pipeline_stage(
        &self,
        pipeline_id: &str,
        position: i64,
        role: &str,
        agent_model: &str,
        substrate: &str,
        checkpoint: bool,
        loop_target_position: Option<i64>,
        loop_max_iterations: i64,
        loop_mode: Option<&str>,
    ) -> AppResult<String> {
        let id = Uuid::new_v4().to_string();
        self.conn.execute(
            "INSERT INTO pipeline_stages
                (id, pipeline_id, position, role, agent_model, substrate, checkpoint,
                 loop_target_position, loop_max_iterations, loop_mode)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![id, pipeline_id, position, role, agent_model, substrate, checkpoint as i64,
                    loop_target_position, loop_max_iterations, loop_mode],
        )?;
        Ok(id)
    }
```

- [ ] **Step 7: Fix the one existing caller (`seed_builtin_pipelines`)**

In `seed_builtin_pipelines` (~1484), update the call to pass linear defaults (L4 sets real values):

```rust
            for (i, (role, model, substrate, checkpoint)) in stages.iter().enumerate() {
                self.insert_pipeline_stage(&pid, i as i64, role, model, substrate, *checkpoint, None, 0, None)?;
            }
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd src-tauri && cargo test --lib review_loop_pipeline_tests 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/db.rs src-tauri/src/orchestrator/types.rs src-tauri/src/tests.rs
git commit -m "feat(direct/L1): loop-config columns + LoopMode + pipeline-stage CRUD"
```

---

### Task 2: run_stages loop columns — copy in create_run, read in list_run_stages, increment counter

**Files:**
- Modify: `src-tauri/src/db.rs` (`RunStageRow` ~1836; `list_run_stages` ~1559; `create_run` ~1520; add `increment_loop_iteration`)
- Test: `src-tauri/src/tests.rs`

- [ ] **Step 1: Write the failing test**

Add inside `mod run_crud_tests` (uses its `test_db()` + `seed_workspace()` helpers):

```rust
    #[test]
    fn create_run_copies_loop_config_and_counter_increments() {
        let db = test_db();
        let ws = seed_workspace(&db);
        let pid = db.insert_pipeline("P", "d", false).unwrap();
        db.insert_pipeline_stage(&pid, 0, "implement", "m", "api", false, None, 0, None).unwrap();
        db.insert_pipeline_stage(&pid, 1, "code_review", "m", "api", true, Some(0), 2, Some("gated")).unwrap();
        let run = db.create_run(&ws, &pid, "t", None, None, &[]).unwrap();

        let stages = db.list_run_stages(&run).unwrap();
        assert_eq!(stages[1].loop_target_position, Some(0));
        assert_eq!(stages[1].loop_max_iterations, 2);
        assert_eq!(stages[1].loop_mode.as_deref(), Some("gated"));
        assert_eq!(stages[1].loop_iterations, 0);

        db.increment_loop_iteration(&stages[1].id).unwrap();
        let after = db.list_run_stages(&run).unwrap();
        assert_eq!(after[1].loop_iterations, 1);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test --lib create_run_copies_loop_config 2>&1 | tail -20`
Expected: FAIL to compile — `RunStageRow` has no `loop_target_position`; no `increment_loop_iteration`.

- [ ] **Step 3: Extend `RunStageRow`**

In `src-tauri/src/db.rs`, add to `RunStageRow` (~1836), after `finished_at`:

```rust
    pub finished_at: Option<String>,
    pub loop_target_position: Option<i64>,
    pub loop_max_iterations: i64,
    pub loop_mode: Option<String>,
    pub loop_iterations: i64,
}
```

- [ ] **Step 4: Read the new columns in `list_run_stages`**

Update `list_run_stages` (~1559) SELECT + row build:

```rust
    pub fn list_run_stages(&self, run_id: &str) -> AppResult<Vec<RunStageRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, run_id, position, role, agent_model, substrate, checkpoint, status,
                    input_tokens, output_tokens, cost_usd, artifact, feedback, error, started_at, finished_at,
                    loop_target_position, loop_max_iterations, loop_mode, loop_iterations
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
                loop_target_position: r.get(16)?,
                loop_max_iterations: r.get(17)?,
                loop_mode: r.get(18)?,
                loop_iterations: r.get(19)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }
```

- [ ] **Step 5: Copy loop config in `create_run`**

In `create_run` (~1520), replace the per-stage INSERT loop body:

```rust
        for s in &stages {
            let model = stage_model_overrides
                .iter()
                .find(|(pos, _)| *pos == s.position)
                .map(|(_, m)| m.as_str())
                .unwrap_or(s.agent_model.as_str());
            let sid = Uuid::new_v4().to_string();
            self.conn.execute(
                "INSERT INTO run_stages
                    (id, run_id, position, role, agent_model, substrate, checkpoint, status,
                     loop_target_position, loop_max_iterations, loop_mode)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,'pending',?8,?9,?10)",
                params![sid, id, s.position, s.role, model, s.substrate, s.checkpoint as i64,
                        s.loop_target_position, s.loop_max_iterations, s.loop_mode],
            )?;
        }
```

(`loop_iterations` keeps its column default of 0.)

- [ ] **Step 6: Add `increment_loop_iteration`**

In `src-tauri/src/db.rs`, after `reset_run_stage` (~1685), add:

```rust
    /// Bump the loop-back counter on a review stage that triggered a loop.
    pub fn increment_loop_iteration(&self, stage_id: &str) -> AppResult<()> {
        self.conn.execute(
            "UPDATE run_stages SET loop_iterations = loop_iterations + 1 WHERE id = ?1",
            params![stage_id],
        )?;
        Ok(())
    }
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd src-tauri && cargo test --lib create_run_copies_loop_config 2>&1 | tail -20`
Expected: PASS. Also run the whole suite to catch other `RunStageRow` constructors that now need the new fields: `cargo test --lib 2>&1 | tail -15` — if any test builds `RunStageRow { .. }` literally, add the four fields there.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/db.rs src-tauri/src/tests.rs
git commit -m "feat(direct/L1): run_stages loop columns + create_run copy + increment_loop_iteration"
```

---

### Task 3: Retired-cost accounting (fixes the reset/recompute undercount)

**Files:**
- Modify: `src-tauri/src/db.rs` (add `retire_stage_cost`, `get_retired_cost`)
- Modify: `src-tauri/src/orchestrator/mod.rs` (`recompute_run_cost` ~215)
- Test: `src-tauri/src/tests.rs`

- [ ] **Step 1: Write the failing test**

Add inside `mod run_crud_tests`:

```rust
    #[test]
    fn retire_stage_cost_accumulates_on_the_run() {
        let db = test_db();
        let ws = seed_workspace(&db);
        let pid = db.insert_pipeline("P", "d", false).unwrap();
        db.insert_pipeline_stage(&pid, 0, "implement", "m", "api", false, None, 0, None).unwrap();
        let run = db.create_run(&ws, &pid, "t", None, None, &[]).unwrap();
        assert_eq!(db.get_retired_cost(&run).unwrap(), (0.0, 0, 0));

        db.retire_stage_cost(&run, 0.5, 100, 40).unwrap();
        db.retire_stage_cost(&run, 0.25, 50, 10).unwrap();
        let (cost, inp, out) = db.get_retired_cost(&run).unwrap();
        assert!((cost - 0.75).abs() < 1e-9);
        assert_eq!(inp, 150);
        assert_eq!(out, 50);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test --lib retire_stage_cost 2>&1 | tail -20`
Expected: FAIL — methods don't exist.

- [ ] **Step 3: Add the retire helpers**

In `src-tauri/src/db.rs`, after `increment_loop_iteration`, add:

```rust
    /// Accumulate a soon-to-be-reset stage's spend onto the run, so the cost
    /// meter keeps counting work erased by a loop-back / reject.
    pub fn retire_stage_cost(
        &self,
        run_id: &str,
        cost_usd: f64,
        input_tokens: i64,
        output_tokens: i64,
    ) -> AppResult<()> {
        self.conn.execute(
            "UPDATE runs
             SET retired_cost_usd = retired_cost_usd + ?2,
                 retired_input_tokens = retired_input_tokens + ?3,
                 retired_output_tokens = retired_output_tokens + ?4
             WHERE id = ?1",
            params![run_id, cost_usd, input_tokens, output_tokens],
        )?;
        Ok(())
    }

    /// `(retired_cost_usd, retired_input_tokens, retired_output_tokens)` for the run.
    pub fn get_retired_cost(&self, run_id: &str) -> AppResult<(f64, i64, i64)> {
        self.conn
            .query_row(
                "SELECT retired_cost_usd, retired_input_tokens, retired_output_tokens FROM runs WHERE id = ?1",
                params![run_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(Into::into)
    }
```

- [ ] **Step 4: Fold retired cost/baseline into `recompute_run_cost`**

In `src-tauri/src/orchestrator/mod.rs`, replace the accumulation in `recompute_run_cost` (~226–241):

```rust
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib retire_stage_cost 2>&1 | tail -10` → PASS.
Run: `cd src-tauri && cargo test --lib 2>&1 | tail -5` → all pass (the existing cost tests still hold because retired_* default to 0).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/db.rs src-tauri/src/orchestrator/mod.rs src-tauri/src/tests.rs
git commit -m "feat(direct/L1): retired-cost accounting in recompute_run_cost"
```

---

### Task 4: StageSpec loop fields + gated-loop pause in the drive loop

**Files:**
- Modify: `src-tauri/src/orchestrator/types.rs` (`StageSpec` ~126)
- Modify: `src-tauri/src/orchestrator/mod.rs` (`run_stage_once` StageSpec build ~117; `drive_inner` Done branch ~320)
- Test: `src-tauri/src/tests.rs` (orchestrator mock-runner module)

- [ ] **Step 1: Add a shared `looped_run` helper + write the failing test**

These tests go in **`mod orchestrator_tests`** (which already defines `db_with_workspace()`, `CollectingSink`, `MockRunner`, and imports `Orchestrator`, `CheckpointAction`, `RunStatus`). First add this helper to that module — it builds a custom 2-stage pipeline (linear `implement` → gated-loop `code_review`) and an orchestrator with the mock runner:

```rust
    /// (orch, run_id, db) for a pipeline: implement(pos 0, no loop) ->
    /// code_review(pos 1, gated loop back to 0, cap = `max_iter`).
    fn looped_run(max_iter: i64) -> (Orchestrator, String, Arc<Mutex<Db>>) {
        let (db, ws) = db_with_workspace();
        let pid = db.lock().insert_pipeline("Looped", "d", false).unwrap();
        db.lock().insert_pipeline_stage(&pid, 0, "implement", "m", "api", false, None, 0, None).unwrap();
        db.lock().insert_pipeline_stage(&pid, 1, "code_review", "m", "api", false, Some(0), max_iter, Some("gated")).unwrap();
        let run_id = db.lock().create_run(&ws, &pid, "t", None, None, &[]).unwrap();
        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Orchestrator::new_with_runner(Arc::clone(&db), sink, Box::new(MockRunner));
        (orch, run_id, db)
    }

    #[tokio::test]
    async fn gated_loop_review_stage_pauses_for_checkpoint() {
        let (orch, run_id, db) = looped_run(2);
        // code_review has checkpoint=false but a gated loop, so it must still pause.
        let status = orch.run_to_pause(&run_id).await.unwrap();
        assert_eq!(status, RunStatus::Paused);
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(stages[0].status, "done");                  // implement
        assert_eq!(stages[1].status, "awaiting_checkpoint");   // code_review parked
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test --lib gated_loop_review_stage_pauses 2>&1 | tail -20`
Expected: FAIL — the review stage runs through and the run completes (no pause), or compile error on `StageSpec`.

- [ ] **Step 3: Add loop fields to `StageSpec`**

In `src-tauri/src/orchestrator/types.rs`, extend `StageSpec` (~126):

```rust
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
}
```

Make sure `LoopMode` is imported where `StageSpec` is constructed (it is in the same `types` module; `mod.rs` already uses `crate::orchestrator::types::*` or specific imports — add `LoopMode` to the `use` if needed).

- [ ] **Step 4: Populate the fields in `run_stage_once`**

In `src-tauri/src/orchestrator/mod.rs`, extend the `StageSpec { .. }` build (~117):

```rust
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
        };
```

- [ ] **Step 5: Add a `has_active_gated_loop` helper + pause in `drive_inner`**

In `src-tauri/src/orchestrator/mod.rs`, add a small free helper near the top of the `impl Orchestrator` block (or a module fn):

```rust
    /// A stage that should pause for a human loop decision: it carries gated
    /// loop config and a target. (Auto mode is handled in Plan L3.)
    fn stage_has_gated_loop(stage: &crate::db::RunStageRow) -> bool {
        stage.loop_target_position.is_some()
            && stage.loop_max_iterations > 0
            && stage.loop_mode.as_deref() == Some("gated")
    }
```

Then in `drive_inner`'s match (~320), broaden the checkpoint pause to also fire for a gated-loop stage:

```rust
                StageStatus::Done if stage.checkpoint || Self::stage_has_gated_loop(&stage) => {
                    self.db
                        .lock()
                        .set_run_stage_status(&stage.id, "awaiting_checkpoint")?;
                    self.db.lock().set_run_status(run_id, "paused", false)?;
                    self.emit_checkpoint(run_id, &stage.id);
                    return Ok(RunStatus::Paused);
                }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd src-tauri && cargo test --lib gated_loop_review_stage_pauses 2>&1 | tail -20`
Expected: PASS. Then `cargo test --lib 2>&1 | tail -5` — fix any `StageSpec { .. }` literals in other tests that now need the four new fields (search for `StageSpec {`).

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/orchestrator/types.rs src-tauri/src/orchestrator/mod.rs src-tauri/src/tests.rs
git commit -m "feat(direct/L1): StageSpec loop fields + gated-loop checkpoint pause"
```

---

### Task 5: `SendBack` checkpoint action — the backward edge

**Files:**
- Modify: `src-tauri/src/orchestrator/types.rs` (`CheckpointAction` ~161)
- Modify: `src-tauri/src/orchestrator/mod.rs` (`resolve_checkpoint` ~334)
- Test: `src-tauri/src/tests.rs` (orchestrator mock-runner module)

- [ ] **Step 1: Write the failing test** (in `mod orchestrator_tests`, using the `looped_run` helper from Task 4)

```rust
    #[tokio::test]
    async fn send_back_resets_range_increments_and_retires_cost() {
        let (orch, run_id, db) = looped_run(2);
        // Drive to the review checkpoint.
        orch.run_to_pause(&run_id).await.unwrap();

        let before = db.lock().list_run_stages(&run_id).unwrap();
        let review_id = before[1].id.clone();
        let spent_before = db.lock().get_run(&run_id).unwrap().unwrap().cost_usd;

        // Human sends it back to implement.
        let status = orch.resolve_checkpoint(
            &run_id,
            CheckpointAction::SendBack { feedback: Some("fix the bug".into()) },
        ).await.unwrap();

        let after = db.lock().list_run_stages(&run_id).unwrap();
        // Re-driven forward and parked at the review checkpoint again.
        assert_eq!(status, RunStatus::Paused);
        assert_eq!(after[1].status, "awaiting_checkpoint");
        // Loop counter bumped on the review stage.
        let review = after.iter().find(|s| s.id == review_id).unwrap();
        assert_eq!(review.loop_iterations, 1);
        // implement re-ran with the feedback injected.
        assert_eq!(after[0].feedback.as_deref(), Some("fix the bug"));
        // Cost did not shrink across the loop-back (retired + live ≥ before).
        let spent_after = db.lock().get_run(&run_id).unwrap().unwrap().cost_usd;
        assert!(spent_after + 1e-9 >= spent_before);
    }

    #[tokio::test]
    async fn send_back_at_cap_does_not_loop() {
        let (orch, run_id, db) = looped_run(1);
        orch.run_to_pause(&run_id).await.unwrap();
        // First send-back uses the single allowed iteration (0 -> 1).
        orch.resolve_checkpoint(&run_id, CheckpointAction::SendBack { feedback: None }).await.unwrap();
        // At the cap (1/1): a second send-back must NOT reset; it approves through.
        let status = orch.resolve_checkpoint(&run_id, CheckpointAction::SendBack { feedback: None }).await.unwrap();
        let stages = db.lock().list_run_stages(&run_id).unwrap();
        assert_eq!(stages[1].status, "done");      // review accepted
        assert_eq!(status, RunStatus::Completed);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test --lib send_back_ 2>&1 | tail -20`
Expected: FAIL — `CheckpointAction::SendBack` does not exist.

- [ ] **Step 3: Add the `SendBack` variant**

In `src-tauri/src/orchestrator/types.rs`, add to `CheckpointAction` (~161):

```rust
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
```

- [ ] **Step 4: Handle `SendBack` in `Orchestrator::resolve_checkpoint`**

In `src-tauri/src/orchestrator/mod.rs`, add a `SendBack` arm to the `match action` in `resolve_checkpoint` (the block at ~345, alongside `Approve | Edit` and `Reject`):

```rust
            CheckpointAction::SendBack { feedback } => {
                if let Some(review) = &blocked {
                    let target = review.loop_target_position;
                    let at_cap = review.loop_iterations >= review.loop_max_iterations;
                    match (target, at_cap) {
                        (Some(target_pos), false) => {
                            // Retire the cost of every stage we're about to reset, then
                            // reset the contiguous [target..=review] range to pending.
                            let stages = self.db.lock().list_run_stages(run_id)?;
                            for s in &stages {
                                if s.position >= target_pos && s.position <= review.position {
                                    self.db.lock().retire_stage_cost(
                                        run_id, s.cost_usd, s.input_tokens, s.output_tokens,
                                    )?;
                                    // Inject the reviewer feedback onto the target stage only.
                                    let fb = if s.position == target_pos { feedback.as_deref() } else { None };
                                    self.db.lock().reset_run_stage(&s.id, None, fb)?;
                                }
                            }
                            self.db.lock().increment_loop_iteration(&review.id)?;
                            self.recompute_run_cost(run_id)?;
                        }
                        // No target, or cap reached → accept the review and move on
                        // (same effect as Approve).
                        _ => {
                            self.db.lock().set_run_stage_status(&review.id, "done")?;
                        }
                    }
                }
            }
```

> Note on placement: `blocked` is the `find(|s| status == "awaiting_checkpoint" || status == "failed")` computed at the top of `resolve_checkpoint`. `reset_run_stage` already zeroes the stage's `cost_usd`/tokens (which is *why* we retire first), sets `pending`, and writes `feedback`. After the match, the existing `self.run_to_pause(run_id).await` re-drives: the lowest non-done `pending` stage is now `target_pos`, so the run re-runs the range forward and re-reaches the review checkpoint.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib send_back_ 2>&1 | tail -20`
Expected: PASS both. Then `cargo test --lib 2>&1 | tail -5` — all pass (existing `Reject`/`Approve` paths untouched).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/orchestrator/types.rs src-tauri/src/orchestrator/mod.rs src-tauri/src/tests.rs
git commit -m "feat(direct/L1): SendBack checkpoint action — range reset + cap + cost retire"
```

---

### Task 6: Wire `send_back` through the IPC command

**Files:**
- Modify: `src-tauri/src/commands.rs` (`resolve_checkpoint` command)
- Test: `src-tauri/src/tests.rs` (optional — the command is a thin mapper)

- [ ] **Step 1: Map the new action string**

In `src-tauri/src/commands.rs`, in the `resolve_checkpoint` command's `match action.as_str()`, add the `send_back` arm:

```rust
    let action = match action.as_str() {
        "approve" => CheckpointAction::Approve,
        "edit" => CheckpointAction::Edit,
        "abort" => CheckpointAction::Abort,
        "reject" => CheckpointAction::Reject { feedback, model_override },
        "send_back" => CheckpointAction::SendBack { feedback },
        other => return Err(crate::error::AppError::Other(format!("unknown action: {other}"))),
    };
```

- [ ] **Step 2: Verify the whole backend builds + tests green**

Run: `cd src-tauri && cargo test --lib 2>&1 | tail -5`
Expected: PASS (all). Run `cargo build 2>&1 | tail -3` — no new warnings (the `model_override` binding is still used by `reject`, so no unused-variable warning).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(direct/L1): wire send_back through resolve_checkpoint command"
```

---

## Self-review (against the spec, §4 Plan L1)

- **Seven loop columns + migration** → Task 1 (pipeline_stages ×3) + Task 2 (run_stages ×4). ✓
- **PipelineStageRow / RunStageRow / StageSpec + create_run copy** → Tasks 1, 2, 4. ✓
- **increment_loop_iteration** → Task 2. ✓
- **run_to_pause loop-decision for gated mode + the cap** → Task 4 (pause) + Task 5 (SendBack reset + cap guard). ✓
- **CheckpointAction::SendBack + commands.rs wiring** → Tasks 5, 6. ✓
- **Cost Option A (retired cost)** → Task 3 (+ retire calls in Task 5). ✓ Also fixes today's Reject undercount path *to the extent SendBack uses it*; note Reject itself still zeroes without retiring — extending Reject to retire is a one-line follow-up not required by L1 and intentionally left for the Reject-undercount fix to avoid scope creep (call out in the PR).
- **Backward compatibility:** every column is NULL/DEFAULT 0; `stage_has_gated_loop` is false without config; `SendBack` is the only new action. Linear pipelines and existing tests behave identically. ✓
- **No frontend** (L2) and **no verdict/auto** (L3) — correctly excluded. ✓

**Type consistency check:** `LoopMode::{Gated,Auto}` + `from_db`/`as_db` (types.rs) used by `StageSpec.loop_mode` (Task 4); DB stores `loop_mode` as `TEXT` and the orchestrator compares the raw string `== Some("gated")` in `stage_has_gated_loop` (Task 4) and in `create_run`/copy paths — consistent (the enum is for `StageSpec`; the hot-path pause check reads the raw column to avoid an enum round-trip). `insert_pipeline_stage` arg order `(…, checkpoint, loop_target_position: Option<i64>, loop_max_iterations: i64, loop_mode: Option<&str>)` matches all call sites (seeder Task 1, tests Tasks 1–2). `retire_stage_cost(run_id, cost_usd, input_tokens, output_tokens)` / `get_retired_cost → (f64,i64,i64)` match Tasks 3 and 5.

**Harness (verified against `src-tauri/src/tests.rs`):** DB-level tests (Tasks 1–3) go in `mod run_crud_tests`, which defines `test_db() -> Db` and `seed_workspace(&Db) -> String` (workspace `"w1"`). Orchestrator tests (Tasks 4–5) go in `mod orchestrator_tests`, which defines `db_with_workspace() -> (Arc<Mutex<Db>>, String)` (project + workspace + seeded builtins), `CollectingSink`, `MockRunner` (returns `Done`, cost `0.01`, tokens `10/2`), and `Orchestrator::new_with_runner(Arc<Mutex<Db>>, Arc<dyn EventSink>, Box<dyn AgentRunner>) -> Orchestrator`. The `looped_run` helper (Task 4) builds a custom looped pipeline rather than a seeded builtin. All test snippets above are literal against these helpers.

**Sanity arithmetic for the cost assertion (Task 5):** MockRunner spends `0.01`/stage. First drive: implement+review = `0.02` live → `spent_before = 0.02`. SendBack retires both (`retired = 0.02`), resets the range, re-drives implement (`0.01`) and re-parks review (`0.01`) → live `0.02` + retired `0.02` = `spent_after = 0.04 ≥ 0.02`. ✓
