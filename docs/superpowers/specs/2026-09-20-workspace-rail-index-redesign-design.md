# Workspace Rail — "The Index" · Design

**Date:** 2026-09-20
**Status:** Approved (live mock reviewed on the design canvas), implemented
**Surface:** Left rail (`src/components/WorkspaceRail.tsx`), `ProjectMark`, the
rail entries in `docs/FEATURES.md` and `docs/design-system.md` §8.

---

## 1. Why

The rail was the one surface that still read like a generic explorer sidebar.
The audit against the design system found seven faults, all of grammar rather
than pixels:

1. **Four nested frames** — panel → bordered project card → bordered monogram
   → bordered chips. §9 forbids boxes inside boxes.
2. **Tint on every row's edge** — each workspace painted its tint on a 3px left
   border, so the brass of the active row drowned among the tints.
3. **Up to five boxed chips per row** (ticket, ↑, ↓, PR, dirty): quiet facts
   shouting. It read as a dashboard, not navigation.
4. **The header repeated the list** (dirty / PR aggregates) in tint + a brass
   hexagon per project — the loudest, least actionable element; N brass
   hexagons break "surgical brass".
5. **A permanent bordered filter box** taking 40px of prime rail — the
   VS Code / Cursor cliché, duplicating the ⌘ palette.
6. **A reserved 24px posture slot** holding an 11px mute icon: a hole between
   monogram and name that nobody could read.
7. **The collapsed rail** (50px tinted tiles + hairlines) lost the project and
   shared no grammar with the Run session rail (44px / 32px cells / reserved
   edge). Several rows could pulse at once, against the single-beacon law.

## 2. The design

The rail is a **typeset index**: one surface, hierarchy by type and space.

### 2.1 Expanded (280px)

- **Head line (36px):** `Search` icon + upright-serif placeholder
  "Find a project or mission", borderless; the line's bottom hairline turns
  brass on focus. The `+` icon button (Add project) sits at its right. Replaces
  the bordered filter box *and* the footer "Add project" row.
- **Project line (28px):** `ProjectMark` in **mute** (the project's tint accent
  only when the user chose one) · name in **Spectral 13** (ivory when the
  project holds the active workspace, sage otherwise, ivory on hover). The name
  folds/unfolds the project. Revealed on hover/focus: "New mission in …",
  the drag grip, the chevron (which stays while folded). Aggregates
  (`N missions · dirty · PRs`) fade in **only while folded**.
- **Row (32px):** reserved 2px identity edge · 20px bare serif glyph in the
  tint accent · sans 13 name · right-aligned unboxed mono 10 meta
  (ticket sage · ↑/↓ mute · PR verdigris · dirty glyph · attention dot).
- **Edge = state:** brass on the active row; marching segments while working
  (brass on the active row, sage elsewhere); transparent at rest. Never the
  tint.
- **Posture** rides the glyph's tooltip (`"{intent} mission · read-only ·
  sandboxed"`); no slot.
- **Empty project:** "No missions yet", aligned with the names.
- **Footer:** Recently-closed drawer only (unchanged; hidden when empty).

### 2.2 Collapsed (44px)

The Run session rail's geometry: 32px cells, reserved 2px edge (brass active /
marching), one cluster per project headed by its mark, a 20px hairline between
clusters, the `+` at the top. Hover or focus opens a `fixed`, viewport-clamped
flyout in the shared menu chrome, portalled to `document.body` — project
eyebrow · name · status · `⌘N` (`Ctrl+N` off a Mac) — with a 120ms leave grace
(a keyboard-opened one waits for blur); no native `title` doubles it.

### 2.3 Attention — one beacon

`resolveAttention(projects, flagsByWs, activeId, runningByWs)`: among flagged
workspaces that are neither active nor running, the one waiting longest
(oldest `flag.since` — the first ping of the current wait, kept by
`attentionStore.ping` while `at` follows every later ping) pulses; every other carries a static 5px brass dot. Running
suppresses attention in both modes — the marching edge owns the row until the
run pauses or finishes. Reduced motion: the pulse becomes a static
`--brass-dim` halo.

### 2.4 Search

Case-insensitive over project and mission names. The hit inside a mission name
is washed with the found-match tokens; a project-name hit keeps all of its
missions; projects with no hit leave the rail; "Nothing matches" otherwise.
Escape clears. Drag-reorder is off while filtering.

### 2.5 ⌘N

`App` computes `shortcutByWs` from the very list `⌘1…⌘9` indexes (the active
project's `workspaces`) so the hint — in the name tooltip and the flyout — can
never name a key that does something else.

## 3. Decisions taken

| # | Decision | Chosen |
|---|----------|--------|
| 1 | Project header voice | **Spectral 13 name** (the ContextHeader's "name of a thing" voice) over a mono eyebrow |
| 2 | Monogram | **Bare glyph** over a soft 9% tile |
| 3 | Mission posture | **Tooltip only** over a trailing glyph |
| 4 | Search | **Always-visible quiet line** over an icon that expands |

Copy keeps the product's established vocabulary in this surface ("mission":
`Find a project or mission`, `No missions yet`, `New mission in …`,
`N missions`).

## 4. What is preserved

Drag & drop reorder, pin (menu), both context menus, glyph/tint customisation,
per-project fold persistence, Recently closed, `⌘1…⌘9`, filter with Escape,
the footer toggle, the running bar, the attention flags.

## 5. Tokens & motion

No new colours. Uses `--brass-ghost` (active ground), `--brass-dim` (PRM halo),
`--octo-match*` (search wash), `--color-octo-*` text ramp, `.rail-bar-running`
(sized inline: 2px), `.animate-attention-pulse`, `.octo-fade-in`,
`.octo-pop-in`, `.octo-menu-enter`; width 220ms, fold 280ms (grid-rows),
hover 180ms, all on `--ease-octo`.

## 6. Testing

`WorkspaceRail.test.tsx` covers widths, the serif header, aggregates only while
folded, the active row, the edge, marching in both modes, the single beacon
(and `resolveAttention` as a pure function), posture tooltips, the search line
with its wash and empty state, the ⌘N hint, Add project in both modes, and the
collapsed flyout's open/grace/close cycle. The context-menu and integration
suites are unchanged in intent.

## 7. Follow-ups (out of scope here)

- **Per-theme monogram tints.** `TINTS` in `src/lib/monogram.ts` are fixed hex;
  on `vellum` `bone #d8c9a8` sits at ≈1.4:1. The light mock used darkened,
  saturated equivalents (§1.1 rule 2). Implement as a per-theme tint table
  solved like `text_muted`, with a contrast gate.
- **Workspace reorder within a project** — still by `last_active`.
