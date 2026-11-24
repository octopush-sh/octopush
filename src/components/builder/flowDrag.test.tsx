// The real @xyflow/react (no stub): a press on a stage that barely moves is a
// click, not a drag, so it never reaches `onNodeDragStart`, which records an
// undo entry in the builder.
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { ReactFlow, ReactFlowProvider, type Node } from "@xyflow/react";
import { NODE_DRAG_THRESHOLD } from "./flowTheme";

const nodes: Node[] = [{ id: "a", position: { x: 0, y: 0 }, data: { label: "A" }, width: 100, height: 40 }];

/** A mouse event whose `view` is the window: d3-drag (under XYDrag) follows
 *  the pointer there. jsdom's constructor refuses Vitest's window as `view`,
 *  so it is set afterwards. */
function mouse(type: string, clientX: number): MouseEvent {
  const event = new MouseEvent(type, { clientX, clientY: 20, button: 0, bubbles: true, cancelable: true });
  Object.defineProperty(event, "view", { value: window });
  return event;
}

/** A press on `el` that travels `moveBy` px before it is released (the
 *  moves bubble up to the window, where d3-drag listens). */
function press(el: Element, moveBy: number) {
  fireEvent(el, mouse("mousedown", 50));
  fireEvent(el, mouse("mousemove", 50 + moveBy));
  fireEvent(el, mouse("mouseup", 50 + moveBy));
  fireEvent(el, mouse("click", 50 + moveBy));
}

function mount() {
  const onNodeDragStart = vi.fn();
  const onNodeClick = vi.fn();
  const view = render(
    <div style={{ width: 800, height: 600 }}>
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          nodeDragThreshold={NODE_DRAG_THRESHOLD}
          onNodeDragStart={onNodeDragStart}
          onNodeClick={onNodeClick}
        />
      </ReactFlowProvider>
    </div>,
  );
  const node = view.container.querySelector('[data-id="a"]');
  if (!node) throw new Error("node not rendered");
  return { node, onNodeDragStart, onNodeClick };
}

describe("builder canvas: click vs drag (real @xyflow/react)", () => {
  it("a press that moves less than the threshold is a click and starts no drag", async () => {
    const { node, onNodeDragStart, onNodeClick } = mount();
    await act(async () => press(node, NODE_DRAG_THRESHOLD - 1));
    expect(onNodeDragStart).not.toHaveBeenCalled();
    expect(onNodeClick).toHaveBeenCalledTimes(1);
  });

  it("a press that travels past the threshold is a drag", async () => {
    const { node, onNodeDragStart } = mount();
    await act(async () => press(node, NODE_DRAG_THRESHOLD + 6));
    expect(onNodeDragStart).toHaveBeenCalledTimes(1);
  });
});
