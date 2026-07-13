# Routines — phase 1 design (scheduled crews)

**Date:** 2026-07-13 · **Pillar:** crews that work while you don't (piece c) · **Feature key:** `routines.scheduled` (Pro)

The close of the pillar. (a) crew notifications (v0.4.7) told you when a crew needs you; (b) detached runs
(v0.4.8) let a crew outlive the app. (c) **Routines** makes a crew *start on its own* — a saved pipeline that
fires on a schedule and drives itself via the detached worker. "Every morning there's a finished PR waiting."

## What it reuses (audit verdict: nothing new is hard)

- **Firing a run is already headless.** `Db::create_run(workspace_id, pipeline_id, task, …)` needs no AppHandle;
  `Orchestrator::spawn_detached_segment` + the `start_run` guard sequence are plain methods a background task
  holding `Arc<Orchestrator>` (+ its `self.db`) can call — exactly what the detached bridge already does.
- **Workspace creation is headless.** `workspace::create(&Mutex<Db>, project_id, project_path, name, task,
  branch, from_branch, setup_script)` shells to git directly (shared by the Tauri command and `octopush-mcp`).
- **The periodic-task idiom exists.** `spawn_detached_bridge` (a `tauri::async_runtime::spawn` + `loop { sleep;
  tick }`) is the template; the scheduler is a sibling with a coarser (30s) tick.
- **Durable-scalar + entitlement + upgrade-sheet plumbing** are all in place.

## Scheduling model — in-app tick, catch-up-once

A `spawn_routine_scheduler` task ticks every **30s**. Each tick: `SELECT enabled routines WHERE next_due_at <=
now`; fire each; recompute `next_due_at`. Phase 1 fires **only while the app runs**; a routine whose window
passed while the app was closed **catches up once** on the next tick (never N times — `next_due` jumps to the
next future slot after firing). A **LaunchAgent backstop** for fire-while-fully-closed is deferred to phase 2
(it needs install/permission UX; the user paused Apple signing).

**Schedule kinds (phase 1):**
- `interval` — every N seconds (surfaced as minutes/hours). `next_due = now + N` at fire time (no drift accrual).
- `daily` — at `HH:MM` machine-local (chrono `Local`). `next_due` = the next `HH:MM` strictly after now.

`next_due` computation is a **pure function** (`routine_next_due(kind, spec, now_local) -> DateTime`) so it's
unit-testable without a clock. Weekly/cron are deferred (no cron crate; not worth the parser for phase 1).

## Workspace strategy — two modes

- **`fixed`** (recommended, simple): the routine targets an existing workspace; each fire runs the pipeline
  there. Overlap is naturally prevented by `has_concurrent_run` (a still-running fire → the next is skipped +
  logged). Right for recurring audits / triage / a long-lived branch.
- **`fresh`**: each fire creates a NEW worktree with a **unique timestamped branch** (`{branch_prefix}-{ts}`)
  off `base_branch` — a genuinely clean tree per fire (the "PR waiting each morning" mode). Because
  `workspace::create` is idempotent on `(project, branch)`, uniqueness is mandatory; a fixed branch would
  return last fire's dirty tree.
  - **Runaway guard:** a `fresh` routine will not fire while its own previous run (`last_run_id`) is still
    active — bounds accumulation to ~one worktree per cadence.
  - **No auto-reaper in phase 1** (documented limitation): fresh workspaces persist for review; the user
    archives them via the existing workspace flow. Phase 2 adds retention (auto-archive terminal routine
    workspaces older than N days).

## The guard-sharing spine (correctness)

`commands::start_run` performs 8 load-bearing guards (same-workspace concurrency, fresh-lease, monthly quota,
parallel-runs gate, budget, `mark_ever_ran`, detached spawn + in-process fallback discipline). The scheduler
MUST replicate all of them — but a **copy would drift**. So they're extracted into one shared
`orchestrator::launch::launch_run(orch, db, run_id, budget_usd)` that returns the SAME errors `start_run`
returns today; `commands::start_run` becomes a thin delegate, and the scheduler calls the identical function,
logging+skipping on any refusal (quota, parallel, concurrent, leased). One code path, no drift, reviewed once.

## Schema (additive)

```
CREATE TABLE routines (
  id, name, project_id (FK→projects CASCADE), pipeline_id (FK→pipelines CASCADE),
  task, reference_model, stage_overrides (JSON), budget_usd,
  schedule_kind ('interval'|'daily'), schedule_spec (secs | 'HH:MM'),
  workspace_mode ('fixed'|'fresh'), fixed_workspace_id, base_branch, branch_prefix,
  enabled, last_fired_at, next_due_at, last_run_id, created_at
);
```
`last_fired_at`/`next_due_at`/`last_run_id` are written **before** the fire's side effects so a crash or double
tick can't double-fire. Timestamps RFC3339; bools INTEGER; created via the `execute_batch` migrate block.

## Entitlement

`feature::ROUTINES_SCHEDULED` (Pro; in `pro()` + `free_unrestricted()`, NOT `free_restricted()`).
`require_feature_gate` on `create_routine`/`update_routine`/`set_routine_enabled`/`run_routine_now`, AND a
re-check inside the scheduler tick before each fire (a plan downgrade silently stops firing — defense in depth,
mirroring the History mirror read-gate).

## Commands & UI

- Commands: `list_routines`, `create_routine`, `update_routine`, `delete_routine`, `set_routine_enabled`,
  `run_routine_now` (fire immediately — the test affordance).
- **UI home (Atelier-compliant): a new Settings pane** `Routines` under a new `Automation` group — fully
  declarative via `settingsTabs.ts`, zero new top-level chrome (respects "Atelier layout is the law"). CRUD:
  a routine list (name · schedule · next fire · last outcome · enable toggle) + a `ModalShell` editor (project
  → pipeline → workspace mode → schedule → brief → optional budget). Motion primitives, tokens, upright-serif
  CTAs. A read-only "next fire" line can later surface in Mission Control (deferred; not required for phase 1).

## Deferred (phase 2+)

LaunchAgent fire-while-fully-closed; fresh-workspace auto-reaper/retention; weekly/cron schedules; per-routine
notification preferences; a Mission Control routines strip; "Schedule this pipeline…" deep-link from Direct.
