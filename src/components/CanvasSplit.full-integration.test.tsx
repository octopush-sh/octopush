import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Stub the editor so this integration test exercises the split layout only,
// without booting a real CodeMirror EditorView (which can't render in jsdom).
vi.mock("./ScratchpadEditor", () => ({
  ScratchpadEditor: () => <div data-testid="scratchpad-editor">editor</div>,
}));

import { ScratchpadIcon } from "./ScratchpadIcon";
import { CanvasSplit } from "./CanvasSplit";
import { useScratchpadStore } from "../stores/scratchpadStore";

/**
 * Integration: clicking the scratchpad icon toggles the store, and the mounted
 * CanvasSplit reacts by revealing the split affordance (the resize divider)
 * while always keeping the canvas content mounted.
 *
 * Note on the current design: CanvasSplit ALWAYS renders both panes in the DOM
 * (the scratchpad pane is collapsed to width 0 + hidden when closed) so that
 * children — including live terminals — are never remounted. The reliable
 * signal that the split is "open" is therefore the presence of the resize
 * divider, not the appearance/disappearance of a pane.
 */
describe("Integration: Icon Click → Split toggles", () => {
  beforeEach(() => {
    useScratchpadStore.getState().reset();
  });

  function TestApp() {
    return (
      <div className="h-screen flex flex-col">
        <div className="flex items-center gap-2 p-4">
          <ScratchpadIcon onClick={() => useScratchpadStore.getState().toggleOpen()} />
        </div>
        <div className="flex-1 overflow-hidden">
          <CanvasSplit>
            <div data-testid="canvas-content">Canvas Content</div>
          </CanvasSplit>
        </div>
      </div>
    );
  }

  it("reveals the resize divider after the icon is clicked, keeping the canvas mounted", async () => {
    const user = userEvent.setup();
    const { container } = render(<TestApp />);

    // Closed: canvas present, no divider yet.
    expect(screen.getByTestId("canvas-content")).toBeInTheDocument();
    expect(container.querySelector(".cursor-col-resize")).toBeNull();

    await user.click(screen.getByRole("button"));

    expect(useScratchpadStore.getState().isOpen).toBe(true);
    await waitFor(() => {
      expect(container.querySelector(".cursor-col-resize")).toBeInTheDocument();
    });
    // Canvas content stays mounted across the toggle (no remount).
    expect(screen.getByTestId("canvas-content")).toBeInTheDocument();
  });

  it("hides the divider again when toggled closed", async () => {
    const user = userEvent.setup();
    const { container } = render(<TestApp />);
    const button = screen.getByRole("button");

    await user.click(button); // open
    await waitFor(() =>
      expect(container.querySelector(".cursor-col-resize")).toBeInTheDocument(),
    );

    await user.click(button); // close
    await waitFor(() =>
      expect(container.querySelector(".cursor-col-resize")).toBeNull(),
    );
    expect(useScratchpadStore.getState().isOpen).toBe(false);
  });
});
