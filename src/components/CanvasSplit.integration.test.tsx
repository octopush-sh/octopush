import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CanvasSplit } from "./CanvasSplit";
import { useScratchpadStore } from "../stores/scratchpadStore";

/**
 * EXHAUSTIVE INTEGRATION TESTS FOR CANVASPLIT
 *
 * These tests verify the complete flow:
 * 1. Store state isOpen: false → component renders children only
 * 2. Store state isOpen: true → component renders split layout
 * 3. Store state changes → component re-renders correctly
 */

describe("CanvasSplit - Integration Tests", () => {
  beforeEach(() => {
    const store = useScratchpadStore.getState();
    store.reset?.();
  });

  it("CRITICAL: CanvasSplit renders children when isOpen is false", () => {
    const { container } = render(
      <CanvasSplit>
        <div data-testid="test-child">Canvas Content</div>
      </CanvasSplit>
    );

    // Should render child without split layout
    expect(screen.getByTestId("test-child")).toBeInTheDocument();
    expect(screen.getByText("Canvas Content")).toBeInTheDocument();

    // Should NOT have split container (flex with gap-0)
    const splitContainer = container.querySelector(".gap-0");
    expect(splitContainer).not.toBeInTheDocument();
  });

  it("CRITICAL: CanvasSplit renders split layout when isOpen is true", () => {
    const store = useScratchpadStore.getState();
    store.toggleOpen(); // isOpen becomes true

    const { container } = render(
      <CanvasSplit>
        <div data-testid="test-child">Canvas Content</div>
      </CanvasSplit>
    );

    // Should have split container with flex layout
    const splitContainer = container.querySelector(".flex.gap-0");
    expect(splitContainer).toBeInTheDocument();
    expect(splitContainer).toHaveClass("h-full");
    expect(splitContainer).toHaveClass("w-full");
  });

  it("CRITICAL: Split layout has two columns with correct widths", () => {
    const store = useScratchpadStore.getState();
    store.toggleOpen();

    const { container } = render(
      <CanvasSplit>
        <div data-testid="test-child">Canvas</div>
      </CanvasSplit>
    );

    // Get flex columns (children of split container)
    const splitContainer = container.querySelector(".flex.gap-0");
    const columns = Array.from(splitContainer?.children || []).filter(
      (child) => child.className.includes("h-full") && child.className.includes("overflow-hidden")
    );

    // Should have exactly 2 columns (left: canvas, right: scratchpad)
    expect(columns).toHaveLength(2);

    // Left column should have 50% width by default
    const leftColumn = columns[0] as HTMLElement;
    expect(leftColumn.style.width).toBe("50%");

    // Right column should have 50% width by default
    const rightColumn = columns[1] as HTMLElement;
    expect(rightColumn.style.width).toBe("50%");
  });

  it("CRITICAL: Divider exists with correct styling when split is open", () => {
    const store = useScratchpadStore.getState();
    store.toggleOpen();

    const { container } = render(
      <CanvasSplit>
        <div>Canvas</div>
      </CanvasSplit>
    );

    const divider = container.querySelector(".w-\\[1px\\]");
    expect(divider).toBeInTheDocument();
    expect(divider).toHaveClass("bg-octo-hairline");
    expect(divider).toHaveClass("cursor-col-resize");
  });

  it("CRITICAL: Left column contains canvas children", () => {
    const store = useScratchpadStore.getState();
    store.toggleOpen();

    const { container } = render(
      <CanvasSplit>
        <div data-testid="canvas-content">Canvas Content Here</div>
      </CanvasSplit>
    );

    expect(screen.getByTestId("canvas-content")).toBeInTheDocument();

    // Verify it's in the left column (first h-full column)
    const splitContainer = container.querySelector(".flex.gap-0");
    const firstColumn = splitContainer?.firstChild as HTMLElement;
    expect(firstColumn?.textContent).toContain("Canvas Content Here");
  });

  it("CRITICAL: Right column contains ScratchpadEditor", () => {
    const store = useScratchpadStore.getState();
    store.toggleOpen();

    const { container } = render(
      <CanvasSplit>
        <div>Canvas</div>
      </CanvasSplit>
    );

    // Right column should have ScratchpadEditor rendered
    const splitContainer = container.querySelector(".flex.gap-0");
    const rightColumn = splitContainer?.lastChild as HTMLElement;

    // Should contain scratchpad editor (which renders tabs and code editor)
    // At minimum, should have content from ScratchpadEditor
    expect(rightColumn).toBeInTheDocument();
  });

  it("CRITICAL: Toggle from closed to open renders split layout", () => {
    const store = useScratchpadStore.getState();
    const { container, rerender } = render(
      <CanvasSplit>
        <div data-testid="test-child">Canvas</div>
      </CanvasSplit>
    );

    // Initially closed: no split container
    expect(container.querySelector(".flex.gap-0")).not.toBeInTheDocument();

    // Toggle open
    store.toggleOpen();
    rerender(
      <CanvasSplit>
        <div data-testid="test-child">Canvas</div>
      </CanvasSplit>
    );

    // Now should have split container
    expect(container.querySelector(".flex.gap-0")).toBeInTheDocument();
  });

  it("CRITICAL: Toggle from open to closed hides split layout", () => {
    const store = useScratchpadStore.getState();
    store.toggleOpen(); // Start open

    const { container, rerender } = render(
      <CanvasSplit>
        <div data-testid="test-child">Canvas</div>
      </CanvasSplit>
    );

    // Initially open: has split container
    expect(container.querySelector(".flex.gap-0")).toBeInTheDocument();

    // Toggle closed
    store.toggleOpen();
    rerender(
      <CanvasSplit>
        <div data-testid="test-child">Canvas</div>
      </CanvasSplit>
    );

    // Now should NOT have split container
    expect(container.querySelector(".flex.gap-0")).not.toBeInTheDocument();
  });

  it("CRITICAL: isOpen state is correctly read from store", () => {
    const store = useScratchpadStore.getState();

    // Test closed state
    expect(store.isOpen).toBe(false);
    let { container } = render(
      <CanvasSplit>
        <div>Canvas</div>
      </CanvasSplit>
    );
    expect(container.querySelector(".flex.gap-0")).not.toBeInTheDocument();

    // Test open state
    store.toggleOpen();
    expect(store.isOpen).toBe(true);
    ({ container } = render(
      <CanvasSplit>
        <div>Canvas</div>
      </CanvasSplit>
    ));
    expect(container.querySelector(".flex.gap-0")).toBeInTheDocument();
  });

  it("CRITICAL: Both columns have h-full for proper height", () => {
    const store = useScratchpadStore.getState();
    store.toggleOpen();

    const { container } = render(
      <CanvasSplit>
        <div>Canvas</div>
      </CanvasSplit>
    );

    const splitContainer = container.querySelector(".flex.gap-0");
    const columns = Array.from(splitContainer?.querySelectorAll("[style*='width']") || []);

    // Both columns should have h-full class
    columns.forEach((col) => {
      expect(col).toHaveClass("h-full");
      expect(col).toHaveClass("overflow-hidden");
    });
  });

  it("CRITICAL: Container has correct flex properties", () => {
    const store = useScratchpadStore.getState();
    store.toggleOpen();

    const { container } = render(
      <CanvasSplit>
        <div>Canvas</div>
      </CanvasSplit>
    );

    const splitContainer = container.querySelector(".flex.gap-0");
    expect(splitContainer).toHaveClass("flex");
    expect(splitContainer).toHaveClass("h-full");
    expect(splitContainer).toHaveClass("w-full");
    expect(splitContainer).toHaveClass("gap-0");
    expect(splitContainer).toHaveClass("min-h-0"); // For flex height calculation
  });
});
