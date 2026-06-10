# Run Navigation — Plan N2 (Companion hub + launcher gate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give the user the affordances N1 enabled — clickable run rows + a `⟶ Begin a new run` CTA in the Companion (driving `selectRun`), and a gated **"Begin the run"** in the launcher while a run is executing.

**Architecture:** `CompanionRuns` becomes the run hub (rows → `selectRun(ws, id)`, CTA → `selectRun(ws, null)`, dual viewed/executing indicators). `PipelineSetup` gains an `executingRun` prop that disables Begin with a helper; `DirectCanvas` passes `hasExecutingRun(ws)`. Builds on N1 (same branch/PR).

**Tech Stack:** React 19 + TS + Zustand + Tailwind (Atelier tokens). Vitest.

**Spec:** `…/2026-06-09-direct-run-navigation-design.md` §4–§5. **Design rules:** serif-phrase brass CTA, `⟶` glyph, NO italics, English, tokens (no hex).

---

## File map
- **Modify** `src/components/PipelineSetup.tsx` — `executingRun` prop → disable Begin + helper.
- **Modify** `src/components/DirectCanvas.tsx` — pass `executingRun={hasExecutingRun(ws)}`.
- **Modify** `src/components/CompanionRuns.tsx` — clickable rows + `⟶ Begin a new run` CTA + viewed/executing indicators.
- **Create** `src/components/PipelineSetup.test.tsx`, `src/components/CompanionRuns.test.tsx`.

---

### Task 1: launcher gate (`PipelineSetup` + `DirectCanvas`)

**Files:** Modify `src/components/PipelineSetup.tsx`, `src/components/DirectCanvas.tsx`; create `src/components/PipelineSetup.test.tsx`.

- [ ] **Step 1 — Write the failing test** `src/components/PipelineSetup.test.tsx`. PipelineSetup pulls `usePipelineStore` + `ModelPicker` + `ipc.estimateRunCost`; mock them so a pipeline is "loaded" and the Begin button renders:
```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const PIPE = { pipeline: { id: "p1", name: "Feature Factory", description: "d", isBuiltin: true, createdAt: "t" },
  stages: [{ id: "s0", pipelineId: "p1", position: 0, role: "plan", agentModel: "m", substrate: "api", checkpoint: false,
    loopTargetPosition: null, loopMaxIterations: 0, loopMode: null }] };

vi.mock("../stores/pipelineStore", () => ({
  usePipelineStore: (sel: any) => sel({ pipelines: [PIPE], loaded: true, load: vi.fn(), error: null }),
}));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => <div /> }));
vi.mock("../lib/ipc", () => ({ ipc: { estimateRunCost: vi.fn().mockResolvedValue({ estimateUsd: 0.05, baselineUsd: 0.4 }) } }));

const { PipelineSetup } = await import("./PipelineSetup");

describe("PipelineSetup begin gate", () => {
  it("disables Begin + shows the helper when a run is executing", () => {
    render(<PipelineSetup defaultTask="build it" onBegin={vi.fn()} executingRun />);
    const begin = screen.getByRole("button", { name: /Begin the run/i });
    expect(begin).toBeDisabled();
    expect(screen.getByText(/A run is in progress/i)).toBeInTheDocument();
  });

  it("enables Begin when no run is executing and a task is set", () => {
    render(<PipelineSetup defaultTask="build it" onBegin={vi.fn()} executingRun={false} />);
    expect(screen.getByRole("button", { name: /Begin the run/i })).not.toBeDisabled();
    expect(screen.queryByText(/A run is in progress/i)).not.toBeInTheDocument();
  });
});
```
> Note: adapt the mocked `PIPE`/store-slice shape to the real `PipelineWithStages` / `usePipelineStore` selectors if they differ (read `PipelineSetup.tsx` + `pipelineStore.ts`). The test only needs a loaded pipeline so section III + the Begin button render.

- [ ] **Step 2 — Run, confirm FAIL:** `npx vitest run src/components/PipelineSetup 2>&1 | tail -20`.
- [ ] **Step 3 — Add the `executingRun` prop + gate.** In `PipelineSetup.tsx`:
  - `interface Props`: add `executingRun: boolean;`. Destructure it: `export function PipelineSetup({ defaultTask, onBegin, executingRun }: Props) {`.
  - Replace the Begin button block (the `<button … disabled={!task.trim()} …>Begin the run ⟶</button>`) with a column wrapper holding the button + helper:
```tsx
            <div className="ml-auto flex flex-col items-end gap-1.5">
              <button
                type="button"
                disabled={!task.trim() || executingRun}
                onClick={() => onBegin(selected.pipeline.id, task.trim(), overrideTuples())}
                className="rounded-lg bg-octo-brass px-5 py-2.5 font-serif text-base text-octo-onyx disabled:opacity-40"
              >
                Begin the run ⟶
              </button>
              {executingRun && (
                <p className="m-0 font-mono text-[10px] text-octo-mute">
                  A run is in progress — finish or abort it before starting another.
                </p>
              )}
            </div>
```
  (the `ml-auto` moves from the button to the wrapper.)
- [ ] **Step 4 — Pass it from DirectCanvas.** In `DirectCanvas.tsx`, add `const executingRun = useRunsStore((s) => s.hasExecutingRun(workspaceId));` near the other selectors, and pass `executingRun={executingRun}` to the `<PipelineSetup … />` in the launcher branch.
- [ ] **Step 5 — Run tests + typecheck:** `npx vitest run src/components/PipelineSetup src/components/DirectCanvas 2>&1 | tail -8`; `npm run typecheck`. (DirectCanvas's existing test mocks PipelineSetup, so the new prop won't break it; if DirectCanvas typecheck complains that `executingRun` is required, the mock in DirectCanvas.test already returns a stub component ignoring props — fine.)
- [ ] **Step 6 — Commit:**
```bash
git add src/components/PipelineSetup.tsx src/components/DirectCanvas.tsx src/components/PipelineSetup.test.tsx
git commit -m "feat(direct/nav-n2): gate 'Begin the run' while a run is executing"
```

---

### Task 2: Companion run hub (`CompanionRuns`)

**Files:** Modify `src/components/CompanionRuns.tsx`; create `src/components/CompanionRuns.test.tsx`.

Context: `CompanionRuns` lists runs and highlights `r.id === activeId`. Make rows clickable (`selectRun`), add the `⟶ Begin a new run` CTA, and split the highlight (viewed) from the running indicator (executing).

- [ ] **Step 1 — Write the failing test** `src/components/CompanionRuns.test.tsx`:
```tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("../lib/ipc", async (orig) => {
  const actual = await orig<any>();
  return { ...actual, ipc: { ...actual.ipc, listRuns: vi.fn().mockResolvedValue([]) } };
});

const { CompanionRuns } = await import("./CompanionRuns");
const { useRunsStore } = await import("../stores/runsStore");

const mkRun = (id: string, status: string) => ({ id, workspaceId: "w1", pipelineId: "p", task: `task ${id}`,
  status, costUsd: 0, baselineUsd: 0, referenceModel: null, linkedIssueKey: null, createdAt: "t", finishedAt: null });

describe("CompanionRuns hub", () => {
  beforeEach(() => {
    useRunsStore.setState({
      runsByWs: { w1: [mkRun("rRun", "running"), mkRun("rDone", "completed")] },
      activeRunIdByWs: { w1: "rRun" }, selectedRunIdByWs: {}, detailByRun: {}, selectedStageByRun: {},
    });
  });

  it("clicking a run row selects it for viewing", () => {
    render(<CompanionRuns workspaceId="w1" />);
    fireEvent.click(screen.getByText("task rDone"));
    expect(useRunsStore.getState().getViewedRunId("w1")).toBe("rDone");
  });

  it("'Begin a new run' selects the launcher (null)", () => {
    render(<CompanionRuns workspaceId="w1" />);
    fireEvent.click(screen.getByText(/Begin a new run/i));
    expect(useRunsStore.getState().getViewedRunId("w1")).toBe(null);
  });
});
```

- [ ] **Step 2 — Run, confirm FAIL:** `npx vitest run src/components/CompanionRuns 2>&1 | tail -20`.

- [ ] **Step 3 — Rebuild `CompanionRuns.tsx`.** Add store selectors `selectRun` + `getViewedRunId`; make rows buttons; add the CTA; split indicators:
```tsx
import { useEffect } from "react";
import { useRunsStore } from "../stores/runsStore";
import { runStatusMeta } from "../lib/runStatus";

interface Props { workspaceId: string; }

export function CompanionRuns({ workspaceId }: Props) {
  const loadRuns = useRunsStore((s) => s.loadRuns);
  const runs = useRunsStore((s) => s.getRuns(workspaceId));
  const activeId = useRunsStore((s) => s.getActiveRunId(workspaceId));
  const viewedId = useRunsStore((s) => s.getViewedRunId(workspaceId));
  const selectRun = useRunsStore((s) => s.selectRun);

  useEffect(() => { void loadRuns(workspaceId); }, [workspaceId, loadRuns]);

  return (
    <div className="border-b border-octo-hairline">
      <div className="flex items-center justify-between px-3.5 pb-1.5 pt-2.5">
        <span className="font-mono text-[9px] uppercase tracking-[0.13em] text-octo-brass">
          Runs <span className="text-octo-mute">· {runs.length}</span>
        </span>
        <button
          type="button"
          onClick={() => selectRun(workspaceId, null)}
          className="font-serif text-[12px] text-octo-brass hover:text-octo-ivory"
        >
          ⟶ Begin a new run
        </button>
      </div>
      {runs.length === 0 && (
        <div className="px-3.5 pb-3 font-mono text-[11px] text-octo-mute">No runs yet.</div>
      )}
      {runs.map((r) => {
        const meta = runStatusMeta(r.status);
        const executing = r.id === activeId;
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => selectRun(workspaceId, r.id)}
            className={`flex w-full flex-col gap-0.5 border-l-2 px-3.5 py-2 text-left octo-rise-in ${
              r.id === viewedId ? "border-octo-brass bg-[var(--brass-ghost)]" : "border-transparent hover:bg-octo-panel-2"
            }`}
          >
            <div className="truncate text-[12.5px] text-octo-ivory">{r.task || "(untitled run)"}</div>
            <div className="flex items-center gap-2 font-mono text-[10px] text-octo-sage">
              {executing && <span className="text-octo-brass">●</span>}
              <span className={meta.className}>{meta.label}</span>
              <span>· ${r.costUsd.toFixed(2)}</span>
              {r.linkedIssueKey && <span>· {r.linkedIssueKey}</span>}
            </div>
          </button>
        );
      })}
    </div>
  );
}
```
  (Highlight = `viewedId` (the run you're looking at); `●` brass dot = the executing run, independent of which is viewed.)

- [ ] **Step 4 — Run tests + typecheck + full sweep:** `npx vitest run src/components/CompanionRuns 2>&1 | tail -8`; `npm run typecheck`; `npx vitest run 2>&1 | grep -E "Test Files|Tests "`. If a `Companion.test.tsx` asserted the old read-only row markup, update it to the button form.

- [ ] **Step 5 — Commit:**
```bash
git add src/components/CompanionRuns.tsx src/components/CompanionRuns.test.tsx
git commit -m "feat(direct/nav-n2): Companion run hub — clickable rows + Begin-a-new-run CTA + dual indicators"
```

---

## Self-review (against spec §4–§5)

- **Clickable rows → `selectRun`; `⟶ Begin a new run` CTA → `selectRun(null)`; viewed (brass) vs executing (● dot) indicators** → Task 2. ✓
- **`PipelineSetup` `executingRun` gate + helper; `DirectCanvas` passes `hasExecutingRun`** → Task 1. ✓
- **Design rules:** serif brass CTA + `⟶`, no italics, English, tokens → Tasks 1/2. ✓
- **Out of scope (N3):** backend concurrency guard. ✓

**Type consistency:** `PipelineSetup` Props gains `executingRun: boolean` (passed by DirectCanvas via `hasExecutingRun`). `CompanionRuns` uses `selectRun(ws, string|null)` + `getViewedRunId` + `getActiveRunId` (all from N1). The CTA passes `null`; rows pass `r.id`.

**Note:** if `Companion.test.tsx` or another test mounts `CompanionRuns` and asserts the old `<div>` rows, switch the assertion to the `<button>`; the visible text (`task …`, status label) is unchanged.
