# DIRECT mode — halt diagnostics & recovery

**Date:** 2026-06-14
**Status:** Approved design, ready for implementation plan
**Area:** `src-tauri/src/orchestrator/` (backend), `src/components/RunControlBar.tsx` (frontend)

## Problem

A DIRECT-mode pipeline run (`Bugfix relay`) halted at its `verify` stage and the user
could not tell why or recover the partial work. Postmortem of run `8895befb` found:

1. The `verify` stage failed with the generic banner message **"claude exited with an
   error"**. The real cause was almost certainly `error_max_turns` (the CLI hit its
   `--max-turns 25` budget mid-edit while following custom instructions to review + fix +
   PR + merge + release). The CLI also produced a separate **15-minute wall-clock timeout**
   on another attempt.
2. **Octopush had the real cause and discarded it.** `parse_cli_result`
   (`cli_runner.rs:165-189`) only surfaces the result `subtype` when
   `subtype_only = !is_error && exit_success`; when `is_error` is true (the common case
   for `error_max_turns`/`error_during_execution`) the subtype is dropped and the generic
   message wins. Separately, captured `stderr` is only used on the unparseable/no-result
   paths and is thrown away when a parseable error result arrives.
3. The terminal failure reason is written to `run_stages.error` only — **never appended to
   the work journal** (`stage_log`), so the journal just stops mid-action.
4. The timeout is a **fixed 15-minute wall-clock backstop** (`CLI_TIMEOUT_SECS = 900`,
   `cli_runner.rs:360`) with **no idle detection** — legitimately long work (a release
   build that streams output) is killed at 15 minutes even while actively producing output.
5. The checkpoint banner offered only **Accept & continue / Re-run / Abort**. None lets the
   user understand the error, recover the in-progress agent, or cleanly discard the
   half-applied edits. "Accept & continue" would advance the pipeline over a half-baked,
   possibly non-compiling worktree.

Industry context (Cursor's 25-tool-call "resume the conversation", Windsurf Cascade's
continue + per-step revert, Google Antigravity's checkpointing + "Resume run" +
transactional file edits) confirms the direction: treat a budget stop as a **resumable
checkpoint that continues the same session**, surface a **structured cause** instead of a
log dump, and make **per-step revert** possible.

## Goals

- Make the **real failure cause** visible (named subtype + stderr tail) in both the banner
  and the work journal.
- Let the user **resume the same Claude session** for a halted CLI stage, with an
  adjustable **turn budget**, instead of only re-running from scratch.
- Replace the fixed wall-clock timeout with **idle-based detection** plus a generous
  absolute backstop, so long-but-active stages survive.
- Let the user **discard only the failed stage's changes** safely, preserving prior stages'
  work, via per-stage baseline snapshots.
- Deliver all of this in the approved **Option A** banner (expandable detail), English copy,
  honoring the minimalism doctrine (primary row ≤ 3 controls).

## Non-goals (explicit follow-ups)

- **True session resume for the API substrate** (persisting the `Vec<LlmMessage>`
  transcript). API and CLI-without-session stages fall back to **Re-run** (worktree
  preserved). The agentic API loop discards its message history today (`agentic.rs:108`);
  adding durable transcripts is a separate effort.
- Splitting fix-findings / PR / merge / release into **dedicated stage roles**. Tracked
  separately; this spec does not add roles.
- Per-stage configurable timeouts (constants now; per-stage config later).

---

## Design

### A. Failure diagnostics (backend)

**A1 — Name the subtype even when `is_error` is true.** In `parse_cli_result`
(`cli_runner.rs`), replace the `subtype_only` gate with logic that prefers a known
`subtype` whenever present, regardless of `is_error`/exit code:

```
match (bad_subtype, result.is_empty()) {
  (Some(st), true)  => format!("claude stopped early ({st}) — see the journal, then resume or re-run"),
  (Some(st), false) => format!("claude stopped early ({st}): {result}"),
  (None, true)      => "claude exited with an error".to_string(),
  (None, false)     => result.clone(),
}
```

This makes `error_max_turns` / `error_during_execution` always visible. `CliResult` already
parses `subtype`.

**A2 — Fold a stderr tail into the error.** `parse_cli_result` stays pure but gains a
`stderr_tail: &str` parameter; when it produces a `Failed` outcome with otherwise-empty
detail, it appends the last ~10 non-empty stderr lines. `CliRunner::run` already captures
`stderr_out` (`cli_runner.rs:384`) — pass it in on the parseable-result path too.

**A3 — Terminal journal entry on halt.** When a stage lands `Failed`, append one terminal
`text` entry to `stage_log` so the journal explains itself (e.g.
`"⏹ Stage halted — claude stopped early (error_max_turns)"`). Implemented in
`run_stage_once`'s failure paths (`mod.rs:281-394`) via `db.append_stage_log` + a
`run://log` emit through the existing `LiveEmitter`, so the live view and the persisted
journal both get it.

### B. Session capture & CLI Resume (backend)

**B1 — Capture `session_id`.** Add `session_id: Option<String>` to `CliResult` (the headless
`claude` result event carries `session_id`) and to `StageOutcome`. Persist it on every
stage finish (done *and* failed).

**B2 — Schema.** Add two nullable columns to `run_stages` (via `add_column_if_missing`,
matching the existing migration style at `db.rs:402`):
- `session_id TEXT` — the Claude Code session id from the stage's last CLI attempt; shown in
  diagnostics; gates the Resume affordance.
- `resume_pending INTEGER` — set to 1 by a Resume action to signal "the next run of this
  stage should `--resume session_id`"; cleared by `CliRunner` when it starts.

`session_id` survives `reset_run_stage` (it is not cleared); `resume_pending` is set only by
the Resume path.

**B3 — `--resume` in the CLI runner.** In `CliRunner::run`, if `stage.resume_pending` and
`stage.session_id` is present, build args with `--resume <session_id>` (continue the same
session) instead of a fresh `-p` run, then clear `resume_pending`. `build_cli_args` gains a
variant/param for the resume session. The user prompt on a resume is a short continuation
nudge (e.g. "Continue the task. You have a fresh turn budget."), not the full
`user_input_for` dossier.

**B4 — Turn-budget override.** Extend `CheckpointAction::Resume` and
`CheckpointAction::Reject` to carry `max_turns_override: Option<i64>`. When present, the
handler updates `run_stages.max_iterations` before re-running, so the next run honors the new
budget (`CliRunner` reads `stage.max_iterations` into `build_cli_args`). Default offered by
the UI: for an `error_max_turns` halt, the current limit ×2 (e.g. 25 → 50); otherwise the
current limit.

**B5 — Resume handler.** Extend `CheckpointAction::Resume` (`mod.rs:830`): for a `failed`
stage, archive the attempt, retire its cost (as today), apply `max_turns_override`, set
`resume_pending = 1` **iff** the stage is CLI substrate with a `session_id`, then reset to
pending and re-drive. For API / no-session stages, `resume_pending` stays unset → the
re-drive is a normal fresh re-run (worktree preserved). This keeps one action that "does the
right thing per substrate"; the frontend just labels the button Resume vs Re-run.

### C. Idle timeout (backend)

Replace the single `timeout(CLI_TIMEOUT_SECS, read_loop)` (`cli_runner.rs:359-371`) with:
- **Idle timeout** `IDLE_TIMEOUT_SECS` (default 300): fail if no stdout line arrives for that
  long. Implemented by wrapping each `read_until` in `tokio::time::timeout(IDLE, …)` and
  treating `Elapsed` as an idle halt.
- **Absolute backstop** `ABS_CAP_SECS` (default 3600): a total-elapsed ceiling, tracked from
  a start `Instant`, so a stage that streams a trickle forever still terminates.
- Distinct, honest messages: `"claude timed out — no output for 5m"` (idle) vs
  `"claude exceeded the 60m cap"` (absolute). Both go through `failed_stage` and A3's
  terminal journal entry. The director-cancel race is preserved.

### D. Per-stage baseline snapshots & Discard (backend)

**D1 — Baseline at stage start.** Because stages never commit (`runner.rs:78`), capture a
**restorable** baseline of the worktree at the start of each stage, without touching the
user's index or working tree, using a temporary index:

```
GIT_INDEX_FILE=$tmp git read-tree HEAD
GIT_INDEX_FILE=$tmp git add -A            # stages current worktree into the temp index
tree=$(GIT_INDEX_FILE=$tmp git write-tree)
baseline=$(git commit-tree $tree -p HEAD -m "octopush stage baseline")
```

Store `baseline` (a dangling commit SHA) in a new nullable column
`run_stages.baseline_commit TEXT`. This captures tracked **and** newly-added files as of
stage start. The real index/worktree are untouched (operations use `GIT_INDEX_FILE`).

**D2 — Discard restores to the baseline.** New `CheckpointAction::Discard`. Its handler, for
a failed stage with a `baseline_commit`, makes the worktree **byte-identical to the baseline
tree**. The invariant, not a specific command line:

> Every path present in the baseline tree is restored to its baseline content; every path
> absent from the baseline tree is removed. Nothing else on disk changes, and the user's
> real git index is never touched.

Because the baseline (D1) was captured with `git add -A` at stage start, it already contains
everything that existed then (tracked + untracked-at-the-time), so "absent from baseline" is
exactly "created during this stage" — safe to remove. The implementation operates through a
temporary `GIT_INDEX_FILE` (e.g. `read-tree $baseline` → `checkout-index -a -f` to overwrite
baseline files, then remove the set `worktree_files − baseline_files` computed from
`git ls-tree -r --name-only $baseline`). This is the single most safety-critical sequence;
the exact plumbing is finalized in the implementation plan and pinned by the round-trip tests
in Testing (it must never fall back to a blanket `git clean`). After discard, the stage stays
`failed` and the checkpoint stays open (the user then chooses Resume/Re-run/Abort); the run is
refreshed.

**D3 — Confirmation.** Discard is destructive → it is confirmed via a `<ModalShell>` dialog
(`closeOnBackdrop={false}`) before firing, per the design system.

### E. Banner — Option A (frontend)

In `RunControlBar.tsx` `DecisionBar`, the **failed** branch becomes (English copy):

**Primary row (≤ 3 controls):**
- Recoverable (CLI + `sessionId`): `Resume` (brass outline) · `Re-run` (ghost) · `Abort`
  (ghost, rouge hover).
- Not recoverable (API / no session): `Re-run` (brass outline) · `Abort`.

**Disclosure** `▸ why this halted` → `<Reveal>` panel containing:
- **Cause line** in plain English, derived from `blockedStage.error` (a small mapper:
  `error_max_turns` → "Claude stopped early — it reached the {maxIterations}-turn limit",
  `error_during_execution` → "Claude hit an execution error", `no output for` → "Claude
  produced no output for {n}", else the raw first line).
- **Raw diagnostic** (full `error`, mono, scrollable, with session id / tokens / cost when
  available).
- **Turn-budget `Stepper`** (`src/components/controls/Stepper`), defaulting per B4.
- **Actions:** `Resume with N turns` / `Re-run with N turns` (brass) · `Accept partial work`
  (ghost, = existing `approve`) · `Discard changes` (rouge ghost, opens confirm).

The same disclosure renders for any failure cause; only the cause line wording adapts. Motion
uses the existing `<Reveal>` (grid-rows) and respects `prefers-reduced-motion`. No new tokens,
no italics, primary row never exceeds three controls.

---

## Data model changes

`run_stages` (all via `add_column_if_missing`, nullable, back-compatible):
- `session_id TEXT`
- `resume_pending INTEGER`
- `baseline_commit TEXT`

Mirror `session_id` into `RunStageRow` (`db.rs`) and the frontend `RunStage`
(`src/lib/ipc.ts`) as `sessionId: string | null`. `resume_pending` and `baseline_commit`
are backend-internal (not surfaced to the frontend).

## IPC changes

- `resolveCheckpoint(runId, action, feedback?, modelOverride?, maxTurnsOverride?)` —
  `resolve_checkpoint` command (`commands.rs:1112`) gains `max_turns_override` and a new
  `"discard"` action mapping to `CheckpointAction::Discard`; `"resume"` and `"reject"` carry
  `max_turns_override`.
- `CheckpointActionName` (`ipc.ts`) gains `"discard"`.

## Error handling / edge cases

- **No session id** (legacy runs, API substrate): Resume degrades to Re-run; the button label
  reflects it. Never present a dead "Resume".
- **`--resume` fails** (session pruned from `~/.claude`, worktree moved): the CLI exits with
  an error; this lands as a normal halt with a clear message → the user can Re-run. Detect a
  resume-specific failure and annotate the journal entry ("session could not be resumed —
  re-running starts fresh").
- **Baseline capture fails** (not a git repo, detached state): skip silently (forensic, like
  the existing diff snapshot) and disable Discard for that stage (the menu action is omitted
  when `baseline_commit` is null).
- **Discard plumbing** must never touch the user's real index; all snapshot/restore git calls
  use a temporary `GIT_INDEX_FILE`. Untracked-file removal is scoped to files absent from the
  baseline tree — never a blanket `git clean`.
- **Idle vs cancel race:** the director-stop cancel watch is preserved alongside both timeouts.

## Testing

- **Rust units** (`tests.rs`):
  - `parse_cli_result`: `error_max_turns` with `is_error:true` → message names the subtype;
    stderr tail folded in; success path unchanged; empty vs non-empty result arms.
  - `session_id` parsed from a sample result event and threaded into `StageOutcome`.
  - Idle-timeout helper: a stream that goes silent past `IDLE_TIMEOUT` fails with the idle
    message; a steadily-emitting stream past the old 900s does **not** fail before
    `ABS_CAP_SECS`.
  - Baseline snapshot + discard round-trip on a temp git repo: create file in "fix",
    create/modify in "verify", discard → verify's changes gone, fix's changes intact,
    user index untouched. **This is the highest-risk test; cover tracked-modify,
    tracked-add, untracked-add, and nested dirs.**
- **Frontend** (`*.test.ts`): banner shows Resume vs Re-run by `sessionId`; cause mapper
  output for each known subtype; turn-budget default; Discard opens a confirm.
- `npm run typecheck` + `cargo test` green before completion.
- **Cross-cutting sub-agents** (per the user's request): an adversarial bug-hunt agent
  focused on the Discard git plumbing (data-loss paths) and the idle-timeout race, plus a
  design/look-and-feel review of the banner against the minimalism doctrine.

## Rollout

Single PR off `model-picker-relay` (or a fresh branch). Migrations are additive and
back-compatible; old runs simply have null `session_id`/`baseline_commit` and degrade to
Re-run with Discard hidden.
