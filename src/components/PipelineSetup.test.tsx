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
const entitlementState = vi.hoisted(() => ({ usage: { used: 4, limit: 25 } as { used: number; limit: number | null } | null }));
vi.mock("../hooks/useEntitlement", () => ({
  useEntitlement: () => ({ usage: entitlementState.usage, hasFeature: () => false }),
}));
const estimateMock = vi.hoisted(() => vi.fn());
const cliVersionMock = vi.hoisted(() => vi.fn());
vi.mock("../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    ipc: { ...actual.ipc, estimateRunCost: estimateMock, claudeCliVersion: cliVersionMock },
  };
});

const { PipelineSetup } = await import("./PipelineSetup");
const { useRunsStore } = await import("../stores/runsStore");
const { useMissionsStore } = await import("../stores/missionsStore");

const PERF = { pipeline: { id: "pperf", name: "Perf probe", description: "d", isBuiltin: true, createdAt: "t" },
  stages: [
    { id: "ps0", pipelineId: "pperf", position: 0, role: "critique", agentModel: "m", substrate: "api", checkpoint: false,
      loopTargetPosition: null, loopMaxIterations: 0, loopMode: null, maxIterations: 25 },
  ] };

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
  entitlementState.usage = { used: 4, limit: 25 };
  estimateMock.mockReset();
  estimateMock.mockResolvedValue({ estimateUsd: 0.05, baselineUsd: 0.4 });
  useRunsStore.setState({ launcherPrefill: null });
  useMissionsStore.setState({ missionByWorkspaceId: {} });
});

describe("PipelineSetup begin gate", () => {
  it("disables Begin + shows the helper when a run is executing", () => {
    render(<PipelineSetup workspaceId="w1" workspacePath="/tmp/w1" defaultTask="build it" onBegin={vi.fn()} executingRun onEditPipeline={vi.fn()} />);
    const begin = screen.getByRole("button", { name: /Begin the run/i });
    expect(begin).toBeDisabled();
    expect(screen.getByText(/A run is in progress/i)).toBeInTheDocument();
  });

  it("enables Begin when no run is executing and a task is set", () => {
    render(<PipelineSetup workspaceId="w1" workspacePath="/tmp/w1" defaultTask="build it" onBegin={vi.fn()} executingRun={false} onEditPipeline={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Begin the run/i })).not.toBeDisabled();
    expect(screen.queryByText(/A run is in progress/i)).not.toBeInTheDocument();
  });
});

describe("PipelineSetup budget field", () => {
  it("renders the optional budget input with its quiet eyebrow", () => {
    render(<PipelineSetup workspaceId="w1" workspacePath="/tmp/w1" defaultTask="t" onBegin={vi.fn()} executingRun={false} onEditPipeline={vi.fn()} />);
    const input = screen.getByPlaceholderText("no budget");
    expect(input).toBeInTheDocument();
    expect(screen.getByText("budget")).toBeInTheDocument(); // eyebrow label
  });

  it("passes the parsed budget to onBegin", () => {
    const onBegin = vi.fn();
    render(<PipelineSetup workspaceId="w1" workspacePath="/tmp/w1" defaultTask="build it" onBegin={onBegin} executingRun={false} onEditPipeline={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("no budget"), { target: { value: "2.50" } });
    fireEvent.click(screen.getByRole("button", { name: /Begin the run/i }));
    expect(onBegin).toHaveBeenCalledWith("p1", "build it", [], 2.5);
  });

  it("passes null when the budget is empty or invalid", () => {
    const onBegin = vi.fn();
    render(<PipelineSetup workspaceId="w1" workspacePath="/tmp/w1" defaultTask="build it" onBegin={onBegin} executingRun={false} onEditPipeline={vi.fn()} />);
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

describe("PipelineSetup intent auto-select", () => {
  it("default-selects the intent-matched builtin (perf → Perf probe)", () => {
    storeState.pipelines = [PIPE, PERF];
    useMissionsStore.setState({ missionByWorkspaceId: { w1: { intent: "perf" } as any } });
    const onBegin = vi.fn();
    render(<PipelineSetup workspaceId="w1" workspacePath="/tmp/w1" defaultTask="find the slowdown" onBegin={onBegin} executingRun={false} onEditPipeline={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Begin the run/i }));
    expect(onBegin).toHaveBeenCalledWith("pperf", "find the slowdown", [], null);
  });

  it("falls back to the first builtin when the intent has no mapping", () => {
    storeState.pipelines = [PIPE, PERF];
    useMissionsStore.setState({ missionByWorkspaceId: { w1: { intent: "build" } as any } });
    const onBegin = vi.fn();
    render(<PipelineSetup workspaceId="w1" workspacePath="/tmp/w1" defaultTask="ship it" onBegin={onBegin} executingRun={false} onEditPipeline={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Begin the run/i }));
    expect(onBegin).toHaveBeenCalledWith("p1", "ship it", [], null);
  });
});

describe("PipelineSetup designed states", () => {
  it("renders the ceremony header", () => {
    render(<PipelineSetup workspaceId="w1" workspacePath="/tmp/w1" defaultTask="" onBegin={vi.fn()} executingRun={false} onEditPipeline={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Direct the work" })).toBeInTheDocument();
    expect(screen.getByText("A crew of agents, your brief, one run.")).toBeInTheDocument();
  });

  it("shows skeletons while pipelines load, not the error card", () => {
    storeState.loaded = false;
    storeState.pipelines = [];
    const { container } = render(
      <PipelineSetup workspaceId="w1" workspacePath="/tmp/w1" defaultTask="" onBegin={vi.fn()} executingRun={false} onEditPipeline={vi.fn()} />,
    );
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(container.querySelectorAll(".h-24").length).toBe(3); // three skeleton cards
  });

  it("shows 'estimating…' until the estimate arrives", () => {
    estimateMock.mockReturnValue(new Promise(() => {})); // never resolves
    render(<PipelineSetup workspaceId="w1" workspacePath="/tmp/w1" defaultTask="" onBegin={vi.fn()} executingRun={false} onEditPipeline={vi.fn()} />);
    expect(screen.getByText("estimating…")).toBeInTheDocument();
    expect(screen.queryByText(/\$0\.00/)).not.toBeInTheDocument(); // no zero flash
  });

  it("draws the crew as a quiet line — no numerals, no arrows", () => {
    render(<PipelineSetup workspaceId="w1" workspacePath="/tmp/w1" defaultTask="" onBegin={vi.fn()} executingRun={false} onEditPipeline={vi.fn()} />);
    expect(screen.getByText("Plan")).toBeInTheDocument();
    expect(screen.getByText("Implement")).toBeInTheDocument();
    expect(screen.queryByText("⟶")).not.toBeInTheDocument();
    expect(screen.queryByText("I")).not.toBeInTheDocument();
    expect(screen.queryByText("II")).not.toBeInTheDocument();
  });

  it("shows the p25–p75 range, then the savings, with a per-stage breakdown on hover", async () => {
    estimateMock.mockResolvedValue({
      estimateUsd: 0.7, baselineUsd: 1.84, lowUsd: 0.4, highUsd: 1.1, confidence: "history", unpricedStages: 0,
      perStage: [
        { position: 0, role: "plan", effort: "medium", model: "claude-haiku-4-5", lowUsd: 0.05, highUsd: 0.1, samples: 6, rough: false },
        { position: 1, role: "implement", effort: null, model: "claude-sonnet-4-6", lowUsd: 0.35, highUsd: 1.0, samples: 4, rough: false },
      ],
    });
    render(<PipelineSetup workspaceId="w1" workspacePath="/tmp/w1" defaultTask="" onBegin={vi.fn()} executingRun={false} onEditPipeline={vi.fn()} />);
    const range = await screen.findByTestId("estimate-range");
    expect(range.textContent).toBe("est. $0.40–$1.10");
    const saves = screen.getByTestId("estimate-savings");
    expect(saves.textContent).toBe("· saves ~62% vs all-premium");
    expect(saves.className).toContain("text-octo-verdigris");
    // the range leads; the savings follow it
    expect(range.compareDocumentPosition(saves) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const title = range.getAttribute("title") ?? "";
    expect(title).toContain("plan · claude-haiku-4-5 · medium  $0.05–$0.10  (6 past runs)");
    expect(title).toContain("implement · claude-sonnet-4-6  $0.35–$1.00  (4 past runs)");
    expect(screen.queryByTestId("estimate-rough")).not.toBeInTheDocument();
  });

  it("labels a cold-start estimate rough", async () => {
    estimateMock.mockResolvedValue({
      estimateUsd: 0.2, baselineUsd: 0.2, lowUsd: 0.1, highUsd: 0.3, confidence: "rough",
      perStage: [{ position: 0, role: "plan", effort: null, model: "m", lowUsd: 0.1, highUsd: 0.3, samples: 0, rough: true }],
    });
    render(<PipelineSetup workspaceId="w1" workspacePath="/tmp/w1" defaultTask="" onBegin={vi.fn()} executingRun={false} onEditPipeline={vi.fn()} />);
    expect((await screen.findByTestId("estimate-rough")).textContent).toBe("· rough");
    // nothing to save against the same model: no savings fragment
    expect(screen.queryByTestId("estimate-savings")).not.toBeInTheDocument();
  });

  it("reads 'unpriced', never $0, when no stage model has a price", async () => {
    estimateMock.mockResolvedValue({
      estimateUsd: 0, baselineUsd: 0, lowUsd: 0, highUsd: 0, confidence: "rough",
      unpricedModels: ["claude-mythos-1"], unpricedStages: 2,
      perStage: [
        { position: 0, role: "plan", effort: null, model: "claude-mythos-1", lowUsd: null, highUsd: null, samples: 0, rough: true },
        { position: 1, role: "implement", effort: null, model: "claude-mythos-1", lowUsd: null, highUsd: null, samples: 0, rough: true },
      ],
    });
    render(<PipelineSetup workspaceId="w1" workspacePath="/tmp/w1" defaultTask="" onBegin={vi.fn()} executingRun={false} onEditPipeline={vi.fn()} />);
    expect((await screen.findByTestId("estimate-range")).textContent).toBe("est. unpriced");
    expect(screen.queryByText(/\$0\.00/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("estimate-rough")).not.toBeInTheDocument();
  });

  it("still renders a single-figure estimate without the range fields", async () => {
    render(<PipelineSetup workspaceId="w1" workspacePath="/tmp/w1" defaultTask="" onBegin={vi.fn()} executingRun={false} onEditPipeline={vi.fn()} />);
    expect((await screen.findByTestId("estimate-range")).textContent).toBe("est. ~$0.05");
    expect(screen.getByTestId("estimate-savings").textContent).toBe("· saves ~88% vs all-premium");
  });

  it("names unpriced stage models and, with a budget, says it cannot be enforced", async () => {
    estimateMock.mockResolvedValue({
      estimateUsd: 0.05, baselineUsd: 0.4, unpricedModels: ["claude-mythos-1"], unpricedStages: 2,
    });
    render(<PipelineSetup workspaceId="w1" workspacePath="/tmp/w1" defaultTask="" onBegin={vi.fn()} executingRun={false} onEditPipeline={vi.fn()} />);
    const tag = await screen.findByTestId("estimate-unpriced");
    expect(tag.textContent).toBe("· claude-mythos-1 unpriced");
    expect(tag.getAttribute("title")).toContain("claude-mythos-1");
    expect(screen.queryByTestId("estimate-budget-unenforceable")).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("no budget"), { target: { value: "2" } });
    expect(screen.getByTestId("estimate-budget-unenforceable").textContent).toBe("· budget not enforceable: 2 stages unpriced");
  });

  it("shows no unpriced note when every stage is priced", async () => {
    render(<PipelineSetup workspaceId="w1" workspacePath="/tmp/w1" defaultTask="" onBegin={vi.fn()} executingRun={false} onEditPipeline={vi.fn()} />);
    await screen.findByTestId("estimate-range");
    expect(screen.queryByTestId("estimate-unpriced")).not.toBeInTheDocument();
  });

  it("the beacon lands on Begin only when ready (Law 2)", () => {
    const { container, rerender } = render(
      <PipelineSetup workspaceId="w1" workspacePath="/tmp/w1" defaultTask="build it" onBegin={vi.fn()} executingRun={false} onEditPipeline={vi.fn()} />,
    );
    expect(container.querySelectorAll(".octo-stage-pulse")).toHaveLength(1); // the CTA
    rerender(<PipelineSetup workspaceId="w1" workspacePath="/tmp/w1" defaultTask="build it" onBegin={vi.fn()} executingRun onEditPipeline={vi.fn()} />);
    expect(container.querySelectorAll(".octo-stage-pulse")).toHaveLength(0); // executing → ghost, calm
  });

  it("⌘⏎ in the brief begins the run when ready — and only then", () => {
    const onBegin = vi.fn();
    render(<PipelineSetup workspaceId="w1" workspacePath="/tmp/w1" defaultTask="build it" onBegin={onBegin} executingRun={false} onEditPipeline={vi.fn()} />);
    fireEvent.keyDown(screen.getByLabelText("The brief"), { key: "Enter", metaKey: true });
    expect(onBegin).toHaveBeenCalledWith("p1", "build it", [], null);
    onBegin.mockClear();
    fireEvent.change(screen.getByLabelText("The brief"), { target: { value: "   " } });
    fireEvent.keyDown(screen.getByLabelText("The brief"), { key: "Enter", metaKey: true });
    expect(onBegin).not.toHaveBeenCalled(); // blank brief → not ready
  });

  it("an exhausted quota ghosts the CTA and says why", () => {
    entitlementState.usage = { used: 25, limit: 25 };
    const { container } = render(
      <PipelineSetup workspaceId="w1" workspacePath="/tmp/w1" defaultTask="build it" onBegin={vi.fn()} executingRun={false} onEditPipeline={vi.fn()} />,
    );
    expect(container.querySelectorAll(".octo-stage-pulse")).toHaveLength(0);
    expect(screen.getByRole("button", { name: /Begin the run/i })).toBeDisabled();
    expect(screen.getByText("Monthly Direct runs are used up.")).toBeInTheDocument();
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
    render(<PipelineSetup workspaceId="w1" workspacePath="/tmp/w1" defaultTask="" onBegin={onBegin} executingRun={false} onEditPipeline={vi.fn()} />);
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
    render(<PipelineSetup workspaceId="w1" workspacePath="/tmp/w1" defaultTask="" onBegin={onBegin} executingRun={false} onEditPipeline={vi.fn()} />);
    expect(screen.getByDisplayValue("ghost pipeline run")).toBeInTheDocument();
    expect(useRunsStore.getState().launcherPrefill).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Begin the run/i }));
    // default pipeline, no stale overrides
    expect(onBegin).toHaveBeenCalledWith("p1", "ghost pipeline run", [], null);
  });
});

describe("PipelineSetup Claude Code version preflight", () => {
  const cliPipe = (agentModel: string) => ({
    pipeline: { id: "pc", name: "CLI crew", description: "d", isBuiltin: true, createdAt: "t" },
    stages: [
      { id: "c0", pipelineId: "pc", position: 0, role: "implement", agentModel, substrate: "cli", checkpoint: false,
        loopTargetPosition: null, loopMaxIterations: 0, loopMode: null, maxIterations: 25 },
    ],
  });

  beforeEach(async () => {
    const { resetClaudeCliVersionCache } = await import("../lib/claudeCli");
    resetClaudeCliVersionCache();
    cliVersionMock.mockReset();
  });

  it("warns on an old CLI but still lets the run begin", async () => {
    storeState.pipelines = [cliPipe("claude-sonnet-4-6")];
    cliVersionMock.mockResolvedValue({ version: "2.1.307", floor: "2.1.314", belowFloor: true });
    const onBegin = vi.fn();
    render(<PipelineSetup workspaceId="w1" workspacePath="/tmp/w1" defaultTask="build it" onBegin={onBegin} executingRun={false} onEditPipeline={vi.fn()} />);
    const note = await screen.findByTestId("launcher-claude-cli-update");
    expect(note.textContent).toContain("Update Claude Code (2.1.314 or newer recommended)");
    expect(note.textContent).toContain("2.1.307");
    expect(note.textContent).toContain("wrong token usage");
    fireEvent.click(screen.getByRole("button", { name: /Begin the run/i }));
    expect(onBegin).toHaveBeenCalledWith("pc", "build it", [], null);
  });

  it("stays quiet on a current CLI", async () => {
    storeState.pipelines = [cliPipe("claude-sonnet-4-6")];
    cliVersionMock.mockResolvedValue({ version: "2.1.316", floor: "2.1.314", belowFloor: false });
    render(<PipelineSetup workspaceId="w1" workspacePath="/tmp/w1" defaultTask="build it" onBegin={vi.fn()} executingRun={false} onEditPipeline={vi.fn()} />);
    await vi.waitFor(() => expect(cliVersionMock).toHaveBeenCalled());
    expect(screen.queryByTestId("launcher-claude-cli-update")).not.toBeInTheDocument();
  });

  it("does not probe for crews without a Claude Code CLI stage", async () => {
    storeState.pipelines = [cliPipe("gpt-5-codex")];
    cliVersionMock.mockResolvedValue({ version: "2.1.307", floor: "2.1.314", belowFloor: true });
    render(<PipelineSetup workspaceId="w1" workspacePath="/tmp/w1" defaultTask="build it" onBegin={vi.fn()} executingRun={false} onEditPipeline={vi.fn()} />);
    await screen.findByTestId("estimate-range");
    expect(cliVersionMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("launcher-claude-cli-update")).not.toBeInTheDocument();
  });
});
