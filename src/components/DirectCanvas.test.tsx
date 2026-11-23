import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { Run } from "../lib/ipc";

// DirectCanvas renders PipelineSetup (the launcher); stub it — its real form
// reaches ipc/stores, absent in jsdom.
vi.mock("./PipelineSetup", () => ({
  PipelineSetup: ({ onEditPipeline }: any) => (
    <div>
      LAUNCHER
      <button onClick={() => onEditPipeline(null)}>compose</button>
    </div>
  ),
}));
vi.mock("./PipelineBuilder", () => ({ PipelineBuilder: () => <div>BUILDER</div> }));
vi.mock("./RunFlow", () => ({
  RunFlow: ({ beaconStageId }: any) => (
    <>
      <div>RUNVIEW</div>
      <div>beacon:{String(beaconStageId)}</div>
    </>
  ),
}));
vi.mock("./StageFocus", () => ({ StageFocus: () => <div /> }));
vi.mock("./RunLedger", () => ({ RunLedger: () => <div /> }));
const TERMINAL = new Set(["completed", "aborted", "failed"]);
vi.mock("./RunControlBar", () => ({
  RunControlBar: ({ run, blockedStage, beacon, onRunAgain, onApprove }: any) => (
    <div>
      {blockedStage && <div>CHECKPOINT</div>}
      {blockedStage && <div>decides:{blockedStage.id}</div>}
      <div>decision-beacon:{String(!!beacon)}</div>
      {blockedStage && <button onClick={onApprove}>approve</button>}
      {TERMINAL.has(run.status) && <button onClick={onRunAgain}>again</button>}
    </div>
  ),
}));

const { DirectCanvas } = await import("./DirectCanvas");
const { useRunsStore } = await import("../stores/runsStore");

const run: Run = { id: "r1", workspaceId: "w1", pipelineId: "p", task: "t", status: "running",
  costUsd: 0, baselineUsd: 0, referenceModel: null, linkedIssueKey: null, createdAt: "t", finishedAt: null, budgetUsd: null, detached: false };

const mkStage = (id: string, position: number, status: string) => ({
  id, runId: "r1", position, role: "implement", agentModel: "haiku",
  substrate: "api", checkpoint: false, status, inputTokens: 0, outputTokens: 0,
  costUsd: 0, artifact: null, feedback: null, error: null, startedAt: null, finishedAt: null,
  loopTargetPosition: null, loopMaxIterations: 0, loopMode: null, loopIterations: 0, maxIterations: 25,
}) as any;

describe("DirectCanvas viewed-run routing", () => {
  afterEach(() => { vi.useRealTimers(); });
  beforeEach(() => {
    useRunsStore.setState({
      runsByWs: {}, activeRunIdByWs: {}, detailByRun: {}, selectedStageByRun: {},
      selectedRunIdByWs: {}, liveByStage: {},
      // The canvas loads runs/detail on mount; there's no IPC in jsdom, so the
      // real actions reject (an unhandled error that fails `vitest run`).
      loadRuns: vi.fn(async () => {}),
      refreshDetail: vi.fn(async () => {}),
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

  it("clears a manual pin when the watched stage finishes (focus follows the action)", () => {
    const s1 = mkStage("s1", 0, "running");
    const s2 = mkStage("s2", 1, "pending");
    useRunsStore.setState({ detailByRun: { r1: { run, stages: [s1, s2] } } });
    useRunsStore.getState().selectRun("w1", "r1");
    useRunsStore.getState().selectStage("r1", "s1");
    render(<DirectCanvas active workspaceId="w1" defaultTask="" linkedIssueKey={null} workspacePath="/tmp" />);
    expect(useRunsStore.getState().getSelectedStageId("r1")).toBe("s1");

    act(() => {
      useRunsStore.setState({
        detailByRun: { r1: { run, stages: [{ ...s1, status: "done" }, { ...s2, status: "running" }] } },
      });
    });
    expect(useRunsStore.getState().getSelectedStageId("r1")).toBe(null);
  });

  it("clears a manual pin when the watched stage halts at a checkpoint", () => {
    const s1 = mkStage("s1", 0, "running");
    useRunsStore.setState({ detailByRun: { r1: { run, stages: [s1] } } });
    useRunsStore.getState().selectRun("w1", "r1");
    useRunsStore.getState().selectStage("r1", "s1");
    render(<DirectCanvas active workspaceId="w1" defaultTask="" linkedIssueKey={null} workspacePath="/tmp" />);

    act(() => {
      useRunsStore.setState({
        detailByRun: { r1: { run, stages: [{ ...s1, status: "awaiting_checkpoint" }] } },
      });
    });
    expect(useRunsStore.getState().getSelectedStageId("r1")).toBe(null);
  });

  it("respects a pin on an already-finished stage while OTHER stages change status", () => {
    const s1 = mkStage("s1", 0, "done");
    const s2 = mkStage("s2", 1, "running");
    useRunsStore.setState({ detailByRun: { r1: { run, stages: [s1, s2] } } });
    useRunsStore.getState().selectRun("w1", "r1");
    useRunsStore.getState().selectStage("r1", "s1"); // pinned on a terminal stage
    render(<DirectCanvas active workspaceId="w1" defaultTask="" linkedIssueKey={null} workspacePath="/tmp" />);

    act(() => {
      useRunsStore.setState({
        detailByRun: { r1: { run, stages: [s1, { ...s2, status: "done" }] } },
      });
    });
    expect(useRunsStore.getState().getSelectedStageId("r1")).toBe("s1");
  });

  it("Run it again sets the launcher prefill from the run and navigates to the launcher (R3)", () => {
    const done: Run = { ...run, status: "completed" };
    const s1 = { ...mkStage("s1", 0, "done"), role: "plan", agentModel: "haiku" };
    const s2 = { ...mkStage("s2", 1, "done"), role: "implement", agentModel: "opus" };
    useRunsStore.setState({ detailByRun: { r1: { run: done, stages: [s1, s2] } } });
    useRunsStore.getState().selectRun("w1", "r1");
    render(<DirectCanvas active workspaceId="w1" defaultTask="" linkedIssueKey={null} workspacePath="/tmp" />);

    fireEvent.click(screen.getByText("again"));
    expect(useRunsStore.getState().launcherPrefill).toEqual({
      task: "t",
      pipelineId: "p",
      overrides: [[0, "haiku"], [1, "opus"]],
    });
    // navigates to the launcher
    expect(useRunsStore.getState().selectedRunIdByWs.w1).toBeNull();
  });

  it("a sibling's gate beside a scheduled plan wait takes the bar and the beacon, and Approve names it", () => {
    const resolve = vi.fn(async () => true);
    const resumeAt = Math.floor(Date.now() / 1000) + 3600;
    const paused: Run = { ...run, status: "paused",
      planWait: { window: "five_hour", resetsAt: resumeAt - 90, resumeAt, resumeCount: 0, otherHold: true } };
    const plan = { ...mkStage("p1", 1, "failed"), error: "Paused by your Claude plan\n(plan_limit)" };
    const gate = { ...mkStage("g1", 2, "awaiting_checkpoint"), checkpoint: true };
    // A gate's approve goes through the store's gate approve (#957), with no comments here.
    const approveWithComments = vi.fn(async () => {});
    useRunsStore.setState({ resolve, approveWithComments, detailByRun: { r1: { run: paused, stages: [mkStage("s0", 0, "done"), plan, gate] } } });
    useRunsStore.getState().selectRun("w1", "r1");
    render(<DirectCanvas active workspaceId="w1" defaultTask="" linkedIssueKey={null} workspacePath="/tmp" />);
    expect(screen.getByText("decides:g1")).toBeInTheDocument();
    expect(screen.getByText("decision-beacon:true")).toBeInTheDocument();
    fireEvent.click(screen.getByText("approve"));
    expect(approveWithComments).toHaveBeenCalledWith("r1", "g1", []);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("shows the decision surface when paused at a checkpoint, and the running controls once resumed", () => {
    const blocked = {
      id: "s1", runId: "r1", position: 0, role: "code_review", agentModel: "haiku",
      substrate: "api", checkpoint: true, status: "awaiting_checkpoint",
      inputTokens: 0, outputTokens: 0, costUsd: 0, artifact: null, feedback: null,
      error: null, startedAt: null, finishedAt: null,
      loopTargetPosition: null, loopMaxIterations: 0, loopMode: null, loopIterations: 0, maxIterations: 25,
    } as any;
    useRunsStore.setState({ detailByRun: { r1: { run: { ...run, status: "paused" }, stages: [blocked] } } });
    useRunsStore.getState().selectRun("w1", "r1");
    render(<DirectCanvas active workspaceId="w1" defaultTask="" linkedIssueKey={null} workspacePath="/tmp" />);

    // Paused at a checkpoint: the decision surface is shown; the header run
    // controls stay mounted but disabled (they fade, no layout shift), and
    // the decision suppresses the stage beacon (Law 2 — one beacon).
    expect(screen.getByText("CHECKPOINT")).toBeInTheDocument();
    expect(screen.getByTitle("Pause at the next stage")).toBeDisabled();
    expect(screen.getByText("beacon:null")).toBeInTheDocument();

    // Resumed: the control bar adapts to the running controls (no decision).
    act(() => {
      useRunsStore.setState({
        detailByRun: { r1: { run: { ...run, status: "running" }, stages: [{ ...blocked, status: "running" }] } },
      });
    });
    expect(screen.queryByText("CHECKPOINT")).not.toBeInTheDocument();
    expect(screen.getByTitle("Pause at the next stage")).toBeEnabled();
  });
});
