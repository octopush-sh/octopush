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
});
