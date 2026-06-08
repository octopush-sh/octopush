# REVIEW mode — full audit (2026-06-07)

> Senior SWE + UX audit of Octopush's Review mode, grounding the 7-stream overhaul
> (see `plans/2026-06-07-review-mode-master-grouping.md`). Findings are evidence-based
> (file:line). Claims marked **[verified]** were re-checked by hand after the agent sweep.

## Surface map
Review mode (toggled in the ModeSwitcher) renders a 3-column canvas — `App.tsx:1398–1469`:
- **Left 260px:** `ChangesPanel` — staged/unstaged file index, per-file stage toggle, commit message + commit + push.
- **Center:** `ReviewCanvas` — Diff⇄Editor toggle, test-command runner, "Accept all", hunk cards.
- **Center (Editor sub-mode):** `EditorTabs` + `EditorPane` (CodeMirror 6, diff gutter).
- **Right (Companion):** `CompanionFileTree`.

---

## 1. Editor — grade B-
**Stack [verified]:** CodeMirror 6 (`codemirror@6.0.2`, `@codemirror/view@6.43`, `state`, `commands`, `language`); 11 langs + plaintext (`editorLang.ts`, `EditorPane.tsx:28-41`); custom Atelier theme (`editor/atelierTheme.ts`).
**Present:** syntax highlight, line numbers, fold gutter, active-line, bracket matching, indent-on-input, undo/redo (`history`+`historyKeymap`), `indentWithTab`, multi-tab (`EditorTabs.tsx`), dirty dots (`EditorTabs.tsx:51-59`), manual save `Mod-S` (`EditorPane.tsx:81-85`), diff gutter (`editor/diffGutter.ts`).
**Missing [verified — packages absent]:** in-file search / find-replace (`@codemirror/search` not installed), autocomplete/LSP (`@codemirror/autocomplete` absent), lint (`@codemirror/lint` absent). Also: minimap, soft-wrap, multi-cursor, go-to-line, keyboard-shortcut help.
**Tabs:** no keyboard nav, no tooltip on truncated names, no drag-reorder.
**AI gaps:** no ghost-text, no "explain selection", no inline quick-fix.

## 2. Editor reliability / file I/O — grade B- (safety)
- **No size cap** in backend `read_file` (`commands.rs`, `std::fs::read_to_string`) → huge/minified file freezes app.
- **No binary detection** + UTF-8-only → opening `.png`/latin-1 corrupts or errors.
- **Save failure swallowed:** `EditorPane.tsx:83` `.catch(console.error)` → user believes a failed save succeeded.
- **Stale-disk overwrite:** `editorStore` reads `file.content` at save time; if disk changed (agent/git/build) `Mod-S` clobbers it silently. *Most dangerous gap in an agentic IDE.*
- Tab switch resets cursor/scroll/undo (acceptable, matches VS Code).
- Minor: `Mod-S` keymap captures `workspaceId` at editor-creation; eslint exhaustive-deps suppressed at `EditorPane.tsx:119` (low risk).

## 3. Diff / review experience — grade B
- Inline unified diff; hunk-level **Accept/Reject** (`ReviewCanvas.tsx` HunkCard ~59-277); file-level toggle (`ChangesPanel.tsx`); "Accept all".
- **"Why?" drawer** (`ReviewCanvas.tsx:98-128,227-274`): traces a hunk to the agent turn that produced it (model, timestamp, message). On-brand, ahead of peers — but it only *retrieves*, never *generates*.
- **No syntax highlighting in the diff** (plain mono).
- **No intra-line (word) diff.**
- **No next/prev hunk nav, no keyboard accept/reject.**
- **No "viewed", no collapse/expand, no side-by-side.**
- Two staging mental models (per-file vs per-hunk) collide.
- **No amend.**
- Diff gutter undercounts multi-line deletions (one ▾ only) — `editor/diffGutter.ts`.
- Test runner: output not selectable/copyable; parse errors only to console; no run progress.

## 4. Git management — grade B-
**Backend = libgit2 + CLI hybrid.** Has: `get_status`, `get_diff_text` (1 MiB cap, `git_ops.rs:353`), stage file/hunk/all, unstage (file/all, modern+fallback), `revert_hunk`, commit (user shell, GPG-safe), push (`--set-upstream`), branch/worktree CRUD, PR lookup (GitHub API + `gh` fallback).
**Missing:** pull/fetch, merge, rebase, stash, reset(hard/mixed/soft beyond unstage), user amend, clean, blame, log/history, cherry-pick, tag, conflict resolution.
**Risks:** hunk-apply errors opaque ("git apply failed") on context drift; `get_status` recurses all untracked dirs (slow on large repos); `upstream_ahead_behind` no timeout; no concurrent-op locking. **Path safety [verified-good]:** `.args()` + `--` separators, shell-escaped messages — no injection found.
**AI gaps:** no AI commit message, no AI conflict resolution, no AI PR description, no semantic diff.

## 5. Design-system fidelity — grade B+
- **[verified BUG]** Undefined token classes `text-octo-text` (`ReviewCanvas.tsx:330,352`) and `text-octo-textMuted` (`:362`) — NOT in `@theme` (only `octo-ivory`/`octo-mute` exist) → Test-output drawer text renders an unintended inherited color. **(Note: `octo-success`/`octo-danger` ARE defined — that part of an agent report was wrong.)**
- **Hardcoded `rgba()`** where tokens exist: `CompanionFileTree.tsx:174,271`; `ReviewCanvas.tsx:297,307` (→ `--verdigris-ghost`/`--rouge-ghost`); `EditorTabs.tsx:36` (→ `--brass-faint`).
- **Motion gaps:** "Why?" drawer, Diff⇄Editor toggle, Test drawer appear abruptly (no `octo-*` entrance primitive); `duration-200` instead of 220ms token (`ReviewCanvas.tsx:142`).
- CodeMirror theme inline hex is **intentional & documented** (theme() takes JS objects) — not a violation.
- Correct elsewhere: eyebrows, brass accents, hairlines, mono-meta, `§` glyph, status colors.

## 6. File tree & customization & a11y — grade C
- `CompanionFileTree`: expand/collapse, changed-file dots (brass/mute), `§` mark, indent guides. **Missing:** file-type icons, filter/search, context menu, keyboard nav, virtualization, file ops (rename/new/delete).
- **Customization near-zero:** font size hard-coded 13px (`atelierTheme.ts:37`), no wrap/tab-width/line-number toggles, diff/editor view-mode not persisted; only test command persists.
- **A11y:** tree rows are clickable `div`s (not `role="treeitem"`), no keyboard nav, no focus rings; reduced-motion globally respected `[verified]`.

---

## Overall
Bones are good; the "Why?" drawer shows the right agentic instinct. But Review today is a **competent diff-approver**, not a place a developer *prefers* to review and edit. Fastest path to "won't miss other tools" = Tier-0 correctness + editor inhabitability (search/wrap) + the AI review features. Full remediation is organized into the 7 streams in the master grouping doc.
