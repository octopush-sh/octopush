import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Stub ModelPicker to a button that surfaces the active model and lets us
// trigger a change — so we can assert the crew-override wiring.
vi.mock("../ModelPicker", () => ({
  ModelPicker: ({ activeModel, onSelectModel }: { activeModel: string; onSelectModel: (m: string) => void }) => (
    <button onClick={() => onSelectModel("new-model")}>model:{activeModel}</button>
  ),
}));

const { StageFlow } = await import("./StageFlow");

const stages = [
  {
    id: "s0", pipelineId: "p", position: 0, role: "plan", agentModel: "m0", substrate: "api",
    checkpoint: false, loopTargetPosition: null, loopMaxIterations: 0, loopMode: null, maxIterations: 25,
    posX: null, posY: null, parents: [], tools: null, customName: null, instructions: null,
  },
  {
    id: "s1", pipelineId: "p", position: 1, role: "code_review", agentModel: "m1", substrate: "cli",
    checkpoint: true, loopTargetPosition: 0, loopMaxIterations: 2, loopMode: "gated", maxIterations: 25,
    posX: null, posY: null, parents: [0], tools: null, customName: null, instructions: null,
  },
] as any;

describe("StageFlow", () => {
  it("draws a card per stage with title, numeral, and gate/loop markers", () => {
    render(<StageFlow stages={stages} overrides={{}} onOverride={vi.fn()} />);
    expect(screen.getByText("Plan")).toBeInTheDocument();
    expect(screen.getByText("Code review")).toBeInTheDocument();
    expect(screen.getByText("I")).toBeInTheDocument();
    expect(screen.getByText("II")).toBeInTheDocument();
    expect(screen.getByText("⟜ gate")).toBeInTheDocument(); // s1 gates
    expect(screen.getByText("⟲ ×2")).toBeInTheDocument(); // s1 loops back ×2
  });

  it("reflects the crew override and fires onOverride from the model chip", () => {
    const onOverride = vi.fn();
    render(<StageFlow stages={stages} overrides={{ 0: "override-0" }} onOverride={onOverride} />);
    expect(screen.getByText("model:override-0")).toBeInTheDocument(); // stage 0 uses the override
    expect(screen.getByText("model:m1")).toBeInTheDocument(); // stage 1 keeps its default
    fireEvent.click(screen.getByText("model:m1")); // change stage 1's model
    expect(onOverride).toHaveBeenCalledWith(1, "new-model");
  });
});
