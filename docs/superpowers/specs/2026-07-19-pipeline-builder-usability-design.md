# Pipeline builder usability — "Atelier dock" anatomy

**Date:** 2026-07-19 · **Mode:** DIRECT · **Surface:** `PipelineBuilder` (create/edit pipeline canvas)
**Status:** Approved design, pending implementation plan.

## Problem

Four confirmed defects, each with an identified root cause:

1. **Stage inspector clipped behind the footer bar.** The `StageInspector` lives in a
   React Flow `Panel position="top-right"` whose `max-h-[calc(100%-1.5rem)]` sits on the
   Panel, not on the inspector. The inspector renders at natural height (~750px with all
   sections) and the flow container's `overflow: hidden` cuts it at the canvas edge —
   visually "behind" the Save/Cancel/Delete bar. Its internal `overflow-y-auto` never
   engages because nothing actually bounds its height.
2. **Zoom controls lost behind the stage palette.** `Controls` renders bottom-left; the
   `NodePalette` renders top-left with a `max-h-[56vh]` list. On short screens the palette
   (which grows with custom roles) descends over the zoom buttons. No coordination exists
   between the two corners.
3. **Edges cannot be discoverably disconnected.** Edges are technically selectable and
   Backspace-deletable, but `FlowEdge`/`LoopEdge` set `stroke` as an inline style, which
   overrides the `.react-flow__edge.selected` CSS rule — selection produces **zero visual
   feedback**. There is no hover state, no affordance, no context action, no reconnect
   drag. Users reasonably conclude edges are permanent and delete stages instead.
4. **Parallel branches are invisible.** The data model is a full DAG (multiple parents,
   per-branch context isolation in the orchestrator's dossier assembly), but execution is
   strictly sequential (one stage at a time in topological order) and the canvas gives no
   hint that branches are even drawable.

Cross-cutting gaps: no undo/redo (an accidental delete is unrecoverable), no auto-layout,
no gesture discoverability, inspector overlaps the minimap on narrow canvases.

## Goals / non-goals

**Goals**

- Rebuild the builder's anatomy so overlay-collision bugs are impossible by construction.
- Make edge disconnection first-class, visible, and reversible.
- Add undo/redo, tidy auto-layout, and gesture hints.
- Keep every visual decision inside Onyx & Brass tokens and motion primitives.

**Non-goals**

- Concurrent stage execution. The orchestrator stays sequential.
- Pushing DAG authoring as a feature. Branches remain drawable and honest, not promoted.
- **Future initiative (separate spec):** a built-in "Orchestrator" role that dispatches
  parallel subagents Claude Code-style (fan out, gather results, continue the main flow).
  Parallelism becomes a capability of a stage, not topology the user wires. A minimal CLI
  version (seeded role instructions) and a full API version (dispatch tool in the runner,
  subagent visibility in the run) will be brainstormed on their own.

## §A · Anatomy

The builder moves from "everything floats over the canvas" to **three regions + owned
corners**.

```
┌─ header: eyebrow · name · description ────────────────┐
├──────────────────────────────────────┬────────────────┤
│  canvas (ReactFlow, 1fr)             │  stage dock    │
│  ┌─Stages─┐ (collapsible)   [↶ ↷ ⌗] │  (0 ↔ 320px)   │
│  │palette │    □──□                  │  identity      │
│  └────────┘     │                    │  engine        │
│                 □                    │  execution     │
│                        ┌─ − + fit ─┐ │  instructions  │
│                        │  minimap  │ │  loop          │
├────────────────────────┴───────────┴─┴────────────────┤
│ [Save pipeline] [Cancel]   validation readout  Delete │
└───────────────────────────────────────────────────────┘
```

- **Body grid:** `grid-template-columns: 1fr <dock>`; the dock animates closed↔open
  (0 ↔ 320px, 240–280ms `var(--ease-octo)`). The dock is a sibling of the ReactFlow
  wrapper — **outside** its `overflow: hidden` — so clipping is structurally impossible.
  It spans full height between header and footer with its own scroll
  (`min-h-0` + `flex-1` + `overflow-y-auto` on the scrollable body).
- **Dock behavior:** opens when a node is selected; closes on Esc, pane click, or its ✕.
  Content keyed by node id (as today) so switching stages remounts cleanly.
- **Inspector regrouped** (same controls, new order, hairline + eyebrow separated):
  - *Identity* — name, archetype.
  - *Engine* — model, reasoning; **"Escalate on failure" collapses into a `Reveal`**
    (closed by default unless configured) — it currently spends ~180px on a rarely-used
    policy and is the single biggest driver of inspector height.
  - *Execution* — substrate, approval gate, tools, max turns.
  - *Instructions* — free-form textarea.
  - *Loop* — review archetypes only (existing `Reveal`).
- **Corner ownership on the canvas:**
  - **Top-left:** stage palette, now collapsible to a compact pill ("Stages ▸"); the
    expanded list's internal scroll is capped so it never reaches the bottom third.
  - **Bottom-right:** the **view cluster** — zoom controls (−/+/fit) stacked directly
    above the minimap with a fixed gap. One corner owns everything "view". The minimap
    fades out when the canvas is narrower than ~560px (it is a luxury, not a control).
  - **Top-right:** a mini-toolbar of icon buttons — Undo · Redo · Tidy — each with
    tooltip + shortcut hint.
  - **Bottom-left:** permanently empty. That is where today's collision dies.
- **Footer:** unchanged structure (Save as upright-serif brass phrase · Cancel ·
  flex-1 validation readout · Delete). The readout gains room now that nothing else
  competes for width.

## §B · Interactions

### Edge disconnection — four paths, one always visible

1. **Hover:** edge brightens to brass, `cursor: pointer`. Requires moving edge strokes
   from inline styles to CSS classes scoped under `.octo-flow` (this inline style is the
   root cause of the invisible-selection bug).
2. **Disconnect pill:** on hover or selection, a small ✕ button appears at the edge
   midpoint (`octo-pop-in`; tooltip "Disconnect — or press Backspace"). Click removes the
   edge. Works on loop edges too (equivalent to the inspector's "don't loop").
3. **Keyboard:** Backspace/Delete removes the selected edge (existing behavior — now with
   real visual selection feedback).
4. **Reconnect drag:** edge endpoints become draggable (`edgesReconnectable` +
   `onReconnect`); dropping an endpoint on empty pane deletes the edge; dropping on
   another handle re-routes it. The existing anti-cycle / anti-duplicate guards apply to
   re-routes. Loop edges re-route only among valid flow-ancestors.

### Undo / redo

- History of graph snapshots (`nodes` + `edges`): push on add/remove node, connect/
  disconnect/reconnect, node drag end, inspector property patch (coalesced per field so
  typing is one step), loop change, tidy. Cap 100 entries.
- `⌘Z` / `⇧⌘Z` (Ctrl on other platforms). Ignored while focus is in a text input —
  native input undo rules there. Pipeline name/description are excluded (native undo).
- Toolbar buttons disable at stack ends.

### Tidy (auto-layout)

- Hand-rolled layered layout, zero new dependencies: depth = longest path from entry
  nodes (reusing `topoOrder`); rows by depth (top→bottom flow, as today); within a row,
  preserve the author's current X order; center rows; constant row/column gaps.
- Nodes animate to their new positions (280ms `var(--ease-octo)` transition applied
  during the move), then `fitView`. Tidy is a single undo step.

### Discoverability

- **Hint chip** (bottom-center, mono 10px, `octo-rise-in`): "Drag from a stage's edge to
  connect it" — appears only when the graph has ≥2 nodes and 0 flow edges; fades on the
  first connection; dismissible; dismissal remembered in `localStorage`.
- **Handles:** invisible enlarged hit-area (CSS `::after`) so grabbing is forgiving;
  existing tooltips stay.
- Every new chrome control carries a `title` tooltip including its shortcut.

## §C · Motion, tokens, quality

- All motion via existing primitives: dock = horizontal reveal at 240–280ms
  `var(--ease-octo)`; pill = `octo-pop-in`; chip = `octo-rise-in`; minimap hide/show =
  fade. Nothing mounts or unmounts abruptly. `prefers-reduced-motion` respected
  everywhere (transitions collapse to instant).
- Zero new colors, zero hex literals: edge states use `--brass` / `--brass-dim` /
  `--brass-rule-dim`; chrome uses panel/hairline/mute tokens. Upright serif only; no
  italics; no retired glyphs (the `⟲` loop badge and `⟜` gate mark stay — they are
  sanctioned structural glyphs).
- UI copy in English throughout.

## Implementation notes

- `PipelineBuilder.tsx`: body becomes the two-column grid; inspector moves out of the
  React Flow `Panel` into the dock column; `Controls` → bottom-right (stacked above
  `MiniMap`); add the top-right toolbar; wire undo/redo store + keyboard; hint chip.
- `builder/StageInspector.tsx`: regroup sections; wrap escalation in `Reveal`; height/
  scroll contract (`flex-1 min-h-0 overflow-y-auto` body).
- `builder/edges.tsx`: strokes to CSS classes; midpoint disconnect pill (button in
  `EdgeLabelRenderer`, `pointer-events-auto`).
- `builder/NodePalette.tsx`: collapsible pill state; list cap.
- `builder/graph.ts`: `tidyLayout(nodes, edges)` pure function.
- New: `builder/history.ts` (pure snapshot history reducer — push/undo/redo/coalesce).
- `styles.css`: `.octo-flow` edge hover/selected rules, handle hit-area, dock reveal
  helpers if needed.
- `docs/FEATURES.md`: builder section updated (dock, disconnect paths, undo/redo, tidy,
  hint chip, palette collapse, view cluster).

## Testing

- Unit: `tidyLayout` (depths, row ordering, stability), `history.ts` reducer (push /
  undo / redo / coalesce / cap), reconnect guards (no cycles, no duplicates, loop
  re-route restricted to ancestors). Existing `graph.test.ts` stays green.
- Component: inspector renders inside the dock (not a flow Panel); disconnect pill
  removes the edge; hint chip appears/fades per its rule.
- Gates: `npm run typecheck`, `npm test`.
