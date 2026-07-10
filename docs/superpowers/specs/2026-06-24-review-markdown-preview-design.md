# REVIEW · Rendered Markdown preview (Editor split)

**Date:** 2026-06-24
**Status:** Approved design — ready for implementation plan
**Mode:** Review
**Surface:** Editor view (`ReviewCanvas` + `EditorPane`)

---

## 1. Goal

When reviewing a Markdown file in REVIEW mode, let the user see the document
**rendered** — headings, lists, tables, code, blockquotes — side by side with the
source, via a one-button toggle. Today a `.md` file shows only its raw markup in
both the Diff and Editor views; the formatted document is never visible.

This is the familiar IDE "preview to the side": source ‖ rendered, a single
icon toggle, a draggable divider. It reuses the Markdown infrastructure already
in the repo (`react-markdown` v10) — no rendering engine is invented.

Non-goals for this release are listed in §11.

## 2. Approved decisions (from brainstorming + visual companion)

| Decision | Choice |
|---|---|
| Placement | **Beside the Editor** (option A). Source ‖ rendered, single-file. |
| Toggle | Icon-only **lucide `Eye`** + `title` tooltip. Brass-ghost pill when open, quiet outline when hidden. |
| Content rendered | The **live editor buffer** (`activeFile.content`) — updates as you type. |
| GFM | **Add `remark-gfm`** — tables, task lists, strikethrough, autolinks. |
| Default state | **Preview open** when a Markdown file is the active editor tab. |
| Divider | **Draggable** in v1, with persisted ratio + double-click reset. |
| Change-aware ticks | Out (that was option B's optional touch). |

The two approved mockups live under `.superpowers/brainstorm/` (`md-preview-surface.html`,
`md-preview-icon.html`).

## 3. UX behavior

- **Visibility of the toggle.** The `Eye` button appears in the `ReviewCanvas`
  toolbar **only** when `viewMode === "editor"` **and** the active editor tab is a
  Markdown file. It is hidden in Diff view, for non-Markdown tabs, for binary
  files, and when no file is open. (No control shown that doesn't apply — design
  system minimalism.)
- **Toggling.** Clicking `Eye` flips a persisted `mdPreview` boolean. On → the
  editor area splits and the rendered pane grows in. Off → the editor returns to
  full width.
- **Default.** `mdPreview` defaults to `true`, so opening a `.md` tab shows the
  rendered pane immediately. The user's choice persists across sessions
  (localStorage, like the other review prefs).
- **Live preview.** The rendered pane reflects the editor buffer, including
  unsaved edits — identical to an IDE live preview. (In REVIEW the working tree
  is what the editor opened; in-editor edits are part of the review flow.)
- **Divider.** A 1px hairline divider between source and preview, `cursor-col-resize`,
  brass on hover. Drag to resize (clamped 25–75% for the source column).
  Double-click resets to 50/50. The ratio persists.
- **Scroll.** Source and preview scroll independently in v1 (no scroll-sync — see §11).

## 4. Architecture

The editor children passed to `ReviewCanvas` change from
`<EditorTabs/> + <EditorPane/>` to `<EditorTabs/> + <EditorWithPreview/>`. The tab
strip stays full-width on top; only the pane area below splits.

```
ReviewCanvas (toolbar: Diff|Editor toggle + Eye toggle)
└─ children (editor mode)
   ├─ EditorTabs                 (unchanged, full width)
   └─ EditorWithPreview          (new — horizontal split)
      ├─ EditorPane              (unchanged; ALWAYS mounted)
      ├─ <divider>               (draggable)
      └─ MarkdownPreview         (new; mounted but width-collapsed when hidden)
         └─ ReactMarkdown + markdownComponents + remark-gfm
```

### New / changed units

- **`src/lib/markdownComponents.tsx`** (new) — a **document-grade** `Components`
  map for `react-markdown`, styled with Onyx & Brass tokens. Deliberately
  *separate* from ChatMessage's `makeMarkdownComponents`, which is chat-tuned in
  two ways wrong for a document surface: it renders `h3` as a mono brass *eyebrow*
  and `hr` as the **brass gradient rule retired for new surfaces** (CLAUDE.md).
  This map provides a real serif `h1–h6` scale, a plain hairline `hr`, and full
  table / list / code / blockquote / task-list styling. Pure, token-driven,
  independently testable. ChatMessage is left untouched.
  - *Interface:* `markdownComponents(opts?: { onOpenInEditor?: (path: string) => void }): Components`.
    `onOpenInEditor` is optional and unused in v1 (reserved for relative-link →
    editor wiring later); links open externally as ChatMessage does.

- **`src/components/editor/MarkdownPreview.tsx`** (new) — the scrollable pane.
  - *Props:* `{ source: string }`.
  - Renders `<ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents()}>`.
  - The rendered tree is memoized on `source` (`useMemo`) so unrelated re-renders
    don't re-parse. Independent vertical scroll; padded content column matching
    the editor's reading rhythm.
  - **No `rehype-raw`** — embedded HTML in the doc is not executed (see §8).

- **`src/components/editor/EditorWithPreview.tsx`** (new) — the split wrapper.
  - *Props:* same as `EditorPane` (`workspaceId`, `workspacePath`, `diffText`),
    forwarded verbatim.
  - Reads the active file from `useEditorStore` and `mdPreview` + `mdPreviewSplit`
    from `useReviewPrefs`.
  - Renders `EditorPane` (left, always mounted) and `MarkdownPreview` (right).
    When the active file is **not** Markdown, or `mdPreview` is off, the preview
    column collapses to `0` width and is `visibility:hidden` — **but stays
    mounted** (CanvasSplit's lesson: never remount, here to protect EditorPane's
    CodeMirror state and avoid input glitches; the preview is stateless but
    collapsing-not-unmounting keeps the motion clean).
  - Owns the draggable divider (see §6). When the preview is collapsed, the
    divider is not interactive.

- **`src/components/ReviewCanvas.tsx`** (changed) — add the `Eye` toggle to the
  toolbar, gated on `viewMode === "editor"` && active-file-is-markdown. Reads the
  active file via `useEditorStore` (new selector) and `mdPreview` + `toggleMdPreview`
  via `useReviewPrefs`. Styling mirrors the existing toolbar toggles (brass-ghost
  active pill, `focus-visible:ring-octo-brass`).

- **`src/stores/reviewPrefsStore.ts`** (changed) — add persisted state:
  - `mdPreview: boolean` (default `true`)
  - `mdPreviewSplit: number` (source-column percent, default `50`, clamped 25–75)
  - `toggleMdPreview(): void`, `setMdPreviewSplit(pct: number): void`
  - Back-compatible: zustand's default shallow merge keeps the initializer values
    when an older persisted blob lacks the keys.

- **`src/App.tsx`** (changed) — swap the ReviewCanvas editor child from
  `<EditorPane/>` to `<EditorWithPreview/>` (same props). One-line composition change.

- **`package.json`** (changed) — add `remark-gfm` (^4).

### Markdown detection

A file is Markdown when `activeFile.kind === "text" && activeFile.lang === "markdown"`
(the editor store already classifies language via `lib/editorLang`). Fallback
extension check (`.md`, `.markdown`, `.mdx`) guards the rare untyped case. A small
helper `isMarkdownFile(file)` centralizes this so the toggle's visibility and the
preview's render gate agree.

## 5. Rendering details

- `react-markdown` (already a dep) + `remark-gfm` (new). CommonMark + GFM only.
- The component map covers: `h1–h6` (serif scale, ivory), `p` (sans, sage),
  `strong` (ivory), `em` (upright per global `em{font-style:normal}`), `a`
  (brass underline, external), `ul/ol/li` (brass/mute markers), GFM task-list
  checkboxes (read-only), `blockquote` (brass-dim left border), `hr` (plain
  hairline — **not** the retired brass gradient), inline `code` (brass on
  brass-ghost), fenced `code`/`pre` (mono on onyx, horizontal scroll; no syntax
  highlighting in v1), and `table/thead/th/td` (hairline grid, mono brass headers).
- Images: remote `src` render; relative `src` won't resolve in v1 (no asset base) —
  acceptable limitation, noted in §11.

## 6. Resizable divider

Modeled on `CanvasSplit` (reference) and the Companion resize in `App.tsx`
(persistence + double-click reset), implemented locally in `EditorWithPreview`
(no generic splitter exists to reuse; keep it focused):

- Source column width = `mdPreviewSplit%`; preview = `100 - split%`.
- `onMouseDown` on the divider attaches `mousemove`/`mouseup` to `document`;
  `mousemove` computes the ratio from the container rect, clamped 25–75; commit to
  `setMdPreviewSplit` on move (persisted via the store's `persist`).
- **Width transition is disabled while dragging** (a transition during drag lags
  the cursor); it is enabled only for the open/close toggle so the pane *grows*
  in/out with the canonical motion (§9).
- Double-click the divider → reset to 50.
- `aria-label="Resize preview"`, `role="separator"`, `aria-orientation="vertical"`.

## 7. Motion & design-system compliance

- Pane reveal/hide *grows* via a `grid-template-columns`/width transition with the
  **canonical** token `280ms cubic-bezier(0.2,0.8,0.3,1)`; content uses
  `.octo-fade-in`. Honors `prefers-reduced-motion` (no transition when reduced).
- Tokens only — no hex, no font literals (renderer styles use `text-octo-*`,
  `var(--brass-ghost)`, etc.).
- Icon + `title` tooltip, never a bare icon. English-only copy.
- Reuses the existing toolbar-toggle visual language; introduces no new chrome,
  no new colors, no retired decoration.

## 8. Security

The Markdown being previewed is **untrusted content** (it's the diff under
review, possibly authored by an agent or a third party). We therefore:

- **Do not** add `rehype-raw` or otherwise enable raw HTML — embedded
  `<script>`/HTML is rendered inert as text, never executed.
- Keep links `target="_blank" rel="noopener"` (as ChatMessage does).
- Do not auto-fetch arbitrary local files; relative images simply don't resolve.

## 9. Edge cases

- **Switching tabs.** `.md` (preview open) → `.ts`: preview collapses, `Eye`
  hides, EditorPane keeps its state (not remounted). Back to `.md`: preview
  reopens (pref persisted), divider ratio restored.
- **No active file / binary file:** no `Eye`, no preview.
- **Empty Markdown buffer:** preview renders empty (no error).
- **Very large doc / fast typing:** memoized render keyed on `source`; if
  profiling shows jank, a short debounce can be added (not in v1).
- **Reduced motion:** instant show/hide, no width animation.
- **Old persisted prefs blob:** missing `mdPreview`/`mdPreviewSplit` fall back to
  defaults via shallow merge.

## 10. Testing

- **`reviewPrefsStore`** — `mdPreview` defaults to `true`; `toggleMdPreview`
  flips and persists; `setMdPreviewSplit` clamps 25–75.
- **`markdownComponents` / `MarkdownPreview`** — renders headings, lists, a GFM
  table, a task list, fenced code, blockquote from a source string; updates when
  `source` changes; **does not** render raw HTML (a `<script>`/`<b>` in source
  appears as text, no live element).
- **`EditorWithPreview`** — preview present only when active file is Markdown
  **and** `mdPreview` is on; EditorPane is always present; divider drag updates
  the ratio (clamped); double-click resets to 50.
- **`ReviewCanvas`** — `Eye` shown only in editor mode for a Markdown active
  file; hidden in diff mode / for non-Markdown; click calls `toggleMdPreview`.
- `npm run typecheck` clean; full Vitest suite green.

## 11. Out of scope (future)

- **Preview beside the Diff** (option B) and **both views** (option C).
- **Change-aware rendering** — brass margin-ticks on changed blocks (option ②).
- **Scroll sync** between source and preview.
- **Relative image / relative `.md` link resolution** (asset protocol; links
  opening in the editor via `onOpenInEditor`).
- **Syntax highlighting inside fenced code blocks** in the preview.
- **Per-workspace** preview prefs (v1 is a single global pref).

## 12. Rollout

Single release. Ships behind no flag (it's additive and inert for non-Markdown
files). Goes out in the next `npm run release` (would be **v0.2.9**) alongside any
other enhancements bundled for that release.
