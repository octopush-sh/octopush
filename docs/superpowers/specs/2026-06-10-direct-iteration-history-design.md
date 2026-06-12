# Direct mode — iteration history, loop-back context, focus follow

**Date:** 2026-06-10 · **Scope:** Direct orchestrator + canvas. Fixes three live-testing findings (post v0.1.55).

## Problems

1. **Loop-backs destroy history.** `loop_back`/`reset_run_stage` erase the artifact/error of every stage in `[target..=review]`, and the `reset:true` event makes the frontend `clearLog` the journal. Only retired cost survives. Reject (re-run) has the same shape for a single stage. Reloading the app also loses every journal (live entries were never persisted).
2. **Gated send-back loses the review findings.** `CheckpointAction::SendBack` forwards only the user's optional note; the review's findings (its artifact) are reset away without reaching the target — the implement stage "starts from scratch". (Auto mode already forwards findings.) The re-run prompt also never says the worktree still holds the previous attempt.
3. **Focus doesn't follow the action.** A manually selected stage stays focused after it finishes; the newly running stage works off-screen.

## Design

### D1 — Persist the live journal (`stage_log`)

New table `stage_log(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, stage_id TEXT, entry TEXT)` — one row per `run://log` entry, including `{"kind":"reset"}` marker rows. Populated by a `PersistingSink` wrapper around the orchestrator's `EventSink` (installed in `Orchestrator::new`): on `RUN_LOG_EVENT` it inserts the entry (or a reset marker) and forwards. Constraint: event emission must never happen while holding the db lock (current emit sites comply; keep it that way).

- Journal segments = rows split on reset markers: segment *i* is iteration *i*'s journal; the segment after the last marker is the current one.
- IPC `get_stage_log(stage_id) -> Vec<Json>` returns all rows in order.
- Frontend hydration: when StageFocus shows a terminal stage whose in-memory journal is empty (e.g. after reload), it fetches the log and hydrates the **current** segment into `liveByStage` — the journal drawer works across restarts.

### D2 — Archive attempts (`stage_iterations`)

New table `stage_iterations(id TEXT PK, run_id, stage_id, iteration INTEGER, role, agent_model, status, artifact, error, cost_usd, input_tokens, output_tokens, closing_feedback, created_at)`.

- Helper `archive_stage_attempt(stage_row, closing_feedback)` inserts a snapshot with `iteration = COUNT(existing archives for stage)+1`. Called **before** every reset: in `loop_back` for each stage in range (only stages that have an artifact or error — pending stages aren't attempts; `closing_feedback` recorded on the review row), and in the Reject arm before `reset_run_stage`.
- IPC `list_stage_iterations(stage_id) -> Vec<StageIterationRow>` (camelCase serde).

### D3 — Send-back forwards the findings

In the `SendBack` arm, compose the target feedback from the review row already in hand (before reset): findings = review artifact `text`; user note appended as `Director's note: …`. Findings alone when the note is empty; note alone when the review somehow has no artifact. Auto mode unchanged.

`user_input_for` gains one line when `feedback` is present: the workspace may still contain the previous attempt's changes — revise them rather than starting over.

### D4 — Focus follows the action

In DirectCanvas: when the **manually selected** stage transitions out of `running`, clear the selection (`selectStage(runId, null)`) so the shown stage falls back to `activeStage` (next running / blocked / last done). A pin on an already-finished stage is respected — only "I was watching the live stage" follows the action.

### D5 — Iteration navigation in StageFocus

When a stage has archived iterations: a quiet nav in the focus header — `‹ attempt N of M ›` (mono, brass numerals, IconButton chevrons). Default = current attempt (M). Viewing a past attempt renders: an `archived attempt` eyebrow notice (mute), the archived artifact text (or rouge error), its cost, the `closing feedback` that ended it (when present), and that iteration's journal segment from `stage_log`. Current attempt renders exactly as today. Switching stages resets to current.

## Out of scope

Per-iteration worktree/diff snapshots (still the next candidate); CLI substrate max-turns audit; journal retention caps.

## Tests

Rust: sink persists entries + reset markers; `loop_back` archives artifacts with ordinals and composed feedback reaches the target's `feedback` column; Reject archives the failed attempt; send-back composition (findings+note / findings-only / note-only). Vitest: focus-follow clears only running→terminal selections; iteration nav renders archive + segment; hydration fills the journal drawer for terminal stages with empty memory.

## Halt recovery (2026-06-11)

Live testing of the iteration cap (an `implement` stage burning all its tool turns → failed by design) surfaced four gaps, fixed as F1–F4 on top of this design:

### F1 — The cap explains itself

`run_agentic_loop` emits a terminal notice — `iteration cap reached — N of N tool turns used` — into the journal at exhaustion, before returning the unfinished result. The journal no longer just stops.

### F2 — The halt is visible without scrolling

The StageFocus failed banner is `sticky top-0 z-10` inside the journal scroll container, layered over an opaque `bg-octo-onyx` wrapper so the rouge-ghost tint never lets scrolled lines bleed through. The CheckpointBar failed strip replaces the generic copy with the error's first line — `<role> halted: <firstLine(error)>`, truncated, full text in the hover `title`.

### F3 — Accept & continue (the pipeline-native recovery)

Approving a FAILED blocked stage in `resolve_checkpoint` now accepts the partial work instead of no-op pausing: it synthesizes a role-shaped artifact (`(accepted by the director after a halt: <first error line>)`, `refs_worktree` for diff/tests kinds), completes the stage as **done** via `complete_run_stage` preserving the burned tokens/cost, then drives on — the next stage runs against the worktree as the halted agent left it, and the following review catches gaps and loops back. Budget-parked and awaiting-checkpoint Approve behavior is unchanged. The failed checkpoint strip gains a primary brass-outlined serif action: `Accept & continue ⟶`; Re-run and Abort remain.

### F4 — Per-stage tool-turn budget

`max_iterations INTEGER NOT NULL DEFAULT 25` on **both** `pipeline_stages` and `run_stages` (`add_column_if_missing`; the default backfills existing rows with the former hard cap). Plumbed through `insert_pipeline_stage`/seeder, `save_pipeline`, `create_run` (copied per run stage), `StageDraft.maxIterations` (validated **1..=100**), and `StageSpec` — `ApiRunner` feeds it to `run_agentic_loop` (the cap error reports the real value) and `CliRunner` uses it for `--max-turns` (replacing the fixed 30). The builder's stage card gains a quiet `max turns` Stepper (5–100, default 25) after the gate pill; `toStageDrafts` serializes it; loop-target-by-identity logic untouched.

## Run control & provenance (2026-06-11)

User findings from live runs — the brief vanishes after launch, an in-flight stage can't be stopped (`abort_run` only flips the DB status that the drive loop checks BETWEEN stages, so the agent keeps spending), and a finished pipeline can't be re-run — fixed as R1–R3 on top of this design:

### R1 — The brief is always visible

RunTrack's header row gains, beside `stage n/m`, a `the brief` eyebrow (mono 10px, mute) over the run task as a truncated one-line serif text (full text in the hover `title`). Clicking it toggles a `<Reveal>` under the header with the full task — `whitespace-pre-wrap`, sage, selectable. Uses the `run` prop the component already received.

### R2 — Stop the stage in course (real cancellation)

The Orchestrator keeps per-run cancel flags (`cancels: Mutex<HashMap<String, Arc<AtomicBool>>>`): `run_stage_once` installs a FRESH flag before each stage, hands it to the substrate via `StageContext.cancel`, and removes it after. `stop_current_stage(run_id)` sets the live flag (no-op when idle); `abort_run` ALSO sets it — aborting kills in-flight work, not just the DB row. `run_agentic_loop` checks the flag at the top of every iteration: when set it closes the journal with a `stopped by the director` notice and returns unfinished; `ApiRunner` maps unfinished+cancelled to `stopped by the director — review the work journal, then accept, re-run, or abort` (vs the iteration-cap message) via the shared `unfinished_stage_error` helper. `CliRunner` races the child's NDJSON stream against a 500ms cancel poll (`tokio::select!`) and on stop kills the child and fails the stage with the same message, zero usage; the 15-minute backstop stays. `drive_inner` never downgrades an abort issued mid-stage back to `paused`. IPC: `stop_stage(run_id)` → `ipc.stopStage` → `runsStore.stopStage`. UI: while the run is `running`, a reserved RunTrack header slot (S1) shows two quiet mono controls — `Stop the stage` (hairline, hover ivory) and `Abort` (mute, hover rouge). The stopped stage lands in the EXISTING failed/decision-strip recovery (Accept & continue / Re-run / Abort) — no new recovery UI.

### R3 — Run it again

`runsStore.launcherPrefill` (`{ task, pipelineId, overrides: [position, agentModel][] }`) with `setLauncherPrefill` and a consume-once getter. Terminal runs (completed/aborted/failed) show `⟶ Run it again` (serif, brass) in the same reserved header slot; DirectCanvas builds the prefill from the run — every stage's `[position, agentModel]` — and navigates to the launcher (`selectRun(ws, null)`). PipelineSetup consumes the prefill once pipelines are loaded: task always applies; pipeline + crew only when that pipeline still exists (stale overrides never leak onto a different pipeline; `overrideTuples()` already drops models equal to the pipeline default at Begin).
