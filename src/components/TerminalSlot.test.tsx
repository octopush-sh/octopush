import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { useTerminalSlotsStore } from "../stores/terminalSlotsStore";
import { TerminalSlot } from "./TerminalSlot";

const rectOf = () => Object.values(useTerminalSlotsStore.getState().slots)[0]?.rect;

beforeEach(() => useTerminalSlotsStore.setState({ slots: {}, origin: { left: 0, top: 0 } }));

describe("TerminalSlot", () => {
  it("measures again when a moving ancestor's transition ends, not an unrelated one", () => {
    const { container } = render(
      <div>
        <div data-testid="pane">
          <TerminalSlot mode="run" terminalId="a" />
        </div>
        <div data-testid="other" />
      </div>,
    );
    const slot = container.querySelector("[data-terminal-slot]")!;
    const pane = container.querySelector('[data-testid="pane"]')!;
    const other = container.querySelector('[data-testid="other"]')!;
    // The pane moves without resizing, so no ResizeObserver callback.
    vi.spyOn(slot, "getBoundingClientRect").mockReturnValue({ left: 400, top: 0, width: 300, height: 200 } as DOMRect);

    act(() => void other.dispatchEvent(new Event("transitionend", { bubbles: true })));
    expect(rectOf()?.left).toBe(0);
    act(() => void pane.dispatchEvent(new Event("transitionend", { bubbles: true })));
    expect(rectOf()).toEqual({ left: 400, top: 0, width: 300, height: 200 });
  });
});
