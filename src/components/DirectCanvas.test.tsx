import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { Run } from "../lib/ipc";

vi.mock("./PipelineSetup", () => ({
  PipelineSetup: ({ onEditPipeline }: any) => (
    <div>
      LAUNCHER
      <button onClick={() => onEditPipeline(null)}>compose</button>
    </div>
  ),
}));
vi.mock("./PipelineBuilder", () => ({ PipelineBuilder: () => <div>BUILDER</div> }));
vi.mock("./RunTrack", () => ({ RunTrack: () => <div>RUNVIEW</div>, labelForRole: (r: string) => r }));
vi.mock("./StageFocus", () => ({ StageFocus: () => <div /> }));
vi.mock("./CheckpointBar", () => ({ CheckpointBar: () => <div>CHECKPOINT</div> }));
vi.mock("./RunLedger", () => ({ RunLedger: () => <div /> }));

const { DirectCanvas } = await import("./DirectCanvas");
const { useRunsStore } = await import("../stores/runsStore");

const run: Run = { id: "r1", workspaceId: "w1", pipelineId: "p", task: "t", status: "running",
  costUsd: 0, baselineUsd: 0, referenceModel: null, linkedIssueKey: null, createdAt: "t", finishedAt: null };

describe("DirectCanvas viewed-run routing", () => {
  afterEach(() => { vi.useRealTimers(); });
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

  it("opens the builder from the launcher and closes back", () => {
    vi.useFakeTimers(); // the canvas FadeSwap holds the old view for the 120ms exit
    useRunsStore.getState().selectRun("w1", null);
    render(<DirectCanvas active workspaceId="w1" defaultTask="" linkedIssueKey={null} workspacePath="/tmp" />);
    fireEvent.click(screen.getByText("compose"));
    act(() => { vi.advanceTimersByTime(130); });
    expect(screen.getByText("BUILDER")).toBeInTheDocument();
    expect(screen.queryByText("LAUNCHER")).not.toBeInTheDocument();
  });

  it("keeps the checkpoint strip mounted in a Reveal and folds it away on resume", () => {
    const blocked = {
      id: "s1", runId: "r1", position: 0, role: "code_review", agentModel: "haiku",
      substrate: "api", checkpoint: true, status: "awaiting_checkpoint",
      inputTokens: 0, outputTokens: 0, costUsd: 0, artifact: null, feedback: null,
      error: null, startedAt: null, finishedAt: null,
      loopTargetPosition: null, loopMaxIterations: 0, loopMode: null, loopIterations: 0,
    } as any;
    useRunsStore.setState({ detailByRun: { r1: { run: { ...run, status: "paused" }, stages: [blocked] } } });
    useRunsStore.getState().selectRun("w1", "r1");
    render(<DirectCanvas active workspaceId="w1" defaultTask="" linkedIssueKey={null} workspacePath="/tmp" />);

    // Paused: the strip is open.
    const strip = screen.getByText("CHECKPOINT");
    expect(strip.closest("[aria-hidden]")).toHaveAttribute("aria-hidden", "false");

    // Resume: the strip folds away but its content stays mounted through the animation.
    act(() => {
      useRunsStore.setState({
        detailByRun: { r1: { run: { ...run, status: "running" }, stages: [{ ...blocked, status: "running" }] } },
      });
    });
    expect(screen.getByText("CHECKPOINT")).toBeInTheDocument();
    expect(screen.getByText("CHECKPOINT").closest("[aria-hidden]")).toHaveAttribute("aria-hidden", "true");
  });
});
