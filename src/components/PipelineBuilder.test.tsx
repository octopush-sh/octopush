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
    // Render the real custom node components through nodeTypes so a node that
    // reads context (useBuilder) is exercised — catches provider-scope bugs.
    ReactFlow: ({ children, nodes, nodeTypes }: any) =>
      React.createElement(
        "div",
        { "data-testid": "flow" },
        (nodes ?? []).map((n: any) => {
          const Comp = nodeTypes?.[n.type];
          return Comp ? React.createElement(Comp, { key: n.id, id: n.id, data: n.data, selected: false }) : null;
        }),
        children,
      ),
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

// Seed minimal roles so the palette renders in tests (no Tauri IPC available).
import { setArchetypes } from "./builder/graph";
import type { Role } from "../lib/ipc";
const SEED_ROLES_FOR_TEST: Role[] = [
  { key: "plan", label: "Plan", description: "", promptBody: "", artifactKind: "plan", environment: "worktree", canLoop: false, defaultTools: ["read_file", "list_files"], defaultSubstrate: "api", defaultCheckpoint: false, tokenEstIn: 4000, tokenEstOut: 1000, isBuiltin: true },
  { key: "implement", label: "Implement", description: "", promptBody: "", artifactKind: "diff", environment: "worktree", canLoop: false, defaultTools: ["read_file", "list_files", "write_file", "run_command"], defaultSubstrate: "api", defaultCheckpoint: false, tokenEstIn: 12000, tokenEstOut: 6000, isBuiltin: true },
  { key: "code_review", label: "Code review", description: "", promptBody: "", artifactKind: "review", environment: "worktree", canLoop: true, defaultTools: ["read_file", "list_files"], defaultSubstrate: "api", defaultCheckpoint: false, tokenEstIn: 8000, tokenEstOut: 1000, isBuiltin: true },
  { key: "test", label: "Tests", description: "", promptBody: "", artifactKind: "tests", environment: "worktree", canLoop: false, defaultTools: ["read_file", "list_files", "write_file", "run_command"], defaultSubstrate: "api", defaultCheckpoint: false, tokenEstIn: 6000, tokenEstOut: 2000, isBuiltin: true },
];
const mockRolesState = { roles: SEED_ROLES_FOR_TEST, loaded: true, load: vi.fn().mockResolvedValue(undefined) };
vi.mock("../stores/rolesStore", () => ({
  useRolesStore: Object.assign(
    (sel?: any) => (typeof sel === "function" ? sel(mockRolesState) : mockRolesState),
    { getState: () => mockRolesState },
  ),
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
// A gated implement stage with no write tool — triggers the "can't write files"
// caution AND a gate, the case where the node icon used to be hidden.
const flaggedGated = {
  pipeline: { id: "p3", name: "Flagged", description: "d", isBuiltin: false, createdAt: "t" },
  stages: [stage({ id: "s0", position: 0, role: "implement", checkpoint: true, tools: ["read_file", "list_files"] })],
} as any;

describe("PipelineBuilder (node canvas)", () => {
  beforeEach(() => {
    saveMock.mockClear();
    removeMock.mockClear();
    setArchetypes(SEED_ROLES_FOR_TEST);
  });

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

  it("renders the stage nodes inside the builder context (no provider-scope crash)", () => {
    // The default new-pipeline node is an "Implement" stage; it must render
    // without throwing from useBuilder (provider must wrap ReactFlow's nodes).
    render(<PipelineBuilder pipeline={null} onClose={vi.fn()} />);
    // "Implement" appears both in the palette and as the node title.
    expect(screen.getAllByText("Implement").length).toBeGreaterThanOrEqual(2);
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

  it("states a stage's caution on the node and in the save bar, even when it gates", () => {
    render(<PipelineBuilder pipeline={flaggedGated} onClose={vi.fn()} />);
    // The node carries the reason on its warning marker (which now coexists
    // with the gate marker instead of being hidden by it).
    expect(screen.getByLabelText(/can't write files/i)).toBeInTheDocument();
    // And the save bar states the cause, not just a count.
    expect(screen.getByText(/can't write files/i)).toBeInTheDocument();
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
