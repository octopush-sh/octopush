# G3 · Diff Reading Experience — design spec

**Goal:** Make Octopush Review mode's diff fast and legible — a hybrid continuous diff with a signature brass per-hunk rail, syntax highlighting, word-level diff, keyboard-driven triage, collapse/"viewed", and an optional side-by-side mode — without changing staging semantics (G4) or adding AI (G5).

**Architecture:** Refactor the 722-line `ReviewCanvas.tsx` into a thin shell + focused `review/` sub-components and `lib/` helpers; extend `diffParser.ts`; add a tiny G3-owned prefs store; one additive backend flag. Everything else (ChangesPanel, staging backend, AI) is untouched so G3 stays parallelizable with the other streams.

**Tech Stack:** React 19 + TS, Zustand, CodeMirror 6 (reuse `editorLang.ts` + `editor/atelierTheme.ts` for diff highlighting), Tailwind v4 tokens, libgit2 (`git2` crate), Vitest.

**Part of:** the 7-stream Review overhaul — see `../plans/2026-06-07-review-mode-master-grouping.md` (G3) and `../2026-06-07-review-mode-audit.md`. Branch trunk `feat/review-mode`; implement on `feat/review-g3-diff`.

---

## 1. Current state (what we're changing)

- `src/components/ReviewCanvas.tsx` (722 lines) holds everything: toolbar, `HunkCard`, `DiffLine`, `TestDrawer`, `FileDiffSection`, `EmptyDiffState`, test-runner + view-mode state.
- Diff is rendered as `<pre>` with per-line `DiffLine` (plain colored text, **no syntax highlight**, **no word diff**) — `ReviewCanvas.tsx:292-314`.
- Hunks are **bordered cards** with per-card Accept/Reject/Why — `ReviewCanvas.tsx:139-225`.
- `src/lib/diffParser.ts` → `parseFullDiff` builds `DiffFile`/`DiffHunk`; `parseDiffForFile` builds gutter markers (has a deleted-line undercount, `:171-176`).
- `src/components/editor/diffGutter.ts` paints CodeMirror gutter markers.
- View mode (`diff`/`editor`) is component state, **not persisted**; there is **no inline/side-by-side** concept today.
- Backend diff: `src-tauri/src/git_ops.rs` `get_diff_text` (1 MiB cap), no whitespace option.

## 2. Locked design decisions (from brainstorming)

1. **Review optimizes for "Balanced"** — legible-by-default *and* fast keyboard triage; the two reinforce each other. Editing stays available via the existing Editor toggle but is not what the diff surface optimizes for.
2. **Paradigm C — Hybrid:** one continuous syntax-highlighted diff per file (reading flow), with hunks delineated by a signature **brass rule** and a **slim sticky hunk rail** carrying +/−, Accept/Reject/Why and keyboard focus. No heavy card chrome. Focused hunk = bright rule; staged hunk = dimmed.
3. **Reading mode:** **inline (unified) default + side-by-side toggle**, persisted. Side-by-side is two synced panes with cross-pane word-diff.
4. **Triage flow approved** (keyboard map + collapse + viewed + undo-on-reject) — see §7.
5. **Per-line human comments are cut.** Instead build a **line/hunk anchoring primitive** (§10) that G5 attaches AI actions to.

## 3. File structure (refactor map)

All paths under `src/`. G3 **owns** every file below (disjoint from other streams).

| File | Responsibility |
|------|----------------|
| `components/ReviewCanvas.tsx` | Shell: toolbar (Diff/Editor toggle, inline/SBS toggle, whitespace toggle, test runner, Accept-all) + orchestration. Renders `DiffView` or `children` (editor). |
| `components/review/DiffView.tsx` | Continuous diff container: maps `DiffFile[]` → `FileDiffSection[]`; owns scroll; hosts the keyboard hook; empty state. |
| `components/review/FileDiffSection.tsx` | One file: header (type badge, path, hunk count, rename display), viewed/collapse state, renders its `HunkRail` + `DiffLines` per hunk. |
| `components/review/HunkRail.tsx` | Sticky brass rail per hunk: range label (`⟶ lines X–Y`), +/− counts, Accept/Reject/Why, focus styling, staged-dim. |
| `components/review/DiffLines.tsx` | Renders a hunk's lines syntax-highlighted + word-diffed, in inline OR side-by-side layout. Line-number gutters (old/new). |
| `components/review/TestDrawer.tsx` | Extracted test-output drawer + polish (selectable output, exit badge, parse-error feedback). |
| `components/review/EmptyDiffState.tsx` | Extracted empty/all-staged state. |
| `components/review/useDiffKeyboard.ts` | Keyboard model hook: focus index over the flattened visible-hunk list + action dispatch. |
| `stores/reviewPrefsStore.ts` | **New, G3-owned.** Persisted: `readingMode: "inline"|"sbs"`, `ignoreWhitespace: boolean`. (Does NOT touch G1's editor prefs.) |
| `lib/diffHighlight.ts` | Tokenize a code line via the file's CodeMirror language (`editorLang.ts`) + Atelier `HighlightStyle` (`editor/atelierTheme.ts`) → styled spans. |
| `lib/wordDiff.ts` | Intra-line diff between a paired removed/added line → segment runs (`equal`/`del`/`add`). |
| `lib/diffParser.ts` | Extend: pair adjacent `-`/`+` lines per hunk; attach old/new line numbers per line; keep `rawText` for `git apply`. Fix the deleted-line gutter undercount. |
| `components/editor/diffGutter.ts` | Consume the corrected markers (one `removed-after` marker per deletion run is fine, but count is now correct via parser fix). |

## 4. Data model (diffParser extensions)

Extend `DiffHunk` with a structured line list (keep `lines`/`rawText` for compatibility + `git apply`):

```ts
type DiffRowKind = "context" | "add" | "del";
interface DiffRow {
  kind: DiffRowKind;
  text: string;            // line content without the +/-/space sign
  oldLine: number | null;  // 1-based old-file line (null for added)
  newLine: number | null;  // 1-based new-file line (null for removed)
  /** Word-diff segments vs its paired counterpart (only for paired add/del rows). */
  segments?: WordSegment[];
}
interface WordSegment { kind: "equal" | "add" | "del"; text: string; }
```

`DiffHunk` gains `rows: DiffRow[]`. Pairing rule: within a hunk, a maximal run of `del` rows immediately followed by a run of `add` rows is a "replace block"; pair them index-wise (del[i]↔add[i]); compute `segments` for paired rows via `wordDiff`. Unpaired del/add rows have no segments (rendered as whole-line del/add).

## 5. Word-diff algorithm (`lib/wordDiff.ts`)

`wordDiff(oldText, newText): { old: WordSegment[]; new: WordSegment[] }`. Tokenize each line into words + punctuation + whitespace (regex `/(\s+|\w+|[^\s\w]+)/g`), run a standard LCS over tokens, emit `equal`/`del` for the old side and `equal`/`add` for the new side. No new dependency — implement a compact LCS (lines are short). Cap token count (e.g. 400) → fall back to whole-line highlight for pathological lines.

## 6. Syntax highlighting (`lib/diffHighlight.ts`)

`highlightLine(text, langName): Array<{text, className|style}>`. Build a one-off CodeMirror `EditorState` per language (memoized by langName) or use the language's stream/Lezer parse to tokenize the single line, mapping tags to the Atelier `HighlightStyle` already defined in `editor/atelierTheme.ts`. Reuse `langForExtension` from `editorLang.ts` to pick the language from the file path. **Diff colors = editor colors** → visual consistency. Word-diff backgrounds (`add`/`del`) layer *over* the syntax-colored foreground.

## 7. Keyboard model (`useDiffKeyboard.ts`)

Operates only when the Review canvas (diff view) has focus; never hijacks the editor. Maintains `focusedHunk` (index into the flattened list of currently-visible hunks).

| Key | Action |
|-----|--------|
| `j` / `↓` | next hunk (scrolls into view) |
| `k` / `↑` | prev hunk |
| `]` / `[` | next / prev file |
| `Space` | expand/collapse focused hunk or file |
| `/` | focus the file filter (lives in left ChangesPanel via callback; G3 just emits the intent) |
| `a` | accept (stage) focused hunk → `ipc.stageHunk` |
| `x` | reject focused hunk → `ipc.revertHunk` + **undo toast** |
| `A` | accept whole file → `ipc.stageFile` (existing IPC; no G4 dependency) |
| `v` | mark focused file viewed (collapse + mark) |
| `o` | open focused file in editor at the hunk's first changed line → existing `navigateToFile(path,"editor")` |
| `w` | toggle Why? drawer for focused hunk |
| `c` | focus commit message (emit intent to parent → ChangesPanel) |
| `?` | toggle the keyboard cheatsheet overlay |

**Undo on reject:** `x` (and the Reject button) call `revertHunk`, then show a toast "Hunk rejected · Undo". Undo re-applies by staging-then-unstaging is NOT correct; instead capture the hunk `rawText` and re-apply via `ipc.stageHunk`-style forward patch (a new `ipc.applyHunk` that does `git apply` without `--cached` to restore the worktree change). **This requires one tiny additive backend command `apply_hunk` (worktree, forward)** — G3-owned (diff/worktree), additive in `commands.rs`. Mouse remains fully supported; keyboard is additive.

## 8. Reading modes (`DiffLines.tsx`)

- **Inline:** single column; del rows then add rows; line-number gutter shows old|new; word-diff inline.
- **Side-by-side:** two synced-scroll panes (old | new); paired replace-blocks align row-for-row; word-diff highlighted within each pane; context rows mirrored. Persisted via `reviewPrefsStore.readingMode`. Toggle lives in the toolbar.

## 9. Collapse & "viewed"

- Per-workspace, in-memory (session) state keyed by file path: `{ viewed: boolean, collapsedHunks: Set<idx> }`.
- `viewed` collapses the whole file section and checks it (G3 renders the check; the ChangesPanel checkbox integration is read-only from G3's side — it emits an `onViewedChange(path, viewed)` the parent can forward; **no ChangesPanel edit by G3**).
- Auto-reset: if a file's diff content hash changes between fetches, clear its `viewed`.
- Hunks/files larger than `COLLAPSE_THRESHOLD = 40` rows collapse by default with a "⋯ N lines hidden — Space to expand" fold.

## 10. Line/hunk anchoring primitive (for G5)

`DiffLines` supports a line-range selection (click+drag or shift-click on line numbers) producing `{ filePath, startLine, endLine }` held in `DiffView` state and exposed via an optional `onAnchor?(anchor)` / `anchorSlot?` render prop. G3 ships the selection + visual highlight only (no actions wired beyond the existing Why?). G5 later renders AI actions into `anchorSlot`. No AI code in G3.

## 11. Backend (additive, G3-owned)

- `get_diff_text(path, ignore_whitespace: bool)` — add `DiffOptions::ignore_whitespace(true)` when set; thread the param through the IPC (`ipc.getGitDiff(path, ignoreWhitespace?)`). Default false preserves current behavior.
- `apply_hunk(path, rawText)` — new command: `git apply -p1` (forward, worktree) for reject-undo. Mirrors existing `revert_hunk` (`commands.rs:1852`) with `--reverse` removed.
- Register both in `lib.rs` invoke handler (additive — the only merge seam).

## 12. Tier-0 correctness/polish (this surface — do first)

- **Bug:** replace undefined `text-octo-text` (`ReviewCanvas.tsx:330,352`) and `text-octo-textMuted` (`:362`) with `text-octo-ivory` / `text-octo-mute` (carried into the extracted `TestDrawer.tsx`).
- **Tokens:** hardcoded `rgba()` at `ReviewCanvas.tsx:297,307` → `var(--verdigris-ghost)` / `var(--rouge-ghost)` (add the verdigris token to `styles.css` if absent; `--rouge-ghost` exists).
- **Motion:** Why? drawer, inline⇄SBS + Diff⇄Editor toggle crossfade, test-drawer reveal → use `.octo-fade-in`/`.octo-rise-in`; replace `duration-200` (`:142`) with the 220ms token.
- **A11y:** diff rows/rail get `role`/`aria` + visible `focus-visible` rings; keyboard cheatsheet is reachable via `?`.

## 13. Scope boundaries (keep streams independent)

- **No** changes to `ChangesPanel.tsx`, staging *model*, amend, per-line staging → **G4**. G3 reuses existing staging IPC + emits intents (`/`, `c`, viewed) via callbacks the parent wires with one line.
- **No** AI features → **G5**; only the anchoring primitive.
- **No** changes to the editor engine (`EditorPane`/`EditorTabs`) → **G1**; G3 only calls existing `navigateToFile`.
- `App.tsx` Review block (~1398-1469): minimal additive wiring (pass `readingMode`, forward `onViewedChange`/`onFocusCommit`/`onFilter`).

## 14. Testing (Vitest)

- `lib/wordDiff.test.ts` — equal/replace/insert/delete, whitespace, token cap fallback.
- `lib/diffHighlight.test.ts` — tokenization maps to Atelier classes; plaintext fallback.
- `lib/diffParser.test.ts` — row pairing, old/new line numbers, deleted-line count fix, rename detection.
- `review/useDiffKeyboard.test.ts` — focus movement across files/hunks, action dispatch, no-op when editor focused.
- `review/HunkRail.test.tsx` — actions call correct IPC, staged-dim, focus styling.
- `review/DiffView.test.tsx` — inline vs SBS render, collapse/viewed, anchor selection.
- Reject-undo: toast + `apply_hunk` forward re-apply.
- CodeMirror mocked where needed; keep existing tests green.

## 15. Out of scope / cuts
- Human per-line comments/threads (replaced by §10 anchoring → G5).
- Staging model overhaul, amend, per-line staging (G4).
- All AI affordances (G5).

## 16. Risks
- **Single-line CodeMirror tokenization cost** — memoize per language; lazily highlight only visible rows (virtualize long files in a later pass if needed).
- **Side-by-side alignment** for unbalanced replace-blocks — pad the shorter side; verify with multi-line replace tests.
- **`apply_hunk` context drift** for undo — capture rawText at reject time; if re-apply fails, toast "couldn't undo automatically" rather than silent loss.
