import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Run } from "../lib/ipc";

vi.mock("./PipelineSetup", () => ({ PipelineSetup: () => <div>LAUNCHER</div> }));
vi.mock("./RunTrack", () => ({ RunTrack: () => <div>RUNVIEW</div>, labelForRole: (r: string) => r }));
vi.mock("./StageFocus", () => ({ StageFocus: () => <div /> }));
vi.mock("./CheckpointBar", () => ({ CheckpointBar: () => <div /> }));
vi.mock("./RunCostMeter", () => ({ RunCostMeter: () => <div /> }));

const { DirectCanvas } = await import("./DirectCanvas");
const { useRunsStore } = await import("../stores/runsStore");

const run: Run = { id: "r1", workspaceId: "w1", pipelineId: "p", task: "t", status: "running",
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
