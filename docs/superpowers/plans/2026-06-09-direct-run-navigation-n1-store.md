# Run Navigation — Plan N1 (store + DirectCanvas viewed-run) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add a **viewed-run** axis to `runsStore` (separate from the executing run) and make `DirectCanvas` render the *viewed* run (or the launcher), loading its detail — the pivot that lets the Companion (N2) drive multi-run navigation.

**Architecture:** `runsStore` gains `selectedRunIdByWs` + `selectRun`/`getViewedRunId`/`hasExecutingRun`; `begin` auto-selects the new run. `DirectCanvas` switches from keying on `getActiveRunId` to `getViewedRunId`, fetching the viewed run's detail. No UI affordances yet (those are N2); behavior is identical to today until something calls `selectRun`.

**Tech Stack:** React 19 + TypeScript + Zustand. Vitest.

**Spec:** `docs/superpowers/specs/2026-06-09-direct-run-navigation-design.md` (§2, §3). N2 (Companion hub + launcher gate) and N3 (backend guard) are separate plans on the same branch.

---

## File map
- **Modify** `src/stores/runsStore.ts` — viewed-run state/actions/selectors + `begin` auto-select.
- **Modify** `src/stores/runsStore.test.ts` — viewed-run tests.
- **Modify** `src/components/DirectCanvas.tsx` — render the viewed run / launcher, load its detail.
- **Create** `src/components/DirectCanvas.test.tsx` — branch-selection test.

---

### Task 1: runsStore — the viewed-run axis

**Files:** Modify `src/stores/runsStore.ts`, `src/stores/runsStore.test.ts`.

- [ ] **Step 1 — Write the failing tests** (add inside the existing `describe("runsStore", …)` in `src/stores/runsStore.test.ts`; the `beforeEach` already resets store slices — extend it to also reset `selectedRunIdByWs: {}`):
```ts
  it("getViewedRunId defaults to the active run, honors an explicit selection, and null = launcher", () => {
    useRunsStore.setState({ activeRunIdByWs: { w1: "rActive" }, selectedRunIdByWs: {} });
    expect(useRunsStore.getState().getViewedRunId("w1")).toBe("rActive"); // default → active
    useRunsStore.getState().selectRun("w1", "rOther");
    expect(useRunsStore.getState().getViewedRunId("w1")).toBe("rOther");  // explicit run
    useRunsStore.getState().selectRun("w1", null);
    expect(useRunsStore.getState().getViewedRunId("w1")).toBe(null);      // launcher
  });

  it("hasExecutingRun reflects a non-terminal active run", () => {
    useRunsStore.setState({ activeRunIdByWs: { w1: "r1" } });
    expect(useRunsStore.getState().hasExecutingRun("w1")).toBe(true);
    useRunsStore.setState({ activeRunIdByWs: { w1: null } });
    expect(useRunsStore.getState().hasExecutingRun("w1")).toBe(false);
  });

  it("begin auto-selects the newly created run for viewing", async () => {
    (ipc.createRun as any).mockResolvedValue("rNew");
    (ipc.startRun as any).mockResolvedValue(undefined);
    (ipc.listRuns as any).mockResolvedValue([
      { id: "rNew", workspaceId: "w1", pipelineId: "p", task: "t", status: "running",
        costUsd: 0, baselineUsd: 0, referenceModel: null, linkedIssueKey: null, createdAt: "t", finishedAt: null },
    ]);
    await useRunsStore.getState().begin("w1", "p", "t", []);
    expect(useRunsStore.getState().getViewedRunId("w1")).toBe("rNew");
  });
```
(`ipc` is already mocked in this test file with `createRun`/`startRun`/`listRuns` as `vi.fn()`.)

- [ ] **Step 2 — Run, confirm FAIL:** `npx vitest run src/stores/runsStore 2>&1 | tail -20` (from worktree root).

- [ ] **Step 3 — Add the state + selectors + action.** In `src/stores/runsStore.ts`:
  - Interface (`RunsState`), after `selectedStageByRun`:
```ts
  /** The run the canvas is VIEWING per workspace. Absent = default (active run);
   *  null = the launcher (explicit "new run"); a runId = view that run. */
  selectedRunIdByWs: Record<string, string | null>;
```
  - Interface, after `getSelectedStageId`:
```ts
  getViewedRunId: (workspaceId: string) => string | null;
  hasExecutingRun: (workspaceId: string) => boolean;
  selectRun: (workspaceId: string, runId: string | null) => void;
```
  - Store body init (next to `selectedStageByRun: {}`): `selectedRunIdByWs: {},`
  - Store body getters (next to `getSelectedStageId`):
```ts
  getViewedRunId: (workspaceId) => {
    const sel = get().selectedRunIdByWs;
    return workspaceId in sel ? sel[workspaceId] : get().getActiveRunId(workspaceId);
  },
  hasExecutingRun: (workspaceId) => get().getActiveRunId(workspaceId) !== null,
  selectRun: (workspaceId, runId) =>
    set((s) => ({ selectedRunIdByWs: { ...s.selectedRunIdByWs, [workspaceId]: runId } })),
```
  - `begin`: append `get().selectRun(workspaceId, runId);` as the LAST line of the async body (after `await get().loadRuns(workspaceId);`).

- [ ] **Step 4 — Run, confirm PASS:** `npx vitest run src/stores/runsStore 2>&1 | tail -8`. `npm run typecheck` clean.

- [ ] **Step 5 — Commit:**
```bash
git add src/stores/runsStore.ts src/stores/runsStore.test.ts
git commit -m "feat(direct/nav-n1): viewed-run axis in runsStore (selectRun/getViewedRunId/hasExecutingRun)"
```

---

### Task 2: DirectCanvas — render the viewed run / launcher

**Files:** Modify `src/components/DirectCanvas.tsx`; create `src/components/DirectCanvas.test.tsx`.

Context: `DirectCanvas` currently reads `activeRunId = getActiveRunId(ws)`, `detail = getDetail(activeRunId)`, and renders `PipelineSetup` when `!activeRunId || !detail?.run`, else the run view from `detail`. Switch to the **viewed** run and load its detail when missing.

- [ ] **Step 1 — Write the failing test** `src/components/DirectCanvas.test.tsx` (mock the children to isolate the branch decision):
```tsx
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("./PipelineSetup", () => ({ PipelineSetup: () => <div>LAUNCHER</div> }));
vi.mock("./RunTrack", () => ({ RunTrack: () => <div>RUNVIEW</div>, labelForRole: (r: string) => r }));
vi.mock("./StageFocus", () => ({ StageFocus: () => <div /> }));
vi.mock("./CheckpointBar", () => ({ CheckpointBar: () => <div /> }));
vi.mock("./RunCostMeter", () => ({ RunCostMeter: () => <div /> }));

const { DirectCanvas } = await import("./DirectCanvas");
const { useRunsStore } = await import("../stores/runsStore");

const run = { id: "r1", workspaceId: "w1", pipelineId: "p", task: "t", status: "running",
  costUsd: 0, baselineUsd: 0, referenceModel: null, linkedIssueKey: null, createdAt: "t", finishedAt: null };

describe("DirectCanvas viewed-run routing", () => {
  beforeEach(() => {
    useRunsStore.setState({
      runsByWs: {}, activeRunIdByWs: {}, detailByRun: {}, selectedStageByRun: {},
      selectedRunIdByWs: {}, liveByStage: {},
    });
  });

  it("renders the launcher when the viewed run is null", () => {
    useRunsStore.getState().selectRun("w1", null);
    render(<DirectCanvas active workspaceId="w1" defaultTask="" linkedIssueKey={null} workspacePath="/tmp" />);
    expect(screen.getByText("LAUNCHER")).toBeInTheDocument();
  });

  it("renders the run view for the selected (non-active) run when its detail is loaded", () => {
    useRunsStore.setState({ detailByRun: { r1: { run, stages: [] } } });
    useRunsStore.getState().selectRun("w1", "r1");
    render(<DirectCanvas active workspaceId="w1" defaultTask="" linkedIssueKey={null} workspacePath="/tmp" />);
    expect(screen.getByText("RUNVIEW")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2 — Run, confirm FAIL:** `npx vitest run src/components/DirectCanvas 2>&1 | tail -20`.

- [ ] **Step 3 — Switch DirectCanvas to the viewed run.** In `src/components/DirectCanvas.tsx`:
  - Replace the selectors:
```tsx
  const loadRuns = useRunsStore((s) => s.loadRuns);
  const refreshDetail = useRunsStore((s) => s.refreshDetail);
  const viewedId = useRunsStore((s) => s.getViewedRunId(workspaceId));
  const detail = useRunsStore((s) => (viewedId ? s.getDetail(viewedId) : undefined));
  const selectedStageId = useRunsStore((s) => (viewedId ? s.getSelectedStageId(viewedId) : null));
```
  (keep `selectStage`, `begin`, `resolve`, `abort` as they are.)
  - Replace the load effect:
```tsx
  useEffect(() => { if (active) void loadRuns(workspaceId); }, [active, workspaceId, loadRuns]);
  useEffect(() => {
    if (active && viewedId && !detail?.run) void refreshDetail(viewedId);
  }, [active, viewedId, detail?.run, refreshDetail]);
```
  - Replace the launcher guard `if (!activeRunId || !detail?.run)` with `if (!viewedId || !detail?.run)` (body unchanged — `PipelineSetup` with the same props).
  - The run-view body (`const { run, stages } = detail; …`) is unchanged: it already reads from `detail` (now the viewed run) and targets `run.id` for checkpoint actions.

- [ ] **Step 4 — Run the test + typecheck + full sweep:** `npx vitest run src/components/DirectCanvas src/stores/runsStore 2>&1 | tail -10`; `npm run typecheck`; `npx vitest run 2>&1 | grep -E "Test Files|Tests "` (whole suite green — DirectCanvas behavior is unchanged for existing flows since `getViewedRunId` defaults to the active run).

- [ ] **Step 5 — Commit:**
```bash
git add src/components/DirectCanvas.tsx src/components/DirectCanvas.test.tsx
git commit -m "feat(direct/nav-n1): DirectCanvas renders the viewed run (loads detail) or the launcher"
```

---

## Self-review (against spec §2–§3)

- **`selectedRunIdByWs` + `selectRun` + `getViewedRunId` (default→active, null→launcher) + `hasExecutingRun`** → Task 1. ✓
- **`begin` auto-selects the new run** → Task 1. ✓
- **DirectCanvas renders the viewed run, loads its detail, launcher when null** → Task 2. ✓
- **No new chrome; existing flows unchanged** (default viewed = active) → Task 2. ✓
- **Out of scope (N2/N3):** Companion clickable rows + `Begin a new run` CTA, the `PipelineSetup` `executingRun` gate, the backend concurrency guard. ✓

**Type consistency:** `selectedRunIdByWs: Record<string, string | null>`; `getViewedRunId(ws): string | null` (uses `ws in sel` to distinguish "unset → active" from "null → launcher"); `selectRun(ws, string | null)`; `hasExecutingRun(ws): boolean`. `DirectCanvas` reads `getViewedRunId`/`refreshDetail`; the run-view body still destructures `detail.{run,stages}` and targets `run.id`.

**Note:** N1 is observable mainly via `begin` auto-select + the DirectCanvas test; the user-facing affordances (clicking a run, "Begin a new run") arrive in N2, which calls the `selectRun` this plan adds.
