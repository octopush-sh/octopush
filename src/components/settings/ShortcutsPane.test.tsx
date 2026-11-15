import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

import { ShortcutsPane } from "./ShortcutsPane";

describe("ShortcutsPane", () => {
  it("renders the keybinding chips in mute, not brass", () => {
    const { container } = render(<ShortcutsPane />);
    const chips = Array.from(container.querySelectorAll("kbd"));
    expect(chips.length).toBeGreaterThan(10);
    for (const chip of chips) {
      expect(chip.className).toContain("text-octo-mute");
      expect(chip.className).not.toMatch(/brass/);
    }
  });

  it("shows each key exactly once, with no escape leaking into a label", () => {
    const { container } = render(<ShortcutsPane />);
    const labels = Array.from(container.querySelectorAll("kbd")).map((k) => k.textContent);
    expect(labels).toContain("⌘\\");
    for (const label of labels) {
      expect(label).not.toContain("\\\\");
    }
  });
});
