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
| G5 AI Review Intelligence | slice 1 done (merged to main, PR #12) | [design](../specs/2026-06-08-review-g5-ai-review-pass-design.md) | [plan](2026-06-08-review-g5-ai-review-pass.md) | merged |
| G1 Editor Engine | slice 1 done (merged to main, PR #13) | [design](../specs/2026-06-08-review-g1-editor-engine-design.md) | [plan](2026-06-08-review-g1-editor-engine.md) | merged |
| G2 Editor Reliability | slice 1 done (merged to main, PR #18) | [design](../specs/2026-06-09-review-g2-editor-reliability-design.md) | [plan](2026-06-09-review-g2-editor-reliability.md) | merged |
| G4 Staging & Commit | slice 1 done (merged to main, PR #20) | [design](../specs/2026-06-09-review-g4-staging-commit-design.md) | [plan](2026-06-09-review-g4-staging-commit.md) | merged |
| G7 Git Operations Depth | slice 1 done (merged to main, PR #24) | [design](../specs/2026-06-09-review-g7-git-ops-design.md) | [plan](2026-06-09-review-g7-git-ops.md) | merged |
| G6 File Explorer | slice 1 done (merged to main, PR #29) | [design](../specs/2026-06-09-review-g6-file-explorer-design.md) | [plan](2026-06-09-review-g6-file-explorer.md) | merged |

States: `not started` → `brainstorming` → `spec'd` → `planned` → `in progress` → `done (merged to trunk)`.

### Follow-ups handed off from completed streams

**From G3 (intentionally deferred to keep stream boundaries):**
- **Staged-hunk dimming** (HunkRail already has the `staged` prop as the hook) → **G4**: needs a diff that includes staged changes; the current index→workdir diff drops a hunk on accept rather than dimming it. Part of G4's staging model.
- **`c` (focus commit) and `/` (focus filter) keys** dispatch `onFocusCommit`/`onFocusFilter` but App.tsx leaves them unwired (they'd focus ChangesPanel, which G3 must not touch) → **G4** wires them. Cheatsheet currently omits `c` to avoid advertising a dead key.
- **`o` open-at-line** opens the file but not at the hunk's first changed line (needs editor scroll-to-line) → **G1**.
- **Line/hunk anchor selection interaction** (shift-click/drag on line numbers + highlight): the `DiffAnchor` type + `anchorSlot` render-prop are shipped and inert; the selection UI + AI actions land with **G5**.

**From G5 slice 1 (deferred after the merge code-review — none blocking):**
- **Line-precise jump.** Finding cards pass `onJump(file, line)` but `App.navigateToFile(file, "diff")` drops the line (the diff has only a per-file anchor today). Needs the G3/G1 diff line-anchor before the line can be honored.
- **`gitDiff` workspace mis-attribution race.** App's single `gitDiff` lags `activeWorkspaceId` on switch; a review triggered in that sub-second window stamps the old diff under the new workspace (self-flags as stale immediately after). A synchronous clear would flash the main diff view — proper fix is a workspace-tagged diff (`{workspaceId, text}`) or store-backed diff with a real change token.
- **`ai_complete` is a one-shot primitive** (single user-text message, `tools:[]`, no streaming, no history). Fine for the review pass; when G1/G4 need tool calls / multi-turn / streaming, extend it (or add a sibling) against `LlmRequest` rather than forcing the String-only shape.
- **No DB token recording.** `ai_complete` computes cost but writes no `token_events` row (and drops `cache_read`/`cache_creation`), so Usage dashboards under-report AI-review spend. The command currently has no db handle — wire it via TokenEngine when cost-accounting matters.
- **Shared `reqwest::Client`.** `ai_complete` builds a fresh client per call (full TLS handshake each review); ChatEngine already pools one — reuse via managed state for lower latency.
- **Structured output.** The parser scrapes JSON from prose; the provider supports tool / JSON-schema calls for guaranteed shape. Consider a schema-call primitive instead of prose-scraping when reused.
- **Persisted-model reconciliation.** `models[ws]` persists to localStorage; a now-retired model id would make `resolve_provider` error. Reconcile against the live ModelPicker catalog on load.

**From G1 slice 1 (deferred — slices II/III + review notes):**
- **Slice II — Navigation & ergonomics:** tab keyboard arrow-nav + truncation tooltip + drag-reorder (Slice I shipped only Tier-0 tab roles/aria/focus); editor command palette / shortcut-hints overlay; the full "Editor" settings tab UI; `cmdk` palette entries for the editor prefs/commands.
- **Slice III — Intelligence:** language-aware autocomplete (`@codemirror/autocomplete`); minimap (third-party dep); AI ghost-text + explain-selection (reuses `ipc.aiComplete`); LSP.
- **Per-tab state across Diff↔Editor toggle.** `EditorPane` only mounts under `viewMode === "editor"`, so toggling to Diff unmounts it and clears the per-tab `EditorState` cache — cursor/undo survive tab switches but not a Diff↔Editor round-trip. Lift the cache above the view-mode boundary if that round-trip preservation is wanted.
- **Status-bar re-render.** `setPos` fires on every keystroke/selection move, re-rendering `EditorPane` + `EditorStatusBar` each time. Safe (no effect re-runs), but memoize if profiling shows jank on large files.
- **`o` open-at-line** (handed off from G3) now has the editor scroll-to-line primitive available — wire it.

**From G2 slice 1 (deferred — slices II/III):**
- **Slice II — External-change safety:** standalone `file_meta` (size+mtime) command; on window-focus and before-save, compare disk `mtime` vs the tracked `OpenFile.mtime` (Slice 1 already captures + refreshes it on save); if an agent/another app changed the file under the user, show a reload-or-overwrite `ConfirmDialog`. The scariest agentic-IDE gap. (Agents write directly via the chat tool executor `std::fs::write`, never notifying the editor.)
- **Slice III — Auto-save (optional):** `autoSave` toggle in `editorPrefsStore` + debounced save.
- **Process lesson:** the stream's explore must grep for an EXISTING util before a plan says "create" one. `formatBytes` already existed (used by `PerfMonitorBar`); G2 recreated it and broke 4 tests before reverting to reuse. Check `src/lib/*` for collisions during explore.

**From G4 slice 1 (deferred — slice II/III + review debt):**
- **Slice II — Unified staging model + staged dimming:** make the Review diff include staged changes (the `get_staged_diff` command shipped in G4-s1 is the building block) so an accepted hunk *dims in place* via the `HunkRail.staged` hook instead of vanishing; reconcile the per-file toggle with G3's per-hunk Accept into one mental model; discard-hunk; wire the **`/` file-filter** (G4-s1 wired only `c`); rename-display polish.
- **Slice III — Per-line staging** (`git add -p` granularity).
- **Review debt (optional, non-blocking):** extract a shared `git_commit_via_login_shell` helper (`amend_commit` duplicates `commit_changes`); a single shared `DEFAULT_MODEL` constant (the `"claude-sonnet-4-6"` literal is repeated in aiReviewStore/chatStore/ChangesPanel); symlink-hardening of `discard_file_inner`'s containment guard.

**From G7 slice 1 (deferred — slices II–V):**
- **Slice II — Conflict resolution: SHIPPED 2026-06-11** (feat/review-g7-conflicts): take ours/theirs (rebase-aware UPSTREAM/MINE labels), mark-resolved, continue/abort with outcome classification, AI resolution with preview. Follow-ups from its review: graceful exit animation when the conflict section unmounts (op completes); refresh open editor buffers after resolve/take/abort (G2 mtime seam — a conflicted file open in the editor goes stale after an AI apply; a blind Cmd+S would overwrite the resolution).
- **Slice III — Inspect:** log/history browser; per-line blame gutter.
- **Slice IV — Branch & stash:** branch list/switch/create; stash push/pop/list.
- **Slice V — Advanced:** reset (soft/mixed/hard, guarded); clean untracked; cherry-pick; tags.
- **Review notes:** expand the per-workspace `git_lock` to stage/unstage/discard (G7-s1 covers only pull/fetch/commit/amend); `aheadBehindKnown=false` currently conflates timeout with no-upstream (both hide the badge — fine, but a distinct signal would be cleaner); fetch/pull use sync `std::process::Command` in async fns (pre-existing pattern; `tokio::process` later).

**From G6 slice 1 (deferred — slices II–III + review debt):**
- **Slice II — File operations:** rename / new file / new folder / delete (new Rust commands + confirm flows) from the tree context menu. Prereq noted in review: the tree's cache has no external invalidation entry point — file ops (and agent runs creating files) need an `invalidate(path)` hook or a small store.
- **Slice III — Scale & navigate:** filter/search in the tree; virtualization for huge trees. (Arrow-key nav + roving tabindex + Shift+F10 already shipped in slice 1's review round.)
- **Review debt (cross-cutting, from the PR #29 review):** consolidate the 3 menu positioning idioms — `useMenuChrome` should own portal+fixed+z so Project/Workspace/FileTree menus stop diverging (ITEM/SEP strings now have 3 copies too; extract to a shared module or `<MenuItem>`); shared `copyToClipboard(text, title)` util (4th copy shipped, semantics already diverged on no-clipboard contexts); 3 extension tables in `src/lib` (fileIcons / languageDetection / editorLang) need one `getExtension()` + reconciled lists; `walk_one_level`'s walker config is the 3rd copy in commands.rs (list_workspace_files / search_workspace_text — extract a shared builder); per-workspace persisted prefs use 3 key schemes across stores (only workspaceStore prunes — `showIgnoredFiles` keys by rootPath, deletes on toggle-off but recycled paths can inherit an ON pref).

**Workspace creation follow-ups (2026-06-11, from the base-branch mini-feature):**
- **Editable branch name** in the creator — today the branch is the task slug, not editable; a collision silently reuses the existing branch (`create_branch` is idempotent), which can surprise. Editable name + a "branch already exists" inline warning.
- **Create from a remote branch / PR** — base picker currently lists local branches only; tracking `origin/x` (fetch + `checkout -b x origin/x`) and "workspace from PR #N" are natural extensions.
- **Branch picker search** — for repos with many branches the `useMenuChrome` menu needs a filter input (and possibly virtualization).
- **Per-project default setup script** — the setup script is retyped per workspace; persist a project-level template prefilled in step II.
- **Show the base branch on the workspace** — surface "feat-x · from release/1.0" in the ContextHeader / rail tooltip; requires persisting `from_branch` in the workspaces table (today it's not stored).

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
