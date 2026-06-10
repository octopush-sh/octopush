# Direct Mode — Run Navigation (multi-run)

**Date:** 2026-06-09
**Status:** Design proposal, pending implementation plan
**Scope:** Let a workspace hold and navigate **multiple Direct runs** — view/switch between them via the Companion, return to the launcher to begin a new one — instead of being locked into a single run with no way back. Second of the Direct UX sub-projects (after the live orchestration view; the pipeline builder is the third).

---

## 1. Summary

Today `DirectCanvas` shows the launcher (`PipelineSetup`) **only when `getActiveRunId(workspaceId)` is null**, and the run view otherwise (reading the *active* run's detail). The moment a run starts, `activeRunIdByWs` is set and the canvas is pinned to that run with **no way back to the launcher**; `CompanionRuns` rows are **not clickable** (no run switching) and there is **no "new run" affordance**. The database already supports many runs per workspace — the lock is purely navigational.

This spec decouples **"the run you're viewing"** from **"the run that's executing"** and makes the **Companion the run hub**: click a run to view it; a `⟶ Begin a new run` CTA returns the canvas to the launcher. Because all runs in a workspace **share the one git worktree** (the blackboard), only **one run executes at a time**: you can always prepare a new run, but **"Begin the run" is gated** while another run is running/paused (enforced in both the UI and the backend).

### Goals
- View and switch between any run in the workspace from the Companion.
- A discoverable way to return to the launcher and **begin another run**.
- One executing run per workspace, gated in UI **and** backend (protects the shared worktree).
- No new top-level chrome (honor the Atelier surface contract; the Companion already hosts Runs).

### Non-goals
- **Concurrent execution / per-run worktrees** — out of scope (architectural; runs share one worktree).
- **Run queueing** — not building it (the gate is "finish/abort first", not a queue).
- The **pipeline builder** (separate sub-project) and **live-cost** changes.

---

## 2. State model (`runsStore`)

Add a **viewed-run** axis alongside the existing executing-run axis:
- New: `selectedRunIdByWs: Record<string, string | null | undefined>`. Meaning of the value for a workspace: a **runId** = view that run; **`null`** = show the launcher (explicit "new run" intent); **`undefined`** (unset) = default — view the active run if one exists, else the launcher.
- New action `selectRun(workspaceId, runId | null)` — sets the viewed run (`null` = launcher).
- New selector `getViewedRunId(workspaceId): string | null` — resolves the default: `selectedRunIdByWs[ws]` if defined, else `getActiveRunId(ws)` (so a fresh workspace with a running run still lands on it).
- New selector `hasExecutingRun(workspaceId): boolean` — `getActiveRunId(ws) !== null` (the active run is the first non-terminal run; `TERMINAL = {completed, aborted, failed}` already exists in the store).
- `begin(...)` is extended to `selectRun(ws, newRunId)` after the run is created+started (so the canvas jumps to the new run). `loadRuns` keeps setting `activeRunIdByWs`; it does **not** clobber an explicit `selectedRunIdByWs`.

The viewed run drives which run's `detailByRun` the canvas renders; `refreshDetail` must be called for the viewed run (not only the active one) so switching to a non-active run loads its stages.

---

## 3. `DirectCanvas`

Replace the `activeRunId`-keyed branch with the **viewed** run:
- `const viewedId = getViewedRunId(workspaceId)`; `const detail = viewedId ? getDetail(viewedId) : undefined`.
- On `active` (mode shown) or when `viewedId` changes: `loadRuns(ws)` and, if `viewedId` and its detail is missing, `refreshDetail(viewedId)`.
- If `viewedId` is `null` **or** its detail/run is missing → render `PipelineSetup` (launcher), passing the new `disabled`/guard props (§5).
- Else render the run view exactly as today (`RunTrack`/`StageFocus`/`RunCostMeter`/`CheckpointBar`) but reading the **viewed** run's `run`/`stages`. The existing `activeStage`/`shownStage`/`blockedStage`/loop-prop computation is unchanged (it already operates on `detail.stages`). Checkpoint actions still target `run.id` (the viewed run, which — when paused — is also the executing one).

No new chrome is added to the canvas; the launcher and the run view are the same two states as today, now selected by `viewedId` instead of `activeRunId`.

---

## 4. `CompanionRuns` (the run hub)

- **Header CTA:** above the list, a `⟶ Begin a new run` action (serif phrase, brass `⟶`, per the design system's italic-serif-but-upright CTA rule and the no-italic override) → `selectRun(ws, null)` (canvas shows the launcher). Always available.
- **Clickable rows:** each run row becomes a `<button>` → `selectRun(ws, r.id)`. Reuse the existing motion/`octo-rise-in` patterns; rows get the pointer cursor via the global rule.
- **Two indicators, not one:** today the row highlights `r.id === activeId`. Split into: the **viewed** run gets the brass left-border/ghost-bg highlight (`r.id === getViewedRunId(ws)`); the **executing** run gets a small `● running` / status dot via the existing `runStatusMeta` (independent of which is viewed). A run can be both.
- Empty state ("No runs yet.") stays; the `⟶ Begin a new run` CTA still shows so a fresh workspace can start.

---

## 5. `PipelineSetup` (launcher) — the concurrency gate

- New prop `executingRun: boolean` (passed from `DirectCanvas` = `hasExecutingRun(ws)`). The user can still pick a pipeline + write the task freely.
- **"Begin the run" is disabled** when `executingRun` is true, with an English helper line beneath it: *"A run is in progress — finish or abort it before starting another."* (mono, mute). When false, the button behaves as today.
- `onBegin` is unchanged in signature; `begin(...)` now auto-selects the new run (§2), so a successful Begin moves the canvas to the new run view.

---

## 6. Backend guard (defense-in-depth)

The UI gate is not the only line of defense — a stale/duplicated frontend or a direct IPC call must not start a second concurrent run in a workspace and corrupt the shared worktree. Add the check at the start path:
- In `start_run` (`commands.rs`) — or a thin `Orchestrator` method it calls — look up the run's `workspace_id` (`db.get_run(run_id)`), then `db.list_runs(workspace_id)` and reject with an `AppError` (e.g. *"another run is already in progress in this workspace"*) if **any other** run is non-terminal (status `running` | `paused` | `draft`-that's-executing). The run being started is allowed (it's `draft` → about to run). Concretely: a workspace may have at most one run whose status ∈ {running, paused}; `start_run` refuses if one already exists for a *different* run id.
- The frontend already surfaces backend errors via `run://error` / the IPC rejection; the UI gate (§5) prevents reaching this in normal use, so the guard is a safety net with a clear message.

---

## 7. Edge cases

- **Fresh workspace, no runs:** `getViewedRunId` → null → launcher; Begin enabled.
- **Run completes while viewing it:** stays viewed (now read-only: artifacts + diff; the live journal is empty out-of-session — expected). `hasExecutingRun` flips false → Begin re-enabled; the row's running dot clears.
- **Viewing a past (terminal) run while none executes:** read-only; Begin enabled; `⟶ Begin a new run` returns to the launcher.
- **Switching to a run whose detail isn't loaded:** `refreshDetail(viewedId)` fetches it (handled in §3).
- **Abort:** aborting the viewed (executing) run leaves you viewing it (terminal) and re-enables Begin.

---

## 8. Data flow

`CompanionRuns` click / `Begin a new run` → `selectRun(ws, id|null)` → `DirectCanvas` re-renders the viewed run or launcher (loading detail as needed). `begin(...)` → `create_run` + `start_run` (backend guard) → `selectRun(ws, newRunId)` → run view. Run lifecycle events (`run://stage-update`/`cost`/`checkpoint`/`error`) keep updating `detailByRun`/`runsByWs` as today; the viewed-run selection is independent of them.

---

## 9. Testing

- **runsStore (Vitest):** `selectRun` sets/clears the viewed run; `getViewedRunId` default resolution (selected → active → null); `hasExecutingRun`; `begin` auto-selects the new run.
- **CompanionRuns (Vitest):** row click calls `selectRun(r.id)`; `Begin a new run` calls `selectRun(null)`; viewed vs executing indicators render independently.
- **PipelineSetup (Vitest):** Begin disabled + helper when `executingRun`; enabled otherwise; `onBegin` fires when enabled.
- **DirectCanvas (Vitest):** launcher when `viewedId` null; run view for a selected non-active run.
- **Backend (Rust):** `start_run`/guard rejects a second concurrent run in a workspace (create two runs, start one, assert starting the other errors); allows starting after the first reaches a terminal status.

---

## 10. Decomposition (plans)

- **Plan N1 — store + navigation (frontend):** `selectedRunIdByWs`/`selectRun`/`getViewedRunId`/`hasExecutingRun`; `DirectCanvas` viewed-run rendering + detail loading; `begin` auto-select. (The pivot — everything else hangs off it.)
- **Plan N2 — Companion hub + launcher gate (frontend):** clickable rows + `⟶ Begin a new run` CTA + dual indicators in `CompanionRuns`; `PipelineSetup` `executingRun` gate. Vitest.
- **Plan N3 — backend concurrency guard:** `start_run` rejects a concurrent run in the workspace + Rust test.

Each plan is independently shippable; N1 alone makes navigation work (with the UI/backend gates added in N2/N3).

---

## 11. Open decisions

1. **Persisting the viewed run across reload** — `selectedRunIdByWs` is in-memory; on reload it resets to the default (active run). Acceptable (you land on the executing run); persisting per-workspace selection is a follow-up, not needed for the core fix.
2. **`draft` runs in the list** — `create_run` makes a `draft` row before `start_run`. With `begin` always create+start back-to-back, drafts are transient; the Companion shows them with a `draft` status briefly. Recommend: leave as-is (no separate "drafts" treatment).
3. **Where exactly the `⟶ Begin a new run` CTA sits** — header of the Runs section vs a footer. Recommend the header (most discoverable, mirrors "Begin a new study" framing).

---

## 12. Consistency check (self-review)

- Viewed-run decoupled from executing-run; one executing run/workspace enforced in UI **and** backend ✓. No new canvas chrome (launcher/run-view are the existing two states) ✓. Companion is the hub (already the Runs surface) ✓. Multi-run already supported by the DB; this is navigation-only + a safety guard ✓. Design-system: serif-phrase brass CTA, no italics, English copy, reuse motion ✓. Three independently-shippable plans, N1 observable on its own ✓.
