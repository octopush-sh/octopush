# DIRECT — multi-provider CLI substrates & parallel DAG scheduling (design note)

**Status:** SHIPPED (2026-08-10, second pass) — B6 shipped as model-derived dialects (claude + codex;
the `cli_dialect` column was simplified away — the model picker is the selector); C10 shipped as
Phase 1 (ready-set scheduling with write-set gating; run-level pauses preserved). Phase 2
(worktree-per-branch with join-merge) and a Gemini dialect remain open follow-ups.
**Context:** the adversarial architecture review of DIRECT mode (2026-08-10) identified and fixed
16 of 18 findings in place (tool parity, loop memory, structured verdicts, conventions injection,
ask_director continuation, intra-stage budgets, context compaction, commit detection, read-only
CLI reviewers, question-as-result blocks, inter-stage consultation, and the robustness fixes).
Two findings were **deferred by design** because both change product-level contracts and carry
real corruption risk if shipped mechanically. This note records the problem, the constraint that
makes each hard, and the recommended design, so the work is scoped and never forgotten.

---

## 1. B6 — Multi-provider CLI substrates

### Problem

The `cli` substrate is hardcoded to Claude Code (`cli_runner.rs` resolves the `claude` binary and
parses its `stream-json` NDJSON contract). The only way for a stage to be a *first-class* agent —
full tool arsenal, sub-agents, repo-native context — is therefore to be Claude. The 2026-08-10
pass narrowed the gap substantially by upgrading the API substrate (grep/glob/edit_file, windowed
reads, conventions injection, context compaction), but a Codex CLI or Gemini CLI stage is still
impossible, which structurally biases the multi-provider vision.

### Constraints discovered in the codebase

- `parse_cli_result` / `entries_from_stream_event` / session resume (`--resume`) / usage
  accounting are all Claude-NDJSON-specific.
- The halt-recovery vocabulary (`error_max_turns`, session ids, `resume_pending`) leaks the
  Claude contract into `db.rs`, `runStatus.ts`, and the DecisionBar copy.
- `build_cli_args`'s `--append-system-prompt` / `--permission-mode` / `--disallowedTools` flags
  have per-CLI equivalents but not identical semantics (permission bypass especially).

### Recommended design

1. Introduce a `CliDialect` trait behind `CliRunner`:
   `fn argv(&self, spec, system, read_only) -> Vec<String>`, `fn resume_argv(...) -> Option<...>`,
   `fn parse_event(&self, line) -> CliEvent` (where `CliEvent` = `Progress(entries) | Usage(u) |
   Result(outcome)`), `fn binary_names(&self) -> &[&str]`.
2. Ship two dialects first: `claude` (extract the current code verbatim) and `codex`
   (`codex exec --json` speaks a close-enough JSONL contract). Gemini CLI next.
3. Persist the dialect on the stage (`substrate` stays `cli`; new nullable `cli_dialect` column,
   default `claude`) so existing rows and pipelines are untouched.
4. Sessions: dialects without resume return `None` from `resume_argv` — the existing
   "fresh re-run, worktree preserved" path already handles that gracefully.
5. Builder: the substrate chip becomes a small picker (`api · claude · codex · …`) with the
   existing validation warning reused ("CLI without a matching model").

**Non-goals:** translating permission models 1:1 (each dialect declares its own read-only
mechanism or `read_only_supported() = false`, in which case the review guardrail falls back to
the prompt + the API-substrate reviewer allowlists).

---

## 2. C10 — Parallel scheduling of authored DAGs

### Problem

The builder authors a genuine DAG (`parents`, acyclicity validation, ancestry-scoped dossiers and
reset ranges) — but `drive_inner` executes strictly serially: *first non-done stage in position
order*. Two independent branches never run concurrently, and a branch parked at a checkpoint
blocks a sibling branch that doesn't depend on it. The UI implies concurrency the engine doesn't
have.

### Why it was NOT shipped mechanically

The worktree is the run's shared blackboard — every stage reads and writes the same checkout.
Two concurrent writer stages on one worktree is silent corruption (interleaved edits, racing
`git add`, baselines capturing each other's work). Fixing that properly is a product decision
about isolation, not a scheduler patch:

- **Option A — worktree-per-branch:** fork a git worktree per parallel branch, merge at the join
  node. Cleanest semantics; needs conflict UX at joins (a human-visible merge gate).
- **Option B — write-set gating:** run branches concurrently only when at most one of them is a
  writer (reviews/probes/plans are read-only by tool grant); serialize writers. No merge UX, much
  smaller win, zero corruption risk. **Recommended first step.**
- **Option C — keep serial, fix the UI:** label parallel-looking branches as "ordered by
  position" in the builder. The honest floor if neither A nor B is scheduled.

### Recommended design (incremental)

1. **Phase 0 (honesty):** builder copy notes that sibling branches execute in position order.
2. **Phase 1 (Option B):** `drive_inner` computes the ready set (all parents done) instead of
   `first non-done`; runs concurrently every ready stage whose tool grant is read-only (no
   `write_file`/`edit_file`/`run_command` for API; `read_only` CLI reviewers), plus at most ONE
   writer. Cancel flags, cost recompute, and `PersistingSink` are already per-stage-id safe; the
   `active`-slot claim stays per-run. Checkpoint parking becomes per-stage (a parked branch no
   longer blocks its siblings — the drive returns Paused only when NO stage is ready).
3. **Phase 2 (Option A):** opt-in per pipeline ("parallel branches: isolated worktrees") once the
   join-merge UX exists (reuse the REVIEW-mode conflict surface).

**Interactions to re-verify at implementation time:** budget gates fire per stage-start (fine);
`loop_back`'s window semantics on a branch (already ancestry-scoped); `has_concurrent_run`
(worktree safety) stays run-level; the detached worker drives one segment — the ready-set loop
must live inside the segment, not spawn worker-per-branch.
