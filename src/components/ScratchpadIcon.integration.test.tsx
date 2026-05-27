import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ScratchpadIcon } from "./ScratchpadIcon";
import { useScratchpadStore } from "../stores/scratchpadStore";

/**
 * EXHAUSTIVE INTEGRATION TESTS FOR SCRATCHPAD ICON
 *
 * These tests verify:
 * 1. Icon reads isOpen state correctly
 * 2. Icon displays correct title based on state
 * 3. Icon opacity changes based on state
 * 4. Clicking icon calls the onClick callback
 * 5. Icon re-renders when store state changes
 */

describe("ScratchpadIcon - Integration Tests", () => {
  beforeEach(() => {
    const store = useScratchpadStore.getState();
    store.reset?.();
  });

  it("CRITICAL: Icon renders with correct title when closed", () => {
    const store = useScratchpadStore.getState();
    expect(store.isOpen).toBe(false);

    render(<ScratchpadIcon onClick={vi.fn()} />);

    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("title", "Open scratchpad");
    expect(button).toHaveAttribute("aria-label", "Open scratchpad");
  });

  it("CRITICAL: Icon renders with correct title when open", () => {
    const store = useScratchpadStore.getState();
    store.toggleOpen();
    // Re-read fresh state: the captured `store` snapshot is not mutated in
    // place by Zustand (each set() produces a new state object).
    expect(useScratchpadStore.getState().isOpen).toBe(true);

    render(<ScratchpadIcon onClick={vi.fn()} />);

    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("title", "Close scratchpad");
    expect(button).toHaveAttribute("aria-label", "Close scratchpad");
  });

  it("CRITICAL: Icon shows correct opacity when closed", () => {
    const store = useScratchpadStore.getState();
    expect(store.isOpen).toBe(false);

    const { container } = render(<ScratchpadIcon onClick={vi.fn()} />);

    const button = container.querySelector("button");
    // Opacity should be 0.2 when closed
    expect(button).toHaveStyle("opacity: 0.2");
  });

  it("CRITICAL: Icon shows correct opacity when open", () => {
    const store = useScratchpadStore.getState();
    store.toggleOpen();
    // Re-read fresh state: the captured `store` snapshot is not mutated in
    // place by Zustand (each set() produces a new state object).
    expect(useScratchpadStore.getState().isOpen).toBe(true);

    const { container } = render(<ScratchpadIcon onClick={vi.fn()} />);

    const button = container.querySelector("button");
    // Opacity should be 1 when open
    expect(button).toHaveStyle("opacity: 1");
  });

  it("CRITICAL: Icon renders the ≡ glyph", () => {
    render(<ScratchpadIcon onClick={vi.fn()} />);

    expect(screen.getByText("≡")).toBeInTheDocument();
  });

  it("CRITICAL: Clicking icon calls onClick callback", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();

    render(<ScratchpadIcon onClick={onClick} />);

    const button = screen.getByRole("button");
    await user.click(button);

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("CRITICAL: Icon has correct styling classes", () => {
    render(<ScratchpadIcon onClick={vi.fn()} />);

    const button = screen.getByRole("button");
    expect(button).toHaveClass("flex");
    expect(button).toHaveClass("items-center");
    expect(button).toHaveClass("justify-center");
    expect(button).toHaveClass("h-8");
    expect(button).toHaveClass("w-8");
    expect(button).toHaveClass("rounded");
    expect(button).toHaveClass("transition-colors");
  });

  it("CRITICAL: Icon color is always brass", () => {
    const { container } = render(<ScratchpadIcon onClick={vi.fn()} />);

    const button = container.querySelector("button");
    expect(button).toHaveStyle("color: var(--color-octo-brass)");
  });

  it("CRITICAL: Icon transitions between states when store changes", () => {
    const store = useScratchpadStore.getState();
    const { rerender } = render(<ScratchpadIcon onClick={vi.fn()} />);

    // Initial: closed
    expect(screen.getByRole("button")).toHaveAttribute("title", "Open scratchpad");
    expect(screen.getByRole("button")).toHaveStyle("opacity: 0.2");

    // Toggle open
    store.toggleOpen();
    rerender(<ScratchpadIcon onClick={vi.fn()} />);

    // Now open
    expect(screen.getByRole("button")).toHaveAttribute("title", "Close scratchpad");
    expect(screen.getByRole("button")).toHaveStyle("opacity: 1");

    // Toggle closed
    store.toggleOpen();
    rerender(<ScratchpadIcon onClick={vi.fn()} />);

    // Back to closed
    expect(screen.getByRole("button")).toHaveAttribute("title", "Open scratchpad");
    expect(screen.getByRole("button")).toHaveStyle("opacity: 0.2");
  });

  it("CRITICAL: Icon glyph uses correct font", () => {
    const { container } = render(<ScratchpadIcon onClick={vi.fn()} />);

    const glyph = container.querySelector("span");
    expect(glyph).toHaveClass("font-mono");
    expect(glyph).toHaveClass("text-[14px]");
  });

  it("CRITICAL: Multiple clicks trigger callback multiple times", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();

    render(<ScratchpadIcon onClick={onClick} />);

    const button = screen.getByRole("button");
    await user.click(button);
    await user.click(button);
    await user.click(button);

    expect(onClick).toHaveBeenCalledTimes(3);
  });

  it("CRITICAL: Icon button has type=button", () => {
    render(<ScratchpadIcon onClick={vi.fn()} />);

    const button = screen.getByRole("button");
    expect(button).toHaveAttribute("type", "button");
  });

  it("CRITICAL: Icon reads store state reactively", () => {
    const store = useScratchpadStore.getState();
    const { rerender } = render(<ScratchpadIcon onClick={vi.fn()} />);

    // Verify initial state
    expect(store.isOpen).toBe(false);
    expect(screen.getByRole("button")).toHaveAttribute("title", "Open scratchpad");

    // Change store state
    store.toggleOpen();

    // Icon should NOT update until rerender is called (React doesn't auto-update)
    // But when rerender happens, it should show new state
    rerender(<ScratchpadIcon onClick={vi.fn()} />);
    expect(screen.getByRole("button")).toHaveAttribute("title", "Close scratchpad");
  });
});
