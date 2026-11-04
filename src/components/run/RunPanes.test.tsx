import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

const mockIpc = { createTerminal: vi.fn() };
vi.mock("../../lib/ipc", () => ({ ipc: mockIpc }));
const noop = () => {};

const { useTerminalsStore } = await import("../../stores/terminalsStore");
const { useTerminalLayoutStore, evenRatios } = await import("../../stores/terminalLayoutStore");
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
    useTerminalsStore.getState().updateLayout(WS, (l) => ({ ...l, slots, focused, ratios: evenRatios(slots.length) })),
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
    render(<RunPanes workspaceId={WS} onOpenBeside={noop} />);
    expect(published()).toEqual(["a"]);
    expect(screen.queryByTestId("run-pane-caption-0")).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("puts two sessions side by side under captions, the focused one ivory; a click focuses", () => {
    seed(["a", "b"], ["a", "b"], 1);
    render(<RunPanes workspaceId={WS} onOpenBeside={noop} />);
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
    render(<RunPanes workspaceId={WS} onOpenBeside={noop} />);
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
    render(<RunPanes workspaceId={WS} onOpenBeside={noop} />);
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
    render(<RunPanes workspaceId={WS} onOpenBeside={noop} />);
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
    render(<RunPanes workspaceId={WS} onOpenBeside={noop} />);
    const divider = screen.getByRole("separator");
    const area = divider.parentElement!;
    vi.spyOn(area, "getBoundingClientRect").mockReturnValue({ left: 100, width: 1000 } as DOMRect);
    fireEvent.pointerDown(divider, { button: 0, pointerId: 1 });
    expect(useTerminalLayoutStore.getState().resizing).toBe(true);
    fireEvent.pointerMove(divider, { clientX: 400, pointerId: 1 });
    expect(run().ratios[0]).toBeCloseTo(0.3);
    fireEvent.pointerUp(divider, { pointerId: 1 });
    expect(useTerminalLayoutStore.getState().resizing).toBe(false);
  });

  it("an empty seat invites a session: a click opens the switcher, its CTA opens one here", async () => {
    seed(["a"], ["a", null], 0);
    mockIpc.createTerminal.mockResolvedValue({ id: "n", label: "Terminal 2", position: 1 });
    const onOpenBeside = vi.fn();
    render(<RunPanes workspaceId={WS} onOpenBeside={onOpenBeside} />);
    const seat = screen.getByTestId("run-empty-seat");
    expect(seat).toHaveTextContent("Beside");
    expect(seat).toHaveTextContent("Bring a session alongside.");
    expect(published()).toEqual(["a"]);

    fireEvent.click(seat);
    expect(onOpenBeside).toHaveBeenCalledTimes(1);
    expect(run().focused).toBe(1);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open a new session here" }));
    });
    expect(onOpenBeside).toHaveBeenCalledTimes(1);
    expect(run().slots).toEqual(["a", "n"]);
  });

  it("lays three panes around a large slot 0, with a main and a side divider", () => {
    seed(["a", "b", "c"], ["a", "b", "c"], 2);
    render(<RunPanes workspaceId={WS} onOpenBeside={noop} />);
    expect(published()).toEqual(["a", "b", "c"]);
    const [main, side] = screen.getAllByRole("separator");
    expect(main).toHaveAttribute("aria-orientation", "vertical");
    expect(side).toHaveAttribute("aria-orientation", "horizontal");
    // The side divider moves with ↑/↓ and leaves the main split alone.
    fireEvent.keyDown(side, { key: "ArrowDown" });
    fireEvent.keyDown(side, { key: "ArrowRight" });
    expect(run().ratios[0]).toBe(0.5);
    expect(run().ratios[1]).toBeCloseTo(0.55);
    fireEvent.doubleClick(side);
    expect(run().ratios).toEqual([0.5, 0.5]);
    // Focus never moves a session between slots.
    fireEvent.click(screen.getByRole("button", { name: /Label a/ }));
    expect(run().slots).toEqual(["a", "b", "c"]);
  });

  it("stacks from the caption menu for two and three panes, until Automatic again", () => {
    seed(["a", "b"], ["a", "b"]);
    render(<RunPanes workspaceId={WS} onOpenBeside={noop} />);
    fireEvent.click(screen.getByTestId("run-pane-menu-0"));
    expect(screen.getByRole("menuitemradio", { name: "Automatic" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Stack" }));
    expect(run().orientation).toBe("stacked");
    expect(screen.getByRole("separator")).toHaveAttribute("aria-orientation", "horizontal");
    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowUp" });
    expect(run().ratios[0]).toBeCloseTo(0.45);

    // The override holds at three panes.
    act(() => useTerminalsStore.getState().openBeside(WS, null));
    expect(screen.getAllByRole("separator")[0]).toHaveAttribute("aria-orientation", "horizontal");
    fireEvent.click(screen.getByTestId("run-pane-menu-1"));
    expect(screen.getByRole("menuitemradio", { name: "Stack" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Automatic" }));
    expect(run().orientation).toBe("auto");
    expect(screen.getAllByRole("separator")[0]).toHaveAttribute("aria-orientation", "vertical");
  });

  it("stacks on its own when side by side would leave a pane under 72 columns", () => {
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ left: 0, top: 0, width: 700, height: 600 } as DOMRect);
    seed(["a", "b"], ["a", "b"]);
    render(<RunPanes workspaceId={WS} onOpenBeside={noop} />);
    expect(screen.getByRole("separator")).toHaveAttribute("aria-orientation", "horizontal");
    rect.mockRestore();
  });

  it("puts four panes in a 2×2 grid with one shared cross and no orientation choice", () => {
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ left: 0, top: 0, width: 700, height: 600 } as DOMRect);
    seed(["a", "b", "c", "d"], ["a", "b", "c", "d"], 3);
    render(<RunPanes workspaceId={WS} onOpenBeside={noop} />);
    rect.mockRestore();
    expect(published()).toEqual(["a", "b", "c", "d"]);
    // Narrow, yet still the grid: the 72-column rule doesn't apply at four.
    const dividers = screen.getAllByRole("separator");
    expect(dividers.map((d) => d.getAttribute("aria-orientation"))).toEqual(["vertical", "horizontal"]);
    fireEvent.keyDown(dividers[0], { key: "ArrowLeft" });
    fireEvent.keyDown(dividers[1], { key: "ArrowDown", shiftKey: true });
    expect(run().ratios[0]).toBeCloseTo(0.45);
    expect(run().ratios[1]).toBeCloseTo(0.51);
    fireEvent.click(screen.getByTestId("run-pane-menu-3"));
    expect(screen.queryByRole("menuitemradio")).toBeNull();
    expect(screen.getByRole("menu")).toHaveTextContent("Leave the view");

    // Leaving a pane shifts the rest down and lays out three.
    fireEvent.click(screen.getByRole("menuitem", { name: "Leave the view" }));
    fireEvent.click(screen.getByTestId("run-pane-leave-1"));
    expect(run().slots).toEqual(["a", "c"]);
  });

  it("ends a drag the divider never saw released, so the PTYs get their size again", () => {
    seed(["a", "b"], ["a", "b"]);
    const { unmount } = render(<RunPanes workspaceId={WS} onOpenBeside={noop} />);
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
