import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

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

describe("StageFlow — quiet crew line", () => {
  it("renders one line: role names, the ⟜ gate mark, the loop badge — no romans, no arrows", () => {
    render(<StageFlow stages={stages} overrides={{}} onOverride={vi.fn()} />);
    expect(screen.getByText("Plan")).toBeInTheDocument();
    expect(screen.getByText("Code review")).toBeInTheDocument();
    expect(screen.getByText("⟜")).toBeInTheDocument();          // gate mark on the gated stage
    expect(screen.getByText("⟲ ×2")).toBeInTheDocument();       // loop badge
    expect(screen.queryByText("⟶")).not.toBeInTheDocument();
    expect(screen.queryByText("I")).not.toBeInTheDocument();
    expect(screen.queryByText("II")).not.toBeInTheDocument();
    // the crew editor is folded — no model chips at rest
    expect(screen.queryByText(/^model:/)).not.toBeInTheDocument();
  });

  it("shows the overridden model in mute on the line", () => {
    render(<StageFlow stages={stages} overrides={{ 0: "override-0" }} onOverride={vi.fn()} />);
    expect(screen.getByText("· override-0")).toBeInTheDocument();
  });

  it("unfolds the crew editor from the pencil and wires overrides", () => {
    const onOverride = vi.fn();
    render(<StageFlow stages={stages} overrides={{ 0: "override-0" }} onOverride={onOverride} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit the crew" }));
    expect(screen.getByRole("button", { name: "Close the crew editor" })).toBeInTheDocument();
    expect(screen.getByText("model:override-0")).toBeInTheDocument(); // stage 0 uses the override
    expect(screen.getByText("model:m1")).toBeInTheDocument();         // stage 1 keeps its default
    fireEvent.click(screen.getByText("model:m1"));
    expect(onOverride).toHaveBeenCalledWith(1, "new-model");
    expect(screen.getByText("⟜ gate")).toBeInTheDocument();           // gate badge inside the editor card
  });
});
