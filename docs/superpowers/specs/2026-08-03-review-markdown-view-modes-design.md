# REVIEW · Markdown view modes, jump-to-source, selectable prose

**Date:** 2026-08-03 · **Status:** implemented · **Surface:** REVIEW → Editor view → `.md` tabs

## The problem

Reading a spec inside Octopush had three specific frictions, each with a different cause.

| Friction | Cause |
|---|---|
| The rendered preview is either off or a split — never the document alone | `reviewPrefsStore.mdPreview` was a **boolean**; the state model admitted only two layouts |
| Clicking a rendered section can't take you to that markdown | The data existed (`node.position.start.line` per block) and so did a reveal path (`pendingRevealByWs` + `EditorPane`'s reveal effect, used by the file tree and ⌘⇧F) — nothing connected them |
| Rendered text can't be selected or copied | `body { user-select: none }`; chat, editor and terminal opt back in, the preview never did |

## Design

### 1 · Three view modes

`mdPreview: boolean` becomes `mdView: "source" | "split" | "reading"`.

- **Toolbar:** an icon-only segmented control (`Code` / `Columns2` / `BookOpen`) beside the existing Diff/Editor pair, rendered only in Editor view for a markdown tab. Icon-only with `title` tooltips matches the reading-mode and whitespace controls it sits next to, and keeps the row from wrapping.
- **Keyboard:** `⌥⌘M` cycles source → split → reading. Bound in `ReviewCanvas` rather than `App` because that is the only surface it applies to, and keyed on the physical `KeyM` because macOS turns ⌥M into "µ". `ModeOverlay` keeps its children mounted, so the canvas takes an `active` prop — without it the binding would keep firing from TALK, RUN and DIRECT. It also stands down on `defaultPrevented`/`repeat`, the house rule for anything CodeMirror can reach first.
- **The editor never unmounts.** A hidden column collapses to zero width. CodeMirror's undo history, folds, scroll position and per-tab `EditorState` all survive every switch — an unmount would throw them away.
- **Migration:** a `version: 1` bump plus a `migrate` hook maps a legacy `mdPreview` boolean (`false` → source, `true` → split) and drops the key. It has to live in `migrate` rather than `merge`: zustand writes the store back to storage **only** after a real version migration, so a `merge`-only mapping is correct in memory while the dead key lingers on disk. `merge` keeps the defensive job — re-clamping a bad `mdPreviewSplit`, falling back on an unknown `mdView`.
- A non-markdown tab renders editor-only regardless of the pref.

### 2 · Jump to source

- `markdownComponents` stamps `data-md-line` (1-based, from the node's parser position) on every block renderer. The attribute is inert for any other consumer of the map.
- **Resolution is innermost-wins** via `closest("[data-md-line]")`: a list item beats its list, a table row beats its table.
- Two affordances, deliberately chosen against the alternatives:
  - **Margin marker** (discoverable) — hovering a block reveals a brass line-number button in the left gutter; clicking it jumps.
  - **⌘/Ctrl-click** (the editor idiom) — same action, anywhere in the block, including over a link, since a plain click already opens the link.
  - **Rejected: double-click** (it is how you select a word — it would spend the gesture most needed for copying) and **single click** (it fires on every click while reading and makes links unreachable).
- The marker is positioned with `getBoundingClientRect()` against the document wrapper, not `offsetTop` — a `<tr>`'s `offsetParent` is its `<table>`. It holds position while the pointer crosses the gutter (which belongs to the pane, not to a block; dismissing there would make an inert marker impossible to click) and hides when the buffer reflows underneath it.
- The jump reuses the existing one-shot reveal: `editorStore.revealLine` writes `pendingRevealByWs`; `EditorPane` places the caret, centre-scrolls and consumes it. `revealLine` is a no-op for a path that isn't open, and hands a **fresh object** every call so repeating the same jump re-fires the effect.
- **From reading**, the jump opens split first and defers the reveal by the width transition (280 ms, skipped under reduced motion). Revealing mid-animation would measure CodeMirror against a zero-width viewport. The timer is cancelled by a newer jump and on unmount, and **re-checks at fire time**: `EditorPane` refuses a reveal aimed at a non-active path *without consuming it*, so a jump that lands after a tab switch would sit in the store and ambush the user when they next open that tab.

### 3 · Selectable prose

The preview opts into selection with `.octo-selectable` — the general selectable-island class, renamed from `.chat-selectable` (it was already carrying the editor, the scratchpad and the Direct journal, none of which are chat). Selecting rendered text copies prose without its markdown; the source column still copies raw markdown.

## Deliberately out of scope

**Scroll-linking** (the document dragging the editor along) and **caret-follows** (marking the block the caret sits in) both fall out cheaply once the line map exists, and both were prototyped. Neither ships: scroll-linking reads as possessive when you only wanted to skim one pane, and the marker already answers "where is this in the source?" without a persistent coupling. Revisit only if the jump proves not to be enough.

## Files

`stores/reviewPrefsStore.ts` · `stores/editorStore.ts` (`revealLine`) · `lib/markdownComponents.tsx` (`lineAttr`) · `components/editor/MarkdownPreview.tsx` · `components/editor/EditorWithPreview.tsx` · `components/ReviewCanvas.tsx` · `styles.css` (`.octo-selectable`) · `docs/FEATURES.md` · `docs/design-system.md` (margin marker + selectable islands recipes).
