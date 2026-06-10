import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { RunStatus } from "../lib/ipc";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("../lib/ipc", async (orig) => {
  const actual = await orig<any>();
  return { ...actual, ipc: { ...actual.ipc, listRuns: vi.fn().mockResolvedValue([]) } };
});

const { CompanionRuns } = await import("./CompanionRuns");
const { useRunsStore } = await import("../stores/runsStore");

const mkRun = (id: string, status: RunStatus) => ({ id, workspaceId: "w1", pipelineId: "p", task: `task ${id}`,
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
