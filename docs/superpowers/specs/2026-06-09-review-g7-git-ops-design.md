# G7 · Git Operations Depth — Slice I design

> Part of the REVIEW-mode overhaul (master tracker:
> `docs/superpowers/plans/2026-06-07-review-mode-master-grouping.md`, stream **G7**,
> priority rank 6 — after G3/G5/G1/G2/G4, all merged). Branch `feat/review-g7-git`
> off `main`, worktree `octopus-sh-review`. Status: **spec'd** (slice 1 of 5).

## Goal

Terminal-free sync. Slice I lets a user **fetch** and **pull** from Review, **see when
they're behind**, **detect conflicts** after a pull, and hardens the git layer against
the two reliability gaps the audit found: the ahead/behind **hang** on huge graphs and
the lack of a **concurrency lock** around git mutations.

## Why slice (the 5-slice plan)

- **Slice I — Sync & safety (this spec).** fetch/pull (ff-only + reconcile), conflict
  *detection*, ahead/behind timeout, per-workspace concurrency lock.
- **Slice II — Conflict resolution.** ours/theirs/edit, mark-resolved, continue/abort,
  AI resolution (reuses `ipc.aiComplete`). Builds on Slice I's detection.
- **Slice III — Inspect.** log/history browser; per-line blame gutter.
- **Slice IV — Branch & stash.** branch list/switch/create; stash push/pop/list.
- **Slice V — Advanced.** reset (soft/mixed/hard, guarded); clean untracked;
  cherry-pick; tags.

## Current state (verified, for a fresh implementer)

- **`src-tauri/src/git_ops.rs`**: `get_status(path) -> AppResult<GitStatus>` (git2) builds
  `GitStatus { branch: Option<String>, changed_files: Vec<FileChange>, ahead: usize,
  behind: usize, has_upstream: bool }` and `FileChange { path, status, staged, unstaged }`
  (both `#[serde(rename_all="camelCase")]`). Ahead/behind comes from a private
  `upstream_ahead_behind(&repo) -> Option<(usize,usize)>` that does
  `repo.graph_ahead_behind(local, upstream)` — **the slow graph walk that can hang**.
  `dirty_ahead_behind(path)` and `is_dirty(path)` are the fast rail signals.
- **`src-tauri/src/commands.rs`**: `get_git_status(path)` (577) wraps `get_status`;
  `workspaces_git_summary(project_id)` (595) batches `dirty_ahead_behind` per workspace —
  **no timeout, hangs on huge graphs**. `push_branch(path)` (2526) runs
  `git push --set-upstream origin <branch>` via the **login shell**
  (`$SHELL -l -c <cmd>`, `.current_dir(path)`) so SSH-agent / credential-helpers / gitconfig
  apply — the pattern all network ops must use. `commit_changes`/`amend_commit` also use
  the login shell. Errors are `AppError::Other(String)`.
- **No git mutation is serialized** — every `#[tauri::command]` runs in its own tokio
  task; concurrent ops on one worktree can race. No conflict detection anywhere
  (`is_conflicted` is unused; `get_status` doesn't report conflicts).
- **`src/components/ChangesPanel.tsx`**: header eyebrow row ("Changes" + `+N/−M`), then
  Staged/Unstaged file sections, the commit area, and a **Push** button (shown with the
  `ahead` count, enabled when `ahead > 0 || !hasUpstream`). Polls `ipc.getGitStatus(projectPath)`
  every 5 s. Receives `projectPath` (the workspace worktree path).
- **`src/lib/types.ts`**: TS `GitStatus { branch, changedFiles: FileChange[], ahead,
  behind, hasUpstream }`; `FileChange { path, status, staged, unstaged }`.
- **Reusable**: `pushToast`, `<ConfirmDialog>`, `<ModalShell>`, `ipc.aiComplete` (G5),
  `ipc.pushBranch` (the login-shell network-op precedent).

## Architecture

### A. Backend — fetch / pull (login shell)

```rust
// git_ops.rs — pull strategy + outcome classification (the classifier is pure/testable).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullOutcome { pub kind: PullKind, pub output: String }

#[derive(serde::Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum PullKind { Ok, Diverged, Conflict, Error }

/// Classify a `git pull` result from its exit success + combined stdout/stderr.
/// Pure — unit-tested without git.
pub fn classify_pull(success: bool, combined: &str) -> PullKind {
    let s = combined.to_lowercase();
    if success { PullKind::Ok }
    else if s.contains("not possible to fast-forward") || s.contains("have diverged") { PullKind::Diverged }
    else if s.contains("conflict") || s.contains("automatic merge failed") || s.contains("could not apply") { PullKind::Conflict }
    else { PullKind::Error }
}
```

`commands.rs`:
- **`fetch_changes(workspace_path) -> AppResult<String>`** — `git fetch` via the login
  shell; returns combined output (toast detail). Errors → `Err`.
- **`pull(workspace_path, strategy: String) -> AppResult<PullOutcome>`** — `strategy ∈
  "ffOnly" | "rebase" | "merge"` → `git pull --ff-only` / `git pull --rebase` /
  `git pull --no-rebase`, login shell. Build `PullOutcome { kind: classify_pull(status,
  combined), output: combined }`. `ffOnly` yields `Ok`/`Diverged`/`Error`; `rebase`/`merge`
  yield `Ok`/`Conflict`/`Error`. Never returns `Err` for a diverged/conflict result — those
  are tagged outcomes the UI handles.
- Register both in `lib.rs`.

### B. Backend — conflict detection

Extend `FileChange` with `conflicted: bool` and `GitStatus` with `conflicted: usize` (a
count). In `get_status`, set `conflicted: st.is_conflicted()` per entry and
`conflicted = changed_files.iter().filter(|f| f.conflicted).count()`. git2's index conflict
state is authoritative — no `<<<<<<<` marker scanning in Slice I.

### C. Backend — ahead/behind timeout (reliability)

The graph walk is moved behind a timeout so it can never hang the UI:
- `git_ops::status_files(path)` — branch + `Vec<FileChange>` (incl. `conflicted`) + a
  **cheap** `has_upstream` (`branch.upstream().is_some()`, no graph walk).
- `git_ops::ahead_behind(path) -> Option<(usize,usize)>` — opens the repo and does the
  graph walk (the slow part), as a standalone fn.
- `get_git_status` command: get `status_files` (fast), then compute ahead/behind via
  `tokio::time::timeout(Duration::from_secs(3), tokio::task::spawn_blocking(move || git_ops::ahead_behind(path)))`.
  On timeout/err → ahead/behind unknown. Add `aheadBehindKnown: bool` to `GitStatus`
  (true normally, false on timeout) so the UI hides the ↑/↓ badge instead of showing a
  misleading `0`. The file list is **always** returned. Apply the same timeout in
  `workspaces_git_summary`'s per-workspace ahead/behind (degrade to `0,0` there; the rail
  just shows no badge).

### D. Backend — per-workspace concurrency lock (reliability)

A module (`src-tauri/src/git_lock.rs`): `static LOCKS: Lazy<Mutex<HashMap<String,
Arc<tokio::sync::Mutex<()>>>>>` + `async fn git_lock(path: &str) ->
tokio::sync::OwnedMutexGuard<()>` (get-or-insert the per-path mutex, lock it). Mutating
commands acquire the guard for the duration so two ops on the same worktree serialize.
**Slice I scope:** wrap `pull`, `fetch_changes`, `commit_changes`, `amend_commit`.
(Expanding to stage/unstage/discard is noted for a follow-up.)

### E. Frontend

- **IPC** (`ipc.ts`): `fetchChanges(path)`, `pull(path, strategy)` returning
  `{ kind: "ok"|"diverged"|"conflict"|"error"; output: string }`. `GitStatus`/`FileChange`
  gain `conflicted` (+ `aheadBehindKnown` on GitStatus).
- **Sync control** — a compact row added to the **ChangesPanel header** (recommended
  placement; it already owns branch/ahead/Push): branch name · **↑ahead ↓behind** badges
  (hidden when `!aheadBehindKnown`) · **Fetch** button · **Pull** button (enabled when
  `behind > 0`). Pull flow:
  1. `const r = await ipc.pull(projectPath, "ffOnly")`.
  2. `r.kind === "ok"` → success toast + refresh.
  3. `r.kind === "diverged"` → open a reconcile dialog (`ModalShell`): **"Your branch and
     upstream have diverged — reconcile by:"** `[Rebase] [Merge] [Cancel]` → on choice
     `await ipc.pull(projectPath, choice)` then branch on its `kind`.
  4. `r.kind === "conflict"` (from a rebase/merge pull) → refresh + the conflict banner (below).
  5. `r.kind === "error"` → error toast with `r.output`.
  Fetch → `fetchChanges` → toast + refresh.
- **Conflict banner (detection only)** — when `gitStatus.conflicted > 0`, a rouge banner at
  the top of ChangesPanel: **"N conflicts — resolve them in your terminal for now; in-app
  resolution is coming next."** Conflicted files get a `!` glyph (rouge) in the file list.
  Full ours/theirs/edit resolution is Slice II.
- **Tier-0**: focus rings + aria-labels on Fetch/Pull and the reconcile dialog.

## Data flow

```
Fetch → ipc.fetchChanges → toast + refresh status
Pull  → ipc.pull(ffOnly)
          ├ ok        → toast + refresh
          ├ diverged  → reconcile dialog → ipc.pull(rebase|merge) → ok|conflict|error
          ├ conflict  → refresh + conflict banner (rebase/merge path)
          └ error     → toast
status → get_git_status: files (fast) + ahead/behind (spawn_blocking + 3s timeout);
         conflicted count from git2 index conflict state
mutations (pull/fetch/commit/amend) → acquire per-workspace git_lock first
```

## Error handling

Network ops → toast on a real `Error`/`Err` with the parsed git output. **Diverged** and
**conflict** are tagged outcomes (reconcile dialog / banner), never silent and never a raw
error. Ahead/behind timeout degrades to "unknown" (badge hidden), never a hang.

## Testing

- **Rust**: `classify_pull` (pure — ok/diverged/conflict/error from sample outputs);
  `get_status` reports `conflicted` (set up a real conflict in a temp repo via the `git`
  CLI: branch, divergent edits, `git merge` → conflict, assert the file's `conflicted` is
  true and the count > 0); the ahead/behind timeout helper (a deliberately-slow closure →
  unknown fallback); `git_lock` returns a guard and the same path serializes (two
  lock acquisitions don't overlap — a simple ordering assertion). Pull/fetch network
  happy-paths are verified manually (login shell + credentials).
- **Front** (vitest, ipc mocked): ChangesPanel sync control — Fetch/Pull call ipc; a
  `diverged` pull opens the reconcile dialog and routes Rebase→`pull("rebase")`; a
  `conflict` result shows the banner; `conflicted > 0` renders the banner + glyphs; the
  ↑/↓ badge hides when `aheadBehindKnown === false`.

## Scope guardrails (YAGNI / out of scope for Slice I)

Conflict **resolution** UI + AI (Slice II); log/history + blame (III); branch switch /
stash (IV); reset / clean / cherry-pick / tags (V); expanding the concurrency lock to
stage/unstage/discard; rail behind/conflict indicators (optional later); rebase/merge
*interactive* flows.

## Design-system compliance

Tokens only (no hardcoded hex/rgba). English-only UI copy. No italics. The sync control,
reconcile dialog (`ModalShell`), and conflict banner reuse existing Atelier primitives
(brass eyebrow, mono meta, rouge for conflict, `pushToast`, focus rings). No new
top-level chrome — everything lives in the existing ChangesPanel.
