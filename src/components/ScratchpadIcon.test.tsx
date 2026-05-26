import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ScratchpadIcon } from "./ScratchpadIcon";
import { useScratchpadStore } from "../stores/scratchpadStore";

describe("ScratchpadIcon - Click Handler Test", () => {
  beforeEach(() => {
    const store = useScratchpadStore.getState();
    store.reset?.();
  });

  it("CRITICAL: onClick callback is called when button is clicked", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();

    render(<ScratchpadIcon onClick={onClick} />);

    const button = screen.getByRole("button");
    await user.click(button);

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("CRITICAL: Clicking icon actually toggles store state", async () => {
    const user = userEvent.setup();
    const store = useScratchpadStore.getState();

    // Initial state
    expect(store.isOpen).toBe(false);

    // Pass toggleOpen directly as onClick
    render(<ScratchpadIcon onClick={store.toggleOpen} />);

    const button = screen.getByRole("button");
    await user.click(button);

    // After click, get fresh state
    const updatedStore = useScratchpadStore.getState();
    expect(updatedStore.isOpen).toBe(true);
  });

  it("CRITICAL: Icon renders with button role", () => {
    render(<ScratchpadIcon onClick={vi.fn()} />);

    const button = screen.getByRole("button");
    expect(button).toBeInTheDocument();
  });

  it("CRITICAL: Icon renders the ≡ glyph", () => {
    render(<ScratchpadIcon onClick={vi.fn()} />);

    expect(screen.getByText("≡")).toBeInTheDocument();
  });
});
