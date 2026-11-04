import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { TerminalHost } from "./TerminalHost";
import { TerminalSlot } from "./TerminalSlot";
import { useTerminalSlotsStore, type SlotMode } from "../stores/terminalSlotsStore";

// The host sits at (0, 60); every slot measures (40, 100) · 600×400.
function domRect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, x: left, y: top, right: left + width, bottom: top + height, toJSON: () => ({}) } as DOMRect;
}

const mounts: Record<string, number> = {};

function Pane({ id, shown }: { id: string; shown: boolean }) {
  useEffect(() => {
    mounts[id] = (mounts[id] ?? 0) + 1;
  }, [id]);
  return <div data-testid={`pane-${id}`} data-shown={String(shown)} />;
}

function Canvas({ mode, runId }: { mode: SlotMode | null; runId: string | null }) {
  return (
    <div>
      <TerminalSlot mode="run" terminalId={runId} />
      <TerminalHost
        mode={mode}
        terminalIds={["A", "B"]}
        renderPane={(id, shown) => <Pane id={id} shown={shown} />}
      />
    </div>
  );
}

function frame(id: string): HTMLElement {
  return screen.getByTestId(`pane-${id}`).parentElement as HTMLElement;
}

describe("TerminalHost", () => {
  beforeEach(() => {
    useTerminalSlotsStore.setState({ slots: {}, origin: { left: 0, top: 0 } });
    for (const k of Object.keys(mounts)) delete mounts[k];
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.hasAttribute("data-terminal-slot") ? domRect(40, 100, 600, 400) : domRect(0, 60, 1000, 700);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("draws the slot's session over the slot and hides the rest", () => {
    render(<Canvas mode="run" runId="A" />);
    expect(screen.getByTestId("pane-A").dataset.shown).toBe("true");
    expect(frame("A").style.left).toBe("40px");
    expect(frame("A").style.top).toBe("40px");
    expect(frame("A").style.width).toBe("600px");
    expect(frame("A").style.height).toBe("400px");
    expect(screen.getByTestId("pane-B").dataset.shown).toBe("false");
    expect(frame("B").style.display).toBe("none");
  });

  it("places frames against the host origin from the store, in the same render", () => {
    render(<Canvas mode="run" runId="A" />);
    expect(useTerminalSlotsStore.getState().origin).toEqual({ left: 0, top: 60 });
    // The canvas moves right and down (rail collapse, header growth): the
    // frame follows in the very commit that updates the origin.
    act(() => useTerminalSlotsStore.getState().setOrigin({ left: 20, top: 80 }));
    expect(frame("A").style.left).toBe("20px");
    expect(frame("A").style.top).toBe("20px");
  });

  it("uses only the active mode's slots", () => {
    const { rerender } = render(<Canvas mode={null} runId="A" />);
    // The hidden mode still measured its slot…
    expect(Object.values(useTerminalSlotsStore.getState().slots)).toHaveLength(1);
    // …but nothing is drawn outside it.
    expect(screen.getByTestId("pane-A").dataset.shown).toBe("false");
    rerender(<Canvas mode="talk" runId="A" />);
    expect(screen.getByTestId("pane-A").dataset.shown).toBe("false");
    rerender(<Canvas mode="run" runId="A" />);
    expect(screen.getByTestId("pane-A").dataset.shown).toBe("true");
  });

  it("switches the session in a slot without remounting any pane", () => {
    const { rerender } = render(<Canvas mode="run" runId="A" />);
    rerender(<Canvas mode="run" runId="B" />);
    expect(screen.getByTestId("pane-A").dataset.shown).toBe("false");
    expect(screen.getByTestId("pane-B").dataset.shown).toBe("true");
    rerender(<Canvas mode={null} runId="B" />);
    rerender(<Canvas mode="run" runId="A" />);
    expect(mounts).toEqual({ A: 1, B: 1 });
  });

  it("follows the overlays' fade and never takes the pointer itself", () => {
    const { rerender } = render(<Canvas mode="run" runId="A" />);
    const layer = screen.getByTestId("terminal-host").parentElement as HTMLElement;
    expect(layer.className).toContain("transition-opacity");
    expect(layer.style.opacity).toBe("1");
    expect(layer.style.pointerEvents).toBe("none");
    expect(frame("A").style.pointerEvents).toBe("auto");
    rerender(<Canvas mode={null} runId="A" />);
    expect(layer.style.opacity).toBe("0");
    expect(layer.style.visibility).toBe("hidden");
  });

  it("shows a crashed pane's error card inside the layer, clickable only in Run", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const crash = { on: true };
    function Bomb({ id, shown }: { id: string; shown: boolean }) {
      if (crash.on) throw new Error("pane blew up");
      return <Pane id={id} shown={shown} />;
    }
    const host = (mode: SlotMode | null) => (
      <div>
        <TerminalSlot mode="run" terminalId="A" />
        <TerminalHost mode={mode} terminalIds={["A"]} renderPane={(id, shown) => <Bomb id={id} shown={shown} />} />
      </div>
    );
    const { rerender } = render(host(null));
    const layer = screen.getByTestId("terminal-host").parentElement as HTMLElement;
    const card = screen.getByTestId("panel-error-card");
    expect(layer.contains(card)).toBe(true);
    // Outside Run the card is hidden with the layer.
    expect(layer.style.visibility).toBe("hidden");
    rerender(host("run"));
    expect(layer.style.visibility).toBe("visible");
    expect(layer.style.pointerEvents).toBe("none");
    // Only the card opts back into the pointer, so Try again can be clicked
    // while the full-size fallback lets clicks reach the rail below.
    expect(card.style.pointerEvents).toBe("auto");
    expect((card.parentElement as HTMLElement).style.pointerEvents).not.toBe("auto");
    crash.on = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.queryByTestId("panel-error-card")).toBeNull();
    expect(screen.getByTestId("pane-A").dataset.shown).toBe("true");
  });

  it("reports a click or focus inside a shown pane, never a hidden one", () => {
    const onPaneFocus = vi.fn();
    render(
      <div>
        <TerminalSlot mode="run" terminalId="A" />
        <TerminalHost
          mode="run"
          terminalIds={["A", "B"]}
          renderPane={(id, shown) => <Pane id={id} shown={shown} />}
          onPaneFocus={onPaneFocus}
        />
      </div>,
    );
    fireEvent.pointerDown(screen.getByTestId("pane-A"));
    fireEvent.pointerDown(screen.getByTestId("pane-B"));
    expect(onPaneFocus.mock.calls).toEqual([["A"]]);
    // A pane coming on screen fades in rather than appearing abruptly.
    expect(frame("A").className).toContain("octo-fade-in");
  });

  it("withdraws a slot that unmounts or empties", () => {
    const { rerender, unmount } = render(<Canvas mode="run" runId="A" />);
    rerender(<Canvas mode="run" runId={null} />);
    expect(useTerminalSlotsStore.getState().slots).toEqual({});
    expect(screen.getByTestId("pane-A").dataset.shown).toBe("false");
    rerender(<Canvas mode="run" runId="A" />);
    unmount();
    expect(useTerminalSlotsStore.getState().slots).toEqual({});
  });
});
