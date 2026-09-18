/**
 * Settings → Models → Model tiers: loads the persisted map, a pick persists
 * read-modify-write (never clobbering other settings), clearing removes the
 * key, and unmapped tiers show the picker's empty state.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor, within } from "@testing-library/react";

const getSettings = vi.fn();
const saveSettings = vi.fn();
vi.mock("../../lib/ipc", () => ({
  ipc: {
    getSettings: (...a: unknown[]) => getSettings(...a),
    saveSettings: (...a: unknown[]) => saveSettings(...a),
    listProviders: vi.fn().mockResolvedValue([
      {
        name: "openai",
        apiBase: "https://api.openai.com",
        apiKeyEnv: "OPENAI_API_KEY",
        enabled: true,
        protocol: "openai-compatible",
        local: false,
        models: [
          { id: "gpt-4o-mini", displayName: "GPT-4o mini", inputCostPerM: 0.15, outputCostPerM: 0.6, cacheReadCostPerM: 0, cacheCreationCostPerM: 0, maxContext: 128000, supportsVision: true, supportsTools: true, tags: [] },
          { id: "gpt-4o", displayName: "GPT-4o", inputCostPerM: 2.5, outputCostPerM: 10, cacheReadCostPerM: 0, cacheCreationCostPerM: 0, maxContext: 128000, supportsVision: true, supportsTools: true, tags: [] },
        ],
      },
    ]),
  },
}));

import { ModelTiersSection } from "./ModelTiersSection";

const BASE = { providerKeys: { openai: "k" }, providerBaseUrls: {}, gitCredentials: {}, editorCommand: "cursor" };

beforeEach(() => {
  getSettings.mockReset().mockResolvedValue({ ...BASE });
  saveSettings.mockReset().mockResolvedValue(undefined);
});

describe("ModelTiersSection", () => {
  it("renders the three tiers, empty when nothing is mapped", async () => {
    await act(async () => {
      render(<ModelTiersSection />);
    });
    for (const t of ["fast", "balanced", "strong"]) {
      expect(screen.getByTestId(`tier-${t}`)).toBeInTheDocument();
    }
    expect(within(screen.getByTestId("tier-fast")).getByText("Select model")).toBeInTheDocument();
    expect(screen.queryByLabelText("Clear fast tier")).toBeNull();
  });

  it("shows the persisted mapping and clears a tier without touching other settings", async () => {
    getSettings.mockResolvedValue({ ...BASE, modelTiers: { fast: "gpt-4o-mini", strong: "gpt-4o" } });
    await act(async () => {
      render(<ModelTiersSection />);
    });
    await waitFor(() => expect(within(screen.getByTestId("tier-fast")).getByText("GPT-4o mini")).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Clear fast tier"));
    });
    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1));
    expect(saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({ editorCommand: "cursor", providerKeys: { openai: "k" }, modelTiers: { strong: "gpt-4o" } }),
    );
  });

  it("picking a model persists it under the tier", async () => {
    await act(async () => {
      render(<ModelTiersSection />);
    });
    const balanced = screen.getByTestId("tier-balanced");
    await act(async () => {
      fireEvent.click(within(balanced).getByRole("button", { name: /select model/i }));
    });
    const option = await screen.findByText("GPT-4o");
    await act(async () => {
      fireEvent.click(option);
    });
    await waitFor(() => expect(saveSettings).toHaveBeenCalledTimes(1));
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ modelTiers: { balanced: "gpt-4o" } }));
  });
});
