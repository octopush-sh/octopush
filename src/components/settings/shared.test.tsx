/**
 * Tests for the settings switch: it has no text of its own, so it must carry
 * the setting's name as both its accessible name and its tooltip — in a
 * ToggleRow and on its own.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Switch, ToggleRow } from "./shared";

describe("Switch", () => {
  it("is named by ariaLabel and uses it as its tooltip", () => {
    render(<Switch checked={false} onChange={vi.fn()} ariaLabel="Limit rounds" />);
    const sw = screen.getByRole("switch", { name: "Limit rounds" });
    expect(sw).toHaveAttribute("aria-label", "Limit rounds");
    expect(sw).toHaveAttribute("title", "Limit rounds");
    expect(sw.className).toContain("h-5 w-9");
  });

  it("prefers a specific title over the label for the tooltip", () => {
    render(<Switch checked onChange={vi.fn()} ariaLabel="Sync" title="Pro only" />);
    const sw = screen.getByRole("switch", { name: "Sync" });
    expect(sw).toHaveAttribute("title", "Pro only");
  });
});

describe("ToggleRow", () => {
  it("names its switch with the row's label and gives it a tooltip", () => {
    render(
      <ToggleRow
        label="Play a sound"
        description="When a run needs you."
        checked
        onChange={vi.fn()}
      />,
    );
    const sw = screen.getByRole("switch", { name: "Play a sound" });
    expect(sw).toHaveAttribute("title", "Play a sound");
  });

  it("passes a disabled row's reason through as the switch tooltip", () => {
    render(
      <ToggleRow
        label="Sync run history"
        checked={false}
        onChange={vi.fn()}
        disabled
        title="Available on Pro"
      />,
    );
    const sw = screen.getByRole("switch", { name: "Sync run history" });
    expect(sw).toHaveAttribute("title", "Available on Pro");
    expect(sw).toBeDisabled();
  });
});
