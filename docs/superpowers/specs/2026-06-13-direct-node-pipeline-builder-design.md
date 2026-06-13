# Direct — Node-based Pipeline Builder

**Date:** 2026-06-13
**Status:** Approved (author-delegated; the user asked me to brainstorm, decide, and ship without a separate approval gate)
**Mode:** Direct
**Surface:** `src/components/PipelineBuilder.tsx` (replaced) + supporting canvas modules, with additive backend changes.

---

## 1. Why

Pipeline authoring is meant to be Octopush's flagship act. Today it is a vertical
form: cards stacked in a column, stages reordered with up/down chevrons, loops
chosen from a dropdown. It works, but it reads like configuration, not
composition. You cannot *see* the shape of the work.

We replace the form with a **canvas**: stages are nodes you place, drag, link,
branch, and loop in 2D space, with bounded zoom and a fit-to-view. Each node is
an **agent**: it carries a model, an execution substrate, a tool allowlist, and
free-form instructions on top of a fixed *archetype* that guarantees it can
operate inside a pipeline.

This is an authoring redesign. The run view (`RunTrack`) stays as-is.

---

## 2. The operability contract (what the user can and cannot change)

A stage's **archetype** (today called `role`: `plan`, `plan_review`,
`implement`, `code_review`, `test`, `repro`, `fix`, `verify`, `critique`,
`refine`) is the part Octopush guarantees. The archetype fixes:

- the **artifact kind** the stage emits (`Plan`/`Review`/`Diff`/`Tests`/`Note`)
  and therefore which dossier slot it fills and how later stages label it;
- the **loop eligibility** (only review archetypes may loop back);
- the base system prompt that makes the stage act autonomously inside a headless
  pipeline.

On top of that anchor, the user has creative freedom:

- **Custom name** — a free display label for the node (e.g. "Security pass"
  anchored to the `code_review` archetype). Visual only.
- **Instructions** — free-form text appended to the archetype's system prompt.
  This is where the user shapes the stage's behavior.
- **Tools** — an allowlist over the four workspace tools (`read_file`,
  `list_files`, `write_file`, `run_command`). A review archetype defaults to
  read-only; an implement archetype defaults to all four. The user can widen or
  narrow within reason; validation warns when a choice contradicts the archetype
  (e.g. an `implement` stage with no write/run tool can produce no code).
- **Model** and **substrate** — already per-stage today.

So: archetype = guaranteed contract; name + instructions + tools + model =
creative surface. This is precisely "some things modifiable, some not."

---

## 3. Topology: authored as a graph, executed in safe topological order

The canvas lets the user draw a **DAG** of flow edges plus explicit **loop
back-edges** (review → an ancestor, as today).

- **Flow edge** `a → b`: `a` is an input dependency of `b`. Fan-out (one node,
  many outgoing) and fan-in/join (many incoming) express parallelism.
- **Loop edge**: a review archetype's back-edge to an earlier ancestor. Maps 1:1
  to the existing `loopTargetPosition` + `loopMode` + `loopMaxIterations`.

**Execution stays strictly sequential**, in a topological order of the flow
edges. This is a deliberate, honest choice: every stage shares one git worktree,
so running two code-writing agents concurrently would corrupt each other's
changes. Topological-serial execution is correct and matches the existing
engine; true concurrency is explicitly out of scope and noted as future work.

Parallelism is therefore **real in semantics, not in wall-clock**: branches that
do not feed each other are *isolated in context*. We make this honest by moving
the dossier from "every earlier position" to **"my ancestors only"** (§5). A
critic on branch B never sees a sibling branch A's artifact unless A is an
actual ancestor. Joins are real: a node with two incoming flow edges receives
the freshest artifact of each kind from its upstream branches (bounded to one
section per artifact kind — the existing token ceiling, so two same-kind
branches collapse to the latest).

The authored-vs-legacy choice is made **once per run**, not per stage: a run is
"authored" if *any* stage records parents. In an authored run a parentless node
is a genuine entry and feeds from nothing — so multiple independent entry roots
are allowed (parallel starts that converge at a join), and a second root never
inherits the first. A legacy run (no parents anywhere) keeps the original
"every earlier stage" behavior byte-for-byte. The same per-run rule governs
`loop_back`: in an authored graph it re-runs only the review's lineage (its
ancestors) within the position window, never a sibling branch.

### Save = compile the graph to the existing linear model

On save we:

1. Validate the flow edges form a DAG with a single reachable entry (§6).
2. **Topologically sort** nodes → `position` 0..n (stable: ties broken by
   canvas Y then X, so layout reads top-to-bottom/left-to-right).
3. For each stage persist its **direct upstream positions** (`parents`), its
   `pos_x`/`pos_y`, `tools`, `custom_name`, `instructions`.
4. Derive `loopTargetPosition`/`loopMaxIterations`/`loopMode` from loop edges.

Loading reverses this: nodes restored at `pos_x`/`pos_y`; flow edges rebuilt
from `parents`; loop edges rebuilt from `loopTargetPosition`. A legacy pipeline
with no `parents`/positions falls back to an auto-laid-out linear chain.

---

## 4. Frontend architecture

Built on **`@xyflow/react`** (the maintained successor to react-flow). Rationale:
it is the stable, accessible foundation for pan/zoom/viewport/edge-routing/
minimap — the hard, bug-prone parts. Distinctiveness (the explicit anti-generic
requirement) comes from **100% custom node and edge components**, our design
tokens, and our motion primitives. Hand-rolling a stable zoomable graph in one
pass is exactly the "forced, not well-built" risk we were warned against.

Module layout (new `src/components/builder/`):

- `PipelineBuilder.tsx` — orchestrator: header (name/description eyebrow),
  `ReactFlowProvider`, canvas, palette, inspector, save bar. Owns the draft
  graph state and the graph⇄draft (de)serialization.
- `graph.ts` — pure functions: `draftToGraph`, `graphToStageDrafts` (topo sort +
  parents + loop derivation), `validateGraph`, archetype metadata
  (artifact kind, loop-eligibility, default tools, descriptions). Unit-tested.
- `StageNode.tsx` — the custom node: archetype glyph + Roman index, custom name,
  model chip, substrate chip, tool dots, gate/loop markers, validation ring,
  source/target handles. Calm; brass used surgically for selected/active.
- `FlowEdge.tsx` / `LoopEdge.tsx` — custom edges. Flow uses the `⟶` language;
  loop is a dashed brass back-arc labelled `⟜ ×N`.
- `NodePalette.tsx` — a low-noise rail of archetypes to drop onto the canvas
  (drag or click-to-add). Icons + tooltips, italic-serif archetype names.
- `StageInspector.tsx` — the Companion: opens when a node is selected; edits
  name, archetype, model, substrate, tools, gate, max turns, loop, instructions.
  Uses existing controls (`Listbox`, `SegmentedControl`, `TogglePill`,
  `Stepper`, `ModelPicker`). Slides via grid-rows / `octo-*` motion.
- `CanvasChrome.tsx` — themed `<Controls>` (zoom ±, fit), `<MiniMap>`,
  `<Background>` (faint dotted brass at very low alpha). Bounded zoom
  `minZoom 0.4 … maxZoom 1.75`.

State stays local to the builder (a `useState` graph of nodes+edges), matching
the existing component-local draft pattern; the Zustand `pipelineStore` is still
the persistence boundary (`save`/`remove`/`load`). No new global store.

All visible strings are English. Tooltips back every non-obvious affordance
(handles, tool dots, loop badge, validation ring). Motion respects
`prefers-reduced-motion`; nodes mount with `octo-rise-in`, inspector with the
grid-rows idiom, edges grow rather than pop.

---

## 5. Backend changes (additive, low-risk)

### Schema (`add_column_if_missing`, nullable)

`pipeline_stages` and `run_stages` gain:

- `pos_x REAL`, `pos_y REAL` — canvas layout (pipeline_stages only needs them;
  run_stages may omit — run view stays linear).
- `parents TEXT` — JSON array of upstream stage positions (direct flow deps).
- `tools TEXT` — JSON array of allowed tool names; `NULL` = archetype default.
- `custom_name TEXT` — display label; `NULL` = archetype label.
- `instructions TEXT` — extra system-prompt text; `NULL`/empty = none.

`run_stages` mirrors the **execution-relevant** ones: `parents`, `tools`,
`instructions`. `create_run` copies them from the template.

### `StageDraft` / `PipelineStageRow` / `RunStageRow` / IPC types

Extended with the new optional fields (camelCase on the TS side). Defaults keep
old drafts valid (`parents: []`, `tools: null`, `customName: null`,
`instructions: null`, `posX/posY: null`).

### `validate_pipeline_stages` (the operability guarantee, server side)

In addition to today's checks:

- `parents` reference valid earlier positions (after topo sort they are < self);
  the parent graph is acyclic; position 0 (or the entry set) has no parents.
- `tools`, if present, is a subset of the known tool names and non-empty.
- `instructions` length-capped (defensive, e.g. ≤ 8 KB).

The TS `graph.ts` validator mirrors these so the builder shows problems live;
the Rust validator is the authority.

### Dossier: ancestry-aware (`assemble_stage_input`)

When the running stage has a non-empty `parents` chain available, restrict the
"freshest artifact per kind" scan to the stage's **transitive ancestors**
(computed from `run_stages.parents`) instead of "all positions < self". Absent
`parents` (legacy run), keep the current behavior. This is what makes branch
isolation and joins honest. The breadcrumb still lists the full pipeline.

### Runner: tools + instructions

- `ApiRunner` filters `build_llm_tools()` by the stage's tool allowlist (full set
  when `NULL`) and appends `instructions` to the system prompt (after the
  archetype body, before the verdict instruction). `run_agentic_loop` gains a
  `tools` parameter.
- `CliRunner`: tool allowlisting does not apply (Claude Code owns its tools);
  `instructions` are appended to the prompt. Documented.

`StageSpec` carries `tools: Option<Vec<String>>` and `instructions:
Option<String>`.

---

## 6. Validation rules (live badges + save block)

Hard (block save): empty graph; no name; a flow cycle; a node missing a model;
max turns ∉ 1..100; a loop edge from a non-review archetype or to a node that
is not a flow-ancestor of the review; tool list empty when set. (The
ancestry rule is enforced on both the TS side and authoritatively in
`validate_pipeline_stages`.) Multiple entry roots are allowed — they model
parallel starts that converge at a join.

Soft (warn, non-blocking, brass-amber badge + tooltip): `implement`/`fix`/`test`
without a write or run tool; an `auto` loop (verdict parsing caveat, as today);
an orphan node with no edges in a multi-node graph.

Each node shows a validation state on its ring; the save bar summarizes the
first blocking issue.

---

## 7. Out of scope (explicit)

- Concurrent stage execution (worktree-unsafe; topo-serial is the contract).
- Redesigning the run view (`RunTrack`) into a graph.
- New tools beyond the existing four.
- A free-form "no archetype" stage (would break the artifact/dossier contract).

---

## 8. Testing

- `graph.ts`: Vitest for `graphToStageDrafts` (topo order, parents, loop
  derivation, tie-breaking) and `validateGraph` (each hard/soft rule).
- Rust: extend `validate_pipeline_stages` tests for `parents`/`tools`; a test
  that `assemble_stage_input` honors ancestry (branch isolation + join).
- `npm run typecheck`, `npm test`, `cargo test` all green before review.
- `/code-review` at max effort; fix findings; then PR → merge → release.
```
