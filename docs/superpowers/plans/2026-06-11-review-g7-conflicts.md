# G7 Slice II · Conflict Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax. Design basis: `docs/superpowers/specs/2026-06-09-review-g7-git-ops-design.md` (slice II of the 5-slice plan) + design-system §9 doctrine (no italics, no arrow glyphs in buttons, icons + tooltips, calm motion, rouge = conflict).

**Goal:** Resolve merge/rebase conflicts entirely in-app: per-file take-ours/take-theirs/edit/AI-resolve, mark-resolved, then continue or abort the operation — replacing the slice-I banner that points users to the terminal.

**Architecture:** `git_ops::operation_state` (via git2 `repo.state()`) exposed as `GitStatus.operation: "merge"|"rebase"|null`. New commands (all under the per-workspace `git_lock`): `resolve_conflict_take(path, file, side)` (`git checkout --ours/--theirs -- f` + `git add -- f`), `mark_conflict_resolved(path, file)` (`git add`), `continue_operation(path)` / `abort_operation(path)` (login-shell `git -c core.editor=true merge|rebase --continue` / `--abort`, chosen by the detected state; pure `classify_continue` tags Ok/MoreConflicts/Error). ChangesPanel's conflict banner becomes a resolution section: per-file rows with quiet actions + Continue/Abort once clean. AI resolution: read the conflicted file, `ipc.aiComplete` proposes a merged version, ModalShell preview, Apply = `write_file` + mark resolved.

**Tech Stack:** Rust git2 + login-shell git, React 19, ModalShell/ConfirmDialog/pushToast, Vitest + tempfile/git-CLI tests.

**Branch:** `feat/review-g7-conflicts` off main, worktree `octopus-sh-review`.

---

### Task 1: Backend — operation state + per-file resolution

**Files:** `src-tauri/src/git_ops.rs`, `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/tests.rs`, `src/lib/ipc.ts`, `src/lib/types.ts`

- [ ] **`git_ops::operation_state(path) -> AppResult<Option<&'static str>>`**: open repo, map `repo.state()` — `Merge` → `Some("merge")`; `Rebase | RebaseInteractive | RebaseMerge` → `Some("rebase")`; everything else → `None`. Add `operation: Option<String>` to `GitStatus` (serde camelCase → `operation`), populated in `status_files` (cheap — no graph walk). TS `GitStatus` gains `operation: "merge" | "rebase" | null`.
- [ ] **Commands** (each acquires `git_lock(&path)` first; run git via `std::process::Command` with `.arg`-separated args — NO shell interpolation of file names; mirror the existing `stage_file` pattern in commands.rs):
  - `resolve_conflict_take(workspace_path, file, side)` — `side ∈ "ours"|"theirs"` (validate, else `AppError::Other`); run `git checkout --ours|--theirs -- <file>` then `git add -- <file>`. If checkout fails (e.g. delete/modify conflict where one side has no version), return the trimmed git stderr via `friendly_git_error` if available, else raw — UI shows it in a toast.
  - `mark_conflict_resolved(workspace_path, file)` — `git add -- <file>`.
- [ ] **Tests** (tempdir + git CLI, pattern from `branch_listing_tests`): build a real conflict (init, commit base, branch divergent edits, `git merge` fails) then assert: `operation_state` = merge during, None after abort; `resolve_conflict_take(.., "ours")` leaves the file with HEAD content and `get_status().conflicted == 0`; `"theirs"` leaves the other content; invalid side errors. Register commands in lib.rs; ipc bindings `resolveConflictTake(path, file, side)`, `markConflictResolved(path, file)`.
- [ ] cargo test green + typecheck. Commit `feat(review/g7): operation state + take-ours/theirs conflict resolution`.

### Task 2: Backend — continue / abort

**Files:** `src-tauri/src/git_ops.rs` (classify), `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/tests.rs`, `src/lib/ipc.ts`

- [ ] **Pure** `classify_continue(success: bool, combined: &str) -> ContinueKind {Ok, MoreConflicts, Error}` (serde camelCase like `PullKind`): success → Ok; output containing `conflict` or `could not apply` → MoreConflicts; else Error. Table-test it.
- [ ] **Commands** `continue_operation(workspace_path)` / `abort_operation(workspace_path)`: acquire git_lock; read `operation_state` — None → `AppError::Other("no merge or rebase in progress")`; build `git -c core.editor=true merge --continue` / `git rebase --continue` (and `--abort` twins) and run via the LOGIN SHELL pattern used by `commit_changes`/`pull` (`$SHELL -l -c`, `.current_dir`, combined stdout+stderr). `continue_operation` returns `ContinueOutcome { kind, output }`; abort returns `AppResult<String>`. ipc: `continueOperation(path)`, `abortOperation(path)`.
- [ ] **Tests**: classify table; abort integration (real conflict → `abort_operation` → `operation_state` None, working tree clean). Continue happy-path is exercised manually (login shell). cargo + typecheck green. Commit `feat(review/g7): continue/abort merge and rebase with outcome classification`.

### Task 3: ChangesPanel — resolution UI

**Files:** `src/components/ChangesPanel.tsx` (+test)

- [ ] Replace the static banner (lines ~302-305) with a **conflict section** shown when `conflicted > 0 || gitStatus?.operation`: rouge header row `{n} conflict{s} · {operation}` (mono, `--rouge-ghost` bg, `octo-rise-in`), then one row per conflicted file (from `gitStatus.changedFiles.filter(f => f.conflicted)`): truncated name with `title`, and a quiet action cluster — mono 9px text-chips `OURS` / `THEIRS` (each `title="Keep our version — git checkout --ours"` / theirs equivalent, rouge-tinted hover, focus ring, NO glyphs), a `Pencil` icon button (`title="Open in editor"`, uses the existing file-open path the panel already has for clicking changed files — locate it; if none, call the same handler used by ChangesPanel rows or `ipc` editor opening used elsewhere) and a `Sparkles` icon button (`title="Resolve with AI"`, wires Task 4; render disabled with `title="AI resolution — coming in this slice"` until Task 4 lands if needed to keep the task shippable).
- [ ] OURS/THEIRS → `ipc.resolveConflictTake` → refresh status; errors → `pushToast` error. When `conflicted === 0 && operation` (all resolved but op pending): show the same section with `All conflicts resolved` (sage) + two CTAs: `Continue {operation}` (brass-ghost chip; on `MoreConflicts` toast warning "next step has conflicts" + refresh; on Ok toast success + refresh) and `Abort` (rouge quiet button → `ConfirmDialog` "Abort the {operation}? Conflict resolutions in progress are discarded." → `ipc.abortOperation` → refresh).
- [ ] Tests (ipc mocked): conflicted files render rows; OURS calls ipc with side "ours"; resolved-but-pending shows Continue/Abort; abort confirms first; continue MoreConflicts toasts warning. Full suite + typecheck green. Commit `feat(review/g7): in-app conflict resolution UI — take ours/theirs, continue/abort`.

### Task 4: AI resolution

**Files:** `src/components/ConflictAiModal.tsx` (new + test), `src/components/ChangesPanel.tsx`, `src/lib/aiConflict.ts` (new + test)

- [ ] **`src/lib/aiConflict.ts`**: `buildConflictPrompt(fileName, content)` (system: senior engineer merging a git conflict; resolve EVERY `<<<<<<<`/`=======`/`>>>>>>>` block preserving both sides' intent; output ONLY the complete merged file, no fences, no commentary) + `stripFences(text)` cleaning accidental ``` wrappers. Cap: content > 48_000 chars → throw before calling AI. Unit-test both helpers.
- [ ] **`ConflictAiModal`**: ModalShell; on mount reads the file via `ipc.readFileChecked` (kind text only — binary/tooLarge → error state), calls `ipc.aiComplete(model, system, prompt)` with the workspace's review model from `useAiReview`'s `modelFor` (reuse, don't add a picker), shows a calm loading line, then a scrollable mono preview of the proposed merge (`max-h` + `overflow-auto`); footer: `Apply` (brass-ghost chip — `ipc.writeFile` then `ipc.markConflictResolved`, toast success, close+refresh) and `Discard` (quiet). Errors (AI, truncation per the max-tokens guard, remaining markers in output → warn but allow apply with `title` explaining) surface inline in rouge, `octo-rise-in`. FadeSwap between loading/preview/error states.
- [ ] Wire the `Sparkles` button. Tests: prompt/strip helpers; modal happy path applies write+mark (ipc mocked); error path renders inline. Full suite + typecheck. Commit `feat(review/g7): AI conflict resolution with preview`.

---

## Done criteria

A real merge conflict is resolvable end-to-end without a terminal (ours/theirs/editor/AI → continue), abort works with confirmation, rebase multi-step conflicts surface as MoreConflicts and the section persists, the terminal-pointing banner is gone, zero arrow glyphs in buttons / rgba literals / italics, all suites green.
