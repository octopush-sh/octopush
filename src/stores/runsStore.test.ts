import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

vi.mock("../lib/ipc", async () => {
  const actual = await vi.importActual<any>("../lib/ipc");
  return {
    ...actual,
    ipc: {
      listRuns: vi.fn(),
      getRun: vi.fn(),
      createRun: vi.fn(),
      startRun: vi.fn(),
      resolveCheckpoint: vi.fn(),
      abortRun: vi.fn(),
    },
  };
});

import { ipc, type Run, type RunStage } from "../lib/ipc";
import { useRunsStore, EMPTY_RUNS } from "./runsStore";

const RUN: Run = {
  id: "r1", workspaceId: "w1", pipelineId: "p1", task: "t", status: "running",
  costUsd: 0.05, baselineUsd: 0.2, referenceModel: "m", linkedIssueKey: null,
  createdAt: "t", finishedAt: null,
};
const STAGE: RunStage = {
  id: "st1", runId: "r1", position: 0, role: "plan", agentModel: "m", substrate: "api",
  checkpoint: false, status: "running", inputTokens: 0, outputTokens: 0, costUsd: 0,
  artifact: null, feedback: null, error: null, startedAt: null, finishedAt: null,
  loopTargetPosition: null, loopMaxIterations: 0, loopMode: null, loopIterations: 0,
};

describe("runsStore", () => {
  beforeEach(() => {
    useRunsStore.setState({
      runsByWs: {}, activeRunIdByWs: {}, detailByRun: {}, selectedStageByRun: {},
      selectedRunIdByWs: {}, liveByStage: {},
    });
    vi.clearAllMocks();
  });

  it("appendEntry accumulates structured entries per stage and caps the buffer", () => {
    const s = useRunsStore.getState();
    s.appendEntry("st1", { kind: "text", text: "first" });
    s.appendEntry("st1", { kind: "tool", tool: "Edit", hint: "src/x.rs" });
    const e = useRunsStore.getState().getLiveEntries("st1");
    expect(e).toEqual([
      { kind: "text", text: "first" },
      { kind: "tool", tool: "Edit", hint: "src/x.rs" },
    ]);
    // a different stage keeps its own buffer
    s.appendEntry("st2", { kind: "notice", text: "other" });
    expect(useRunsStore.getState().getLiveEntries("st2")).toHaveLength(1);
    // bounded to the most recent 200
    for (let i = 0; i < 250; i++) useRunsStore.getState().appendEntry("st1", { kind: "text", text: `L${i}` });
    const capped = useRunsStore.getState().getLiveEntries("st1");
    expect(capped.length).toBe(200);
    expect(capped[capped.length - 1]).toEqual({ kind: "text", text: "L249" });
  });

  it("clearLog drops a stage's buffer so a re-run starts fresh", () => {
    const s = useRunsStore.getState();
    s.appendEntry("st1", { kind: "text", text: "old" });
    s.clearLog("st1");
    expect(useRunsStore.getState().getLiveEntries("st1")).toEqual([]);
  });

  it("getRuns returns the stable empty default for an unknown workspace", () => {
    expect(useRunsStore.getState().getRuns("nope")).toBe(EMPTY_RUNS);
  });

  it("loadRuns populates runs and picks the active (non-terminal) run", async () => {
    (ipc.listRuns as any).mockResolvedValue([RUN]);
    (ipc.getRun as any).mockResolvedValue({ run: RUN, stages: [STAGE] });
    await useRunsStore.getState().loadRuns("w1");
    expect(useRunsStore.getState().getRuns("w1")).toHaveLength(1);
    expect(useRunsStore.getState().getActiveRunId("w1")).toBe("r1");
    expect(useRunsStore.getState().getDetail("r1")?.stages).toHaveLength(1);
  });

  it("applyStageUpdate replaces the run row in detail and runs list", () => {
    useRunsStore.setState({
      runsByWs: { w1: [RUN] },
      activeRunIdByWs: { w1: "r1" },
      detailByRun: { r1: { run: RUN, stages: [STAGE] } },
      selectedStageByRun: {},
    });
    const updated: Run = { ...RUN, status: "paused" as const, costUsd: 0.09 };
    useRunsStore.getState().applyStageUpdate("r1", updated);
    expect(useRunsStore.getState().getDetail("r1")?.run?.status).toBe("paused");
    expect(useRunsStore.getState().getRuns("w1")[0].costUsd).toBe(0.09);
  });

  it("applyCost updates the active run's cost/baseline", () => {
    useRunsStore.setState({
      runsByWs: { w1: [RUN] }, activeRunIdByWs: { w1: "r1" },
      detailByRun: { r1: { run: RUN, stages: [STAGE] } }, selectedStageByRun: {},
    });
    useRunsStore.getState().applyCost("r1", 0.12, 0.4);
    const d = useRunsStore.getState().getDetail("r1");
    expect(d?.run?.costUsd).toBe(0.12);
    expect(d?.run?.baselineUsd).toBe(0.4);
  });

  it("refreshDetail also syncs the run into runsByWs", async () => {
    const updated = { ...RUN, status: "completed", costUsd: 0.3 };
    (ipc.getRun as any).mockResolvedValue({ run: updated, stages: [STAGE] });
    // Seed an existing list entry with the old run.
    useRunsStore.setState({
      runsByWs: { w1: [RUN] }, activeRunIdByWs: { w1: "r1" },
      detailByRun: {}, selectedStageByRun: {},
    });
    await useRunsStore.getState().refreshDetail("r1");
    expect(useRunsStore.getState().getDetail("r1")?.run?.status).toBe("completed");
    // The list entry must be updated too (not stale).
    expect(useRunsStore.getState().getRuns("w1")[0].status).toBe("completed");
    expect(useRunsStore.getState().getRuns("w1")).toHaveLength(1);
  });

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
});
