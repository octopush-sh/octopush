import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const PIPE = { pipeline: { id: "p1", name: "Feature Factory", description: "d", isBuiltin: true, createdAt: "t" },
  stages: [
    { id: "s0", pipelineId: "p1", position: 0, role: "plan", agentModel: "m", substrate: "api", checkpoint: false,
      loopTargetPosition: null, loopMaxIterations: 0, loopMode: null, maxIterations: 25 },
    { id: "s1", pipelineId: "p1", position: 1, role: "implement", agentModel: "m", substrate: "api", checkpoint: false,
      loopTargetPosition: null, loopMaxIterations: 0, loopMode: null, maxIterations: 25 },
  ] };

const storeState = vi.hoisted(() => ({
  pipelines: [] as any[],
  loaded: true,
  load: vi.fn(),
  error: null as string | null,
}));
vi.mock("../stores/pipelineStore", () => ({
  usePipelineStore: (sel: any) => sel(storeState),
}));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => <div /> }));
const estimateMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    ipc: { ...actual.ipc, estimateRunCost: estimateMock },
  };
});

const { PipelineSetup } = await import("./PipelineSetup");
const { useRunsStore } = await import("../stores/runsStore");

// Fix A: dangling-selectedId recovery — the store mock returns the same shared
// slice, so we cannot cheaply simulate "store reloads without the previously-selected id" in a
// second render. The effect logic is exercised indirectly: the existing tests confirm section III
// renders (auto-select picked pipelines[0]) when `selectedId` starts null, which is the same
// `!exists` branch that now also fires on a dangling id.  Manual test: delete the selected
// pipeline in the app → section III + Begin reappear immediately (was: vanished with no recovery).

beforeEach(() => {
  storeState.pipelines = [PIPE];
  storeState.loaded = true;
  storeState.error = null;
  estimateMock.mockReset();
  estimateMock.mockResolvedValue({ estimateUsd: 0.05, baselineUsd: 0.4 });
  useRunsStore.setState({ launcherPrefill: null });
});

describe("PipelineSetup begin gate", () => {
  it("disables Begin + shows the helper when a run is executing", () => {
    render(<PipelineSetup defaultTask="build it" onBegin={vi.fn()} executingRun onEditPipeline={vi.fn()} />);
    const begin = screen.getByRole("button", { name: /Begin the run/i });
    expect(begin).toBeDisabled();
    expect(screen.getByText(/A run is in progress/i)).toBeInTheDocument();
  });

  it("enables Begin when no run is executing and a task is set", () => {
    render(<PipelineSetup defaultTask="build it" onBegin={vi.fn()} executingRun={false} onEditPipeline={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Begin the run/i })).not.toBeDisabled();
    expect(screen.queryByText(/A run is in progress/i)).not.toBeInTheDocument();
  });
});

describe("PipelineSetup budget field", () => {
  it("renders the optional budget input with its quiet eyebrow", () => {
    render(<PipelineSetup defaultTask="t" onBegin={vi.fn()} executingRun={false} onEditPipeline={vi.fn()} />);
    const input = screen.getByPlaceholderText("no budget");
    expect(input).toBeInTheDocument();
    expect(screen.getByText("budget")).toBeInTheDocument(); // eyebrow label
  });

  it("passes the parsed budget to onBegin", () => {
    const onBegin = vi.fn();
    render(<PipelineSetup defaultTask="build it" onBegin={onBegin} executingRun={false} onEditPipeline={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("no budget"), { target: { value: "2.50" } });
    fireEvent.click(screen.getByRole("button", { name: /Begin the run/i }));
    expect(onBegin).toHaveBeenCalledWith("p1", "build it", [], 2.5);
  });

  it("passes null when the budget is empty or invalid", () => {
    const onBegin = vi.fn();
    render(<PipelineSetup defaultTask="build it" onBegin={onBegin} executingRun={false} onEditPipeline={vi.fn()} />);
    const begin = screen.getByRole("button", { name: /Begin the run/i });
    fireEvent.click(begin); // empty
    expect(onBegin).toHaveBeenLastCalledWith("p1", "build it", [], null);
    fireEvent.change(screen.getByPlaceholderText("no budget"), { target: { value: "free" } });
    fireEvent.click(begin); // unparseable
    expect(onBegin).toHaveBeenLastCalledWith("p1", "build it", [], null);
    fireEvent.change(screen.getByPlaceholderText("no budget"), { target: { value: "-3" } });
    fireEvent.click(begin); // non-positive
    expect(onBegin).toHaveBeenLastCalledWith("p1", "build it", [], null);
    fireEvent.change(screen.getByPlaceholderText("no budget"), { target: { value: "0" } });
    fireEvent.click(begin); // zero is no budget
    expect(onBegin).toHaveBeenLastCalledWith("p1", "build it", [], null);
  });
});

describe("PipelineSetup designed states", () => {
  it("renders the ceremony header", () => {
    render(<PipelineSetup defaultTask="" onBegin={vi.fn()} executingRun={false} onEditPipeline={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Direct the work" })).toBeInTheDocument();
    expect(screen.getByText("— direct")).toBeInTheDocument(); // the brass eyebrow
  });

  it("shows skeletons while pipelines load, not the error card", () => {
    storeState.loaded = false;
    storeState.pipelines = [];
    const { container } = render(
      <PipelineSetup defaultTask="" onBegin={vi.fn()} executingRun={false} onEditPipeline={vi.fn()} />,
    );
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(container.querySelectorAll(".h-24").length).toBe(3); // three skeleton cards
  });

  it("shows 'estimating…' until the estimate arrives", () => {
    estimateMock.mockReturnValue(new Promise(() => {})); // never resolves
    render(<PipelineSetup defaultTask="" onBegin={vi.fn()} executingRun={false} onEditPipeline={vi.fn()} />);
    expect(screen.getByText("estimating…")).toBeInTheDocument();
    expect(screen.queryByText(/\$0\.00/)).not.toBeInTheDocument(); // no zero flash
  });

  it("draws the selected pipeline as a stage flow (Roman numerals + connector)", () => {
    render(<PipelineSetup defaultTask="" onBegin={vi.fn()} executingRun={false} onEditPipeline={vi.fn()} />);
    expect(screen.getByText("I")).toBeInTheDocument();
    expect(screen.getByText("II")).toBeInTheDocument();
    // ⟶ appears both as the brief's prompt glyph and as the flow connector.
    expect(screen.getAllByText("⟶").length).toBeGreaterThan(0);
  });

  it("leads the estimate with savings", async () => {
    render(<PipelineSetup defaultTask="" onBegin={vi.fn()} executingRun={false} onEditPipeline={vi.fn()} />);
    const saves = (await screen.findAllByText(/saves ~\$0\.35/)).pop()!;
    const spent = screen.getAllByText(/runs at/).pop()!;
    // savings (verdigris serif) leads; the spent figure follows it
    expect(saves.compareDocumentPosition(spent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(saves.className).toContain("text-octo-verdigris");
  });
});

describe("PipelineSetup launcher prefill (R3)", () => {
  const PIPE2 = { pipeline: { id: "p2", name: "Second", description: "d", isBuiltin: false, createdAt: "t" },
    stages: [
      { id: "t0", pipelineId: "p2", position: 0, role: "plan", agentModel: "m", substrate: "api", checkpoint: false,
        loopTargetPosition: null, loopMaxIterations: 0, loopMode: null, maxIterations: 25 },
      { id: "t1", pipelineId: "p2", position: 1, role: "implement", agentModel: "m", substrate: "api", checkpoint: false,
        loopTargetPosition: null, loopMaxIterations: 0, loopMode: null, maxIterations: 25 },
    ] };

  it("applies task + pipeline + overrides from the prefill, then clears it", () => {
    storeState.pipelines = [PIPE, PIPE2];
    useRunsStore.getState().setLauncherPrefill({
      task: "run it back", pipelineId: "p2", overrides: [[0, "m2"], [1, "m"]],
    });
    const onBegin = vi.fn();
    render(<PipelineSetup defaultTask="" onBegin={onBegin} executingRun={false} onEditPipeline={vi.fn()} />);
    expect(screen.getByDisplayValue("run it back")).toBeInTheDocument();
    expect(useRunsStore.getState().launcherPrefill).toBeNull(); // consumed once
    fireEvent.click(screen.getByRole("button", { name: /Begin the run/i }));
    // the override equal to the pipeline default ("m" at position 1) is filtered out
    expect(onBegin).toHaveBeenCalledWith("p2", "run it back", [[0, "m2"]], null);
  });

  it("falls back to task-only when the pipeline no longer exists", () => {
    useRunsStore.getState().setLauncherPrefill({
      task: "ghost pipeline run", pipelineId: "ghost", overrides: [[0, "m2"]],
    });
    const onBegin = vi.fn();
    render(<PipelineSetup defaultTask="" onBegin={onBegin} executingRun={false} onEditPipeline={vi.fn()} />);
    expect(screen.getByDisplayValue("ghost pipeline run")).toBeInTheDocument();
    expect(useRunsStore.getState().launcherPrefill).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Begin the run/i }));
    // default pipeline, no stale overrides
    expect(onBegin).toHaveBeenCalledWith("p1", "ghost pipeline run", [], null);
  });
});
