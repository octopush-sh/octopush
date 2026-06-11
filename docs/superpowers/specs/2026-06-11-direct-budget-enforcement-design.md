# Direct mode — run budget enforcement

**Date:** 2026-06-11 · **Scope:** orchestrator + launcher + ledger strip. Follows the cost/ledger work (run `costUsd` vs `baselineUsd`).

## Problem

A Direct run can burn arbitrarily much money: the ledger shows spend live, but nothing stops a pipeline (especially a looping one) from sailing past what the user intended to pay. The launcher shows an estimate; there is no way to make it binding.

## Design

**An optional per-run budget, enforced between stages.** Stages are atomic — no mid-stage interruption. The gate fires before each pending stage starts.

- **Data:** `runs.budget_usd REAL NULL` (`add_column_if_missing`). `RunRow` / TS `Run` gain `budgetUsd: number | null`. The `start_run` IPC takes an optional `budgetUsd`, persisted onto the run before the drive starts (threaded launcher → `runsStore.begin` → `ipc.startRun`).
- **Enforcement (drive loop):** before starting a pending stage, if `budget_usd` is `Some(b)`, `b > 0`, and `run.cost_usd >= b`, the stage does NOT run. The run pauses exactly like a checkpoint: stage → `awaiting_checkpoint`, run → `paused`, a `run://log` notice on that stage (`budget reached — $X.XX of $Y.YY spent`, persisted to `stage_log` by the existing sink) + `emit_checkpoint`.
- **Override:** approving the checkpoint is a conscious override — the parked stage (identifiable as never-started: no `started_at`, no artifact) returns to `pending` and runs regardless of budget; the gate fires again before the FOLLOWING stage. Abort behaves as usual. Reject re-parks (it is not an override).
- **No CheckpointBar changes:** the stage-journal notice is the explanation; no new props or flags.

**Launcher (PipelineSetup):** an optional budget field in the estimate panel — quiet mono eyebrow `budget`, `$`-prefixed mono input, placeholder `no budget`. Parsed as a positive float, else null. Fixed slot; the panel never shifts.

**Ledger strip (RunLedger):** when `budgetUsd` is set, `· budget $Y.YY` (mute, `.octo-tabular`) follows the spent figure; at/over budget the fragment turns rouge.

## Tests

Rust (scripted runner): budget 0.01 + stage costing 0.02 → after stage 1, stage 2 `awaiting_checkpoint`, run `paused`, notice in `stage_log`; approve → stage 2 runs; NULL budget never pauses. Vitest: launcher passes `budgetUsd` (null when empty/invalid); RunLedger renders the budget fragment, turns rouge at/over budget, omits it when null.
