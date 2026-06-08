# REVIEW mode overhaul — master grouping & priority

> Source-of-truth tracker for the full Review-mode hardening initiative. Every gap
> from the 2026-06-07 audit is assigned to exactly one **work-stream**. Streams are
> designed to be *file-disjoint* so they can be specced and built in parallel
> (agents in separate worktrees) without merge conflicts. Nothing here is lost as
> session context grows — start from this doc.

**Branch:** `feat/review-mode` (worktree `octopus-sh-review`, off `main` @ 0b4af71).

---

## Persistence protocol (how to resume across sessions/days)

Nothing lives in chat. Any session — today or weeks later, this directory or another
— resumes from committed artifacts:

1. **`feat/review-mode` is the shared trunk** for the whole initiative. It holds: this
   tracker, the audit (`../2026-06-07-review-mode-audit.md`), and one **spec + plan per
   stream**. Specs/plans are committed to the trunk *before* implementation branches.
2. **Per-stream implementation branch** off the trunk: `feat/review-g<N>-<slug>`
   (e.g. `feat/review-g3-diff`, `feat/review-g5-ai`), each in its own worktree. This is
   what lets G3 run here while G5 runs in another session without collisions. Each merges
   back to the trunk when green.
3. **Specs are self-contained** (writing-plans rule): written for zero prior context, with
   file:line, so a fresh session executes them cold.
4. **Update the Status Index below** whenever a stream changes state, and link its
   spec/plan/branch. This table is the first thing any session reads.
5. A **project memory** (`project_review_mode_overhaul`) points new sessions here.

**To pick up ANY stream later:** `git checkout feat/review-mode` → read this tracker's
Status Index → open that stream's spec/plan → branch `feat/review-g<N>-<slug>` → execute.

## Status Index

| Stream | Status | Spec | Plan | Impl branch |
|--------|--------|------|------|-------------|
| G3 Diff Reading | done (merged to main, PR #6) | [design](../specs/2026-06-08-review-g3-diff-reading-design.md) | [plan](2026-06-08-review-g3-diff-reading.md) | merged |
| G5 AI Review Intelligence | planned (slice 1: primitive + AI Review Pass) | [design](../specs/2026-06-08-review-g5-ai-review-pass-design.md) | [plan](2026-06-08-review-g5-ai-review-pass.md) | `feat/review-g5-ai` |
| G1 Editor Engine | not started | — | — | — |
| G2 Editor Reliability | not started | — | — | — |
| G4 Staging & Commit | not started | — | — | — |
| G7 Git Operations Depth | not started | — | — | — |
| G6 File Explorer | not started | — | — | — |

States: `not started` → `brainstorming` → `spec'd` → `planned` → `in progress` → `done (merged to trunk)`.

### Follow-ups handed off from completed streams

**From G3 (intentionally deferred to keep stream boundaries):**
- **Staged-hunk dimming** (HunkRail already has the `staged` prop as the hook) → **G4**: needs a diff that includes staged changes; the current index→workdir diff drops a hunk on accept rather than dimming it. Part of G4's staging model.
- **`c` (focus commit) and `/` (focus filter) keys** dispatch `onFocusCommit`/`onFocusFilter` but App.tsx leaves them unwired (they'd focus ChangesPanel, which G3 must not touch) → **G4** wires them. Cheatsheet currently omits `c` to avoid advertising a dead key.
- **`o` open-at-line** opens the file but not at the hunk's first changed line (needs editor scroll-to-line) → **G1**.
- **Line/hunk anchor selection interaction** (shift-click/drag on line numbers + highlight): the `DiffAnchor` type + `anchorSlot` render-prop are shipped and inert; the selection UI + AI actions land with **G5**.

---

## Independence model (read first)

Each stream **owns** a disjoint set of frontend files. Four substrates are *shared
but additive* — parallel branches append to them and merges are mechanical, never
logical:

- **`src-tauri/src/commands.rs` + `lib.rs` invoke_handler** — every stream that adds a Tauri command appends here. Conflicts are at the handler list only.
- **`src-tauri/src/git_ops.rs`** — split by function: diff-related fns → G3; all other git fns → G7.
- **`src/styles.css`** — token additions are append-only.
- **`src/App.tsx`** Review render block (~1398–1469) — integration seam; each stream exposes a self-contained component that App wires in one line.

**One shared NEW primitive:** the AI IPC (`ai_complete` streaming backend command +
`ipc.aiComplete`). Built **once** at the start of the first AI-bearing stream (G5),
then reused by the AI sub-features in G1/G3/G4. This is the only soft cross-stream
dependency, and only for the *AI garnish* of those streams — their cores are fully
independent.

---

## The 7 work-streams

### G3 · Diff Reading Experience  *(owns the heart of Review)*
**Mission:** make reviewing a changeset fast, legible, and premium.
**Owns:** `ReviewCanvas.tsx` (split into `DiffView`/`HunkCard`/`DiffLine` sub-files), `diffParser.ts`, `editor/diffGutter.ts`; diff-related fns in `git_ops.rs` (`get_diff_text`).
**Items:**
- Syntax-highlighted diff (currently plain monochrome).
- Intra-line (word-level) diff highlighting.
- Collapse/expand hunks; collapse-by-default for large files.
- Side-by-side diff view toggle (+ persist the Diff/Editor/side-by-side choice).
- Keyboard hunk navigation (next/prev) + keyboard Accept/Reject.
- "Viewed" checkboxes per file (GitHub-style).
- Per-line review annotations/comments anchored to diff lines.
- Rename-detection display in the diff header.
- Test-runner polish (in ReviewCanvas): selectable/copyable output, parse-error feedback, run progress.
- Diff gutter: fix deleted-line undercount (only one ▾ marker today).
- Whitespace-ignore diff option.
- **AI garnish (reuses G5 IPC):** "Explain this hunk" + "Refine this hunk → hand back to an agent" inline on hunk cards.
- **Tier-0 correctness for this surface (do first):** fix undefined `text-octo-text` / `text-octo-textMuted` classes (ReviewCanvas:330,352,362 — real bug); hardcoded rgba → tokens (ReviewCanvas:297,307 → `--verdigris-ghost`/`--rouge-ghost`); add entrance motion to Why?/Diff⇄Editor toggle/Test drawer; `duration-200` → 220ms token; focus rings + a11y on diff controls.

### G5 · AI Review Intelligence  *(owns the AI primitive + net-new AI surfaces)*
**Mission:** make Review the place human + AI converse about a change.
**Owns:** new `ai_complete` backend command + `ipc.aiComplete` (the shared primitive); new AI panel/sub-components (new files); AI-review store.
**Items:**
- The shared AI IPC primitive (streaming, model selection, API-key plumbing) — build first.
- AI **review pass** over the whole changeset (flag risks / missing tests / security / style).
- AI **changeset summary** ("what changed and why" in plain English).
- AI **PR description** generation from commits + diff.
- (Hosts the prompt/orchestration that G1/G3/G4 AI bits call into.)

### G1 · Editor Engine  *(owns everything inside the code editor)*
**Mission:** an editor a developer won't want to leave.
**Owns:** `EditorPane.tsx`, `EditorTabs.tsx`, `editor/atelierTheme.ts`, `editorLang.ts`, new `editorPrefsStore.ts`, editor settings UI.
**Items:**
- Find + find/replace (`@codemirror/search`).
- Go-to-line.
- Soft-wrap toggle.
- Multi-cursor.
- Minimap.
- Keyboard-shortcut palette / hints overlay.
- Autocomplete (CodeMirror language-aware) — **LSP integration as a stretch sub-phase**.
- Tabs: keyboard nav, tooltip on truncated names, drag-to-reorder.
- Customization: font size, tab width, line-numbers toggle, wrap — **persisted** (`editorPrefsStore`).
- **AI garnish (reuses G5 IPC):** ghost-text completions + inline quick-fix / "explain selection".
- **Tier-0 for this surface:** hardcoded rgba → token (EditorTabs:36 → `--brass-faint`); focus rings on tabs/editor controls.

### G2 · Editor Reliability & File I/O  *(owns "never lose or corrupt work")*
**Mission:** safety, especially with agents writing files underneath the user.
**Owns:** `editorStore.ts`; backend `read_file`/`write_file` (+ new `file_meta`/mtime command) in `commands.rs`.
**Items:**
- Large-file guard (size cap + warning before opening).
- Binary-file detection (refuse/warn instead of corrupting).
- Non-UTF-8 encoding handling (detect/fallback instead of silent failure).
- Save-failure toast (currently `.catch(console.error)` swallows it).
- External-change / stale-disk detection → reload-or-overwrite prompt (the scariest gap in an agentic IDE).
- Optional auto-save.

### G4 · Staging & Commit Workflow  *(owns the git "write" path in Review)*
**Mission:** complete, unambiguous staging + commit.
**Owns:** `ChangesPanel.tsx`; staging/commit backend in `commands.rs` (`stage_file`/`stage_hunk`/`stage_all`/`unstage*`/`revert_hunk`/`commit`/new `amend`).
**Items:**
- Amend last commit.
- Discard-file (and discard-hunk) from within Review.
- One coherent staging mental model (reconcile per-file toggle vs per-hunk Accept).
- Per-line staging (`git add -p` line granularity).
- Better hunk-apply error messages (parse `git apply` stderr → say *why*).
- Rename display in the changes panel.
- Commit UX polish (validation, feedback).
- **AI garnish (reuses G5 IPC):** AI commit message from the staged diff.
- **Tier-0 for this surface:** focus rings + a11y on staging/commit controls.

### G7 · Git Operations Depth  *(owns terminal-free git)*
**Mission:** stop sending users to the terminal.
**Owns:** non-diff fns in `git_ops.rs`; new git commands in `commands.rs`; new git UI (toolbar, conflict view, history/blame panels — new files).
**Items:**
- Pull / fetch + "you're behind" awareness.
- Conflict visualization + resolution (+ **AI conflict resolution**, reuses G5 IPC).
- Blame (per-line, editor gutter).
- History / log browser.
- Stash / pop.
- Reset (soft / mixed / hard) with guards.
- Clean untracked.
- Branch switch / create from Review.
- Cherry-pick.
- Tag management.
- `upstream_ahead_behind` timeout (avoid hang on huge graphs).
- Concurrent git-op safety (serialize/lock).

### G6 · File Explorer & Navigation  *(owns the Companion file tree)*
**Mission:** a tree that scales and supports real file ops.
**Owns:** `CompanionFileTree.tsx`; file-ops backend (rename/new/delete) in `commands.rs`.
**Items:**
- File-type icons.
- Filter / search in the tree.
- Context menu: rename / new / delete.
- Keyboard navigation + `role="treeitem"`.
- Virtualization for large trees.
- Richer changed-file affordances.
- **Tier-0 for this surface:** hardcoded rgba → tokens (CompanionFileTree:174,271 → `--brass-dim` + new token); focus rings + a11y.

---

## Priority (most value → least)

| Rank | Stream | Why this rank |
|------|--------|---------------|
| 1 | **G3 Diff Reading** | It *is* Review; felt every session; carries the real bug fix + motion/token polish; restructuring ReviewCanvas now makes G5's inline AI attach cleanly later. |
| 2 | **G5 AI Review Intelligence** | The strategic differentiator and the product thesis ("AI era"); owns the AI primitive that unlocks AI everywhere → build early so G1/G4 AI bits land cheaply. |
| 3 | **G1 Editor Engine** | Directly answers "won't miss other editors" — in-file search alone is a daily unblock. |
| 4 | **G2 Editor Reliability** | Small but safety-critical (agent-vs-user file races = data loss). Cheap insurance — worth fast-tracking regardless of rank. |
| 5 | **G4 Staging & Commit** | Completes the git write path (amend/discard/clear model) + AI commit message. |
| 6 | **G7 Git Operations Depth** | Terminal-free git; broad, but many items are lower-frequency. |
| 7 | **G6 File Explorer** | Useful, but lowest frequency in an AI-first review flow. |

**Recommended start:** G3 (the stage), with G2's tiny safety fixes fast-tracked alongside, and G5's AI primitive built right after so the AI garnish across G1/G3/G4 becomes trivial.

**Parallelization-ready pairs (file-disjoint, safe to run at once):** G3+G1+G6 (three different surfaces), or G2+G4+G7 share only the additive `commands.rs` seam.
