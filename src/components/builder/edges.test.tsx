import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// BaseEdge/EdgeLabelRenderer need a live @xyflow store in jsdom — stub the lib
// to thin shells (same approach as PipelineBuilder.test.tsx).
vi.mock("@xyflow/react", async () => {
  const React = await import("react");
  return {
    BaseEdge: ({ path }: any) => React.createElement("div", { "data-testid": "base-edge", "data-path": path }),
    EdgeLabelRenderer: ({ children }: any) => React.createElement(React.Fragment, null, children),
    getSmoothStepPath: () => ["M0,0 L10,10", 5, 5],
  };
});

const { FlowEdge, LoopEdge } = await import("./edges");
const { BuilderProvider } = await import("./BuilderContext");

const edgeProps = {
  id: "f-a-b",
  source: "a",
  target: "b",
  sourceX: 0, sourceY: 0, targetX: 10, targetY: 10,
  sourcePosition: "bottom", targetPosition: "top",
} as any;

function renderEdge(Comp: any, props: any, onDisconnect = vi.fn()) {
  render(
    <BuilderProvider value={{ validation: {}, selectedId: null, onRemove: vi.fn(), canRemove: true, onDisconnect }}>
      <Comp {...props} />
    </BuilderProvider>,
  );
  return onDisconnect;
}

describe("edges — disconnect pill", () => {
  it("shows no pill while the edge is unselected", () => {
    renderEdge(FlowEdge, { ...edgeProps, selected: false });
    expect(screen.queryByLabelText("Disconnect")).toBeNull();
  });

  it("selected flow edge shows the pill; clicking it disconnects", () => {
    const onDisconnect = renderEdge(FlowEdge, { ...edgeProps, selected: true });
    const pill = screen.getByLabelText("Disconnect");
    expect(pill.getAttribute("title")).toContain("Backspace");
    fireEvent.click(pill);
    expect(onDisconnect).toHaveBeenCalledWith("f-a-b");
  });

  it("selected loop edge shows the pill too (equivalent to \"don't loop\")", () => {
    const onDisconnect = renderEdge(LoopEdge, {
      ...edgeProps, id: "l-r-a", selected: true, data: { kind: "loop", loopMax: 3, loopMode: "gated" },
    });
    fireEvent.click(screen.getByLabelText("Disconnect"));
    expect(onDisconnect).toHaveBeenCalledWith("l-r-a");
  });

  it("keeps the ⟲ badge on loop edges", () => {
    renderEdge(LoopEdge, { ...edgeProps, id: "l-r-a", selected: false, data: { kind: "loop", loopMax: 3, loopMode: "auto" } });
    expect(screen.getByText(/⟲ ×3/)).toBeTruthy();
  });
});
