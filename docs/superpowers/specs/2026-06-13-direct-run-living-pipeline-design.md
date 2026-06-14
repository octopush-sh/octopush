# Direct — "The Living Pipeline" execution view

**Date:** 2026-06-13
**Status:** Approved (author-delegated; same pattern as the builder/launcher passes)
**Mode:** Direct
**Surface:** the run / execution view (and the Direct Companion during a run).

---

## 1. Why

The builder and the launcher now speak one node language. The **execution view**
still doesn't: it's a horizontal-scroll strip of status cards (`RunTrack`), a
journal pane (`StageFocus`), a cost footer (`RunLedger`), and a separate
decision strip (`CheckpointBar`) — functional, but visually a different dialect,
not animated, with **tokens never shown**, controls scattered, and a **Companion
that's just a flat runs list** (far poorer than Talk/Run/Review companions).

This redesign makes the run a **living pipeline**: the same node flow you built
and launched, now animated to show work flowing through it, with premium control,
decisions, AI-transparency (tools + tokens), and loop hand-off made visible.

Backed by the real control surface (no mid-stage prompt injection, no true
mid-flight pause exist today): intervention happens at **stage boundaries and
checkpoints**. We add one safe, requested primitive — **pause at the next
boundary** — by reusing the existing budget-park machinery.

---

## 2. Components

### RunFlow (new) — the centerpiece
Replaces `RunTrack`'s card strip. The pipeline drawn in the builder/launcher node
language (archetype icon, Roman numeral, title, model, substrate), now
execution-aware and **animated**:
- **Status skins:** pending (quiet), **running** (brass pulse halo + a live
  one-line activity from the journal + a soft shimmer), done (verdigris ✓),
  failed (rouge ✕), transient halt (amber ⟳), awaiting decision (brass ◆,
  attention pulse).
- **Flowing connectors:** a completed handoff is solid brass; the connector
  *into the running stage* animates (a traveling dash) so work visibly "flows."
- **Loop arcs:** a review stage with a loop target draws a dashed brass back-arc
  to its target with a live `⟲ n/max`; during an active loop-back the arc
  pulses — the hand-off to an earlier stage made obvious.
- **Per-node meta:** live cost + tokens (in/out), compact.
- Wraps (never hidden), selecting a node focuses its journal, auto-follows the
  active stage (existing D4 logic).

### RunControlBar (new) — one state-adaptive command surface
Subsumes `RunTrack`'s controls **and** `CheckpointBar`. Icons + tooltips, sized
right, minimal. Adapts to run state:
- **Running:** `pause at next stage` · `stop stage` · `abort` (icon buttons).
- **Awaiting checkpoint:** `Approve & continue` · `Send back to <stage>` (when a
  loop target exists) · `Reject` (with feedback editor + optional model
  override) · `Abort`. Loop state `n of max` shown.
- **Failed:** transient → `Resume` (amber); hard → `Accept & continue` ·
  `Re-run` (feedback) · `Abort`.
- **Paused-at-boundary / budget-park:** `Approve & continue` (releases the
  parked stage) · `Abort`.
- **Terminal:** `Run it again` + a one-line outcome.
All existing `resolve`/`abort`/`stopStage` wiring preserved verbatim; this is a
presentation + consolidation change plus the new `pause`.

### StageFocus (enhance) — AI transparency
Keep the journal (text, `§` tool cards, ✓/✕ results, notices, verdict), the
attempt browser (per-attempt journal in a loop), and the diff snapshot. Add a
compact **token meter** (in/out) beside the stage cost. Light polish only.

### RunLedger (enhance)
Add **token totals** (in/out) next to cost/savings/budget. Keep the completion
sweep.

### Companion — CompanionCurrentRun (new) + runs list
Close the gap with other modes: above the runs list, when a run is active/viewed,
show a live **current-run** panel — its stage breadcrumb (compact node dots with
the running one lit), the live activity line, and cost/tokens — so the director
keeps context without switching the canvas. Consistent chrome with
`CompanionHistory`/`CompanionReview`.

### Shared
Extract `labelForRole`/`stageTitle`/`ROMAN` from `RunTrack.tsx` to
`src/lib/stageMeta.ts` (many files import them); update importers; delete
`RunTrack.tsx`. `DirectCanvas` run body becomes `RunFlow` → `StageFocus` →
`RunLedger` → `RunControlBar`.

---

## 3. Backend — pause at the next boundary (small, safe)

Add a per-run pause flag on the orchestrator (in-memory, keyed by run_id, like
`cancels`). `request_run_pause(run_id)` sets it. In `drive_inner`, before
starting the next **pending** stage, if the flag is set, park that stage exactly
as the budget gate does (`pause_for_budget`-style: stage → awaiting_checkpoint,
run → paused, a journal notice, checkpoint event) and clear the flag. The
existing "approve a never-started parked stage" path releases it to pending and
continues — so Resume/Approve already works, no new resolve logic. New: one
command, one ipc wrapper, one store action, one event reuse (`run://checkpoint`).
No DB change. No change to stage execution.

---

## 4. Design rules (unchanged)

Tokens only; **brass surgical** (signatures + the single active/running stage +
the CTA — learned from the launcher: status skins use verdigris/rouge/amber/sage,
not brass everywhere); upright Spectral (no italics); three voices; signature
glyphs (`⟶ ⟜ § & ⟲` + Roman numerals); icons + tooltips for controls; calm
220–320ms motion + the running pulse/shimmer (all `prefers-reduced-motion` safe);
tabular numerals for cost/tokens/time; English copy. No new top-level chrome.

---

## 5. Testing

- `RunFlow.test`: status skins, loop arc + counter, live activity, token/cost,
  select fires.
- `RunControlBar.test`: each state's buttons + actions (approve/reject/send-back/
  resume/abort/pause/stop/run-again), feedback editor, loop state, transient vs
  hard tone — port `CheckpointBar.test`'s coverage.
- `StageFocus`/`RunLedger`: token rendering.
- Backend: a test that a pause request parks the next pending stage and approve
  releases it (reuse the budget-park test pattern).
- `DirectCanvas.test` updated to the new body; `RunTrack.test` → `RunFlow.test`.
- `npm run typecheck`, `npm test`, `cargo test`, `npm run build` green;
  `/code-review` max (correctness + design subagents) → fix → PR → merge →
  release.

---

## 6. Honest scope

No mid-stage prompt injection (the agentic loop can't be interrupted with a new
message today) — "giving the agent orders" = feedback at checkpoints (reject /
send-back) + the new pause-at-boundary + model override on re-run. True
mid-flight steering is noted as future backend work, not faked.
```
