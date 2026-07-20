# Pipeline Builder Usability ("Atelier dock") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the DIRECT pipeline builder's anatomy so the stage inspector can never clip, canvas chrome never collides, edges are discoverably disconnectable, and the graph gains undo/redo, tidy auto-layout, and gesture hints.

**Architecture:** The inspector moves out of the React Flow overlay into a docked right column (outside the flow's `overflow: hidden`). Canvas corners get single owners (palette top-left, undo/redo/tidy top-right, zoom+minimap bottom-right, bottom-left empty). New pure modules (`history.ts`, `tidyLayout`, `reconnectAllowed`) carry the logic; `PipelineBuilder.tsx` wires them.

**Tech Stack:** React 19 + TypeScript, `@xyflow/react` v12, Tailwind v4 tokens, Zustand, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-07-19-pipeline-builder-usability-design.md`

## Global Constraints

- Tokens only: no hex literals, no raw font strings. Colors via `--brass`, `--brass-dim`, `--brass-line`, `--brass-rule-dim`, `--brass-ghost`, panel/hairline/mute Tailwind token classes.
- Motion only via existing primitives / `var(--ease-octo)` + `--dur-*`; every mount/unmount animated; `prefers-reduced-motion` respected (global reduce block in `styles.css` already kills animations — new `transition-*` utilities must also be inside a reduce-guard when hand-written in CSS).
- UI copy in English. Upright serif only — **no italics**. No retired glyphs (`§`, Roman numerals, gradient rules, `⟶` ornament, `✦`). `⟲` and `⟜` stay.
- CTAs as serif phrases (`Save pipeline`), icons from `lucide-react` always with `title` tooltips.
- IPC via `src/lib/ipc.ts` only; state in Zustand stores; functional components.
- `docs/FEATURES.md` must be updated in the same change (Task 11).
- Gates before completion: `npm run typecheck` and `npm test` green.
- Commit after each task; commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Pure undo/redo history module

**Files:**
- Create: `src/components/builder/history.ts`
- Test: `src/components/builder/history.test.ts`

**Interfaces:**
- Consumes: `StageNode`, `StageEdge` types from `./graph`.
- Produces (used by Task 8):
  - `interface GraphSnapshot { nodes: StageNode[]; edges: StageEdge[] }`
  - `interface HistoryStack { past: GraphSnapshot[]; future: GraphSnapshot[]; lastKey: string | null }`
  - `createHistory(): HistoryStack`
  - `pushSnapshot(h, snap, key?): HistoryStack` — records the state **before** a mutation; consecutive same non-null `key` pushes coalesce (only the first is kept); always clears `future`.
  - `undo(h, current): { stack; restored } | null`, `redo(h, current): { stack; restored } | null`
  - `canUndo(h): boolean`, `canRedo(h): boolean`, `HISTORY_CAP = 100`

- [ ] **Step 1: Write the failing tests**

```ts
// src/components/builder/history.test.ts
import { describe, it, expect } from "vitest";
import {
  createHistory,
  pushSnapshot,
  undo,
  redo,
  canUndo,
  canRedo,
  HISTORY_CAP,
  type GraphSnapshot,
} from "./history";

// Positions are enough to tell snapshots apart — data content is irrelevant here.
function snap(tag: number): GraphSnapshot {
  return { nodes: [{ id: `n${tag}`, type: "stage", position: { x: tag, y: 0 }, data: {} } as never], edges: [] };
}

describe("history", () => {
  it("starts empty: no undo, no redo", () => {
    const h = createHistory();
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
    expect(undo(h, snap(0))).toBeNull();
    expect(redo(h, snap(0))).toBeNull();
  });

  it("push → undo restores the pushed snapshot and stashes current for redo", () => {
    let h = createHistory();
    h = pushSnapshot(h, snap(1)); // state before a mutation that produced snap(2)
    const u = undo(h, snap(2));
    expect(u).not.toBeNull();
    expect(u!.restored).toEqual(snap(1));
    expect(canRedo(u!.stack)).toBe(true);
    const r = redo(u!.stack, u!.restored);
    expect(r!.restored).toEqual(snap(2));
    expect(canUndo(r!.stack)).toBe(true);
  });

  it("a new push clears the redo stack", () => {
    let h = createHistory();
    h = pushSnapshot(h, snap(1));
    const u = undo(h, snap(2))!;
    const afterPush = pushSnapshot(u.stack, snap(3));
    expect(canRedo(afterPush)).toBe(false);
  });

  it("coalesces consecutive pushes with the same key (one undo step per burst)", () => {
    let h = createHistory();
    h = pushSnapshot(h, snap(1), "patch:n1:instructions");
    h = pushSnapshot(h, snap(2), "patch:n1:instructions");
    h = pushSnapshot(h, snap(3), "patch:n1:instructions");
    expect(h.past).toHaveLength(1);
    expect(h.past[0]).toEqual(snap(1));
  });

  it("a different key breaks coalescing", () => {
    let h = createHistory();
    h = pushSnapshot(h, snap(1), "patch:n1:instructions");
    h = pushSnapshot(h, snap(2), "patch:n1:customName");
    expect(h.past).toHaveLength(2);
  });

  it("null keys never coalesce", () => {
    let h = createHistory();
    h = pushSnapshot(h, snap(1));
    h = pushSnapshot(h, snap(2));
    expect(h.past).toHaveLength(2);
  });

  it("undo resets coalescing — the same key pushes again afterwards", () => {
    let h = createHistory();
    h = pushSnapshot(h, snap(1), "k");
    const u = undo(h, snap(2))!;
    const h2 = pushSnapshot(u.stack, snap(3), "k");
    expect(h2.past).toHaveLength(1); // past was emptied by undo, then k pushed fresh
    expect(h2.past[0]).toEqual(snap(3));
  });

  it(`caps the stack at ${HISTORY_CAP} snapshots, dropping the oldest`, () => {
    let h = createHistory();
    for (let i = 0; i < HISTORY_CAP + 10; i++) h = pushSnapshot(h, snap(i));
    expect(h.past).toHaveLength(HISTORY_CAP);
    expect(h.past[0]).toEqual(snap(10));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/builder/history.test.ts`
Expected: FAIL — `Cannot find module './history'`.

- [ ] **Step 3: Implement the module**

```ts
// src/components/builder/history.ts
// Pure undo/redo stack for the builder graph. Snapshots are recorded BEFORE a
// mutation; React state stays the single "present". No React imports — fully
// unit-testable, like graph.ts.

import type { StageEdge, StageNode } from "./graph";

export interface GraphSnapshot {
  nodes: StageNode[];
  edges: StageEdge[];
}

export interface HistoryStack {
  past: GraphSnapshot[];
  future: GraphSnapshot[];
  /** Coalescing key of the last push; a repeat with the same key is skipped
   *  so a typing burst in one field stays a single undo step. */
  lastKey: string | null;
}

export const HISTORY_CAP = 100;

export function createHistory(): HistoryStack {
  return { past: [], future: [], lastKey: null };
}

/** Record `snap` (the state before a mutation). Clears the redo stack. */
export function pushSnapshot(h: HistoryStack, snap: GraphSnapshot, key: string | null = null): HistoryStack {
  if (key !== null && key === h.lastKey) return { ...h, future: [] };
  const past = [...h.past, snap];
  if (past.length > HISTORY_CAP) past.shift();
  return { past, future: [], lastKey: key };
}

export function canUndo(h: HistoryStack): boolean {
  return h.past.length > 0;
}

export function canRedo(h: HistoryStack): boolean {
  return h.future.length > 0;
}

/** Step back: `current` moves to the redo stack. Null when nothing to undo. */
export function undo(
  h: HistoryStack,
  current: GraphSnapshot,
): { stack: HistoryStack; restored: GraphSnapshot } | null {
  if (h.past.length === 0) return null;
  const restored = h.past[h.past.length - 1];
  return {
    stack: { past: h.past.slice(0, -1), future: [...h.future, current], lastKey: null },
    restored,
  };
}

/** Step forward again. Null when nothing to redo. */
export function redo(
  h: HistoryStack,
  current: GraphSnapshot,
): { stack: HistoryStack; restored: GraphSnapshot } | null {
  if (h.future.length === 0) return null;
  const restored = h.future[h.future.length - 1];
  return {
    stack: { past: [...h.past, current], future: h.future.slice(0, -1), lastKey: null },
    restored,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/builder/history.test.ts`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add src/components/builder/history.ts src/components/builder/history.test.ts
git commit -m "feat(builder): pure snapshot history for undo/redo

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `tidyLayout` in graph.ts

**Files:**
- Modify: `src/components/builder/graph.ts` (append near `flowAncestors`)
- Test: `src/components/builder/graph.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: module-private `topoOrder` (same file), `StageNode`, `StageEdge`.
- Produces (used by Task 9): `tidyLayout(nodes: StageNode[], edges: StageEdge[]): StageNode[]`, `TIDY_ROW_GAP = 150`, `TIDY_COL_GAP = 260`. Returns repositioned copies; on a cyclic flow returns `nodes` unchanged.

- [ ] **Step 1: Write the failing tests** (append to `graph.test.ts`; the file already seeds archetypes in `beforeEach` and has node/edge helpers — reuse its `mkNode`/`flowEdge` style if present, else use the literals below)

```ts
import { tidyLayout, TIDY_ROW_GAP, TIDY_COL_GAP } from "./graph";

function tnode(id: string, x: number, y: number): StageNode {
  return { id, type: "stage", position: { x, y }, data: newStageData("implement") };
}
function tedge(source: string, target: string): StageEdge {
  return { id: `f-${source}-${target}`, source, target, type: "flow", data: { kind: "flow" } };
}

describe("tidyLayout", () => {
  it("lays a linear chain as a single centered column", () => {
    const nodes = [tnode("a", 40, 300), tnode("b", -80, 10), tnode("c", 5, 90)];
    const edges = [tedge("a", "b"), tedge("b", "c")];
    const out = tidyLayout(nodes, edges);
    const pos = Object.fromEntries(out.map((n) => [n.id, n.position]));
    expect(pos.a).toEqual({ x: 0, y: 0 });
    expect(pos.b).toEqual({ x: 0, y: TIDY_ROW_GAP });
    expect(pos.c).toEqual({ x: 0, y: 2 * TIDY_ROW_GAP });
  });

  it("centers a two-node row and preserves the author's left-to-right order", () => {
    // diamond: a → (left, right) → d ; "right" currently sits left of "left"
    const nodes = [tnode("a", 0, 0), tnode("left", 500, 50), tnode("right", -500, 50), tnode("d", 0, 900)];
    const edges = [tedge("a", "left"), tedge("a", "right"), tedge("left", "d"), tedge("right", "d")];
    const pos = Object.fromEntries(tidyLayout(nodes, edges).map((n) => [n.id, n.position]));
    expect(pos.right.x).toBe(-TIDY_COL_GAP / 2); // was left-most, stays left-most
    expect(pos.left.x).toBe(TIDY_COL_GAP / 2);
    expect(pos.right.y).toBe(TIDY_ROW_GAP);
    expect(pos.left.y).toBe(TIDY_ROW_GAP);
    expect(pos.d).toEqual({ x: 0, y: 2 * TIDY_ROW_GAP });
  });

  it("depth is the LONGEST path from an entry (join sits below its deepest parent)", () => {
    // a → b → c, and a → c directly: c must land at depth 2, not 1.
    const nodes = [tnode("a", 0, 0), tnode("b", 0, 100), tnode("c", 0, 200)];
    const edges = [tedge("a", "b"), tedge("b", "c"), tedge("a", "c")];
    const pos = Object.fromEntries(tidyLayout(nodes, edges).map((n) => [n.id, n.position]));
    expect(pos.c.y).toBe(2 * TIDY_ROW_GAP);
  });

  it("ignores loop edges when computing depth", () => {
    const nodes = [tnode("a", 0, 0), tnode("r", 0, 100)];
    const edges = [tedge("a", "r"), loopEdge("r", "a", 2, "gated")];
    const pos = Object.fromEntries(tidyLayout(nodes, edges).map((n) => [n.id, n.position]));
    expect(pos.a.y).toBe(0);
    expect(pos.r.y).toBe(TIDY_ROW_GAP);
  });

  it("returns nodes untouched when the flow has a cycle", () => {
    const nodes = [tnode("a", 7, 8), tnode("b", 9, 10)];
    const edges = [tedge("a", "b"), tedge("b", "a")];
    expect(tidyLayout(nodes, edges)).toEqual(nodes);
  });

  it("orphans land in row 0 alongside entries", () => {
    const nodes = [tnode("a", 0, 0), tnode("lone", 300, 700)];
    const pos = Object.fromEntries(tidyLayout(nodes, []).map((n) => [n.id, n.position]));
    expect(pos.a.y).toBe(0);
    expect(pos.lone.y).toBe(0);
    expect(pos.a.x).toBe(-TIDY_COL_GAP / 2);
    expect(pos.lone.x).toBe(TIDY_COL_GAP / 2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/builder/graph.test.ts -t tidyLayout`
Expected: FAIL — `tidyLayout` is not exported.

- [ ] **Step 3: Implement** (append to `graph.ts` after `flowAncestors`)

```ts
// ─── Tidy auto-layout ────────────────────────────────────────────────────────

export const TIDY_ROW_GAP = 150;
export const TIDY_COL_GAP = 260;

/** Re-lay the graph on a layered grid: depth = longest flow path from an entry
 *  node, one row per depth (top→bottom), and within a row nodes keep their
 *  current left-to-right order so the author's intent survives. A cyclic flow
 *  returns the nodes untouched (validation already blocks save on cycles). */
export function tidyLayout(nodes: StageNode[], edges: StageEdge[]): StageNode[] {
  const flow = edges.filter((e) => (e.data?.kind ?? "flow") === "flow");
  let ordered: StageNode[];
  try {
    ordered = topoOrder(nodes, flow);
  } catch {
    return nodes;
  }

  const parentsOf = new Map<string, string[]>();
  for (const e of flow) {
    if (!parentsOf.has(e.target)) parentsOf.set(e.target, []);
    parentsOf.get(e.target)!.push(e.source);
  }
  // `ordered` is topological, so every parent's depth is known before its child.
  const depth = new Map<string, number>();
  for (const n of ordered) {
    const ps = parentsOf.get(n.id) ?? [];
    depth.set(n.id, ps.length === 0 ? 0 : Math.max(...ps.map((p) => (depth.get(p) ?? 0) + 1)));
  }

  const rows = new Map<number, StageNode[]>();
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    if (!rows.has(d)) rows.set(d, []);
    rows.get(d)!.push(n);
  }

  const placed = new Map<string, { x: number; y: number }>();
  for (const [d, row] of rows) {
    row.sort((a, b) => a.position.x - b.position.x || (a.id < b.id ? -1 : 1));
    row.forEach((n, i) => {
      placed.set(n.id, { x: (i - (row.length - 1) / 2) * TIDY_COL_GAP, y: d * TIDY_ROW_GAP });
    });
  }
  return nodes.map((n) => ({ ...n, position: placed.get(n.id) ?? n.position }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/builder/graph.test.ts`
Expected: all pass (new + pre-existing).

- [ ] **Step 5: Commit**

```bash
git add src/components/builder/graph.ts src/components/builder/graph.test.ts
git commit -m "feat(builder): layered tidy auto-layout, zero deps

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `reconnectAllowed` guard in graph.ts

**Files:**
- Modify: `src/components/builder/graph.ts` (append after `flowAncestors`)
- Test: `src/components/builder/graph.test.ts` (append a `describe`)

**Interfaces:**
- Produces (used by Task 10): `reconnectAllowed(oldEdge: StageEdge, conn: { source: string; target: string }, edges: StageEdge[]): boolean`. `edges` is the full current edge list (including `oldEdge`).

- [ ] **Step 1: Write the failing tests**

```ts
import { reconnectAllowed } from "./graph";

describe("reconnectAllowed", () => {
  // a → b → c (flow), r reviews c with a loop back to a
  const flowAB = tedge("a", "b");
  const flowBC = tedge("b", "c");
  const loopRA = loopEdge("r", "a", 2, "gated");
  const flowCR = tedge("c", "r");
  const all = [flowAB, flowBC, flowCR, loopRA];

  it("rejects self-connections", () => {
    expect(reconnectAllowed(flowAB, { source: "a", target: "a" }, all)).toBe(false);
  });

  it("allows re-routing a flow edge to a new valid target", () => {
    expect(reconnectAllowed(flowBC, { source: "b", target: "r" }, all)).toBe(true); // b→r is new and acyclic
  });

  it("rejects a duplicate of an existing flow edge", () => {
    expect(reconnectAllowed(flowBC, { source: "a", target: "b" }, all)).toBe(false);
  });

  it("rejects a re-route that closes a cycle", () => {
    // re-routing a→b into c→a would make a → b → c → a
    expect(reconnectAllowed(flowAB, { source: "c", target: "a" }, all)).toBe(false);
  });

  it("allows reversing an isolated edge (no cycle through others)", () => {
    const only = [flowAB];
    expect(reconnectAllowed(flowAB, { source: "b", target: "a" }, only)).toBe(true);
  });

  it("loop edges: the review end stays fixed", () => {
    expect(reconnectAllowed(loopRA, { source: "b", target: "a" }, all)).toBe(false);
  });

  it("loop edges: new return target must be a flow-ancestor of the review", () => {
    expect(reconnectAllowed(loopRA, { source: "r", target: "b" }, all)).toBe(true);  // b is upstream of r
    expect(reconnectAllowed(loopRA, { source: "r", target: "x" }, all)).toBe(false); // x is not
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/builder/graph.test.ts -t reconnectAllowed`
Expected: FAIL — `reconnectAllowed` is not exported.

- [ ] **Step 3: Implement**

```ts
/** May `oldEdge` be re-routed to `conn`? Mirrors the onConnect guards (no
 *  self-links, no duplicates, no cycles) with the old edge excluded from the
 *  checks; loop edges keep their review end and may only return to one of the
 *  review's flow-ancestors. */
export function reconnectAllowed(
  oldEdge: StageEdge,
  conn: { source: string; target: string },
  edges: StageEdge[],
): boolean {
  if (!conn.source || !conn.target || conn.source === conn.target) return false;
  const others = edges.filter((e) => e.id !== oldEdge.id);
  const flow = others.filter((e) => (e.data?.kind ?? "flow") === "flow");

  if ((oldEdge.data?.kind ?? "flow") === "flow") {
    if (flow.some((e) => e.source === conn.source && e.target === conn.target)) return false;
    return !flowAncestors(conn.source, flow).has(conn.target);
  }

  // Loop: the review keeps ownership; only the return target may move.
  if (conn.source !== oldEdge.source) return false;
  if (others.some((e) => e.data?.kind === "loop" && e.source === conn.source && e.target === conn.target)) return false;
  return flowAncestors(conn.source, flow).has(conn.target);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/builder/graph.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/builder/graph.ts src/components/builder/graph.test.ts
git commit -m "feat(builder): reconnect guard mirroring the connect rules

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Edge visuals — CSS-driven strokes, hover/selected states, disconnect pill

**Files:**
- Modify: `src/components/builder/edges.tsx` (full rewrite below)
- Modify: `src/components/builder/BuilderContext.tsx` (add `onDisconnect`)
- Modify: `src/styles.css` (edge + handle rules in the `.octo-flow` block, around line 600)
- Test: Create `src/components/builder/edges.test.tsx`

**Interfaces:**
- Consumes: `useBuilder()` from `./BuilderContext`.
- Produces: `BuilderCtx` gains `onDisconnect: (edgeId: string) => void` (wired in Task 10; until then `PipelineBuilder` must pass a stub — see Step 4). Edge components stop taking inline strokes; styling keys off `.react-flow__edge-flow` / `.react-flow__edge-loop` wrapper classes that @xyflow derives from the edge `type`.

- [ ] **Step 1: Read `src/components/builder/BuilderContext.tsx`, then add the callback**

Add to the `BuilderCtx` interface: `onDisconnect: (edgeId: string) => void;` (same style as `onRemove`). In `PipelineBuilder.tsx`, extend the `BuilderProvider` value with a temporary no-op `onDisconnect: () => {}` so the app compiles until Task 10 wires it (Task 10 replaces it — grep for `onDisconnect: () => {}` then).

- [ ] **Step 2: Write the failing component test**

```tsx
// src/components/builder/edges.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// BaseEdge/EdgeLabelRenderer need a live @xyflow store in jsdom — stub the lib
// to thin shells (same approach as PipelineBuilder.test.tsx).
vi.mock("@xyflow/react", async () => {
  const React = await import("react");
  return {
    BaseEdge: ({ path }: any) => React.createElement("div", { "data-testid": "base-edge", "data-path": path }),
    EdgeLabelRenderer: ({ children }: any) => React.createElement(React.Fragment, null, children),
    getSmoothStepPath: () => ["M0,0 L10,10", 5, 5],
  };
});

const { FlowEdge, LoopEdge } = await import("./edges");
const { BuilderProvider } = await import("./BuilderContext");

const edgeProps = {
  id: "f-a-b",
  source: "a",
  target: "b",
  sourceX: 0, sourceY: 0, targetX: 10, targetY: 10,
  sourcePosition: "bottom", targetPosition: "top",
} as any;

function renderEdge(Comp: any, props: any, onDisconnect = vi.fn()) {
  render(
    <BuilderProvider value={{ validation: {}, selectedId: null, onRemove: vi.fn(), canRemove: true, onDisconnect }}>
      <Comp {...props} />
    </BuilderProvider>,
  );
  return onDisconnect;
}

describe("edges — disconnect pill", () => {
  it("shows no pill while the edge is unselected", () => {
    renderEdge(FlowEdge, { ...edgeProps, selected: false });
    expect(screen.queryByLabelText("Disconnect")).toBeNull();
  });

  it("selected flow edge shows the pill; clicking it disconnects", () => {
    const onDisconnect = renderEdge(FlowEdge, { ...edgeProps, selected: true });
    const pill = screen.getByLabelText("Disconnect");
    expect(pill.getAttribute("title")).toContain("Backspace");
    fireEvent.click(pill);
    expect(onDisconnect).toHaveBeenCalledWith("f-a-b");
  });

  it("selected loop edge shows the pill too (equivalent to \"don't loop\")", () => {
    const onDisconnect = renderEdge(LoopEdge, {
      ...edgeProps, id: "l-r-a", selected: true, data: { kind: "loop", loopMax: 3, loopMode: "gated" },
    });
    fireEvent.click(screen.getByLabelText("Disconnect"));
    expect(onDisconnect).toHaveBeenCalledWith("l-r-a");
  });

  it("keeps the ⟲ badge on loop edges", () => {
    renderEdge(LoopEdge, { ...edgeProps, id: "l-r-a", selected: false, data: { kind: "loop", loopMax: 3, loopMode: "auto" } });
    expect(screen.getByText(/⟲ ×3/)).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/components/builder/edges.test.tsx`
Expected: FAIL — no pill rendered, `onDisconnect` missing from context type.

- [ ] **Step 4: Rewrite `edges.tsx`**

```tsx
// src/components/builder/edges.tsx
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from "@xyflow/react";
import { X } from "lucide-react";
import type { EdgeData } from "./graph";
import { useBuilder } from "./BuilderContext";

/** Midpoint ✕ shown while an edge is selected — the visible way to part two
 *  stages (Backspace works too once selected; the tooltip teaches it). */
function DisconnectPill({ edgeId, x, y }: { edgeId: string; x: number; y: number }) {
  const { onDisconnect } = useBuilder();
  return (
    <EdgeLabelRenderer>
      <button
        type="button"
        aria-label="Disconnect"
        title="Disconnect — or press Backspace"
        onClick={(e) => {
          e.stopPropagation();
          onDisconnect(edgeId);
        }}
        className="octo-pop-in nopan nodrag pointer-events-auto absolute flex h-5 w-5 items-center justify-center rounded-full border border-[var(--brass-dim)] bg-octo-onyx text-octo-brass transition-colors duration-[150ms] hover:border-octo-rouge hover:text-octo-rouge"
        style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
      >
        <X size={11} strokeWidth={2} />
      </button>
    </EdgeLabelRenderer>
  );
}

/** A flow dependency: a calm brass hairline with an arrowhead. Stroke lives in
 *  styles.css (.octo-flow) so hover/selected states can restyle it — an inline
 *  stroke here would override them. */
export function FlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, markerEnd }: EdgeProps) {
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 10 });
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} />
      {selected && <DisconnectPill edgeId={id} x={labelX} y={labelY} />}
    </>
  );
}

/** A loop back-edge from a review stage to an ancestor: a dashed brass arc with
 *  a small `⟲ ×N` pill so the loop reads at a glance even when zoomed out. */
export function LoopEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, markerEnd }: EdgeProps) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 14,
  });
  const d = data as EdgeData | undefined;
  const max = d?.loopMax ?? 2;
  const auto = d?.loopMode === "auto";
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        <div
          // nopan/nodrag so a click on the badge doesn't pan the canvas.
          className="nopan nodrag pointer-events-none absolute rounded-sm border border-[var(--brass-dim)] bg-octo-onyx/90 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-octo-brass"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          title={auto ? "Loops automatically on a parsed verdict" : "Pauses for your decision before looping"}
        >
          ⟲ ×{max}
          {auto ? " · auto" : ""}
        </div>
      </EdgeLabelRenderer>
      {/* Sits just above the ⟲ badge so both stay legible. */}
      {selected && <DisconnectPill edgeId={id} x={labelX} y={labelY - 22} />}
    </>
  );
}
```

- [ ] **Step 5: Add the CSS** (inside the existing `.octo-flow` section of `src/styles.css`, after the `.react-flow__connection-path` rule; keep rule order exactly — resting → loop → hover → selected — so specificity ties resolve by order)

```css
/* Edge strokes are CSS-owned so interaction states can restyle them.
   Wrapper classes .react-flow__edge-flow / -loop derive from the edge `type`. */
.octo-flow .react-flow__edge { cursor: pointer; }
.octo-flow .react-flow__edge .react-flow__edge-path {
  stroke: var(--brass-rule-dim);
  stroke-width: 1.5;
  transition: stroke var(--dur-quick) var(--ease-octo);
}
.octo-flow .react-flow__edge-loop .react-flow__edge-path {
  stroke: var(--brass-dim);
  stroke-dasharray: 4 4;
}
.octo-flow .react-flow__edge:hover .react-flow__edge-path { stroke: var(--brass-line); }
.octo-flow .react-flow__edge.selected .react-flow__edge-path { stroke: var(--color-octo-brass, #d4a574); }

/* Forgiving grab target around the 9px handles (the visual stays 9px). */
.octo-flow .react-flow__handle::after {
  content: "";
  position: absolute;
  inset: -8px;
  border-radius: 9999px;
}
```

Then **delete** the now-duplicated pre-existing rule `.octo-flow .react-flow__edge.selected .react-flow__edge-path { ... }` at the end of the block (it moved into the ordered group above).

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run src/components/builder/edges.test.tsx && npm run typecheck`
Expected: 4 passed; typecheck clean (BuilderContext + provider updated).

- [ ] **Step 7: Commit**

```bash
git add src/components/builder/edges.tsx src/components/builder/BuilderContext.tsx src/components/PipelineBuilder.tsx src/styles.css src/components/builder/edges.test.tsx
git commit -m "feat(builder): edge hover/selected states + disconnect pill (fixes invisible selection)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: StageInspector — dock layout + regrouped sections + escalation Reveal

**Files:**
- Modify: `src/components/builder/StageInspector.tsx`
- Test: `src/components/builder/StageInspector.test.tsx` (append tests; existing ones must stay green)

**Interfaces:**
- Props unchanged. Layout contract changes: the root is now `flex h-full min-h-0 flex-col` with **no** width/border/rounded/backdrop (the dock frames it — Task 6). Header is fixed; the form body scrolls (`flex-1 min-h-0 overflow-y-auto`).

- [ ] **Step 1: Write the failing tests** (append)

```tsx
describe("StageInspector — escalation disclosure", () => {
  it("collapses escalation by default on an unconfigured stage", () => {
    renderInspector({ escalateModel: null, escalateEffort: null });
    const toggle = screen.getByRole("button", { name: /escalate on failure/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens when the stage already has an escalation model", () => {
    renderInspector({ escalateModel: "claude-opus-4-6" });
    const toggle = screen.getByRole("button", { name: /escalate on failure/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("toggles open on click", () => {
    renderInspector({ escalateModel: null, escalateEffort: null });
    const toggle = screen.getByRole("button", { name: /escalate on failure/i });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/builder/StageInspector.test.tsx`
Expected: new tests FAIL (no disclosure button); old ones pass.

- [ ] **Step 3: Restructure the component**

Keep every existing control and handler. Changes only in structure/wrapping:

1. Add imports: `useState` (alongside `useRef`), `ChevronRight` from `lucide-react`, `Reveal` is already imported.
2. Root div: replace
   `className="octo-rise-in flex w-[300px] flex-col gap-4 overflow-y-auto rounded-lg border border-octo-hairline bg-octo-panel/95 p-4 backdrop-blur-sm"`
   with
   `className="flex h-full min-h-0 flex-col"`.
3. Header block (the existing archetype eyebrow + name + close ✕) becomes the fixed top: wrap it in
   `<div className="flex items-start justify-between border-b border-octo-hairline px-4 py-3">…</div>`.
4. Everything below the header moves into a scrollable body:
   `<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">…all sections…</div>`.
5. Regroup with hairline-topped sections in this order (each later group opens with `<div className="flex flex-col gap-4 border-t border-octo-hairline pt-4">`):
   - *(no divider)* issue banner, Name, Archetype
   - Engine group: Model, Reasoning, Escalation disclosure (below)
   - Execution group: Substrate+Approval row, Tools, Max turns
   - Instructions group: Instructions textarea
   - Loop `Reveal` (unchanged, keeps its own `border-t`)
6. Escalation disclosure — replace the current always-open escalate block with:

```tsx
{/* Escalate on failure — collapsed until configured; ~180px of controls that
    most stages never touch stay out of the scroll path. */}
const [escalateOpen, setEscalateOpen] = useState(
  data.escalateModel !== null || data.escalateEffort !== null,
);
```

(the `useState` goes at the top of the component with the other hooks), and in the Engine group:

```tsx
<div className="flex flex-col gap-2">
  <button
    type="button"
    aria-expanded={escalateOpen}
    onClick={() => setEscalateOpen((v) => !v)}
    title="If this stage fails, retry once with this model/effort before halting."
    className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-octo-mute transition-colors duration-[150ms] hover:text-octo-sage"
  >
    <ChevronRight
      size={11}
      strokeWidth={1.75}
      className={`transition-transform duration-[220ms] ${escalateOpen ? "rotate-90" : ""}`}
    />
    Escalate on failure
    {(data.escalateModel || data.escalateEffort) && (
      <span className="h-1 w-1 rounded-full bg-octo-brass" aria-label="Escalation configured" />
    )}
  </button>
  <Reveal open={escalateOpen}>
    <div className="flex flex-col gap-2">
      {/* …the existing escalate ModelPicker row and SegmentedControl move here verbatim… */}
    </div>
  </Reveal>
</div>
```

- [ ] **Step 4: Run the inspector tests**

Run: `npx vitest run src/components/builder/StageInspector.test.tsx`
Expected: all pass. (The old escalation tests exercise controls inside the Reveal; when `escalateModel` is preset the Reveal is open. The `"— none —"` test renders with the Reveal closed — content stays mounted, so `getByText` still finds it.)

- [ ] **Step 5: Commit**

```bash
git add src/components/builder/StageInspector.tsx src/components/builder/StageInspector.test.tsx
git commit -m "feat(builder): inspector adopts dock layout — grouped sections, escalation disclosure

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: PipelineBuilder — the dock column

**Files:**
- Modify: `src/components/PipelineBuilder.tsx`
- Test: `src/components/PipelineBuilder.test.tsx` (adjust stub if needed; add dock test)

**Interfaces:**
- Consumes: restructured `StageInspector` (Task 5).
- Produces: the inspector no longer renders inside a React Flow `Panel`; it renders in a sibling dock column. Escape closes the dock. Selection semantics unchanged (`selectedId`).

- [ ] **Step 1: Write the failing test** (append to `PipelineBuilder.test.tsx`)

```tsx
describe("stage dock", () => {
  it("renders the inspector outside the flow canvas, inside the dock region", () => {
    render(<PipelineBuilder pipeline={null} onClose={vi.fn()} />);
    // A fresh pipeline seeds one implement node; select it through the canvas.
    fireEvent.click(screen.getByTestId("flow-node-select")); // helper added below
    const dock = screen.getByTestId("stage-dock");
    expect(within(dock).getByLabelText("Stage name")).toBeTruthy();
    const flow = screen.getByTestId("flow");
    expect(within(flow).queryByLabelText("Stage name")).toBeNull();
  });

  it("Escape closes the dock", () => {
    render(<PipelineBuilder pipeline={null} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("flow-node-select"));
    expect(screen.getByTestId("stage-dock").getAttribute("data-open")).toBe("true");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("stage-dock").getAttribute("data-open")).toBe("false");
  });
});
```

Stub change to make selection reachable: in the test file's `ReactFlow` mock, render a button that fires `onNodeClick` for the first node:

```tsx
    ReactFlow: ({ children, nodes, nodeTypes, onNodeClick }: any) =>
      React.createElement(
        "div",
        { "data-testid": "flow" },
        React.createElement("button", {
          "data-testid": "flow-node-select",
          onClick: () => nodes?.[0] && onNodeClick?.({}, nodes[0]),
        }),
        (nodes ?? []).map((n: any) => { /* …existing node rendering… */ }),
        children,
      ),
```

Also add `within` to the testing-library import line.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/PipelineBuilder.test.tsx`
Expected: new tests FAIL (`stage-dock` not found).

- [ ] **Step 3: Implement the dock**

In `BuilderInner`:

1. Add dock-content lag state so the close animation has content to show:

```tsx
  // The dock keeps its content mounted through the close animation; the
  // rendered node lags selection by one width transition when closing.
  const [dockNode, setDockNode] = useState<StageNodeT | null>(null);
  useEffect(() => {
    if (selectedNode) setDockNode(selectedNode);
  }, [selectedNode]);
  const dockOpen = selectedNode !== null;
```

2. Escape handler (skip while the Role Editor modal is up — ModalShell owns Escape there):

```tsx
  const editorOpenRef = useRef(false);
  editorOpenRef.current = editorState !== null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !editorOpenRef.current) setSelectedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
```

3. Replace the canvas block: wrap canvas + dock in a row; **remove** the `selectedNode && <Panel position="top-right">…` block entirely; add the dock as the wrapper's sibling:

```tsx
      <div className="flex min-h-0 flex-1">
        <div ref={wrapperRef} className="octo-flow relative min-h-0 flex-1" onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
          {/* …BuilderProvider + ReactFlow exactly as before, minus the inspector Panel… */}
        </div>

        {/* Stage dock — outside the flow's overflow, so it can never clip. */}
        <div
          data-testid="stage-dock"
          data-open={dockOpen}
          aria-hidden={!dockOpen}
          onTransitionEnd={() => {
            if (!dockOpen) setDockNode(null);
          }}
          className={`shrink-0 overflow-hidden border-l bg-octo-panel transition-[width,border-color] duration-[280ms] ease-[var(--ease-octo)] ${
            dockOpen ? "w-[320px] border-octo-hairline" : "w-0 border-transparent"
          }`}
        >
          {dockNode && (
            <div className="h-full w-[320px]" inert={!dockOpen}>
              <StageInspector
                key={dockNode.id}
                node={dockNode}
                ancestors={loopTargets}
                loop={loopState}
                issue={validation.byNode[dockNode.id]}
                onPatch={(p) => patchData(dockNode.id, p)}
                onSetLoop={setLoop}
                onClose={() => setSelectedId(null)}
              />
            </div>
          )}
        </div>
      </div>
```

Note: `loopTargets`/`loopState` still derive from `selectedId`; while closing (`selectedId === null`, `dockNode` lingering) the content is `inert` so stale props are fine.

4. Reduced-motion note: the global `prefers-reduced-motion` block in `styles.css` disables animations; verify it also neutralizes transition utilities (grep `prefers-reduced-motion` in `styles.css`; if transitions aren't covered, the width transition simply completes instantly — `onTransitionEnd` may not fire, which is safe because the content is `inert` and 0-width).

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/components/PipelineBuilder.test.tsx`
Expected: all pass (existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/components/PipelineBuilder.tsx src/components/PipelineBuilder.test.tsx
git commit -m "feat(builder): docked stage inspector — structurally unclippable

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Corner chrome — view cluster, responsive minimap, collapsible palette

**Files:**
- Modify: `src/components/PipelineBuilder.tsx`
- Modify: `src/components/builder/NodePalette.tsx`
- Test: `src/components/PipelineBuilder.test.tsx` (palette collapse test)

**Interfaces:**
- `NodePalette` gains props `open: boolean; onToggle: () => void` (parent-owned so the state survives palette re-renders).
- `Controls` and `MiniMap` both move to `position="bottom-right"`; `Controls` clears the minimap with a margin that collapses when the minimap hides (canvas < 560px wide).

- [ ] **Step 1: Write the failing test**

```tsx
describe("palette collapse", () => {
  it("collapses to a pill and back", () => {
    render(<PipelineBuilder pipeline={null} onClose={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("Hide stage palette"));
    expect(screen.queryByText("Plan & design")).toBeNull();
    fireEvent.click(screen.getByLabelText("Show stage palette"));
    expect(screen.getByText("Plan & design")).toBeTruthy();
  });
});
```

(The seeded test roles put "Plan" in the "Plan & design" group, so the group header is a reliable expanded-marker.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/PipelineBuilder.test.tsx -t "palette collapse"`
Expected: FAIL — no `Hide stage palette` control.

- [ ] **Step 3: Implement `NodePalette` collapse**

In `NodePalette.tsx`: add `open: boolean; onToggle: () => void;` to `Props`; import `ChevronsDownUp, ChevronsUpDown` from `lucide-react` (replacing nothing). At the top of the component:

```tsx
  if (!open) {
    return (
      <button
        type="button"
        aria-label="Show stage palette"
        title="Show stage palette"
        onClick={onToggle}
        className="octo-fade-in flex items-center gap-1.5 rounded-lg border border-octo-hairline bg-octo-panel/95 px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.25em] text-octo-brass backdrop-blur-sm transition-colors duration-[150ms] hover:bg-[var(--brass-ghost)]"
      >
        Stages
        <ChevronsUpDown size={11} strokeWidth={1.75} />
      </button>
    );
  }
```

And in the expanded card's header row, replace the bare `<p>Stages</p>` with a row carrying the collapse control:

```tsx
      <div className="flex items-center justify-between px-1 pb-1">
        <p className="font-mono text-[9px] uppercase tracking-[0.25em] text-octo-brass">Stages</p>
        <button
          type="button"
          aria-label="Hide stage palette"
          title="Hide stage palette"
          onClick={onToggle}
          className="flex h-5 w-5 items-center justify-center rounded-sm text-octo-mute transition-colors duration-[150ms] hover:text-octo-brass"
        >
          <ChevronsDownUp size={11} strokeWidth={1.75} />
        </button>
      </div>
```

Also change the list cap from `max-h-[56vh]` to `max-h-[min(48vh,420px)]` so the palette never reaches the canvas's bottom third.

- [ ] **Step 4: Wire in `PipelineBuilder`**

```tsx
  const [paletteOpen, setPaletteOpen] = useState(true);
```

```tsx
            <Panel position="top-left">
              <NodePalette
                open={paletteOpen}
                onToggle={() => setPaletteOpen((v) => !v)}
                onAdd={addNode}
                onNewRole={() => setEditorState({})}
                onEditRole={(role) => setEditorState({ initial: role })}
              />
            </Panel>
```

- [ ] **Step 5: View cluster + responsive minimap**

1. Canvas width tracking (jsdom-safe — `ResizeObserver` is polyfilled in `src/test-setup.ts`):

```tsx
  // The minimap is a luxury; below this canvas width it yields the corner.
  const MINIMAP_MIN_CANVAS = 560;
  const [canvasWidth, setCanvasWidth] = useState(Number.POSITIVE_INFINITY);
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setCanvasWidth(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const miniMapShown = canvasWidth >= MINIMAP_MIN_CANVAS;
```

2. Replace the `Controls` and `MiniMap` elements:

```tsx
            <Controls
              showInteractive={false}
              position="bottom-right"
              className={`octo-flow-controls !mr-4 transition-[margin] duration-[280ms] ${
                miniMapShown ? "!mb-[178px]" : "!mb-4"
              }`}
            />
            <MiniMap
              pannable
              zoomable
              position="bottom-right"
              className={`octo-flow-minimap !m-4 transition-opacity duration-[220ms] ${
                miniMapShown ? "" : "pointer-events-none opacity-0"
              }`}
              maskColor={`${tokens.onyx}b8`}
              nodeColor={() => tokens.hairline}
              nodeStrokeColor={() => tokens.brassDim}
            />
```

(`178px` = 16 minimap margin + 150 minimap height + 12 gap. The default `Controls` bottom-left corner is now permanently empty.)

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run src/components/PipelineBuilder.test.tsx && npm run typecheck`
Expected: green. (The test stub renders `Controls`/`MiniMap` as `() => null` — position props are ignored there.)

- [ ] **Step 7: Commit**

```bash
git add src/components/PipelineBuilder.tsx src/components/builder/NodePalette.tsx src/components/PipelineBuilder.test.tsx
git commit -m "feat(builder): corner-owned chrome — collapsible palette, bottom-right view cluster, responsive minimap

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Undo/redo wiring, toolbar, keyboard shortcuts

**Files:**
- Modify: `src/components/PipelineBuilder.tsx`
- Test: `src/components/PipelineBuilder.test.tsx`

**Interfaces:**
- Consumes: Task 1's `history.ts` API.
- Produces: `applyUndo()` / `applyRedo()` callbacks + `pushHistory(key?)` used by Tasks 9–10. Top-right canvas toolbar with Undo/Redo (Tidy button lands in Task 9). `⌘Z`/`⇧⌘Z` (`Ctrl` elsewhere), suppressed while typing.

- [ ] **Step 1: Write the failing tests**

```tsx
describe("undo/redo", () => {
  it("undoes an added node and redoes it", async () => {
    render(<PipelineBuilder pipeline={null} onClose={vi.fn()} />);
    // Palette click-adds a Plan node (seeded role) on top of the initial implement node.
    fireEvent.click(screen.getByText("Plan"));
    expect(await screen.findByText(/2 stages/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Undo/));
    expect(await screen.findByText(/1 stage ·/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Redo/));
    expect(await screen.findByText(/2 stages/)).toBeTruthy();
  });

  it("⌘Z triggers undo", async () => {
    render(<PipelineBuilder pipeline={null} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Plan"));
    expect(await screen.findByText(/2 stages/)).toBeTruthy();
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    expect(await screen.findByText(/1 stage ·/)).toBeTruthy();
  });

  it("⌘Z inside a text input is left to the field", async () => {
    render(<PipelineBuilder pipeline={null} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Plan"));
    expect(await screen.findByText(/2 stages/)).toBeTruthy();
    const name = screen.getByLabelText("Pipeline name");
    fireEvent.keyDown(name, { key: "z", metaKey: true });
    expect(screen.getByText(/2 stages/)).toBeTruthy(); // graph untouched
  });

  it("undo buttons disable at the stack ends", () => {
    render(<PipelineBuilder pipeline={null} onClose={vi.fn()} />);
    expect((screen.getByLabelText(/Undo/) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText(/Redo/) as HTMLButtonElement).disabled).toBe(true);
  });
});
```

(Footer copy today is `` `${nodes.length} stages · ready` `` / `"1 stage"` — the regexes match it; adjust only if validation warnings change the readout: the fresh 2-node graph has an unconnected-node warning, so the readout shows the warning instead. **Therefore**: assert on the warning text instead for the 2-node state: `expect(await screen.findByText(/isn't connected/)).toBeTruthy();` and on `/1 stage/` after undo. Use these exact assertions:)

```tsx
    // 2-node state → orphan warning readout; 1-node state → "1 stage · ready".
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/PipelineBuilder.test.tsx -t "undo"`
Expected: FAIL — no Undo control.

- [ ] **Step 3: Implement**

1. Imports: `import { createHistory, pushSnapshot, undo as undoHistory, redo as redoHistory, canUndo, canRedo, type GraphSnapshot } from "./builder/history";` and `import { Undo2, Redo2 } from "lucide-react";` and `useReducer` from react.

2. Refs + stack:

```tsx
  // Latest graph refs so history callbacks never capture stale state.
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;

  const historyRef = useRef(createHistory());
  const [, bumpHistory] = useReducer((c: number) => c + 1, 0);

  const pushHistory = useCallback((key: string | null = null) => {
    historyRef.current = pushSnapshot(
      historyRef.current,
      { nodes: nodesRef.current, edges: edgesRef.current },
      key,
    );
    bumpHistory();
  }, []);

  const applySnapshot = useCallback(
    (snap: GraphSnapshot) => {
      setNodes(snap.nodes);
      setEdges(snap.edges);
      setSelectedId((id) => (id && snap.nodes.some((n) => n.id === id) ? id : null));
    },
    [setNodes, setEdges],
  );

  const applyUndo = useCallback(() => {
    const r = undoHistory(historyRef.current, { nodes: nodesRef.current, edges: edgesRef.current });
    if (!r) return;
    historyRef.current = r.stack;
    applySnapshot(r.restored);
    bumpHistory();
  }, [applySnapshot]);

  const applyRedo = useCallback(() => {
    const r = redoHistory(historyRef.current, { nodes: nodesRef.current, edges: edgesRef.current });
    if (!r) return;
    historyRef.current = r.stack;
    applySnapshot(r.restored);
    bumpHistory();
  }, [applySnapshot]);
```

Note: `setSelectedId` must accept a function — it already does (plain `useState`).

3. Record at every mutation site (**before** the mutation):
   - `addNode`: first line `pushHistory();`
   - `onConnect`: after the guards pass, right before `setEdges`: `pushHistory();`
   - `patchData`: first line `pushHistory(\`patch:${id}:${Object.keys(partial).sort().join("+")}\`);`
   - `setLoop`: first line (inside the `if (!selectedId) return;` guard): `pushHistory(\`loop:${selectedId}\`);`
   - `onBeforeDelete`: in the success path, before `return true`: `pushHistory();` (covers node ✕, Backspace on nodes **and** edges — `deleteElements` and keyboard deletes both pass through it)
   - drag: add to `<ReactFlow …>`: `onNodeDragStart={() => pushHistory()}` (captures the pre-drag position; the post-drag state is "present")

4. Keyboard — extend the Task 6 Escape effect (one listener):

```tsx
  useEffect(() => {
    const isEditable = (t: EventTarget | null) =>
      t instanceof HTMLElement &&
      (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !editorOpenRef.current) {
        setSelectedId(null);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !isEditable(e.target)) {
        e.preventDefault();
        if (e.shiftKey) applyRedo();
        else applyUndo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [applyUndo, applyRedo]);
```

5. Toolbar panel (inside `<ReactFlow>`, after the palette `Panel`) — ghost icons in one quiet card (no nested borders):

```tsx
            <Panel position="top-right" className="!m-3">
              <div className="octo-fade-in flex items-center gap-1 rounded-lg border border-octo-hairline bg-octo-panel/95 p-1 backdrop-blur-sm">
                <button
                  type="button"
                  aria-label="Undo (⌘Z)"
                  title="Undo (⌘Z)"
                  disabled={!canUndo(historyRef.current)}
                  onClick={applyUndo}
                  className="flex h-6 w-6 items-center justify-center rounded-sm text-octo-sage transition-colors duration-[150ms] hover:text-octo-brass disabled:opacity-30"
                >
                  <Undo2 size={13} strokeWidth={1.75} />
                </button>
                <button
                  type="button"
                  aria-label="Redo (⇧⌘Z)"
                  title="Redo (⇧⌘Z)"
                  disabled={!canRedo(historyRef.current)}
                  onClick={applyRedo}
                  className="flex h-6 w-6 items-center justify-center rounded-sm text-octo-sage transition-colors duration-[150ms] hover:text-octo-brass disabled:opacity-30"
                >
                  <Redo2 size={13} strokeWidth={1.75} />
                </button>
              </div>
            </Panel>
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/components/PipelineBuilder.test.tsx`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/PipelineBuilder.tsx src/components/PipelineBuilder.test.tsx
git commit -m "feat(builder): undo/redo — snapshot history, toolbar, ⌘Z/⇧⌘Z

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Tidy button + animated re-layout

**Files:**
- Modify: `src/components/PipelineBuilder.tsx`
- Modify: `src/styles.css`
- Test: `src/components/PipelineBuilder.test.tsx`

**Interfaces:**
- Consumes: `tidyLayout` (Task 2), `pushHistory` (Task 8).
- Produces: Tidy button in the top-right toolbar; `.octo-flow--tidying` CSS hook.

- [ ] **Step 1: Write the failing test**

```tsx
describe("tidy", () => {
  it("re-lays nodes and is a single undo step", async () => {
    render(<PipelineBuilder pipeline={null} onClose={vi.fn()} />);
    fireEvent.click(screen.getByText("Plan")); // 2 nodes now
    fireEvent.click(screen.getByLabelText(/Tidy layout/));
    // Undo once: tidy reverted (still 2 nodes). Undo again: back to 1 node.
    fireEvent.click(screen.getByLabelText(/Undo/));
    expect(await screen.findByText(/isn't connected/)).toBeTruthy(); // 2-node orphan warning
    fireEvent.click(screen.getByLabelText(/Undo/));
    expect(await screen.findByText(/1 stage/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/PipelineBuilder.test.tsx -t tidy`
Expected: FAIL — no Tidy control.

- [ ] **Step 3: Implement**

1. Imports: add `tidyLayout` to the `./builder/graph` import list; `Network` to the `lucide-react` import.
2. State + callback:

```tsx
  const [tidying, setTidying] = useState(false);

  const runTidy = useCallback(() => {
    pushHistory();
    setTidying(true);
    setNodes((ns) => tidyLayout(ns, edgesRef.current));
    // Let the position transition play, then settle the viewport on the result.
    window.setTimeout(() => {
      setTidying(false);
      void rf.fitView({ padding: 0.25, maxZoom: 1, duration: 280 });
    }, 300);
  }, [pushHistory, setNodes, rf]);
```

3. Wrapper class: change the canvas wrapper `className` to include the hook:

```tsx
        <div ref={wrapperRef} className={`octo-flow relative min-h-0 flex-1 ${tidying ? "octo-flow--tidying" : ""}`} …>
```

4. Toolbar button (after Redo, same ghost style):

```tsx
                <button
                  type="button"
                  aria-label="Tidy layout"
                  title="Tidy layout — arrange stages on a clean grid"
                  onClick={runTidy}
                  className="flex h-6 w-6 items-center justify-center rounded-sm text-octo-sage transition-colors duration-[150ms] hover:text-octo-brass"
                >
                  <Network size={13} strokeWidth={1.75} />
                </button>
```

5. CSS (in the `.octo-flow` block of `styles.css`):

```css
/* Tidy: node moves glide instead of jumping. The class lives only for the
   move's duration, so normal drags stay unanimated. */
.octo-flow--tidying .react-flow__node {
  transition: transform var(--dur-standard) var(--ease-octo);
}
@media (prefers-reduced-motion: reduce) {
  .octo-flow--tidying .react-flow__node { transition: none; }
}
```

6. Test stub: the mocked `useReactFlow` already stubs `fitView` — confirm it accepts args (`fitView: () => {}` is fine).

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/components/PipelineBuilder.test.tsx`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/PipelineBuilder.tsx src/styles.css src/components/PipelineBuilder.test.tsx
git commit -m "feat(builder): tidy — animated layered auto-layout, one undo step

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Disconnect + reconnect wiring, hint chip

**Files:**
- Modify: `src/components/PipelineBuilder.tsx`
- Test: `src/components/PipelineBuilder.test.tsx`

**Interfaces:**
- Consumes: `reconnectAllowed` (Task 3), `onDisconnect` context slot (Task 4), `pushHistory` (Task 8).
- Produces: real `onDisconnect` in `BuilderProvider`; `onReconnect`/`onReconnectStart`/`onReconnectEnd` on `<ReactFlow>`; the first-use hint chip.

- [ ] **Step 1: Write the failing tests**

```tsx
describe("hint chip", () => {
  beforeEach(() => localStorage.removeItem("octo.builder.hint.connect"));

  it("appears with ≥2 nodes and no connections, and dismisses persistently", () => {
    render(<PipelineBuilder pipeline={null} onClose={vi.fn()} />);
    // 1 node → hidden (opacity-0 shell)
    expect(screen.getByTestId("connect-hint").className).toContain("opacity-0");
    fireEvent.click(screen.getByText("Plan")); // 2 nodes, 0 edges → visible
    expect(screen.getByTestId("connect-hint").className).not.toContain("opacity-0");
    fireEvent.click(screen.getByLabelText("Dismiss hint"));
    expect(screen.getByTestId("connect-hint").className).toContain("opacity-0");
    expect(localStorage.getItem("octo.builder.hint.connect")).toBe("1");
  });
});

describe("edge disconnect wiring", () => {
  it("onDisconnect removes the edge and records history", async () => {
    // Load a 2-stage pipeline WITH an edge, disconnect via context, undo restores it.
    const pipeline = {
      pipeline: { id: "p1", name: "P", description: "", isBuiltin: false },
      stages: [
        { position: 0, role: "plan", agentModel: "m", substrate: "api", checkpoint: false, maxIterations: 10, parents: [], posX: 0, posY: 0 },
        { position: 1, role: "implement", agentModel: "m", substrate: "api", checkpoint: false, maxIterations: 10, parents: [0], posX: 0, posY: 150 },
      ],
    } as any;
    render(<PipelineBuilder pipeline={pipeline} onClose={vi.fn()} />);
    expect(await screen.findByText(/2 stages · ready/)).toBeTruthy();
    fireEvent.click(screen.getAllByLabelText("Disconnect")[0]); // the real pill — see stub change below
    expect(await screen.findByText(/isn't connected/)).toBeTruthy(); // now orphaned
    fireEvent.click(screen.getByLabelText(/Undo/));
    expect(await screen.findByText(/2 stages · ready/)).toBeTruthy();
  });
});
```

Stub change so the real pill renders: the mocked `ReactFlow` must render edges through `edgeTypes` exactly as it renders nodes through `nodeTypes`, with every edge `selected: true` so the pill is present. The file's existing mock already exports `BaseEdge`, `EdgeLabelRenderer` (passthrough), and `getSmoothStepPath` — extend the `ReactFlow` mock's children with:

```tsx
        (props.edges ?? []).map((e: any) => {
          const Comp = props.edgeTypes?.[e.type];
          return Comp
            ? React.createElement(Comp, { key: e.id, id: e.id, data: e.data, selected: true, sourceX: 0, sourceY: 0, targetX: 0, targetY: 0, sourcePosition: "bottom", targetPosition: "top" })
            : null;
        }),
```

(The mock's `BaseEdge` must return `null` — it currently does — and `getSmoothStepPath` already returns `["M0,0", 0, 0]`.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/components/PipelineBuilder.test.tsx -t "hint chip|disconnect"`
Expected: FAIL.

- [ ] **Step 3: Implement**

1. Real disconnect (replace the Task 4 stub in the provider value):

```tsx
  const onDisconnectEdge = useCallback(
    (edgeId: string) => {
      pushHistory();
      setEdges((es) => es.filter((e) => e.id !== edgeId));
    },
    [pushHistory, setEdges],
  );
```

```tsx
        <BuilderProvider
          value={{ validation: validation.byNode, selectedId, onRemove: removeNode, canRemove: nodes.length > 1, onDisconnect: onDisconnectEdge }}
        >
```

2. Reconnect handlers + props. Import `reconnectAllowed` from `./builder/graph`.

```tsx
  // Reconnect drag: drop on a handle re-routes (guarded), drop on the pane deletes.
  const reconnectOk = useRef(true);
  const onReconnectStart = useCallback(() => {
    reconnectOk.current = false;
  }, []);
  const onReconnect = useCallback(
    (oldEdge: StageEdge, conn: Connection) => {
      reconnectOk.current = true;
      if (!conn.source || !conn.target) return;
      if (oldEdge.source === conn.source && oldEdge.target === conn.target) return;
      if (!reconnectAllowed(oldEdge, { source: conn.source, target: conn.target }, edgesRef.current)) return;
      pushHistory();
      const prefix = oldEdge.data?.kind === "loop" ? "l" : "f";
      setEdges((es) =>
        es.map((e) =>
          e.id === oldEdge.id
            ? { ...e, id: `${prefix}-${conn.source}-${conn.target}`, source: conn.source!, target: conn.target! }
            : e,
        ),
      );
    },
    [pushHistory, setEdges],
  );
  const onReconnectEnd = useCallback(
    (_: MouseEvent | TouchEvent, edge: StageEdge) => {
      if (!reconnectOk.current) {
        pushHistory();
        setEdges((es) => es.filter((e) => e.id !== edge.id));
      }
      reconnectOk.current = true;
    },
    [pushHistory, setEdges],
  );
```

On `<ReactFlow>`: `onReconnect={onReconnect} onReconnectStart={onReconnectStart} onReconnectEnd={onReconnectEnd}` (passing `onReconnect` is what makes edges reconnectable in v12). Also add `deleteKeyCode={["Backspace", "Delete"]}` so both keys remove the selected node/edge (the default is Backspace only); the existing `onBeforeDelete` guard still protects the last stage.

3. Hint chip. State + condition:

```tsx
  const HINT_KEY = "octo.builder.hint.connect";
  const [hintDismissed, setHintDismissed] = useState(() => localStorage.getItem(HINT_KEY) === "1");
  const hasFlowEdges = edges.some((e) => (e.data?.kind ?? "flow") === "flow");
  const hintVisible = !hintDismissed && nodes.length >= 2 && !hasFlowEdges;
```

Markup (inside `<ReactFlow>`, with the other panels — stays mounted so hide is a fade, never an abrupt unmount):

```tsx
            <Panel position="bottom-center" className="!mb-4">
              <div
                data-testid="connect-hint"
                aria-hidden={!hintVisible}
                className={`flex items-center gap-2 rounded-full border border-octo-hairline bg-octo-panel/95 px-3 py-1.5 font-mono text-[10px] text-octo-sage backdrop-blur-sm transition-opacity duration-[220ms] ${
                  hintVisible ? "" : "pointer-events-none opacity-0"
                }`}
              >
                Drag from a stage's edge to connect it
                <button
                  type="button"
                  aria-label="Dismiss hint"
                  title="Dismiss"
                  onClick={() => {
                    localStorage.setItem(HINT_KEY, "1");
                    setHintDismissed(true);
                  }}
                  className="flex h-4 w-4 items-center justify-center rounded-sm text-octo-mute transition-colors duration-[150ms] hover:text-octo-ivory"
                >
                  <X size={10} />
                </button>
              </div>
            </Panel>
```

Import `X` from `lucide-react` in `PipelineBuilder.tsx`.

- [ ] **Step 4: Run the full frontend suite**

Run: `npx vitest run`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/components/PipelineBuilder.tsx src/components/PipelineBuilder.test.tsx
git commit -m "feat(builder): edge disconnect + reconnect-drag + first-use connect hint

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: FEATURES.md, design-conformance sweep, gates

**Files:**
- Modify: `docs/FEATURES.md` (DIRECT → pipeline builder section)
- Verify: whole diff

- [ ] **Step 1: Update `docs/FEATURES.md`**

Locate the pipeline-builder entries (search "builder"). Update/add entries for: docked stage inspector (dock column, Esc/pane-click/✕ close, grouped sections, escalation disclosure); edge disconnect (hover/selected brass states, midpoint ✕ pill, Backspace, reconnect-drag re-route or drop-to-delete with guards); undo/redo (snapshot history, cap 100, ⌘Z/⇧⌘Z, toolbar); tidy auto-layout (layered, preserves row order, animated, single undo step); collapsible palette pill; bottom-right view cluster with responsive minimap (<560px hides); first-use connect hint chip (localStorage-dismissed). Follow the file's existing entry format (mechanism + components + commands).

- [ ] **Step 2: Design-conformance sweep of the branch diff**

```bash
git diff main... -- src | grep -nE "#[0-9a-fA-F]{3,8}" | grep -v "var(--color-octo-brass, #d4a574)"   # token fallbacks in styles.css are the only tolerated hex
git diff main... -- src | grep -nE "font-family|italic"
git diff main... -- src | grep -nE "⟶|§|✦"
```

Expected: no hits (the `var(--color-octo-brass, #d4a574)` fallback pattern matches the file's existing convention). Fix anything that surfaces.

- [ ] **Step 3: Gates**

```bash
npm run typecheck && npm test
```

Expected: both green.

- [ ] **Step 4: Manual smoke script** (for the user's visual pass — paste in the PR/summary)

1. DIRECT → edit a pipeline → select a stage: inspector docks right, full height, scrolls internally; footer bar never covers it at any window height.
2. Shrink the window: zoom controls stay visible bottom-right; minimap fades out below ~560px canvas width; palette collapses to "Stages" pill on demand.
3. Click an edge: brass highlight + midpoint ✕; ✕/Backspace disconnects; drag an edge end to the pane to delete, to another handle to re-route (cycles rejected).
4. ⌘Z/⇧⌘Z through adds/moves/edits; Tidy re-lays the graph with a glide, one ⌘Z reverts it.
5. Two unconnected stages → hint chip appears; connect them → it fades.

- [ ] **Step 5: Commit**

```bash
git add docs/FEATURES.md
git commit -m "docs: feature map — builder dock, edge disconnect, undo/redo, tidy, hints

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
