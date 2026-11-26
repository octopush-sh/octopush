/**
 * Tests for the Settings shell: the grouped navigation renders its category
 * headers, and clicking an item switches the active pane.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { SETTINGS_GROUPS } from "../lib/settingsTabs";

vi.mock("../lib/ipc", () => ({
  ipc: {
    getSettings: vi.fn().mockResolvedValue({ providerKeys: {}, providerBaseUrls: {}, gitCredentials: {} }),
    saveSettings: vi.fn().mockResolvedValue(undefined),
    detectEditors: vi.fn().mockResolvedValue([]),
    listProviders: vi.fn().mockResolvedValue([]),
    saveProviders: vi.fn().mockResolvedValue(undefined),
    getDefaultProviders: vi.fn().mockResolvedValue([]),
    listModels: vi.fn().mockResolvedValue([]),
    refreshPricing: vi.fn().mockResolvedValue({ modelsUpdated: 0, modelsTotal: 0, fetchedAt: "" }),
  },
}));

import { Settings } from "./Settings";

async function renderSettings() {
  await act(async () => {
    render(<Settings open initialTab="general" onClose={vi.fn()} />);
  });
}

beforeEach(() => vi.clearAllMocks());

describe("Settings — grouped navigation", () => {
  it("renders every group header", async () => {
    await renderSettings();
    for (const group of SETTINGS_GROUPS) {
      expect(screen.getByText(group.label)).toBeInTheDocument();
    }
  });

  it("defaults to the General pane", async () => {
    await renderSettings();
    expect(screen.getByText("The basics.")).toBeInTheDocument();
  });

  it("clicking a nav item switches the active pane", async () => {
    await renderSettings();
    // Switch to Editor — the General → Editor split lives under Setup.
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Editor" })); });
    expect(screen.getByText("How code reads.")).toBeInTheDocument();
    expect(screen.queryByText("The basics.")).not.toBeInTheDocument();
  });

  it("the active row keeps the same font, size and height as the rest", async () => {
    await renderSettings();
    const rowShape = (name: string) => {
      const button = screen.getByRole("button", { name });
      const label = button.querySelector("span")!;
      return {
        button: button.className,
        font: label.className.split(" ").filter((c) => !c.startsWith("text-octo-") && !c.startsWith("hover:")),
      };
    };
    const atRest = rowShape("Editor");
    const active = rowShape("General");
    expect(screen.getByRole("button", { name: "General" })).toHaveAttribute("aria-current", "page");
    expect(active).toEqual(atRest);
    expect(active.font).toContain("font-sans");
    expect(active.font).not.toContain("font-serif");
    expect(active.button).toContain("h-8");

    // Switching tabs changes only colour: the old row and the new one keep their shape.
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Editor" })); });
    expect(rowShape("Editor")).toEqual(atRest);
    expect(rowShape("General")).toEqual(atRest);
  });

  it("reserves the border slot on rows at rest", async () => {
    await renderSettings();
    const rest = screen.getByRole("button", { name: "Editor" });
    const active = screen.getByRole("button", { name: "General" });
    expect(rest.className).toContain("border");
    expect(rest.style.borderColor).toBe("transparent");
    expect(active.style.borderColor).toBe("var(--brass-dim)");
    expect(active.style.background).toBe("var(--brass-ghost)");
  });
});
