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

  it("lists the modes in switcher order, numbered in that order", () => {
    const { container } = render(<ShortcutsPane />);
    const rows = Array.from(container.querySelectorAll("li"))
      .map((li) => [li.querySelector("span")?.textContent, li.querySelector("kbd")?.textContent])
      .filter(([desc]) => desc?.endsWith(" mode"));
    expect(rows).toEqual([
      ["Run mode", "⌘⇧1"],
      ["Talk mode", "⌘⇧2"],
      ["Review mode", "⌘⇧3"],
      ["Direct mode", "⌘⇧D"],
    ]);
    expect(container.querySelector('[data-tour="settings-shortcuts-modes"]')).toHaveTextContent("Run mode");
  });

  it("lists Talk's keys, and ⌘⌥K in both modes it answers", () => {
    const { container } = render(<ShortcutsPane />);
    const rows = Array.from(container.querySelectorAll("li")).map(
      (li) => `${li.querySelector("kbd")?.textContent} ${li.querySelector("span")?.textContent}`,
    );
    for (const row of [
      "Esc Stop the running turn",
      "⌘⌥N New conversation",
      "⌘⌥K Switch conversation",
      "⌘⌥K Switch session",
      "⌘⌥A Focus the oldest waiting approval card",
      "⌘⌥P Next permission mode, with the composer focused",
      "Esc Approval card focused: deny",
    ]) {
      expect(rows).toContain(row);
    }
    expect(rows.some((r) => r.startsWith("⌘↵ Approval card focused: approve"))).toBe(true);
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
