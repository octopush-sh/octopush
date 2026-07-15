# Escape valve — `ask_director` (DIRECT operating-model, slice 2)

**Date:** 2026-07-14 · **Initiative:** DIRECT operating model (spine slice 2 of 4) · **Target release:** v0.4.11

Today a DIRECT stage runs under a preamble that says *"there is NO human watching — never ask questions, work
autonomously to completion."* So when a stage hits a decision only the director can make (a genuine ambiguity,
a missing spec/credential, contradictory requirements), it **guesses** — and a wrong guess is the #1 reason a
senior stops trusting an autonomous agent. The escape valve lets a stage **stop and ask the one thing it needs**,
surfacing structured questions with a recommended default for each, and resume with the director's answer. This
is Claude's `STATUS: BLOCKED` / `ESCALATE` made real; it's the pillar's trust primitive.

## Mechanism: a tool, not a sentinel

Question-asking is promoted to a **tool** (`ask_director`), per Anthropic's own agent-design guidance ("promote
question-asking to a tool so it can render as a modal and block the loop until answered"). A tool gives us
structured data (no fragile prose parsing like the `VERDICT:` sentinel), a schema-enforced shape, and a clean
"terminal action" signal.

```
ask_director(input):
  summary: string            # one sentence: what you're blocked on
  questions: [{
    question: string,
    why_blocked: string,     # why you can't proceed without this
    recommended_default: string   # your best answer if the director doesn't specify
  }]
```

- Added to the DIRECT agentic loop's toolset **only** — appended in `agentic.rs` AFTER `build_llm_tools()` and
  AFTER the per-stage allowlist filter, so it's always available regardless of a review stage's read-only
  allowlist, and it is NOT added to TALK (which shares `build_llm_tools()` in `chat_engine.rs` — TALK has a
  human present, so the tool is meaningless there).
- **Terminal:** when a response contains an `ask_director` tool_use, the loop STOPS — it does not execute the
  tool or continue. Any other tool_use in the same turn is discarded (asking supersedes acting). `AgenticResult`
  gains `blocked: Option<BlockedAsk>` (the tool's parsed input); default `None`.

## Resolution: park → answer → re-run with the answer as feedback

**Decision (architectural): a blocked stage is a PAUSE, resolved by re-running the stage with the answer injected
as feedback — NOT a mid-loop suspend/resume.** Rationale:
- It fits the detached/segment-worker architecture, which deliberately holds NO cross-pause in-memory state and
  re-derives everything from the DB at each pause. A worker that hits `ask_director` persists the questions,
  parks, and exits exactly like it does for a checkpoint; the app-side bridge re-emits the event; a later
  drive (app or worker) re-runs the stage. True mid-loop resume would require persisting/restoring the full
  `LlmMessage` history across processes — fighting that grain.
- It reuses the existing reject→feedback→re-run substrate wholesale (`runner.rs:150` already injects human
  feedback into a stage's user input on re-run).
- The trust value lands where blocking matters most — `plan`/`architect` deciding an approach BEFORE any code
  is written (read-only, so re-run is free). The prompt steers agents to **ask before expensive/irreversible
  work**, and worktree changes persist across a re-run anyway (the agent re-reads them), so even `implement`
  doesn't truly lose work.
- True mid-loop resume (persist history blob, feed the answer as the `ask_director` tool_result, continue) is
  the phase-2 optimization; noted, not built.

**Flow:**
1. Loop returns `AgenticResult.blocked = Some(ask)`. The runner maps it to a blocked `StageOutcome` (new
   `blocked: Option<BlockedAsk>` field on `StageOutcome`, alongside its Done/Failed status).
2. The drive loop, seeing a blocked outcome, persists the questions to `run_stages.blocked_questions` (new TEXT
   column, JSON), sets the stage to `awaiting_checkpoint`, and calls the SAME `emit_checkpoint(run_id, stage_id,
   "decision")` a director-pause uses → the crew "needs you" notification and the attention beacon fire for free
   (`crewNotifications.ts` keys off `run://checkpoint`; `beacon.ts` already treats a pending decision as the
   pulse). Run → paused.
3. The director answers via a new command `answer_blocker(run_id, stage_id, answers: string[])`. It formats a
   feedback block (each question + its recommended default + the director's answer), writes it to the stage's
   existing feedback field, CLEARS `blocked_questions`, resets the stage to `pending`, and resumes the drive —
   reusing the reject-resume path (`resolve_checkpoint_apply_only`-style). The stage re-runs; `runner.rs`
   injects the Q&A as "Decisions the director made — proceed with these" into its input.

**Distinguishing a block from a gate:** both are `awaiting_checkpoint`. `blocked_questions IS NOT NULL` marks a
question-block; the UI and the resolve paths branch on it. A normal gate keeps Approve/Reject/Loop; a block gets
the answer form. (No new StageStatus needed — reusing `awaiting_checkpoint` keeps the drive/park/detached logic
untouched. `StageStatus::Blocked` was considered and rejected: it would fork every status check.)

## Preamble amendment (the one behavioral change)

`PREAMBLE_WORKTREE` / `PREAMBLE_ACTION` in `roles.rs` currently forbid all asking. Amend to carve out the
sanctioned exception, preserving the autonomy default:

> "Work autonomously. Do NOT ask questions in prose or wait for input. The one exception: if you hit a decision
> only the director can make — a genuine ambiguity, a missing spec or credential, or contradictory requirements
> — and guessing wrong would waste real work, call the `ask_director` tool ONCE with specific questions and your
> recommended default for each, then stop. Prefer to ask BEFORE making expensive or irreversible changes. For
> anything you can reasonably decide yourself, choose a sensible default and note it — do not ask."

## UI (Atelier-compliant)

The checkpoint decision surface (Companion / DirectCanvas / the parked-stage card) branches on
`blockedQuestions`: instead of Approve/Reject, it renders **"The crew asked you"** with each question, its
`why_blocked` as sub-text, and an answer field **pre-filled with the `recommended_default`**. Two actions:
**"Send answers"** (upright-serif CTA) and **"Accept all defaults"** (one-click — fills every answer with its
recommended default and sends; this is the fast path / the seed of an eventual autonomous "auto-accept defaults"
mode). Tokens, motion primitives, `ModalShell` if modal. English copy. `lib/ipc.ts` gains `answerBlocker` and a
`BlockedAsk`/`RunStage.blockedQuestions` type; the run/stage payloads surface it.

## Data model (additive)

- `run_stages.blocked_questions TEXT` (JSON `BlockedAsk`, NULL when not blocked) — CREATE + `add_column_if_missing`.
- `AgenticResult.blocked: Option<BlockedAsk>`; `StageOutcome.blocked: Option<BlockedAsk>`.
- Serde structs `BlockedAsk { summary, questions: [BlockedQuestion{question, why_blocked, recommended_default}] }`.

## Entitlement

**Ungated.** Like crew notifications, this improves any run (free or Pro) and is core trust, not orchestration
scale. It gates nothing.

## Scope / out of scope

- **API substrate only** (the tool lives in the agentic loop). CLI-substrate stages have their own interaction
  model — out of scope, like effort. `ask_director` is not offered to CLI stages.
- A **re-block guard is human-in-the-loop by nature** (the director answers each block), so no runaway; a stage
  that blocks repeatedly is the director's signal, not a loop to auto-break. No per-stage block cap in v1.
- Deferred: true mid-loop resume (preserve partial work); an "auto-accept defaults" autonomous mode (the
  "Accept all defaults" button is its manual seed); a per-routine/per-run "never block, always default" policy.

## Tests

- Pure: `ask_director` tool_use in a response → `AgenticResult.blocked = Some(...)`, loop stops, other tool_uses
  ignored; a normal tool_use still executes+continues. Feedback-formatting of answers. `BlockedAsk` serde
  round-trip.
- DB: `blocked_questions` write/read/clear; a blocked stage parks as `awaiting_checkpoint`; `answer_blocker`
  resets to pending with feedback and clears the questions.
- Notification: a blocked-stage checkpoint event produces a needs-you notification (existing crewNotifications
  test shape).
- Frontend: the answer form renders questions, pre-fills defaults, `answerBlocker` sends the answers; "Accept
  all defaults" sends the defaults.

## FEATURES.md

Add "escape valve / ask the director (`ask_director`)" under DIRECT run behavior: when/why a stage pauses to ask,
the recommended-default fast path, that it reuses the checkpoint/notification surface, API-substrate only, and
that answering re-runs the stage with the decision injected.
