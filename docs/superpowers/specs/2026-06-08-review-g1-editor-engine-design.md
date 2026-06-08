# G1 · Editor Engine — Slice I design

> Part of the REVIEW-mode overhaul (master tracker:
> `docs/superpowers/plans/2026-06-07-review-mode-master-grouping.md`, stream **G1**).
> Branch `feat/review-g1-editor` off `main`, worktree `octopus-sh-review`.
> Status: **spec'd** (slice 1 of 3).

## Goal

Make Octopush's in-app CodeMirror 6 editor one a developer won't want to leave.
Slice I delivers the daily-driver editing core plus the persistence and
architectural foundation the later slices build on: find / find-and-replace,
go-to-line, full multi-cursor, soft-wrap, persisted editor preferences, a
signature Atelier **editor status bar**, and **per-tab state preservation** so
switching files no longer throws away undo history, cursor, and scroll.

## Why slice (the 3-slice plan)

G1 is too large for one plan. It ships in three independently-mergeable slices:

- **Slice I — Daily-driver editing + prefs foundation (this spec).** Find/replace,
  go-to-line, multi-cursor, soft-wrap, `editorPrefsStore` (persisted), the editor
  status bar, per-tab state, Tier-0 fixes.
- **Slice II — Navigation & ergonomics (future).** Tab keyboard-nav, truncation
  tooltip, drag-to-reorder; editor command-palette / shortcut-hints overlay; the
  full "Editor" settings tab UI.
- **Slice III — Intelligence (future).** Language-aware autocomplete; minimap
  (third-party dep); AI ghost-text + explain-selection (reuses the shipped G5
  `ipc.aiComplete`). LSP deferred entirely.

## Current state (verified, for a fresh implementer)

- **`src/components/EditorPane.tsx`** hand-builds ~13 CodeMirror extensions (no
  `basicSetup`): `lineNumbers`, `foldGutter`, `highlightActiveLineGutter`,
  `highlightActiveLine`, `drawSelection`, `history`, `indentOnInput`,
  `bracketMatching`, a `keymap.of([...])` (`Mod-s` → `saveActive`, `indentWithTab`,
  `...defaultKeymap`, `...historyKeymap`), `langExtension(activeFile.lang)`,
  `atelierTheme`, `diffGutter(markers)`, and an `EditorView.updateListener` that
  pushes the doc string to the store on every keystroke. The `EditorView` is
  **destroyed and recreated** whenever the effect's deps `[activePath, workspaceId]`
  change (it is rebuilt on every file switch). A `viewRef` holds the live view but
  is not exposed to parents.
- **`src/components/EditorTabs.tsx`** reads tabs from `useEditorStore`
  (`getFiles`/`getActivePath`/`isDirty`), switches via `setActive`, closes via
  `closeFile`. **Line 36 has a hardcoded `"rgba(212, 165, 116, 0.04)"`** (active-tab
  background). Tabs have no `role`/tabindex/focus rings; only the close button has an
  `aria-label`.
- **`src/stores/editorStore.ts`** holds `filesByWs: Record<string, OpenFile[]>` and
  `activeByWs: Record<string, string|null>` where
  `OpenFile = { path, content, savedContent, lang }`. **No `persist` middleware; no
  prefs state.** `setContent` updates the working copy; `saveActive` writes to disk
  via `ipc.writeFile`; `isDirty` compares `content !== savedContent`.
- **`src/components/editor/atelierTheme.ts`** exports `atelierTheme: Extension`
  (an `EditorView.theme` + `syntaxHighlighting(HighlightStyle)`). Colors are
  **intentionally hardcoded hex** (CodeMirror's `theme()` API takes a JS object, not
  CSS vars). Includes `BRASS_FAINT = "rgba(212, 165, 116, 0.04)"`.
- **`src/lib/editorLang.ts`** maps file extension → `LangId` and the lang packages
  are imported in `EditorPane`. Installed: `@codemirror/{state,view,language,commands}`,
  the `lang-*` packages, and `codemirror`. **Not installed:** `@codemirror/search`,
  `@codemirror/autocomplete`.
- **Wiring:** `ReviewCanvas` renders `<EditorTabs>` + `<EditorPane>` as children when
  its `viewMode === "editor"` (`ReviewViewMode = "diff" | "editor"`, shipped by G3).
  `App.navigateToFile(path, "editor")` opens the file in the editor and switches to
  Review mode.
- **`cmdk`** is already a dependency and powers an app-wide command palette.
- **Settings** modal has 8 tabs; **no "Editor" tab** (that surface is Slice II).

## Architecture

### A. Persistent EditorView + per-tab state preservation

Replace the destroy-on-switch model with a **single long-lived `EditorView`** that
swaps documents:

- `EditorPane` keeps an in-memory **`useRef<Map<string, EditorState>>`** keyed by
  file path. This map is **ephemeral** (session-only; not persisted, evicted when a
  tab closes).
- On **first open** of a path (no cached state): build a fresh `EditorState` from the
  store's `OpenFile.content` and the path's language, then `view.setState(state)`.
- On **switch to an already-open tab**: before leaving the current tab, write the
  live `view.state` back into the map under the outgoing path; then
  `view.setState(cachedStateForIncomingPath)`. Cursor, scroll position, selection,
  and undo history are preserved per tab.
- The `EditorView` is created once (on mount) into the host element and destroyed
  once (on unmount). The effect that currently depends on `[activePath, workspaceId]`
  is split: **mount/unmount** owns view lifecycle; a **separate effect on
  `activePath`** performs the `setState` swap.
- The keystroke `updateListener → setContent(workspaceId, path, doc)` sync is
  retained, so `editorStore` stays the source of truth for dirty-state and saving.
  Closing a tab evicts its cached `EditorState`. (External/disk changes and stale
  reload are out of scope — that's G2.)

### B. Compartments for live preference reconfiguration

Wrap, line-numbers, tab width, and font size are placed in CodeMirror
**`Compartment`** instances so a preference change reconfigures the view **in place**
(no rebuild):

- `wrapCompartment` → `EditorView.lineWrapping` or `[]`.
- `lineNumbersCompartment` → `lineNumbers()`+`foldGutter()`+gutter highlighters or `[]`.
- `tabSizeCompartment` → `EditorState.tabSize.of(n)` + `indentUnit.of(" ".repeat(n))`.
- `fontCompartment` → `EditorView.theme({ "&": { fontSize: \`${n}px\` }, ".cm-content": { fontSize: \`${n}px\` } })`.

A `useEffect` in `EditorPane` watches the `editorPrefsStore` values and dispatches
`view.dispatch({ effects: compartment.reconfigure(next) })` when any change. Because
compartments are part of the shared base config, they apply across `setState` swaps
(the base extensions are recreated per `EditorState`; the compartment instances are
module/ref-stable and re-seeded from current prefs when building each state).

### C. New extensions for the editing features

- **`@codemirror/search`** (new dep): add `search({ top: true })` + `...searchKeymap`
  to the keymap. This provides find / find-and-replace (`Mod-f`), `findNext`/`findPrevious`,
  the **go-to-line** dialog (`gotoLine`, `Mod-Alt-g`), and **`selectNextOccurrence`**
  (`Mod-d`) for multi-cursor.
- **Column/rectangular multi-cursor:** add `rectangularSelection()` + `crosshairCursor()`
  from `@codemirror/view` (already installed) — `Alt`-drag adds a column of cursors.
- **Select-all-occurrences:** a small **custom command** `selectAllOccurrences(view)`
  — take the main selection's text (if empty, the word under the caret), find every
  occurrence in the document, and set one `SelectionRange` per match (main = the
  original). Bind to `Mod-Shift-l`. Concrete, no panel dependency.

### D. editorPrefsStore (new)

```ts
// src/stores/editorPrefsStore.ts
import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface EditorPrefs {
  wrap: boolean;        // default false
  fontSize: number;     // px, default 13, clamped [10, 22]
  tabWidth: number;     // default 2, one of 2|4|8
  lineNumbers: boolean; // default true
}

interface EditorPrefsStore extends EditorPrefs {
  setWrap: (v: boolean) => void;
  toggleWrap: () => void;
  setFontSize: (px: number) => void;     // clamps
  bumpFontSize: (delta: number) => void; // +1 / -1, clamps
  setTabWidth: (n: number) => void;
  setLineNumbers: (v: boolean) => void;
  toggleLineNumbers: () => void;
}
```

- Global (editor-wide), not per-workspace.
- `persist` with `name: "octo-editor-prefs"`; persist the whole prefs object
  (no `partialize` needed beyond excluding the action functions, which zustand
  handles by storing only data fields — explicitly `partialize` to
  `{ wrap, fontSize, tabWidth, lineNumbers }`).
- `fontSize` clamps to `[10, 22]`; `tabWidth` constrained to `2 | 4 | 8`.

### E. EditorStatusBar (new) — the signature surface

`src/components/EditorStatusBar.tsx` — a thin bottom rail rendered by `EditorPane`
below the editor host. Props: `{ line: number; col: number; selectionCount: number;
lang: string }`. Reads/writes prefs from `editorPrefsStore`.

Segments, left → right:

- **Language** (brass dot + lowercased `lang`).
- **`Ln {line}, Col {col}`** — live caret position (1-based).
- **`{n} selections`** — shown only when `selectionCount > 1`; text in brass.
- *(right group, each a clickable button with focus ring + keyboard handler)*
  **`Spaces: {tabWidth}`** (a button that cycles 2→4→8→2), **`Wrap {on|off}`**
  (toggle), **`Ln# {on|off}`** (toggle), and a **font stepper** rendered as
  `−  Aa {fontSize}  ＋` where the `−`/`＋` buttons call `bumpFontSize(-1)`/`(+1)`.
  Active = brass, inactive = mute.

All copy is English. Tokens only. No italics. The bar uses JetBrains Mono meta
styling consistent with other Atelier meta rails.

### F. Keybindings & command palette

- Keymap (added to the existing `keymap.of`): `...searchKeymap`, plus
  `Alt-z` → toggle wrap, `Mod-=`/`Mod--` → font bump ±1, `Mod-Shift-l` → select all
  occurrences. (`Mod-d`, `Mod-f`, `Mod-Alt-g` come from `searchKeymap`.)
- Add entries to the existing `cmdk` app palette for: Toggle soft wrap, Toggle line
  numbers, Increase/Decrease font size, Cycle indent width, Find, Find & replace,
  Go to line. Each dispatches the same store action or editor command.

### G. Theme additions

- Extend `atelierTheme.ts` to Atelier-style the **search/go-to-line panel** via the
  CodeMirror panel selectors (`.cm-panels`, `.cm-panel.cm-search`, the inputs,
  buttons, match-count, and the case/regex/whole-word toggle buttons): onyx/panel
  backgrounds, hairline borders, brass active states, ivory text. The default
  `search` panel is used (not a custom `createPanel`) and themed — robust and fully
  Atelier without fragile custom DOM.
- The `fontCompartment` supplies font-size theming live (do **not** bake font-size
  into the static `atelierTheme`).

### H. Tier-0 (this surface)

- `EditorTabs.tsx:36`: replace `"rgba(212, 165, 116, 0.04)"` with
  `var(--brass-faint)`. Add the `--brass-faint` token to `src/styles.css`
  `@theme` block if it does not already exist (value `rgba(212, 165, 116, 0.04)`;
  append-only).
- `EditorTabs`: add `role="tablist"` to the container, `role="tab"` +
  `aria-selected` to each tab, and `focus-visible` rings. **Arrow-key roving nav,
  truncation tooltip, and drag-reorder are explicitly deferred to Slice II.**
- Focus rings on all `EditorStatusBar` interactive segments and any new editor
  controls.

## Data flow

- **Cursor / selection → status bar:** the `updateListener` in `EditorPane` reads
  `update.state.selection` on `selectionSet`/`docChanged`, computes `{ line, col }`
  from `state.doc.lineAt(head)` and `selectionCount = ranges.length`, and lifts them
  into `EditorPane` local React state. These are passed as primitive props to
  `EditorStatusBar`, so only the small bar re-renders on caret movement.
- **Prefs → editor:** `editorPrefsStore` values are read in `EditorPane`; a
  `useEffect` reconfigures the matching compartment on change. `EditorStatusBar`,
  keyboard shortcuts, and palette entries all write the same store — one source of
  truth.

## Persistence

- `editorPrefsStore` → localStorage (`octo-editor-prefs`), global prefs, survives
  restart.
- Per-tab `EditorState` map → in-memory only (session); not persisted; evicted on
  tab close.

## Error handling

- Font size and tab width are clamped/constrained in the store; the status bar can
  never set an out-of-range value.
- Compartment reconfiguration is a pure view dispatch; if the view is not yet mounted
  the effect no-ops (guard on `viewRef.current`).
- Opening/saving errors continue to flow through the existing `editorStore` + toast
  path (unchanged).

## Testing

- **`editorPrefsStore.test.ts`** — defaults; `toggleWrap`/`toggleLineNumbers`;
  `bumpFontSize` clamps at 10 and 22; `setTabWidth` constrains; `partialize`
  persists only the four data fields.
- **`EditorStatusBar.test.tsx`** — renders `Ln/Col`; `{n} selections` appears only
  when `selectionCount > 1`; clicking Wrap/Ln#/Spaces/font calls the corresponding
  store action; interactive segments are focusable (have focus-visible classes).
- **`EditorPane.test.tsx`** (extend) — wrap compartment reconfigure flips
  `EditorView` line wrapping; switching `activePath` and back preserves selection
  (per-tab state); `searchKeymap` / `selectNextOccurrence` present; multi-cursor
  command increases selection range count. jsdom state-level assertions (no pixel
  layout).
- **`EditorTabs.test.tsx`** (extend) — container has `role="tablist"`, active tab has
  `aria-selected="true"`, tabs have focus-visible classes, and **no `rgba(` literal**
  remains in the file.

## Scope guardrails (YAGNI / out of scope for Slice I)

Excluded: the "Editor" settings tab UI; tab keyboard-nav / truncation tooltip /
drag-reorder; autocomplete; minimap; AI ghost-text / explain-selection; LSP;
external-change / stale-disk detection (G2); per-workspace prefs; persisting per-tab
state across restarts.

## Design-system compliance

Tokens only (no new hardcoded hex/rgba outside `atelierTheme.ts`'s documented
exception — and even there, the Tier-0 fix removes one rgba from `EditorTabs`).
English-only UI copy. No italics. Calm motion / focus rings consistent with the
Atelier primitives. The status bar reuses existing meta-rail styling; no new
top-level chrome and no change to the Atelier surface contract.
