/**
 * Mission Control — the fleet cockpit.
 *
 * 1. Triage bands: paused → Needs you, running → In flight, settled lingers
 * 2. Card click jumps to the run's workspace
 * 3. Abort is two-step (arm, then confirm)
 * 4. Dismiss removes a settled card
 * 5. Live ticker shows the running stage's latest activity
 * 6. Empty board → "The floor is quiet." + dispatch CTA
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Run, RunStage, RunStatus } from "../lib/ipc";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("../lib/ipc", async (orig) => {
  const actual = await orig<any>();
  return {
    ...actual,
    ipc: {
      ...actual.ipc,
      getRun: vi.fn().mockResolvedValue({ run: null, stages: [] }),
      abortRun: vi.fn().mockResolvedValue(undefined),
    },
  };
});

const { MissionControl } = await import("./MissionControl");
const { useRunsStore } = await import("../stores/runsStore");
const { useWorkspaceStore } = await import("../stores/workspaceStore");
const { ipc } = await import("../lib/ipc");

const mkRun = (id: string, status: RunStatus, over: Partial<Run> = {}): Run => ({
  id,
  workspaceId: `ws-${id}`,
  pipelineId: "p",
  task: `task ${id}`,
  status,
  costUsd: 0.1,
  baselineUsd: 0.5,
  referenceModel: null,
  linkedIssueKey: null,
  createdAt: "2026-07-09T00:00:00Z",
  finishedAt: null,
  budgetUsd: null,
  detached: false,
  ...over,
});

const mkStage = (id: string, runId: string, position: number, status: RunStage["status"]): RunStage => ({
  id,
  runId,
  position,
  role: "implement",
  agentModel: "m",
  substrate: "api",
  checkpoint: false,
  status,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  artifact: null,
  feedback: null,
  error: null,
  startedAt: null,
  finishedAt: null,
  loopTargetPosition: null,
  loopMaxIterations: 0,
  loopMode: null,
  loopIterations: 0,
  diffSnapshot: null,
  maxIterations: 25,
  parents: [],
  tools: null,
  customName: null,
  instructions: null,
  sessionId: null,
  baselineCommit: null,
});

const noop = () => {};

function renderRoom(over: Partial<React.ComponentProps<typeof MissionControl>> = {}) {
  return render(
    <MissionControl open onClose={noop} onJumpToRun={noop} onDispatch={noop} {...over} />,
  );
}

beforeEach(() => {
  useRunsStore.setState({
    runsByWs: {},
    detailByRun: {},
    liveByStage: {},
    settledAt: {},
    statusSince: {},
  });
  useWorkspaceStore.setState({ workspacesByProjectId: {} } as any);
  vi.clearAllMocks();
});

describe("MissionControl", () => {
  it("places runs on the right triage bands and lingers settled ones", () => {
    useRunsStore.setState({
      runsByWs: {
        "ws-a": [mkRun("a", "paused")],
        "ws-b": [mkRun("b", "running")],
        "ws-c": [mkRun("c", "completed")],
      },
      settledAt: { c: Date.now() - 60_000 }, // settled a while ago — no ceremony
    });
    renderRoom();
    expect(screen.getByText("Needs you")).toBeTruthy();
    expect(screen.getByText("In flight")).toBeTruthy();
    expect(screen.getByText("Settled")).toBeTruthy();
    expect(screen.getByText("task a")).toBeTruthy();
    expect(screen.getByText("task b")).toBeTruthy();
    expect(screen.getByText("task c")).toBeTruthy();
  });

  it("a terminal run NOT settled this session stays off the board", () => {
    useRunsStore.setState({
      runsByWs: { "ws-old": [mkRun("old", "completed")] }, // e.g. loaded history
    });
    renderRoom();
    expect(screen.queryByText("task old")).toBeNull();
    expect(screen.getByText("The floor is quiet.")).toBeTruthy();
  });

  it("clicking a card jumps to the run's workspace (when it's loaded)", () => {
    const onJumpToRun = vi.fn();
    useRunsStore.setState({ runsByWs: { "ws-a": [mkRun("a", "running")] } });
    useWorkspaceStore.setState({
      workspacesByProjectId: { p1: [{ id: "ws-a", name: "Alpha" }] },
    } as any);
    renderRoom({ onJumpToRun });
    fireEvent.click(screen.getByRole("button", { name: /task a/ }));
    expect(onJumpToRun).toHaveBeenCalledWith("ws-a");
  });

  it("a run in an UNLOADED workspace renders inert — no jump, but abort still works", () => {
    const onJumpToRun = vi.fn();
    useRunsStore.setState({ runsByWs: { "ws-gone": [mkRun("g", "running")] } });
    renderRoom({ onJumpToRun });
    // No clickable card (the old tray's guard: can't navigate to an unloaded ws)…
    expect(screen.queryByRole("button", { name: /task g/ })).toBeNull();
    expect(screen.getByTitle("Open this run's project to view it")).toBeTruthy();
    // …but the run can still be aborted.
    expect(screen.getByRole("button", { name: "Abort run" })).toBeTruthy();
  });

  it("abort is two-step: first click arms, second aborts — without jumping", () => {
    const onJumpToRun = vi.fn();
    useRunsStore.setState({ runsByWs: { "ws-a": [mkRun("a", "running")] } });
    renderRoom({ onJumpToRun });
    const abortBtn = screen.getByRole("button", { name: "Abort run" });
    fireEvent.click(abortBtn);
    expect(ipc.abortRun).not.toHaveBeenCalled(); // armed, not fired
    fireEvent.click(screen.getByRole("button", { name: "Confirm abort" }));
    expect(ipc.abortRun).toHaveBeenCalledWith("a");
    expect(onJumpToRun).not.toHaveBeenCalled(); // the action never triggers the jump
  });

  it("dismiss removes a settled card from the board", () => {
    useRunsStore.setState({
      runsByWs: { "ws-c": [mkRun("c", "completed")] },
      settledAt: { c: Date.now() - 60_000 },
    });
    renderRoom();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss from the board" }));
    expect(useRunsStore.getState().settledAt).toEqual({});
    expect(screen.getByText("The floor is quiet.")).toBeTruthy();
  });

  it("the live slot shows the running stage's latest activity", () => {
    const run = mkRun("a", "running");
    const st = mkStage("st1", "a", 0, "running");
    useRunsStore.setState({
      runsByWs: { "ws-a": [run] },
      detailByRun: { a: { run, stages: [st] } },
      liveByStage: { st1: [{ kind: "tool", tool: "EDIT", hint: "src/x.rs" }] },
    });
    renderRoom();
    expect(screen.getByText("EDIT src/x.rs")).toBeTruthy();
  });

  it("a paused run at a gate says who holds it", () => {
    const run = mkRun("a", "paused");
    const stages = [mkStage("s1", "a", 0, "done"), mkStage("s2", "a", 1, "awaiting_checkpoint")];
    useRunsStore.setState({
      runsByWs: { "ws-a": [run] },
      detailByRun: { a: { run, stages } },
    });
    renderRoom();
    expect(screen.getByText(/holds the gate/)).toBeTruthy();
  });

  it("empty board offers the dispatch CTA (header icon + ceremonial CTA)", () => {
    const onDispatch = vi.fn();
    renderRoom({ onDispatch });
    // Two dispatch affordances by design: the quiet header Plus and the
    // empty-state ceremonial phrase. Both fire the same handler.
    const btns = screen.getAllByRole("button", { name: "Send out a crew" });
    expect(btns).toHaveLength(2);
    fireEvent.click(btns[btns.length - 1]);
    expect(onDispatch).toHaveBeenCalled();
  });
});
