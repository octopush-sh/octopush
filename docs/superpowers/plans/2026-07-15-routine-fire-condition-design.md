# Routines — conditional fire gate (`fire_condition`)

**Date:** 2026-07-15 · **Pillar:** unattended crews / Routines (v0.4.9) · **Feature key:** `routines.scheduled` (Pro; no new gate)

A routine fires unconditionally on its schedule today. This adds an optional **pre-fire condition**: a shell command
evaluated before each fire — the routine fires only when the command signals "there's work," otherwise the window is
skipped with **zero tokens and no run created**. It's fully generic (any command, any model/substrate/skill the routine's
pipeline uses), which is the point: it serves *any* routine, not just the PR-review-watching use case that motivated it
(a routine that addresses new PR review comments hourly should skip the hours with no new comments).

## The condition — a shell command, exit-code gated

- New routine field `fire_condition: Option<String>` (NULL = always fire — existing routines are unchanged).
- **Semantics: exit code 0 ⇒ fire; non-zero ⇒ skip.** The universal Unix convention; the user writes any check that
  exits 0 when there's work (`git diff --quiet || true`, `gh pr view … -q '…' | grep -q .`, a script, etc.). One clear
  rule — NOT "non-empty output" (ambiguous). Documented with examples.
- Run via the same shell the crew uses (`bash -lc <command>`) so the user's PATH, `gh` auth, etc. are present.
- **cwd:** the routine's target directory — for `fixed` mode, the fixed workspace's `worktree_path`; for `fresh` mode, the
  project root (the fresh worktree doesn't exist yet at gate time — see ordering). Both deterministic.
- **Timeout ~30s** (`tokio::time::timeout` around `tokio::process::Command`) so a hung command never stalls the 30s
  scheduler tick. Timeout ⇒ treated as a condition error (skip).

## Fire order (crash-safe, and never create a fresh worktree just to skip)

`fire_routine` becomes, in order:
1. **Advance `next_due` FIRST** (unchanged — a crash/double-tick can't double-fire; a skipped window is still consumed).
2. **Busy check** (unchanged) — a fixed workspace with a live run ⇒ `Skipped{Busy}`.
3. **NEW: evaluate `fire_condition`** (if set), cwd = fixed workspace path / project root, timeout.
   - exit 0 ⇒ continue.
   - non-zero ⇒ `Skipped{ConditionNotMet}` — return before resolving/creating anything (zero tokens, no run, and for
     `fresh` **no worktree created**).
   - spawn error / timeout ⇒ `Skipped{ConditionError(msg)}` (fail-SAFE: don't fire a run when the gate can't be
     evaluated; surfaced via `last_outcome` so it's discoverable, not silent-forever).
4. Resolve workspace (creates the fresh worktree only now) → `create_run` → stamp → launch. (unchanged)

The condition goes AFTER next_due-advance so the "advance first, side-effects after" invariant holds, and BEFORE
`resolve_routine_workspace` so a skip on a `fresh` routine never materialises a throwaway worktree.

## Outcome + legibility (so a skipping routine doesn't look dead)

- `FireOutcome` gains a reason: `Dispatched | Skipped(SkipReason)` where `SkipReason ∈ { Busy, ConditionNotMet,
  ConditionError(String), WorkspaceUnavailable }` (map the existing skip sites onto it). serde-friendly for the ipc.
- Two additive routine columns set on **every** evaluation: `last_checked_at TEXT`, `last_outcome TEXT`
  ("dispatched" / "condition not met" / "condition error: …" / "workspace busy"). A conditional routine that keeps
  skipping is legible in the list ("checked 2m ago · nothing to do") instead of looking broken.
- **`run_routine_now` RESPECTS the condition** and returns the reason — so "Run now" is an honest test of exactly what a
  scheduled fire would do (dispatched, or "skipped · condition not met"). The user tests the whole gated path in one
  click; to force a fire regardless, they clear/edit the condition.

## Data model (additive)

- `routines`: `fire_condition TEXT` (nullable), `last_checked_at TEXT`, `last_outcome TEXT`. CREATE + `add_column_if_missing`.
  Threaded through `RoutineInput` (Deserialize; `fire_condition` optional, empty→NULL like other trimmed fields),
  `RoutineRow` (Serialize camelCase), insert/update, and the row reader. A setter `set_routine_fire_result(id,
  checked_at, outcome)` used by the tick.

## UI (Atelier-compliant)

- Routine editor (`RoutinesPane` `ModalShell`): a new optional **"Fire only if…"** field — a **mono** command input (it's
  a shell command) + a one-line explainer: *"Runs before each fire in the routine's workspace; the routine fires only if
  this command exits 0. Leave empty to always fire."* Placeholder e.g. `gh pr view --json reviewDecision -q '…' | grep -q .`.
  Tokens, motion, English.
- Routine list row: surface `last_outcome` + `last_checked_at` ("checked 2m ago · nothing to do" / "dispatched 5m ago").
- `lib/ipc.ts`: `Routine`/`RoutineInput` gain `fireCondition?`; `runRoutineNow` returns the richer outcome
  (dispatched / a skip reason string) instead of just "dispatched"|"skipped"; the store toast shows the reason honestly.
- `lib/routineForm.ts`: thread `fireCondition` through the draft (trim empty → undefined).

## Entitlement / safety

- No new gate — it's a property of a Pro routine. The command is a user-authored shell command run unattended on the
  user's own machine — the SAME trust model as routine runs / setup scripts / `run_command` (their commands, their
  machine). Timeout bounds it. No new boundary.

## Out of scope

Non-shell conditions (a model-call gate — deliberately avoided; the whole point is a deterministic, zero-token gate);
per-condition cadence; surfacing a skip history beyond `last_outcome`.

## Tests

- Pure/behavioral: condition exit 0 ⇒ Dispatched; non-zero ⇒ Skipped(ConditionNotMet) and NO run created (and for fresh,
  no worktree); a failing-to-spawn / timing-out command ⇒ Skipped(ConditionError); no condition ⇒ always fires (backward
  compat); next_due advanced before the condition runs (crash-safe order); `run_routine_now` returns the skip reason when
  the condition fails; `last_checked_at`/`last_outcome` written on every evaluation.
- Frontend: editor round-trips `fireCondition` (empty → none); the list shows the last outcome; runNow toast reflects a
  skip reason.

## FEATURES.md

Update the Routines entry: an optional pre-fire `fire_condition` (exit-0 gate, runs in the workspace, times out), the
zero-token/no-run skip, `last_outcome` legibility, and that Run-now respects it. Note it's generic (any command).
