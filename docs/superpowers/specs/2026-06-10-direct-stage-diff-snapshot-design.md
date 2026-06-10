# Direct mode — per-stage diff snapshots

**Date:** 2026-06-10 · **Scope:** orchestrator + StageFocus. Companion to the iteration-history work (PR #28).

## Problem

The focus pane's diff for a done stage is computed LIVE from the worktree (`getGitDiff`), so it mutates as later stages keep editing files — a done implement stage shows changes it never made, and a loop-back's archived attempts have no diff at all. (Per-stage *commits* were tried and reverted: the worktree-as-blackboard depends on uncommitted changes — spec 2026-06-08 §6.3.)

## Design

**Snapshot the diff text, not the git state.** When a stage finishes (done OR failed), the orchestrator captures the worktree diff once and persists it:

- `run_stages.diff_snapshot TEXT` (new column, `add_column_if_missing`) — captured in `run_stage` right after the outcome persists, only when the stage's artifact `refs_worktree` (or, for failed stages, when the role's artifact kind would ref the worktree). Reuse the same backend diff helper the `get_git_diff` IPC uses. Cap at 512 KB; truncate with a trailing `\n… (diff truncated)` marker. Failure to capture must not fail the stage (`let _ =` + tracing warn).
- `stage_iterations.diff_snapshot TEXT` (new column) — `archive_stage_attempt` copies the stage's snapshot, so every archived attempt keeps the worktree state as IT saw it.
- IPC: `RunStage`/`StageIteration` rows expose `diffSnapshot: string | null` (serde camelCase).

**Frontend (StageFocus):**
- Terminal stage (done/failed) with a snapshot → `DiffViewer` renders the snapshot; the live `getGitDiff` fetch is skipped. Label above the diff (mono 10px eyebrow, mute): `worktree when this stage finished`.
- No snapshot (legacy runs) → current live-fetch behavior unchanged.
- Archived attempts (`‹ attempt N ›` view) render their own snapshot beneath the archived artifact when present.

**Honest semantics:** the snapshot is the cumulative worktree state at stage completion — not the stage's isolated contribution. The label says so. Revert-on-loop-back stays out of scope.

## Tests

Rust: stage completion persists a snapshot when refs_worktree (scripted run in a temp git repo with a dirty file); failed capture doesn't fail the stage; archive copies the snapshot; truncation cap. Vitest: terminal stage with `diffSnapshot` renders it without calling `getGitDiff` + shows the label; null snapshot falls back to live fetch; archived attempt shows its snapshot.
