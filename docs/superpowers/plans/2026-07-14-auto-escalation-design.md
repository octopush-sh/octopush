# Automatic model escalation (DIRECT operating-model, slice 3)

**Date:** 2026-07-14 · **Initiative:** DIRECT operating model (spine slice 3 of 4) · **Target release:** v0.4.12

Builds directly on slice 1 (per-stage model + effort). Today when a stage **fails** — the agentic loop
exhausts its tool-turn budget without finishing, or errors after retries — the run **halts and pings the
director** (`drive_inner` `StageStatus::Failed` arm, mod.rs:1071). The director's only recovery is to reject the
parked stage with a manual `model_override`. Automatic escalation removes that babysitting: a stage with an
**escalation policy** retries ONCE at a stronger model (and/or higher effort) before halting — "pay the caro
tier on a *proven* failure, not by default" (Claude's Jira-pipeline design).

## The policy (per-stage, opt-in)

Two new authoring fields on a stage (both optional; a stage has an escalation policy iff either is set):
- `escalate_model: Option<String>` — the stronger model to retry with on failure.
- `escalate_effort: Option<Effort>` — optionally bump effort on the retry (API substrate only, like base effort).

Runtime state (run_stages only): `escalated: bool` — set true the first time the stage escalates; sticky for
the rest of the run.

## Trigger & mechanic (v1 = failure only)

**Trigger: the stage fails** (`StageOutcome.status == Failed`, which includes the loop exhausting
`max_iterations` unfinished). A **blocked** stage (ask_director → `awaiting_checkpoint`) is NOT a failure — it
never escalates. An aborted run never escalates.

**Mechanic — intercept the `StageStatus::Failed` arm in `drive_inner`:**
```
StageStatus::Failed => {
    if self.try_escalate(run_id, &stage)? { self.emit_run_update(run_id); continue; }  // retry at the strong tier
    self.db.lock().set_run_status(run_id, "paused", false)?;   // unchanged halt
    self.emit_checkpoint(run_id, &stage.id, "decision");
    return Ok(RunStatus::Paused);
}
```
`try_escalate(run_id, stage) -> bool`:
- false if `stage.escalated` (already used its one escalation → halt as today).
- false if no policy (`escalate_model` and `escalate_effort` both None → halt as today; ZERO behavior change for
  existing pipelines).
- else: set `escalated = true`, `reset_run_stage(stage_id, None, None)` (→ pending, clears the failure, PRESERVES
  loop/session per its contract), journal-notice `"↑ escalating to {model} after a failed attempt"`, return true.
  The drive loop `continue`s and re-runs the now-pending stage.

**Spec resolution (mod.rs:573–593):** the escalated model/effort is resolved at StageSpec-build time, preserving
the base for history/display:
```
agent_model = if stage.escalated { stage.escalate_model.clone().unwrap_or(stage.agent_model.clone()) } else { stage.agent_model.clone() }
effort      = if stage.escalated { stage.escalate_effort.or(stage.effort) } else { stage.effort }
```
So an escalated stage runs at the strong tier; a second failure hits `try_escalate` → false (already escalated)
→ halts. **Bounded to exactly one escalation.** Because the flag is sticky, any LATER re-run of the stage (a
review loop-back, a manual reject) also uses the strong tier — falls out for free, no extra code.

**Budget interaction (free):** the per-run `budget_usd` gate already runs before a stage starts, so an escalated
retry that would exceed budget pauses for budget instead of running. No special handling.

**Detached/worker (free):** escalation converts a would-be-halt into a `continue` within the same drive segment;
`drive_inner` re-derives from the DB each iteration, so the worker re-runs the escalated stage in the same
segment exactly as the in-process app does. No new pause boundary.

## Substrate

`escalate_model` applies to **both** API and CLI stages (it's just a model swap on the spec; the CLI runner reads
`agent_model` too). `escalate_effort` is **API-only** (effort is API-only, per slice 1) — the inspector disables
the escalate-effort control for CLI stages like it does the base effort control.

## Data model (additive — mirrors the slice-1 effort threading)

- `pipeline_stages`: `escalate_model TEXT`, `escalate_effort TEXT` (the policy).
- `run_stages`: `escalate_model TEXT`, `escalate_effort TEXT` (copied at `create_run`), `escalated INTEGER DEFAULT 0`.
- CREATE + `add_column_if_missing`; threaded through the run-stage readers, the pipeline→run copy, and `StageDraft`
  / `PipelineStageRow` / `RunStageRow`. `set_run_stage_escalated(stage_id, true)` setter.

## Entitlement

**Ungated** — consistent with per-stage effort (slice 1) and the escape valve (slice 2). It's a stage property
that improves reliability; it gates nothing.

## UI (Atelier-compliant)

Stage inspector gains an **"Escalate on failure"** section under the model/effort controls: an escalate-model
picker (optional, "— none —" = no escalation; all substrates) + an escalate-effort control (optional; API-only,
disabled for CLI with the same note). Tooltip: "If this stage fails, retry once with this model/effort before
halting." A run-stage that has escalated shows a brass **"escalated → {model}"** badge on its card / meta line
(StageFlow / RunFlow / StageNode), and the journal already narrates the escalation notice. `lib/ipc.ts` types
gain `escalateModel?`/`escalateEffort?` (authoring) and `escalated` (run state). English copy, tokens, motion.

## Out of scope (later)

- **Trigger B — escalate on review-loop exhaustion** (a stage a reviewer keeps bouncing should escalate on its
  final auto-loop-back). Deferred: it couples to the loop-count semantics (gated vs auto, target-vs-reviewer)
  and carries surprise risk; the sticky `escalated` flag already makes a post-escalation loop-back use the strong
  tier — this only adds the "escalate BECAUSE of repeated rejection (no hard failure)" case. Fast-follow.
- **route=DEEP escalation** — needs dynamic routing (slice 4).
- De-escalation (drop back to the cheap model when the strong one is overkill) — no clear trigger; not pursued.

## Tests

- `try_escalate`: fail + policy + not-escalated → escalates (flag set, stage reset to pending); fail + already-
  escalated → false (halt); fail + no policy → false (halt, no behavior change); effort-only policy escalates
  effort with the same model; model-only policy.
- StageSpec resolution uses the escalated model/effort when `escalated`, base otherwise.
- pipeline→run copy carries `escalate_model`/`escalate_effort`; `escalated` defaults 0/false.
- A blocked stage and an aborted run never escalate.
- Frontend: inspector round-trips the escalate policy (incl. CLI disables escalate-effort); a run-stage with
  `escalated` shows the badge.

## FEATURES.md

Add "automatic model escalation (per stage)" under DIRECT run behavior: the policy fields, the failure trigger,
one retry at the strong tier before halting, sticky flag, budget/detached compatibility, ungated.
