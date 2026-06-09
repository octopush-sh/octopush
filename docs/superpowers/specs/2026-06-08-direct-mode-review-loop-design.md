# Direct Mode — Configurable Review Feedback Loop

**Date:** 2026-06-08
**Status:** Design proposal, pending implementation plan
**Scope:** Add a *configurable review feedback loop* to Direct-mode pipelines, so a `code_review`/`verify` stage that requests changes can route work back to a prior stage (e.g. `implement`/`fix`) instead of flowing strictly forward. Builds directly on the orchestration engine specified in [`2026-06-07-direct-mode-agent-orchestration-design.md`](2026-06-07-direct-mode-agent-orchestration-design.md) and now partly implemented under `src-tauri/src/orchestrator/`.

---

## 1. Summary

Direct mode's pipeline is **strictly linear today**, and review findings are never resolved:

- `Orchestrator::run_to_pause` (`orchestrator/mod.rs`) advances purely by **document order** — `stages.iter().find(|s| s.status != "done")` always picks the lowest-position non-`done` stage. A review stage's verdict is captured only as freeform `StageArtifact { kind: Review }` text and threaded **forward** to the next stage via `previous_artifact`; nothing reads it as a pass/fail signal, and nothing returns to a prior stage.
- The one corrective action — `CheckpointAction::Reject` → `Db::reset_run_stage` (`db.rs`) — re-runs **the same stage** (the review itself), not the code stage that produced the issues. So "the reviewer found problems in `implement`" has no path back to `implement`.

This spec makes the loop a **first-class, user-configurable property of the pipeline**, expressed as one unified mechanism with two modes:

- **`gated`** — when a review stage requests changes, the run pauses at a checkpoint and the human chooses **"Send back to {target}"** vs **"Approve anyway"**. (Human-gated loop-back.)
- **`auto`** — the orchestrator loops `target ↔ review` automatically until the review passes or an iteration cap is hit; the checkpoint is only an override/escape hatch. (Automatic review→fix loop.)

A dedicated `fix` stage is **not** a separate feature — it is simply choosing a different `loop_target`. **No loop config = today's linear behavior**, which stays valid for simple pipelines. Seeded templates ship a sensible default; the not-yet-built linear pipeline builder will expose the knobs.

This is the canonical "automatic, human-free retry loops" non-goal from the 2026-06-07 spec (§Non-goals) being **deliberately reopened** under tight bounds: every loop has a hard `max_iterations` cap, and `auto` mode degrades to a checkpoint at the cap or on an unparseable verdict. The earlier spec rejected *unbounded* autonomous retry; this proposes *bounded, configured, escape-hatched* retry. The reopening is called out explicitly in §10.

### Goals

- A review/verify stage can carry loop config: **where** to return to, **how many times**, and **how** (gated vs auto).
- One mechanism, two modes. "Human-gated loop-back" and "automatic review→fix loop" are the same column set with `loop_mode` differing.
- Backward-compatible: a stage with no loop config behaves exactly as today (forward-only, Reject = re-run same stage).
- Bounded and robust: a hard iteration cap, and a defined failure mode when the auto verdict cannot be parsed (→ fall back to a gated checkpoint, never loop blindly).
- Templates ship a working default; the future builder exposes the controls.

### Non-goals

- **No DAG.** The loop is a backward edge from one review stage to one earlier stage on the same linear pipeline; it is not branching, fan-out, or conditional sub-graphs. The pipeline remains an ordered list.
- **No multi-target fan-out.** A review stage loops to exactly **one** `loop_target` position. (Whether that target may be *any* prior stage or only the immediately-preceding code stage is an open decision — §9.)
- **No new substrate or runner changes.** `ApiRunner`/`CliRunner` and the `AgentRunner` trait (`orchestrator/runner.rs`) are untouched except for how a review verdict is surfaced (§3, additive).
- **No commit/merge behavior change in itself** — but the loop *exposes* an unresolved question about per-stage worktree snapshots that the engine references but does not yet implement (§3.4, §9, flagged as a conflict).

---

## 2. Concepts & vocabulary (delta over the 2026-06-07 spec)

| Term | Meaning |
|------|---------|
| **Loop config** | A small set of columns on a *review* stage: `loop_target_position`, `loop_max_iterations`, `loop_mode`. Absent ⇒ linear. |
| **Loop target** | The earlier stage (by `position`) the run returns to when the review requests changes. Usually `implement`/`fix`. |
| **Loop-back** | One traversal of the backward edge: reset the target (and the stages between it and the review) to `pending`, then re-drive forward. |
| **Iteration** | One completed loop-back. Counted per loop edge, capped by `loop_max_iterations`. |
| **Verdict** | A review stage's structured pass / changes-requested signal, parsed from its outcome. Drives `auto`; informs `gated`. |
| **Cap** | The point where iterations are exhausted; the run escalates to a checkpoint regardless of mode. |

---

## 3. Design

### 3.1 Data model

Loop config lives on the **review/verify stage** (the stage that *requests* the loop-back), in **both** the template table and the run's private copy — mirroring how every other stage attribute (`role`, `agent_model`, `substrate`, `checkpoint`) is duplicated from `pipeline_stages` into `run_stages` by `Db::create_run` so that editing a template never mutates run history (`db.rs`, `create_run`).

**New columns on `pipeline_stages`:**

| Column | Type | Meaning |
|--------|------|---------|
| `loop_target_position` | `INTEGER NULL` | The `position` of the stage to return to. `NULL` = no loop (linear). |
| `loop_max_iterations` | `INTEGER NOT NULL DEFAULT 0` | Max loop-backs from this stage. `0` with a non-null target is degenerate → treat as linear (validation note below). |
| `loop_mode` | `TEXT NULL` | `'gated'` or `'auto'`. `NULL` (or unknown) = linear. |

**New columns on `run_stages`:**

| Column | Type | Meaning |
|--------|------|---------|
| `loop_target_position` | `INTEGER NULL` | Copied from the template stage by `create_run`. |
| `loop_max_iterations` | `INTEGER NOT NULL DEFAULT 0` | Copied. |
| `loop_mode` | `TEXT NULL` | Copied. |
| `loop_iterations` | `INTEGER NOT NULL DEFAULT 0` | **Runtime counter**, lives on the *review* stage row; incremented each time this stage triggers a loop-back. This is the per-loop iteration count the run tracks. |

Putting `loop_iterations` on the review-stage row (not a separate table) keeps the counter co-located with the edge that owns it, survives restart (it's persisted like every other `run_stages` field), and needs no new table. A pipeline can have several review stages each with its own loop and its own counter — naturally supported because each row counts independently.

**Migration approach.** The repo uses two styles in `Db::migrate` (`db.rs`): a big `execute_batch` of `CREATE TABLE IF NOT EXISTS` for the base schema, and incremental `add_column_if_missing(&self.conn, "ALTER TABLE … ADD COLUMN …")` for later additions (SQLite has no `ADD COLUMN IF NOT EXISTS`; `add_column_if_missing` swallows the "duplicate column name" error). These six columns are added the incremental way, appended after the existing `workspaces`/`projects` ALTERs:

```rust
add_column_if_missing(&self.conn, "ALTER TABLE pipeline_stages ADD COLUMN loop_target_position INTEGER")?;
add_column_if_missing(&self.conn, "ALTER TABLE pipeline_stages ADD COLUMN loop_max_iterations INTEGER NOT NULL DEFAULT 0")?;
add_column_if_missing(&self.conn, "ALTER TABLE pipeline_stages ADD COLUMN loop_mode TEXT")?;
add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN loop_target_position INTEGER")?;
add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN loop_max_iterations INTEGER NOT NULL DEFAULT 0")?;
add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN loop_mode TEXT")?;
add_column_if_missing(&self.conn, "ALTER TABLE run_stages ADD COLUMN loop_iterations INTEGER NOT NULL DEFAULT 0")?;
```

(`loop_iterations` is `run_stages`-only — there is no template counterpart.)

**CRUD touch-points (`db.rs`):**

- `get_pipeline_stages` SELECT + `PipelineStageRow` struct: add the three template columns.
- `insert_pipeline_stage` signature + INSERT: accept and write them (the seeder and the future builder call this).
- `create_run`'s per-stage INSERT into `run_stages`: copy `loop_target_position`, `loop_max_iterations`, `loop_mode` from the template `PipelineStageRow`; `loop_iterations` defaults to `0`. The override loop already copies `agent_model` overrides positionally — loop columns sit alongside, unaffected by `stage_model_overrides`.
- `list_run_stages` SELECT + `RunStageRow` struct: add all four run columns.
- A small `Db::increment_loop_iteration(stage_id)` and the existing `reset_run_stage` are how the counter and the loop-back are persisted (§3.3).

**`StageSpec` / IPC.** `StageSpec` (`orchestrator/types.rs`) gains `loop_target: Option<i64>`, `loop_max: i64`, `loop_mode: Option<LoopMode>` so `run_stage_once` can construct it from the `RunStageRow`. A `LoopMode { Gated, Auto }` enum mirrors `AgentSubstrate` (a `from_db`/`as_db` pair; unknown string → `None` ⇒ linear). On the frontend, `PipelineStage` and `RunStage` in `src/lib/ipc.ts` gain `loopTargetPosition: number | null`, `loopMaxIterations: number`, `loopMode: "gated" | "auto" | null`, and `RunStage` additionally gets `loopIterations: number` — matching the `#[serde(rename_all = "camelCase")]` on the Rust row structs.

### 3.2 Structured review verdict (for `auto` mode)

`auto` mode needs to know **pass vs changes-requested** without a human. Today a review stage returns `StageArtifact { kind: Review, text, payload: None }` (`runner.rs`, `ApiRunner::run` → `artifact_kind_for("code_review") == Review`); the text is freeform and `payload` is always `None`. We need a robust, parseable verdict that doesn't depend on natural-language sentiment.

**Mechanism — a structured tail the reviewer emits, parsed into the artifact `payload`.** The review stage's system prompt (`system_prompt_for`, the `"code_review" | "verify"` arm in `runner.rs`) is extended, **only when the stage has `loop_mode = auto`**, to require the agent to end its output with a single sentinel line:

```
VERDICT: PASS
```
or
```
VERDICT: CHANGES_REQUESTED
```

After the agentic loop returns (`ApiRunner`/`CliRunner`), the runner parses the **last** `VERDICT:` line out of `r.text`, sets a new `StageOutcome` field `verdict: Option<ReviewVerdict>` (`Pass | ChangesRequested`), and also stores it on the artifact `payload` (`{"verdict":"changesRequested"}`) so the UI and `previous_artifact` can read it. The sentinel is chosen over JSON-only output because the review stage's `text` is *also* shown verbatim in the focus pane — a trailing line keeps the human-readable body intact while remaining trivially parseable.

**Failure mode (robustness).** If no `VERDICT:` line is present, or the line is malformed/ambiguous, `verdict = None`. The orchestrator then **does not loop**: it falls back to a **gated checkpoint** for that cycle regardless of the configured mode, with a message ("The reviewer's verdict could not be read — choose how to proceed"). Rationale: an unparseable verdict in `auto` mode must never silently loop forever or silently pass; pausing for a human is the safe default. This also covers the substrate where the agent simply ignores the instruction. The verdict parser is pure and unit-testable over recorded text fixtures (parallels the existing `CliRunner` contract-test approach).

> Note: `gated` mode does **not** require the verdict to function — the human reads the findings and decides. The verdict is *advisory* in gated mode (it can pre-highlight the "Send back" button) and *load-bearing* only in auto mode. This keeps gated mode robust even against a reviewer that never emits the sentinel.

### 3.3 Orchestrator control flow

Today's drive loop (`drive_inner` inside `run_to_pause`, `orchestrator/mod.rs`) is:

1. pick the lowest-position non-`done` stage;
2. if it's not `pending`, the run is already blocked → restore `paused`;
3. run it (`run_stage_once`); on `Failed` → `paused` + checkpoint; on `Done` **with** `checkpoint` → `awaiting_checkpoint` + `paused`; otherwise continue.

Advancement is implicitly `position+1` because completed stages become `done` and the next `find` skips them. The loop adds **one decision point**: *after a review stage with loop config completes with a changes-requested verdict, and iterations remain, reset the target and re-drive from there instead of advancing.*

**Where the change lands.** In `run_stage_once`'s `StageStatus::Done` arm (after `complete_run_stage` + `recompute_run_cost`), or equivalently in `drive_inner` right after a stage returns `Done`, evaluate loop config on the just-completed stage:

```
let spec_has_loop = stage.loop_target_position.is_some()
    && stage.loop_max_iterations > 0
    && loop_mode.is_some();

if stage_is_review && spec_has_loop {
    let wants_changes = match (loop_mode, outcome.verdict) {
        (Auto,  Some(Pass))             => false,                 // review passed → advance
        (Auto,  Some(ChangesRequested)) => stage.loop_iterations < stage.loop_max_iterations,
        (Auto,  None)                   => GATE,                  // unparseable → checkpoint (see below)
        (Gated, _)                      => GATE,                  // human decides at the checkpoint
    };
    ...
}
```

There are three outcomes:

- **Advance (no loop this cycle):** review passed (`auto`+`Pass`), or the stage has no loop config. Behaves exactly as today. If the review stage *also* has `checkpoint = true`, the existing `awaiting_checkpoint` pause still happens — loop and checkpoint compose (a passing auto-review with a checkpoint still pauses for a human "ship it").

- **Loop-back (`auto` + `ChangesRequested` + iterations remain):**
  1. `increment_loop_iteration(review_stage_id)` → bumps `loop_iterations`.
  2. For every stage `s` with `loop_target_position ≤ s.position ≤ review.position`, call `reset_run_stage(s.id, None, feedback)` — this sets each back to `pending`, clears its artifact/error/timings/tokens/cost, and (critically) stamps the reviewer's findings as `feedback` on the **target** stage so `user_input_for` surfaces "Reviewer feedback to address this time:" on the re-run (the plumbing already exists — `reset_run_stage` writes `feedback`, and `user_input_for` reads `stage.feedback`). The target gets the findings; the intervening stages are reset with `feedback = None` (or their own prior feedback cleared).
  3. The review stage itself is reset to `pending` too (it's the highest position in the reset range), so after the target re-runs forward, the review naturally runs again.
  4. `continue` the drive loop. The next `find(status != "done")` now picks `loop_target_position` (lowest non-done), and the run re-drives forward through the same stages, re-reaching the review.
  5. `recompute_run_cost` is called (cost handling in §3.4).

  Because each reset stage returns to `pending` and the drive always selects the lowest non-`done` `pending` stage, **no new traversal primitive is needed** — resetting a contiguous prior range and re-entering the existing loop *is* the backward edge. This is the key reuse: the engine already re-drives `pending` stages forward; we only change *which* stages are `pending`.

- **Cap reached (`auto` + `ChangesRequested` + `loop_iterations == loop_max_iterations`)** or **`auto` + unparseable verdict** or **`gated` mode**: do **not** loop. Set the review stage to `awaiting_checkpoint` and the run to `paused`, emit `run://checkpoint` (exactly the existing checkpointed-stage path). The human then resolves via the checkpoint UX (§3.5). At the cap, the checkpoint message states the loop is exhausted ("Reviewed N times; still requesting changes").

**Interaction with existing checkpoints.** The loop decision happens **before** the existing `Done if stage.checkpoint` branch. Precedence:

1. If the stage **failed** → `paused`/checkpoint (unchanged, highest priority).
2. Else if it's a review with an *active auto loop-back* (changes requested, iterations remain, verdict parsed) → reset range + `continue` (no pause), **even if the review stage has `checkpoint = true`** — auto mode's whole point is not to stop while it can still loop. (The checkpoint still fires later if/when the review finally passes, or at the cap.)
3. Else if `gated` loop, or cap reached, or unparseable verdict → `awaiting_checkpoint` + `paused`.
4. Else if `checkpoint = true` (ordinary gate) → `awaiting_checkpoint` + `paused` (unchanged).
5. Else → continue (unchanged).

**Single-drive safety is preserved.** `run_to_pause` already guards one active drive per run via the `active` set; loop-backs happen **inside** one `drive_inner` call, so no re-entrancy is introduced. The cap guarantees termination: `loop_iterations` strictly increases and is bounded by `loop_max_iterations`, so the `loop { … }` in `drive_inner` cannot spin forever.

### 3.4 Cost accounting

This is the subtlest interaction and it **conflicts with current code** if done naively. `recompute_run_cost` (`orchestrator/mod.rs`) computes the run total as `Σ run_stages.cost_usd` over the **current rows**, and `reset_run_stage` (`db.rs`) **zeroes** `input_tokens`, `output_tokens`, and `cost_usd` on every stage it resets. Therefore a loop-back that resets `implement`+`code_review` would **erase those iterations' cost** from the total — re-running `implement` twice would show ~1× cost, not ~2×, which is wrong: looped re-runs really do spend the tokens.

This already affects today's single Reject re-run (the prior attempt's cost vanishes), but the loop makes it systematic and material. Two options:

- **Option A (recommended): accumulate retired cost on the run.** Add a `runs.retired_cost_usd REAL NOT NULL DEFAULT 0` column. **Before** resetting a stage range for a loop-back (and in `Reject`), sum the soon-to-be-cleared stages' `cost_usd`/tokens into `retired_cost_usd` (and parallel retired token columns if we want the baseline to include them). `recompute_run_cost` then computes `cost = retired_cost_usd + Σ current run_stages.cost_usd`, and the baseline likewise adds the retired tokens re-priced at the reference model. This makes "re-running implement twice costs ~2×" true and keeps the savings-vs-baseline honest (both sides include the retried work). It also retro-fixes the existing Reject undercount.
- **Option B: per-iteration stage history rows.** Instead of overwriting on reset, archive the completed `run_stages` row into a `run_stage_history` table before resetting. Richer (full per-iteration audit, replayable in the UI) but heavier: new table, new reads, `recompute_run_cost` must union live + history. Defer to a fast-follow.

**Decision:** ship Option A in the loop plan (one column, minimal change to `recompute_run_cost`, fixes a latent existing bug). Option B is a later enhancement if per-iteration history is wanted in the UI. Either way, `recompute_run_cost` is called after every loop-back so `run://cost` keeps the meter live; the savings figure stays apples-to-apples because retired tokens are re-priced at the reference model just like live ones (`baseline_cost`, `cost.rs`).

> Worktree/commit caveat (flagged conflict): the cost model assumes re-running `implement` re-does work on top of the *current* worktree. As of the autonomous-prompts PR (#15), `PIPELINE_PREAMBLE` (`runner.rs`) now correctly tells the agent to **leave changes uncommitted in the working tree** (the next stage reads them there) — there is deliberately **no per-stage snapshot/commit in the orchestrator** (a first cut that committed per stage was reverted because committing empties the index↔workdir diff that `get_diff_text` and the `code_review` handoff depend on). So a loop-back's re-run sees the *accumulated* edits from the prior attempt, not a reverted baseline. Whether loop-backs should revert to a pre-target snapshot (which requires *building* that snapshot mechanism, compatibly with the diff viewer) or simply stack edits is an open decision (§6 #3).

### 3.5 Checkpoint UX

`gated` mode and the cap need a checkpoint action distinct from today's Reject-re-runs-the-same-stage.

**Backend.** Add a `CheckpointAction::SendBack { feedback: Option<String> }` variant (`orchestrator/types.rs`) and wire it in `commands.rs::resolve_checkpoint` (the `match action.as_str()` that maps `"approve"|"edit"|"abort"|"reject"` → adds `"send_back"`). In `Orchestrator::resolve_checkpoint` (`orchestrator/mod.rs`), `SendBack` performs the **same range reset** as an auto loop-back (§3.3 step 2): find the blocked review stage, increment its `loop_iterations`, reset `[loop_target_position ..= review.position]` to `pending` with the reviewer's findings as `feedback` on the target, then `run_to_pause`. This explicitly differs from `Reject`, which keeps `reset_run_stage(blocked.id, …)` on the **single** blocked stage (re-run the review itself) — both remain available. `SendBack` is only offered when the blocked stage actually has a `loop_target_position`.

**Frontend (`CheckpointBar.tsx`).** Today the bar shows **Approve & continue / Reject / Abort** (and for a failed stage, **Re-run / Abort**). For a *paused review stage that has loop config*, add a primary action:

> **Send back to {labelForRole(targetRole)}** — `⟶ Send back to Implement`

rendered as the italic-serif-phrase-but-upright (no-italic rule) CTA, beside **Approve anyway** (maps to the existing `approve`) and **Abort**. Copy is English (per CLAUDE.md). The bar also shows the iteration state: `Reviewed 1 of 3 — changes requested` using the brass mono meta voice and roman-numeral-adjacent styling already used in the track. At the cap, the "Send back" button is disabled with helper text "Loop exhausted (3/3) — approve to continue or abort." `RunTrack.tsx`'s `labelForRole` is reused to render the target's human label; the target role is found by matching `loopTargetPosition` against the run's stages. The `runsStore.resolve` signature extends to pass the `"send_back"` action (it already forwards `action`, `feedback`, `modelOverride`).

What the human sees in `gated` mode: the run pauses after each review cycle; the bar names the reviewer's verdict and findings (the review artifact in the focus pane via `StageFocus.tsx`), and offers **Send back** (loop once more, with the findings injected as feedback) vs **Approve anyway** (accept despite findings) vs **Abort**. In `auto` mode the human normally sees nothing until the review passes or the cap is hit — at which point the same bar appears.

### 3.6 Templates

The seeder `Db::seed_builtin_pipelines` (`db.rs`) defines stages as `(role, model, substrate, checkpoint)` tuples. Extend the tuple (or add a parallel optional field) to carry `(loop_target_position, loop_max_iterations, loop_mode)` for review stages. Proposed defaults (conservative, gated — matching the 2026-06-07 "generous default checkpoints" stance):

- **Feature Factory** (`plan, plan_review, implement, code_review, test`): set `code_review` (position 3) → `loop_target = 2` (`implement`), `max_iterations = 2`, `mode = gated`. The human stays in control of each loop-back; `test` still runs after the review resolves.
- **Bugfix relay** (`repro, fix, verify`): set `verify` (position 2) → `loop_target = 1` (`fix`), `max_iterations = 2`, `mode = gated`. Natural fix↔verify loop.
- **Plan & review** (`plan, critique, refine`): **no loop** (leave columns `NULL`). It's thinking-only (no code), and `refine` already consumes `critique`'s output forward; a loop adds little. Stays linear — demonstrating that "no loop config = linear" is a first-class, shipped configuration.
- **Claude Code build** (`plan, implement, code_review, test`, CLI substrate): set `code_review` (position 2) → `loop_target = 1` (`implement`), `max_iterations = 2`, `mode = gated`. (This fourth builtin already exists in the seeder; included for completeness.)

`gated` as the default is intentional and is itself an open decision (§9) — `auto` is the more "magic" demo but the riskier default.

Seeding is idempotent (keyed on builtin name); **existing installs already have the four builtins seeded**, so they will *not* be re-seeded with loop config. The loop columns will be `NULL` on already-seeded builtins ⇒ they stay linear until re-created. If we want existing installs to adopt the defaults, the migration must additionally `UPDATE pipeline_stages SET loop_… = … WHERE pipeline_id IN (builtins) AND role IN ('code_review','verify')` — a one-shot backfill guarded so it runs once. Flagged as an open decision (§9): backfill vs. let only fresh installs get loops.

### 3.7 Builder forward-compat (contract only — not built here)

The 2026-06-07 spec defers the linear builder to a fast-follow. This spec only fixes the **contract** it must honor:

- For any stage whose role produces an `ArtifactKind::Review` (`artifact_kind_for`: `plan_review | code_review | critique | verify`), the builder may expose three controls: **Return to →** (a dropdown of earlier stages by position/label), **Max loop-backs** (integer ≥ 1), and **Mode** (Gated / Auto). Leaving "Return to" unset = linear.
- The builder writes these through the extended `insert_pipeline_stage`. It must validate: `loop_target_position < this.position` (no forward/self loops), `loop_max_iterations ≥ 1` when a target is set, and `loop_mode ∈ {gated, auto}` when a target is set. (`max_iterations = 0` with a target is the degenerate case the orchestrator treats as linear; the builder should prevent it.)
- Auto mode in the builder should warn that it relies on the reviewer emitting a parseable verdict and will fall back to a gate otherwise.

No builder UI is built in this spec; this section is the seam.

---

## 4. Phased rollout / decomposition

Each plan is independently shippable and leaves linear pipelines (no loop config) behaving exactly as today.

- **Plan L1 — Data model + orchestrator (gated path, no new UI verdict):** the seven columns + migration; `PipelineStageRow`/`RunStageRow`/`StageSpec` + `create_run` copy; `increment_loop_iteration`; the `run_to_pause` loop-decision for **gated** mode and the cap (auto deferred to L3); `CheckpointAction::SendBack` + the `commands.rs` wiring; cost Option A (`retired_cost_usd`). Testable end-to-end with the existing mock `AgentRunner` (state-machine tests: a gated review → SendBack → target+intervening stages reset → re-drive → cap → checkpoint). No frontend yet.
- **Plan L2 — Gated UX:** `ipc.ts` type additions; `CheckpointBar.tsx` "Send back to {target}" + iteration meter + cap-disabled state; `runsStore.resolve` passes `"send_back"`; `RunTrack.tsx`/`StageFocus.tsx` surface the verdict/iteration. Vitest for the store reduction and the bar's action wiring.
- **Plan L3 — Auto-mode verdict:** the `VERDICT:` sentinel in `system_prompt_for` (auto only); the verdict parser + `StageOutcome.verdict`; the auto loop-back branch in `run_to_pause`; the unparseable → gate fallback. Verdict-parser unit tests over recorded fixtures; orchestrator tests for the auto loop and the cap escalation.
- **Plan L4 — Templates + (optional) backfill:** loop defaults in `seed_builtin_pipelines`; the one-shot backfill `UPDATE` if we choose to retrofit existing installs (§3.6, §9).

Builder controls (§3.7) ride along whenever the deferred linear builder is built — out of scope here.

---

## 5. Testing

- **Rust (mock `AgentRunner`, no real API/CLI):** gated loop-back resets the correct contiguous range and re-drives; iteration counter increments and caps; at the cap the run escalates to `awaiting_checkpoint`; `SendBack` vs `Reject` reset different stage sets; auto `Pass` advances, auto `ChangesRequested` loops, auto with no verdict gates; a stage with no loop config behaves identically to the pre-loop engine (regression guard); cost = retired + live and savings stay non-negative.
- **Verdict parser:** pure unit tests over recorded review text (PASS / CHANGES_REQUESTED / missing / malformed / multiple lines → last wins).
- **Frontend (Vitest):** `runsStore` reduces a `send_back` resolve and a verdict-carrying detail; `CheckpointBar` renders "Send back" only when loop config present and disables it at the cap. `npm run typecheck` before claiming done.

---

## 6. Open decisions / tradeoffs

1. **Gated vs auto as the template default.** This spec ships **gated** (conservative, matches the 2026-06-07 "generous checkpoints" philosophy and the project's bias against "magic"). Auto is the flashier differentiator but loops without a human and depends on a parseable verdict. Decision: keep gated default, ship auto as an opt-in mode — confirm.
2. **Loop target scope: any prior stage vs only the immediately-preceding code stage.** The data model (`loop_target_position`) supports **any** earlier position; the orchestrator's contiguous-range reset works for any target `< review.position`. Restricting to the nearest code stage is simpler to reason about (and to revert worktree-wise) but less expressive (couldn't loop `test`-failure back past `code_review` to `implement`). Recommend **any prior stage**, with builder validation; flag the worktree implication (#3).
3. **Re-run vs worktree: revert or stack? (flagged conflict.)** There is intentionally **no per-stage snapshot/commit** in `orchestrator/` — a first cut (PR #15) that committed per stage was reverted because committing empties the index↔workdir diff that `get_diff_text` (focus pane) and the `code_review` worktree handoff depend on. So a loop-back today re-runs `implement` against the *accumulated* worktree (stacking), not a reverted baseline. Options: (a) build a per-stage snapshot that is **compatible with the working-tree diff model** (e.g. a tagged commit per stage *plus* changing `get_diff_text`/the review handoff to diff against the prior stage's snapshot rather than HEAD↔workdir — this is the deferred "per-stage diff snapshots" fast-follow, and it's what makes clean revertable loop-backs possible); (b) accept stacking (the agent edits on top of its prior attempt, guided by the reviewer feedback) — zero new code, but iterations can drift. This must be resolved before auto mode (L3) ships, because uncontrolled stacking + auto looping compounds drift. Recommend building the snapshot (option a) as part of, or just before, L3 — note it is a real feature, not a one-liner, precisely because it must not break the diff viewer.
4. **Cost model: Option A (`retired_cost_usd`) vs Option B (history rows).** Spec recommends A (one column, fixes the existing Reject undercount). B is richer (per-iteration audit/replay) but heavier; defer. Note A is also a latent **bug fix** for today's single-Reject path, independent of the loop.
5. **Backfill existing builtins.** Idempotent seeding won't add loops to already-seeded installs (§3.6). Decide: one-shot `UPDATE` backfill (everyone gets loops) vs. only fresh installs (safer, but most existing users never see the feature on builtins). Recommend a guarded one-shot backfill so the feature is actually visible.
6. **Verdict sentinel vs structured JSON output.** A trailing `VERDICT:` line keeps the human-readable review body intact and is trivially parseable; a JSON-only contract is stricter but fights the focus-pane rendering and the CLI substrate's freeform output. Recommend the sentinel + `payload` mirror; revisit if reviewers prove unreliable at emitting it (the gate-fallback contains the blast radius regardless).
7. **Reopening the "no autonomous retry" non-goal.** The 2026-06-07 spec explicitly listed "No automatic, human-free retry loops" as a non-goal. Auto mode reopens it under a hard cap + escape-hatch + opt-in default. Confirm this is an intended evolution, not a contradiction to honor.

---

## 7. Consistency check (self-review)

- **Backward compatibility:** every new column is `NULL`/`DEFAULT 0`; `loop_mode = NULL` ⇒ linear ⇒ `drive_inner` takes the unchanged path. Existing runs, existing seeded builtins, and the mock-runner tests are unaffected. ✓
- **Termination:** `loop_iterations` strictly increases per loop-back and is capped by `loop_max_iterations`; at the cap the run escalates to a checkpoint. The `drive_inner` `loop {}` cannot spin forever. ✓
- **Single-drive invariant:** loop-backs occur inside one `drive_inner`; the `active` guard in `run_to_pause` is untouched; no re-entrancy. ✓
- **Reuse over reinvention:** the backward edge is implemented entirely by `reset_run_stage` (existing) over a contiguous range + the existing lowest-`pending`-first selection — no new traversal primitive. `feedback` injection reuses the existing `reset_run_stage(feedback)` → `user_input_for` path. ✓
- **Flagged conflicts:** (a) `recompute_run_cost` + `reset_run_stage` zeroing undercounts looped cost — addressed by cost Option A (§3.4), also fixes today's Reject. (b) `PIPELINE_PREAMBLE` promises a per-stage snapshot that does not exist in code — the revert-vs-stack decision (§6 #3) depends on building it; auto mode should not ship before it's resolved. Both are called out, not glossed. ✓
- **Design system / copy:** `CheckpointBar` additions reuse the brass mono meta voice, `⟶` glyph, upright-serif CTA (no italic per user override), and `labelForRole`; all new UI strings are English. ✓
