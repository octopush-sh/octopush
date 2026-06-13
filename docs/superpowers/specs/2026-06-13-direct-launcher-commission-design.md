# Direct — "The Commission" launcher

**Date:** 2026-06-13
**Status:** Approved (author-delegated; corrective redesign after the dashboard pass landed too incremental)
**Mode:** Direct
**Surface:** the launcher (no active run).

---

## 1. Why (what the last pass got wrong)

The dashboard pass wrapped the existing form instead of fixing its real
problems, and it added a **Recent Runs** gallery that duplicates the Companion's
RUNS list. The launcher still read as a stacked form (I brief · II pipeline · III
crew · cost), and the pipeline step's **horizontal card grid collapses and
truncates** as the canvas narrows — you can't read a pipeline you're choosing.

This redesign attacks those directly and makes the launcher a surface that
*differentiates* Octopush: it reuses Octopush's own **node language** so
choosing and tuning a pipeline feels like the builder, not a web form.

Removed as redundant: `RecentRuns`, `RunCard`, `DirectOverview`, `DirectDashboard`
(runs live in the Companion's RUNS section — the single source). The launcher is
once again `PipelineSetup`, rebuilt.

---

## 2. The composition — one cinematic "commission", top to bottom

A single, generous, centered composition (max readable width), revealed with one
orchestrated staggered load. Editorial negative space, not a cramped grid.

1. **The brief (hero).** Eyebrow `— DIRECT`. A large, calm prompt field led by
   the brass `⟶` glyph (intent entering the ensemble), Spectral-italic
   placeholder. Bigger and more inviting than today's small textarea.

2. **The ensemble (pipeline + crew, unified).** The centerpiece.
   - **Pipeline selector** = a horizontally-scrollable row of compact, *readable*
     **tickets** (`PipelineTicket`): a curated brass `&` seal for Octopush
     builtins ("an Octopush original"), the pipeline name (serif, never slivered
     — fixed min-width, graceful truncate), and a tiny stage-shape glyph row.
     Descriptions leave the ticket. Active ticket = brass. Edit-on-hover; a
     trailing "Compose" ticket opens the builder. Scrolls — never squishes.
   - **Selected pipeline → a readable horizontal stage FLOW** (`StageFlow`)
     rendered in the builder's node language: archetype icon, Roman numeral,
     stage title, a **clickable model chip**, substrate pill, tool dots, and gate
     /loop markers, connected by the brass `⟶` (or `⟜` after a gate). Fixed-width
     cards that scroll horizontally with edge fades — text never collapses.
   - **The flow IS the crew editor.** Clicking a stage's model chip opens the
     ModelPicker and overrides that stage's model in place — folding the old
     "III · The team" table into the visualization. One surface, not two.
     The pipeline's description sits as a quiet serif line above its flow.

3. **The ledger (cost preview).** A refined "receipt" footer above a brass rule:
   savings leading (verdigris serif), `runs at ~$X · all-premium $Y`, the budget
   field, and the ceremonial **Begin the run** CTA. Same data/logic as today
   (`estimateRunCost`, budget parse, executing-run gate), restyled.

States: skeleton tickets while loading; an inviting "compose your first" when
empty; a retry card on error.

---

## 3. Architecture

`PipelineSetup.tsx` keeps its **props and all logic** (task, selectedId,
overrides, budget, estimate effect, prefill consume, executing-run gate, begin)
and owns the page chrome again (header + scroll + padding). Presentation is
rebuilt and split into focused pieces under `src/components/direct/`:

- **`PipelineTicket.tsx`** — one selector ticket (curated seal, name, shape
  glyphs, selected state, edit affordance). Pure presentational.
- **`StageFlow.tsx`** — the readable horizontal stage flow + inline model chips.
  Props: `stages`, `overrides`, `onOverride(position, model)`. Reuses
  `archetypeFor`/`ARTIFACT_ICON`/`TOOLS` (builder graph), `stageTitle`/`ROMAN`
  (RunTrack), and `ModelPicker`. A light `FlowStageCard` (not the xyflow
  `StageNode`, which needs canvas context).

`DirectCanvas` renders `PipelineSetup` directly again. Delete the dashboard
trio + their tests. Keep `aggregateSavings` (CompanionRuns still uses it).

No backend changes, no new IPC, no new tokens/fonts.

---

## 4. Why this differentiates (the bet)

- **It looks like Octopush, end to end.** The launcher speaks the same node
  language as the builder and the run track — a coherent visual world no generic
  agentic IDE has. Choosing a pipeline previews its real shape; tuning the crew
  happens *on* that shape.
- **It fixes the ergonomic failure** (collapsing cards) with fixed-width,
  scrollable, readable units — comfort at any width.
- **It removes redundancy** and noise — one runs list (Companion), one place to
  compose, generous breath, surgical brass.
- **One cinematic reveal** makes entering Direct feel like opening a studio, not
  loading a form.

---

## 5. Design rules (unchanged)

Tokens only; brass ≤5% of pixels (seal, active ticket, connectors, the rule,
CTA); three type voices; the signature glyphs (`⟶ ⟜ § & ` + Roman numerals);
icons + tooltips for non-obvious affordances; calm 220–320ms motion with a
single staggered page-load; tabular numerals so cost never reflows; English
copy; CTAs as italic-serif phrases.

---

## 6. Testing

- `PipelineTicket.test.tsx`: curated seal only on builtins; name renders; selected
  state; edit affordance fires.
- `StageFlow.test.tsx`: renders a card per stage with title + Roman numeral;
  model chip reflects override; changing it calls `onOverride`; gate/loop markers.
- `PipelineSetup.test.tsx`: updated to the new composition — begin/budget/estimate
  gates preserved; selector + flow present; ceremony header back.
- `npm run typecheck`, `npm test`, `npm run build` green; remove dead dashboard
  tests. `/code-review` max → fix → PR → review → merge → release.
```
