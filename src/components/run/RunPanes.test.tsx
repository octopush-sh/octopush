import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

vi.mock("../../lib/ipc", () => ({ ipc: {} }));

const { useTerminalsStore } = await import("../../stores/terminalsStore");
const { useTerminalLayoutStore } = await import("../../stores/terminalLayoutStore");
const { useTerminalSlotsStore } = await import("../../stores/terminalSlotsStore");
const { RunPanes } = await import("./RunPanes");

const WS = "ws-panes";
const run = () => useTerminalLayoutStore.getState().getRun(WS);

function seed(ids: string[], slots: (string | null)[], focused = 0) {
  useTerminalsStore.setState({
    terminalsByWs: {
      [WS]: ids.map((id, position) => ({
        id, label: `Label ${id}`, position, running: true, busy: false, restored: false,
        role: "shell" as const, command: null,
      })),
    },
  });
  act(() =>
    useTerminalsStore.getState().updateLayout(WS, (l) => ({ ...l, slots, focused, ratios: slots.length > 1 ? [0.5] : [] })),
  );
}

/** The sessions the slot registry has on screen, in slot order. */
const published = () =>
  Object.values(useTerminalSlotsStore.getState().slots).map((s) => s.terminalId).sort();

beforeEach(() => {
  useTerminalsStore.setState({ terminalsByWs: {}, activeByWs: {}, setupByTerminal: {} });
  useTerminalLayoutStore.setState({ runByWs: {}, mruByWs: {}, resizing: false });
  useTerminalSlotsStore.setState({ slots: {}, origin: { left: 0, top: 0 } });
});

describe("RunPanes", () => {
  it("is today's full canvas with one pane: one slot, no captions, no divider", () => {
    seed(["a", "b"], ["a"]);
    render(<RunPanes workspaceId={WS} />);
    expect(published()).toEqual(["a"]);
    expect(screen.queryByTestId("run-pane-caption-0")).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("puts two sessions side by side under captions, the focused one ivory; a click focuses", () => {
    seed(["a", "b"], ["a", "b"], 1);
    render(<RunPanes workspaceId={WS} />);
    expect(published()).toEqual(["a", "b"]);
    expect(screen.getByTestId("run-pane-caption-0")).toHaveTextContent("Label a");
    expect(screen.getByTestId("run-pane-caption-0").dataset.focused).toBe("false");
    expect(screen.getByTestId("run-pane-caption-1").innerHTML).toMatch(/border-octo-border-strong text-octo-ivory/);
    expect(screen.getByTestId("run-pane-caption-0").innerHTML).toContain("text-octo-mute");

    // A click on a caption focuses its pane without moving sessions.
    fireEvent.click(screen.getByRole("button", { name: /Label a/ }));
    expect(run().slots).toEqual(["a", "b"]);
    expect(useTerminalsStore.getState().getActiveId(WS)).toBe("a");
  });

  it("leaves the view with ×, back to one pane, and keeps the session", () => {
    seed(["a", "b"], ["a", "b"], 0);
    render(<RunPanes workspaceId={WS} />);
    const leave = screen.getByTestId("run-pane-leave-0");
    expect(leave).toHaveAttribute("title", "Leave the view · the session keeps running");
    fireEvent.click(leave);
    expect(run().slots).toEqual(["b"]);
    expect(useTerminalsStore.getState().getActiveId(WS)).toBe("b");
    expect(useTerminalsStore.getState().getTerminals(WS).map((t) => t.id)).toEqual(["a", "b"]);
    expect(screen.queryByTestId("run-pane-caption-0")).toBeNull();
  });

  it("swaps from the caption menu (focus stays with its session), and leaves from it", () => {
    seed(["a", "b"], ["a", "b"], 0);
    render(<RunPanes workspaceId={WS} />);
    fireEvent.click(screen.getByTestId("run-pane-menu-0"));
    expect(screen.getByRole("menu")).toHaveTextContent("Swap with…");
    fireEvent.click(screen.getByRole("menuitem", { name: "Label b" }));
    expect(run().slots).toEqual(["b", "a"]);
    expect(run().focused).toBe(1);
    expect(useTerminalsStore.getState().getActiveId(WS)).toBe("a");

    fireEvent.click(screen.getByTestId("run-pane-menu-1"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Leave the view" }));
    expect(run().slots).toEqual(["b"]);
  });

  it("resizes from the keyboard, evens on double-click, and stays within 20–80%", () => {
    seed(["a", "b"], ["a", "b"]);
    render(<RunPanes workspaceId={WS} />);
    const divider = screen.getByRole("separator", { name: "Resize the panes" });
    expect(divider).toHaveAttribute("title", "Drag to resize · Double-click to even");
    fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(run().ratios[0]).toBeCloseTo(0.55);
    fireEvent.keyDown(divider, { key: "ArrowLeft", shiftKey: true });
    expect(run().ratios[0]).toBeCloseTo(0.54);
    for (let i = 0; i < 10; i++) fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(run().ratios[0]).toBeCloseTo(0.8);
    fireEvent.doubleClick(divider);
    expect(run().ratios[0]).toBe(0.5);
  });

  it("drags the divider, refitting on frames and telling the PTY only on release", () => {
    seed(["a", "b"], ["a", "b"]);
    render(<RunPanes workspaceId={WS} />);
    const divider = screen.getByRole("separator");
    const row = divider.parentElement!.parentElement!;
    vi.spyOn(row, "getBoundingClientRect").mockReturnValue({ left: 100, width: 1000 } as DOMRect);
    fireEvent.pointerDown(divider, { button: 0, pointerId: 1 });
    expect(useTerminalLayoutStore.getState().resizing).toBe(true);
    fireEvent.pointerMove(divider, { clientX: 400, pointerId: 1 });
    expect(run().ratios[0]).toBeCloseTo(0.3);
    fireEvent.pointerUp(divider, { pointerId: 1 });
    expect(useTerminalLayoutStore.getState().resizing).toBe(false);
  });

  it("ends a drag the divider never saw released, so the PTYs get their size again", () => {
    seed(["a", "b"], ["a", "b"]);
    const { unmount } = render(<RunPanes workspaceId={WS} />);
    fireEvent.pointerDown(screen.getByRole("separator"), { button: 0, pointerId: 1 });
    expect(document.body.style.cursor).toBe("col-resize");
    // The view drops to one pane mid-drag.
    act(() => useTerminalsStore.getState().updateLayout(WS, (l) => ({ ...l, slots: ["a"], focused: 0, ratios: [] })));
    expect(useTerminalLayoutStore.getState().resizing).toBe(false);
    expect(document.body.style.cursor).toBe("");

    // And when Run goes away mid-drag.
    act(() => useTerminalsStore.getState().updateLayout(WS, (l) => ({ ...l, slots: ["a", "b"], ratios: [0.5] })));
    fireEvent.pointerDown(screen.getByRole("separator"), { button: 0, pointerId: 1 });
    unmount();
    expect(useTerminalLayoutStore.getState().resizing).toBe(false);
    expect(document.body.style.cursor).toBe("");
  });
});
