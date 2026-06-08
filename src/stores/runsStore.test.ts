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
};

describe("runsStore", () => {
  beforeEach(() => {
    useRunsStore.setState({
      runsByWs: {}, activeRunIdByWs: {}, detailByRun: {}, selectedStageByRun: {},
      liveLogByStage: {},
    });
    vi.clearAllMocks();
  });

  it("appendLog accumulates live lines per stage and caps the buffer", () => {
    const s = useRunsStore.getState();
    s.appendLog("st1", "first");
    s.appendLog("st1", "§ Edit src/x.rs");
    expect(useRunsStore.getState().getLiveLog("st1")).toBe("first\n§ Edit src/x.rs");
    // A different stage keeps its own buffer.
    s.appendLog("st2", "other");
    expect(useRunsStore.getState().getLiveLog("st2")).toBe("other");
    // Bounded to the most recent 200 lines.
    for (let i = 0; i < 250; i++) useRunsStore.getState().appendLog("st1", `L${i}`);
    const lines = useRunsStore.getState().getLiveLog("st1").split("\n");
    expect(lines.length).toBe(200);
    expect(lines[lines.length - 1]).toBe("L249");
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
});
