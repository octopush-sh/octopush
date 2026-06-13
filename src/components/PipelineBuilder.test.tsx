import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// @xyflow/react can't lay out / measure in jsdom, so stub it to a thin shell.
// The builder's logic we care about (graph → drafts on save, header, save bar,
// palette, delete) all lives outside the canvas; node/edge rendering is covered
// by graph.test.ts. The stubbed node-state hooks stay stateful so the initial
// graph flows through to the save() call.
vi.mock("@xyflow/react", async () => {
  const React = await import("react");
  const Frag = ({ children }: any) => React.createElement(React.Fragment, null, children);
  return {
    ReactFlow: ({ children }: any) => React.createElement("div", { "data-testid": "flow" }, children),
    ReactFlowProvider: Frag,
    Background: () => null,
    BackgroundVariant: { Dots: "dots" },
    Controls: () => null,
    MiniMap: () => null,
    Panel: ({ children }: any) => React.createElement("div", null, children),
    MarkerType: { ArrowClosed: "arrowclosed" },
    Handle: () => null,
    Position: { Top: "top", Bottom: "bottom", Left: "left", Right: "right" },
    BaseEdge: () => null,
    EdgeLabelRenderer: Frag,
    getSmoothStepPath: () => ["M0,0", 0, 0],
    useNodesState: (init: any) => {
      const [n, setN] = React.useState(init);
      return [n, setN, () => {}];
    },
    useEdgesState: (init: any) => {
      const [e, setE] = React.useState(init);
      return [e, setE, () => {}];
    },
    useReactFlow: () => ({
      screenToFlowPosition: (p: any) => p,
      deleteElements: async () => {},
      fitView: () => {},
    }),
  };
});

vi.mock("./ModelPicker", () => ({
  ModelPicker: ({ activeModel }: any) => <div data-testid="model">{activeModel}</div>,
}));

const saveMock = vi.fn().mockResolvedValue("saved-id");
const removeMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../stores/pipelineStore", () => ({
  usePipelineStore: (sel: any) => sel({ save: saveMock, remove: removeMock }),
}));

const { PipelineBuilder } = await import("./PipelineBuilder");

const stage = (over: Record<string, unknown>) => ({
  id: "s", pipelineId: "p1", position: 0, role: "plan", agentModel: "claude-haiku-4-5",
  substrate: "api", checkpoint: false,
  loopTargetPosition: null, loopMaxIterations: 0, loopMode: null, maxIterations: 25,
  posX: null, posY: null, parents: [], tools: null, customName: null, instructions: null, ...over,
});
const builtin = {
  pipeline: { id: "p1", name: "Feature Factory", description: "d", isBuiltin: true, createdAt: "t" },
  stages: [
    stage({ id: "s0", position: 0, role: "implement" }),
    stage({ id: "s1", position: 1, role: "code_review", loopTargetPosition: 0, loopMaxIterations: 2, loopMode: "gated" }),
  ],
} as any;
const custom = {
  pipeline: { id: "p2", name: "Mine", description: "d", isBuiltin: false, createdAt: "t" },
  stages: [stage({ id: "s0", position: 0, role: "plan" })],
} as any;

describe("PipelineBuilder (node canvas)", () => {
  beforeEach(() => { saveMock.mockClear(); removeMock.mockClear(); });

  it("a builtin opens with the fork label and a pre-filled copy name", () => {
    render(<PipelineBuilder pipeline={builtin} onClose={vi.fn()} />);
    expect(screen.getByDisplayValue("Feature Factory (custom)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save as my copy/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Delete$/ })).not.toBeInTheDocument();
  });

  it("a custom opens with its own name, Save label, and Delete", () => {
    render(<PipelineBuilder pipeline={custom} onClose={vi.fn()} />);
    expect(screen.getByDisplayValue("Mine")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save pipeline/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Delete$/ })).toBeInTheDocument();
  });

  it("composing a new pipeline starts with an empty name and the stage palette", () => {
    render(<PipelineBuilder pipeline={null} onClose={vi.fn()} />);
    expect(screen.getByLabelText("Pipeline name")).toHaveValue("");
    // The palette offers archetypes to drop.
    expect(screen.getByText("Stages")).toBeInTheDocument();
    expect(screen.getByText("Code review")).toBeInTheDocument();
  });

  it("save compiles the canvas graph into topologically-ordered drafts", async () => {
    const onClose = vi.fn();
    render(<PipelineBuilder pipeline={builtin} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /Save as my copy/ }));
    await waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1));
    const draft = saveMock.mock.calls[0][0];
    expect(draft.pipelineId).toBe("p1"); // backend forks builtins
    expect(draft.name).toBe("Feature Factory (custom)");
    expect(draft.stages).toHaveLength(2);
    expect(draft.stages[0].role).toBe("implement");
    expect(draft.stages[1].role).toBe("code_review");
    expect(draft.stages[1].parents).toEqual([0]);
    expect(draft.stages[1].loopTargetPosition).toBe(0);
    expect(draft.stages[1].loopMode).toBe("gated");
    expect(onClose).toHaveBeenCalled();
  });

  it("delete asks for confirmation, then removes the custom pipeline", async () => {
    const onClose = vi.fn();
    render(<PipelineBuilder pipeline={custom} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /^Delete$/ }));
    fireEvent.click(screen.getByRole("button", { name: /Confirm delete/ }));
    await waitFor(() => expect(removeMock).toHaveBeenCalledWith("p2"));
    expect(onClose).toHaveBeenCalled();
  });
});
