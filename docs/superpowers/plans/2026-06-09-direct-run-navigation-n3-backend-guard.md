# Run Navigation — Plan N3 (backend concurrency guard) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Refuse to start a second concurrent run in a workspace at the backend, so a stale/duplicated UI or a direct IPC call can't run two pipelines over the shared git worktree and corrupt it.

**Architecture:** Add `Orchestrator::has_concurrent_run(run_id)` (looks up the run's workspace, returns true if another run there is `running`/`paused`); the `start_run` Tauri command checks it and returns an `AppError` instead of spawning. Builds on N1/N2 (same branch/PR); the UI gate (N2) prevents reaching this in normal use.

**Tech Stack:** Rust (tokio), the existing `orchestrator/` + `commands.rs`.

**Spec:** `…/2026-06-09-direct-run-navigation-design.md` §6.

---

## File map
- **Modify** `src-tauri/src/orchestrator/mod.rs` — `has_concurrent_run`.
- **Modify** `src-tauri/src/commands.rs` — `start_run` calls the guard.
- **Modify** `src-tauri/src/tests.rs` — guard test.

---

### Task 1: concurrency guard

**Files:** Modify `src-tauri/src/orchestrator/mod.rs`, `src-tauri/src/commands.rs`; test in `src-tauri/src/tests.rs`.

Context: `commands.rs::start_run` currently is:
```rust
#[tauri::command]
pub async fn start_run(
    orch: State<'_, Arc<Orchestrator>>,
    run_id: String,
) -> AppResult<()> {
    Arc::clone(&*orch).start_run(run_id);
    Ok(())
}
```
`Orchestrator` holds `db: Arc<Mutex<Db>>`. `Db` has `get_run(run_id) -> Option<RunRow>` (with `workspace_id` + `status`) and `list_runs(workspace_id) -> Vec<RunRow>`. A run is "executing" when its `status` is `running` or `paused`.

- [ ] **Step 1 — Write the failing test** (in `mod orchestrator_tests`, which has `db_with_workspace()` + `Orchestrator::new_with_runner` + `CollectingSink`/`MockRunner`):
```rust
    #[tokio::test]
    async fn has_concurrent_run_detects_another_executing_run_in_the_workspace() {
        let (db, ws) = db_with_workspace();
        let ff = db.lock().list_pipelines().unwrap().into_iter()
            .find(|p| p.name == "Feature Factory").unwrap();
        let run_a = db.lock().create_run(&ws, &ff.id, "a", None, None, &[]).unwrap();
        let run_b = db.lock().create_run(&ws, &ff.id, "b", None, None, &[]).unwrap();
        let sink = Arc::new(CollectingSink { events: Mutex::new(vec![]) });
        let orch = Orchestrator::new_with_runner(Arc::clone(&db), sink, Box::new(MockRunner));

        // Nothing running yet → starting B is allowed.
        assert!(!orch.has_concurrent_run(&run_b).unwrap());
        // Mark A as running → B is now blocked.
        db.lock().set_run_status(&run_a, "running", false).unwrap();
        assert!(orch.has_concurrent_run(&run_b).unwrap());
        // A reaches a terminal status → B allowed again.
        db.lock().set_run_status(&run_a, "completed", true).unwrap();
        assert!(!orch.has_concurrent_run(&run_b).unwrap());
        // A run never blocks itself.
        db.lock().set_run_status(&run_b, "running", false).unwrap();
        assert!(!orch.has_concurrent_run(&run_b).unwrap());
    }
```

- [ ] **Step 2 — Run, confirm FAIL:** `cd src-tauri && cargo test --lib has_concurrent_run 2>&1 | tail -15`.

- [ ] **Step 3 — Add the method** to `impl Orchestrator` (`mod.rs`, near the other `pub` methods):
```rust
    /// True if a run OTHER than `run_id` is currently executing (running or
    /// paused) in the same workspace. Runs share the workspace's git worktree,
    /// so only one may execute at a time.
    pub fn has_concurrent_run(&self, run_id: &str) -> AppResult<bool> {
        let db = self.db.lock();
        let Some(run) = db.get_run(run_id)? else { return Ok(false) };
        let others = db.list_runs(&run.workspace_id)?;
        Ok(others
            .iter()
            .any(|r| r.id != run_id && matches!(r.status.as_str(), "running" | "paused")))
    }
```
  (`self.db.lock()` returns the `Db` guard; `get_run`/`list_runs` take `&str`. `AppResult`/`AppError` are already imported in `mod.rs`.)

- [ ] **Step 4 — Wire it into the command.** Replace `commands.rs::start_run` body:
```rust
#[tauri::command]
pub async fn start_run(
    orch: State<'_, Arc<Orchestrator>>,
    run_id: String,
) -> AppResult<()> {
    if orch.has_concurrent_run(&run_id)? {
        return Err(crate::error::AppError::Other(
            "another run is already in progress in this workspace".into(),
        ));
    }
    Arc::clone(&*orch).start_run(run_id);
    Ok(())
}
```

- [ ] **Step 5 — Run the test + suite:** `cd src-tauri && cargo test --lib has_concurrent_run 2>&1 | tail -8` then `cargo test --lib 2>&1 | tail -5`. Ignore the ~5 `pty_*` `PermissionDenied` sandbox failures. No new warnings (`cargo build 2>&1 | grep -iE "warning" | grep -v "never used.*\bids\b"`).

- [ ] **Step 6 — Commit:**
```bash
git add src-tauri/src/orchestrator/mod.rs src-tauri/src/commands.rs src-tauri/src/tests.rs
git commit -m "feat(direct/nav-n3): backend guard — refuse a concurrent run in a workspace"
```

---

## Self-review (against spec §6)

- **`start_run` rejects a second concurrent run in the workspace** (running/paused), allows after the first is terminal, never blocks itself → Task 1. ✓
- **Guard lives at the API boundary** (the command) using a testable `Orchestrator` method → Task 1. ✓
- **Clear error message** surfaced to the frontend via the IPC rejection → Task 1. ✓

**Type consistency:** `Orchestrator::has_concurrent_run(&str) -> AppResult<bool>`; uses `Db::get_run`/`list_runs` (existing). The command returns `AppResult<()>` (unchanged signature). `RunRow.status`/`.workspace_id`/`.id` are existing fields.

**Note on `draft`:** a `draft` run (created, not yet started) is intentionally NOT counted as executing — `begin` creates+starts back-to-back, and a lone draft holds no worktree state. Only `running`/`paused` block.
