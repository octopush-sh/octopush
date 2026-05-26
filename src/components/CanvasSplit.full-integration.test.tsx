import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ScratchpadIcon } from "./ScratchpadIcon";
import { CanvasSplit } from "./CanvasSplit";
import { useScratchpadStore } from "../stores/scratchpadStore";

/**
 * FULL INTEGRATION TEST: Icon Click → Store Toggle → CanvasSplit Re-render
 *
 * Simulates the complete user flow:
 * 1. User clicks ScratchpadIcon
 * 2. toggleOpen is called
 * 3. Store state changes (isOpen = true)
 * 4. CanvasSplit re-renders with split layout visible
 */

describe("Full Integration: Icon Click → Split Render", () => {
  beforeEach(() => {
    const store = useScratchpadStore.getState();
    store.reset?.();
  });

  it("CRITICAL: Clicking icon causes CanvasSplit to render split layout", async () => {
    const user = userEvent.setup();
    const store = useScratchpadStore.getState();

    // Component that contains both icon and split
    function TestApp() {
      return (
        <div className="h-screen flex flex-col">
          <div className="flex items-center gap-2 p-4 bg-gray-100">
            <ScratchpadIcon onClick={() => store.toggleOpen()} />
          </div>
          <div className="flex-1 overflow-hidden">
            <CanvasSplit>
              <div data-testid="canvas-content">Canvas Content</div>
            </CanvasSplit>
          </div>
        </div>
      );
    }

    const { container } = render(<TestApp />);

    // Initially: no split layout, just canvas
    expect(screen.getByTestId("canvas-content")).toBeInTheDocument();
    let splitContainer = container.querySelector(".flex.gap-0");
    expect(splitContainer).not.toBeInTheDocument();
    console.log("✓ Initial state: no split");

    // Click the icon
    const icon = screen.getByRole("button");
    await user.click(icon);
    console.log("✓ Icon clicked");

    // After click, verify store state changed
    const stateAfterClick = useScratchpadStore.getState();
    console.log("Store isOpen after click:", stateAfterClick.isOpen);
    expect(stateAfterClick.isOpen).toBe(true);

    // Wait for CanvasSplit to re-render
    await waitFor(
      () => {
        splitContainer = container.querySelector(".flex.gap-0");
        expect(splitContainer).toBeInTheDocument();
      },
      { timeout: 2000 }
    );

    console.log("✓ Split layout rendered");

    // Verify split has two columns
    const columns = container.querySelectorAll(".h-full.overflow-hidden");
    expect(columns.length).toBeGreaterThanOrEqual(2);
    console.log("✓ Split has", columns.length, "columns");

    // Verify canvas is still there (left column)
    expect(screen.getByTestId("canvas-content")).toBeInTheDocument();
    console.log("✓ Canvas content still present");
  });

  it("CRITICAL: Store toggle directly causes visible split", async () => {
    function TestApp() {
      return (
        <div className="h-screen flex flex-col">
          <div className="flex-1 overflow-hidden">
            <CanvasSplit>
              <div data-testid="canvas">Canvas</div>
            </CanvasSplit>
          </div>
        </div>
      );
    }

    const { container, rerender } = render(<TestApp />);

    // Initially no split
    expect(container.querySelector(".flex.gap-0")).not.toBeInTheDocument();

    // Toggle directly
    const store = useScratchpadStore.getState();
    store.toggleOpen();

    // Re-render to pick up state change
    rerender(
      <div className="h-screen flex flex-col">
        <div className="flex-1 overflow-hidden">
          <CanvasSplit>
            <div data-testid="canvas">Canvas</div>
          </CanvasSplit>
        </div>
      </div>
    );

    // Now split should be visible
    expect(container.querySelector(".flex.gap-0")).toBeInTheDocument();
    console.log("✓ Split appeared after store toggle");
  });
});
