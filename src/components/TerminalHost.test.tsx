import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
    useTerminalSlotsStore.setState({ slots: {} });
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
