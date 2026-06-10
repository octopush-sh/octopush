import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const PIPE = { pipeline: { id: "p1", name: "Feature Factory", description: "d", isBuiltin: true, createdAt: "t" },
  stages: [{ id: "s0", pipelineId: "p1", position: 0, role: "plan", agentModel: "m", substrate: "api", checkpoint: false,
    loopTargetPosition: null, loopMaxIterations: 0, loopMode: null }] };

vi.mock("../stores/pipelineStore", () => ({
  usePipelineStore: (sel: any) => sel({ pipelines: [PIPE], loaded: true, load: vi.fn(), error: null }),
}));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => <div /> }));
vi.mock("../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    ipc: { ...actual.ipc, estimateRunCost: vi.fn().mockResolvedValue({ estimateUsd: 0.05, baselineUsd: 0.4 }) },
  };
});

const { PipelineSetup } = await import("./PipelineSetup");

describe("PipelineSetup begin gate", () => {
  it("disables Begin + shows the helper when a run is executing", () => {
    render(<PipelineSetup defaultTask="build it" onBegin={vi.fn()} executingRun />);
    const begin = screen.getByRole("button", { name: /Begin the run/i });
    expect(begin).toBeDisabled();
    expect(screen.getByText(/A run is in progress/i)).toBeInTheDocument();
  });

  it("enables Begin when no run is executing and a task is set", () => {
    render(<PipelineSetup defaultTask="build it" onBegin={vi.fn()} executingRun={false} />);
    expect(screen.getByRole("button", { name: /Begin the run/i })).not.toBeDisabled();
    expect(screen.queryByText(/A run is in progress/i)).not.toBeInTheDocument();
  });
});
