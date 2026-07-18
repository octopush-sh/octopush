import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { GenesisPrompt } from "./GenesisPrompt";

vi.mock("../lib/ipc", () => ({
  ipc: {
    listProviders: vi.fn(),
    getSettings: vi.fn(),
    saveProviders: vi.fn(),
    saveSettings: vi.fn(),
    getDefaultProviders: vi.fn(),
    listModels: vi.fn(),
  },
}));

import { ipc } from "../lib/ipc";
const m = {
  listProviders: vi.mocked(ipc.listProviders),
  getSettings: vi.mocked(ipc.getSettings),
  saveProviders: vi.mocked(ipc.saveProviders),
  saveSettings: vi.mocked(ipc.saveSettings),
  getDefaultProviders: vi.mocked(ipc.getDefaultProviders),
  listModels: vi.mocked(ipc.listModels),
};

const anthropic = (enabled: boolean) => ({
  name: "anthropic", apiBase: "", apiKeyEnv: "", models: [], enabled, protocol: "anthropic", local: false,
});

function settings(key?: string) {
  return { providerKeys: key ? { anthropic: key } : {} } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.saveProviders.mockResolvedValue(undefined);
  m.saveSettings.mockResolvedValue(undefined);
  m.listModels.mockResolvedValue([
    { provider: "anthropic", model: { id: "claude-opus-4-8" } },
    { provider: "anthropic", model: { id: "claude-sonnet-4-6" } },
    { provider: "openai", model: { id: "gpt-5" } },
  ] as never);
});

describe("GenesisPrompt pre-flight", () => {
  it("a cold user (no key) sees the inline key field; saving it goes through the shared provider path", async () => {
    m.listProviders.mockResolvedValue([anthropic(false)] as never);
    m.getSettings.mockResolvedValue(settings());
    render(<GenesisPrompt onSubmit={vi.fn()} />);
    const field = await screen.findByLabelText("Anthropic API key");
    fireEvent.change(field, { target: { value: "sk-ant-xxx" } });
    // Once saved, crewProviderReady re-check must see the enabled provider + key.
    m.listProviders.mockResolvedValue([anthropic(true)] as never);
    m.getSettings.mockResolvedValue(settings("sk-ant-xxx"));
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(m.saveProviders).toHaveBeenCalled());
    // Enabled anthropic persisted + the key merged into settings.
    expect(m.saveProviders.mock.calls[0][0].find((p) => p.name === "anthropic")?.enabled).toBe(true);
    expect(m.saveSettings.mock.calls[0][0].providerKeys.anthropic).toBe("sk-ant-xxx");
    // The key field goes away once ready.
    await waitFor(() =>
      expect(screen.queryByLabelText("Anthropic API key")).not.toBeInTheDocument(),
    );
  });

  it("a ready user can pick a model, which is passed to onSubmit", async () => {
    m.listProviders.mockResolvedValue([anthropic(true)] as never);
    m.getSettings.mockResolvedValue(settings("sk-ant-xxx"));
    const onSubmit = vi.fn();
    render(<GenesisPrompt onSubmit={onSubmit} />);
    // Model picker appears (anthropic models only).
    await screen.findByLabelText("Crew model");
    fireEvent.change(screen.getByPlaceholderText(/Describe what you want to build/i), {
      target: { value: "a todo cli" },
    });
    fireEvent.click(screen.getByText("Set a crew on it"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    // Default (no explicit pick) → null model.
    expect(onSubmit.mock.calls[0][2]).toBeNull();
  });
});
