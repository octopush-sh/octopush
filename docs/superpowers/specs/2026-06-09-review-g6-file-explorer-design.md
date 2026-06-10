# G6 · File Explorer — Slice I design ("Reach everything")

> Part of the REVIEW-mode overhaul (master tracker:
> `docs/superpowers/plans/2026-06-07-review-mode-master-grouping.md`, stream **G6**,
> priority rank 7 — the LAST slice-1 stream; G3/G5/G1/G2/G4/G7 all merged). Branch
> `feat/review-g6-explorer` off `main`, worktree `octopus-sh-review`. Status: **spec'd**
> (slice 1 of 3).

## Goal

Make every file in a workspace **reachable** from the Companion file tree — including
generated/gitignored files (e.g. a built `target/*.war`) — and **actionable** via a
context menu (Reveal in Finder, Open in system app, Open in terminal, Copy path).
Plus the low-risk quality wins: file-type icons, Tier-0 token compliance, and tree
a11y semantics.

This resolves a reported user pain: gitignored build artifacts are invisible in the
tree today (`read_directory` respects `.gitignore`), and there is no way to reveal or
open a file with the system from the tree.

## Why slice (the 3-slice plan)

- **Slice I — Reach everything (this spec).** Show-ignored toggle, context menu
  (read-only actions via existing IPC), file-type icons, Tier-0 (rgba→token,
  `role="tree"/"treeitem"`, focus rings).
- **Slice II — File operations.** Rename / new file / new folder / delete — new Rust
  commands + confirm flows.
- **Slice III — Scale & navigate.** Keyboard arrow-nav (roving tabindex), filter/search,
  virtualization for large trees.

## Current state (verified, for a fresh implementer)

- **`src/components/CompanionFileTree.tsx`** (280 lines): props
  `{ rootPath, rootLabel, changedPaths, onFileClick? }`. Lazy per-folder loading via
  `ipc.readDirectory(path)` cached in `children: Record<string, DirectoryEntry[] |
  "loading" | "error">`; recursive `<TreeNode>`; files show `◦` (or brass `●` when
  changed); folders show a rotating `▶` chevron + a `§` glyph. **Hardcoded rgba at
  line 174** (`rgba(212, 165, 116, 0.4)` — § glyph) **and line 271**
  (`rgba(212, 165, 116, 0.5)` — current-level indent guide). No `role` attributes, no
  keyboard focus, no icons, no context menu.
- **`src-tauri/src/commands.rs:1916-1985`**: `read_directory(path)` uses
  `ignore::WalkBuilder` with `max_depth(Some(1))`, `standard_filters(true)`,
  `require_git(false)`, `hidden(false)` — so `.gitignore` rules apply and gitignored
  entries never reach the frontend. `.git` is always excluded by name. Returns
  `Vec<DirectoryEntry { name, path, is_dir }>` (serde camelCase), dirs-then-files,
  each group alphabetical case-insensitive.
- **Existing IPC to reuse (do NOT recreate)**: `ipc.revealInFinder(path)` (`open -R`),
  `ipc.openFileInSystem(path)` (`open`/`xdg-open`), `ipc.openInTerminal(path)` — all
  already used by ProjectContextMenu/WorkspaceContextMenu.
- **Menu pattern**: `src/lib/useMenuChrome.ts` (viewport clamping via
  `window.innerWidth/Height`, first-item focus, ↑/↓ nav, Escape + outside-click
  dismiss) + the `ProjectContextMenu.tsx` template (`ITEM`/`DANGER`/`SEP` class
  strings, `role="menu"`/`menuitem`, `octo-menu-enter`, eyebrow header).
  **Gotcha (memory: overflow-clipped popovers, PR #8):** the tree scrolls inside an
  `overflow-y-auto` container — an inline `absolute` menu gets clipped. The tree's
  menu must render via `createPortal(document.body)` with `position: fixed`;
  `useMenuChrome`'s clamping math is viewport-based so it composes with `fixed` as-is.
- **`src/stores/reviewPrefsStore.ts`**: small persisted Zustand store
  (`octo-review-prefs`) holding REVIEW prefs (`readingMode`, `ignoreWhitespace`) —
  the natural home for the show-ignored pref.
- **Reusable**: `pushToast`, lucide-react icons, `--brass-ghost` hover pattern.

## Architecture

### A. Backend — `read_directory` gains `show_ignored`

```rust
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_ignored: bool, // NEW — true only in show_ignored mode for gitignored/hidden entries
}

#[tauri::command]
pub async fn read_directory(path: String, show_ignored: Option<bool>) -> AppResult<Vec<DirectoryEntry>>
```

- `show_ignored` is `Option<bool>`; `None`/`Some(false)` ⇒ **exactly today's behavior**
  (single filtered walk, every entry `is_ignored: false`). Existing call sites are
  unaffected (Tauri treats the missing arg as `None`).
- `Some(true)` ⇒ two walks of the same single directory (both `max_depth(1)`):
  1. The **filtered** walk (today's builder) → collect entry paths into a
     `HashSet<PathBuf>`.
  2. The **full** walk: same builder but `.git_ignore(false).git_global(false)
     .git_exclude(false).ignore(false).parents(false)` — gitignore filtering off.
  Entries from the full walk become the result; `is_ignored = !filtered_set.contains(path)`.
- `.git` stays always-excluded by name in both modes. Sort order unchanged
  (dirs-then-files, alphabetical case-insensitive), ignored entries interleaved
  normally — the *dimming* distinguishes them, not segregation.
- Cost: two `max_depth(1)` walks of one directory — microseconds even for big dirs;
  the tree stays lazy so `node_modules/` children are only walked when expanded.

### B. State — per-workspace pref in `reviewPrefsStore`

```ts
showIgnoredFiles: Record<string, boolean>;          // key: workspace rootPath
toggleShowIgnored: (rootPath: string) => void;
```

Persisted with the existing `octo-review-prefs` store. Default (absent key) = `false`.

### C. Tree — toggle, dimming, icons

- **Toggle**: the "Files" eyebrow row becomes `flex justify-between`; right side gets
  an icon button — lucide `Eye` (active, `text-octo-brass`) / `EyeOff` (inactive,
  `text-octo-mute`), 12px, `aria-label="Show ignored files"`, `title` tooltip, focus
  ring. Clicking calls `toggleShowIgnored(rootPath)`; the component **clears its
  `children` cache and re-fetches** open folders with the new flag (simplest correct
  cache invalidation: reset `children` to `{}` and re-run `fetchChildren` for
  `rootPath`; expanded dirs reload lazily as they re-render).
- `fetchChildren` passes the flag: `ipc.readDirectory(path, showIgnored)`.
- **Dimming**: `depthColorClass` gains an `isIgnored` branch that wins over depth:
  ignored labels are `text-octo-mute`; their icon also renders mute. Ignored files
  are fully clickable/right-clickable (that is the point).
- **File-type icons**: new pure module `src/lib/fileIcons.ts` exporting
  `fileIcon(name: string): LucideIcon` — extension → icon map (code, json/yaml/toml,
  markdown/text, image, archive (`.war`/`.jar`/`.zip`/`.tar.gz`…), shell, lockfile/
  config, generic `File` fallback). File rows replace the `◦` dot with the 12px icon
  in `--color-octo-mute`; the brass `●` **changed** indicator stays exactly as today
  (changed wins over icon). Folders keep chevron + `§` (no folder icons).

### D. Context menu — `src/components/FileTreeContextMenu.tsx`

New component cloned from the `ProjectContextMenu` template (`useMenuChrome`,
`ITEM`/`SEP` classes, `role="menu"`/`menuitem`, `octo-menu-enter`, eyebrow = file/dir
name) but rendered with **`createPortal(document.body)` + `position: fixed`**.

Items (exact set, English copy):

| Target | Items |
|---|---|
| File | Reveal in Finder · Open in system app · ── · Copy path · Copy relative path |
| Folder | Reveal in Finder · Open in terminal · ── · Copy path · Copy relative path |

- Reveal → `ipc.revealInFinder(path)`; Open in system app → `ipc.openFileInSystem(path)`;
  Open in terminal → `ipc.openInTerminal(path)`.
- Copy path → `navigator.clipboard.writeText(absPath)` + `pushToast` ("Path copied").
  Copy relative path → path relative to `rootPath` (strip prefix + leading `/`).
- Wiring: `onContextMenu` on every row (`e.preventDefault()`), state in
  `CompanionFileTree`: `{ x, y, path, name, isDir } | null`. Left-click behavior is
  unchanged (files open in the editor via `onFileClick`; no "Open in editor" item).
- No mutating items (rename/new/delete) — Slice II.

### E. Tier-0 / a11y

- **Tokens**: `--brass-dim: rgba(212, 165, 116, 0.4)` **already exists**
  (`styles.css:45`) — no new token. Line 174 § glyph (`rgba(…, 0.4)`) →
  `var(--brass-dim)` (exact match). Line 271 indent guide (`rgba(…, 0.5)`) →
  `var(--brass-dim)` too (0.5→0.4 is imperceptible on a 1px hairline and the tracker
  explicitly calls for consolidating both onto `--brass-dim`). Zero `#hex`/`rgba(`
  literals in the diff.
- **Roles**: scroll container → `role="tree"` (`aria-label="Workspace files"`); each
  row → `role="treeitem"`, dirs get `aria-expanded={isExpanded}`; nested children
  lists → `role="group"`.
- **Focus**: rows get `tabIndex={0}` (Slice III will refine to roving tabindex),
  a visible `focus-visible` brass ring, and Enter/Space triggering the row's click
  action. The toggle button and menu items are keyboard-reachable (menu already is,
  via `useMenuChrome`).

## Data flow

```
toggle ──► reviewPrefs.showIgnoredFiles[rootPath] ──► clear children cache
                                                      └► ipc.readDirectory(path, show)
read_directory(path, true) ──► filtered walk → HashSet
                            └► full walk → entries, is_ignored = !set.contains(path)
right-click row ──► menu state {x,y,path,name,isDir} ──► portal(fixed) menu
   ├ Reveal in Finder    → ipc.revealInFinder
   ├ Open in system app  → ipc.openFileInSystem      (files)
   ├ Open in terminal    → ipc.openInTerminal        (folders)
   └ Copy (relative) path → clipboard + pushToast
```

## Error handling

`read_directory` error paths unchanged (nonexistent path / not a dir → `AppError`,
row renders the existing "error reading directory." state). Clipboard write failures
→ error toast. Reveal/open IPC failures → existing `ipc` error propagation + toast.
No new failure modes: the menu only calls fire-and-forget system opens.

## Testing

- **Rust** (`tests.rs`, tempfile + std fs — no git needed since `require_git(false)`):
  1. default mode: `.gitignore` with `target/` → `target` absent, others
     `is_ignored == false`;
  2. `show_ignored = true`: `target` present with `is_ignored == true`, non-ignored
     entries `false`, sort order still dirs-then-files alphabetical;
  3. `.git` excluded in **both** modes.
- **Frontend** (vitest, ipc mocked):
  - toggle: click → `readDirectory` re-called with `true`; ignored entries render
    dimmed (`text-octo-mute`) and remain clickable;
  - context menu: right-click a file row → menu with the 4 file items; a folder row →
    folder items (Open in terminal, no Open in system app); item click calls the right
    ipc fn and dismisses; Copy path writes to a mocked clipboard + toasts;
  - `fileIcon`: extension mapping unit tests (`.war` → archive, `.ts` → code,
    unknown → generic);
  - a11y: `role="tree"` present; dir rows have `aria-expanded`; Enter on a file row
    fires `onFileClick`.
- `npm run typecheck` + full `npm test` + `cargo test` before PR.

## Scope guardrails (YAGNI / out of scope for Slice I)

File operations (rename/new/delete — Slice II); keyboard arrow-nav / roving tabindex,
filter/search, virtualization (Slice III); folder icons; "Open in editor" menu item
(left-click already does it); showing `.git/`; gitignore *editing*; per-folder
show-ignored overrides; watching the filesystem for changes.

## Design-system compliance

Tokens only (the two legacy rgbas are *removed*, not added to). English-only copy.
No italics. Menu motion = existing `octo-menu-enter`; no new animation. Brass stays
surgical: the toggle is brass only when active; icons are mute; the changed-file `●`
remains the only brass mark in rows. No new top-level chrome — everything lives in
the existing Companion tree panel.
