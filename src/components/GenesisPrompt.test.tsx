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
    fireEvent.click(screen.getByText("Wake the crew"));
    await waitFor(() => expect(m.saveProviders).toHaveBeenCalled());
    // Enabled anthropic persisted + the key merged into settings.
    expect(m.saveProviders.mock.calls[0][0].find((p) => p.name === "anthropic")?.enabled).toBe(true);
    expect(m.saveSettings.mock.calls[0][0].providerKeys.anthropic).toBe("sk-ant-xxx");
    // The key field goes away once ready.
    await waitFor(() =>
      expect(screen.queryByLabelText("Anthropic API key")).not.toBeInTheDocument(),
    );
  });

  it("a cold user who typed a key but pressed the CTA gets it saved BEFORE genesis proceeds", async () => {
    m.listProviders.mockResolvedValue([anthropic(false)] as never);
    m.getSettings.mockResolvedValue(settings());
    const onSubmit = vi.fn();
    render(<GenesisPrompt onSubmit={onSubmit} />);
    await screen.findByLabelText("Anthropic API key");
    fireEvent.change(screen.getByPlaceholderText(/Describe what you want to build/i), {
      target: { value: "a todo cli" },
    });
    fireEvent.change(screen.getByLabelText("Anthropic API key"), { target: { value: "sk-ant-yyy" } });
    // After the save the re-check should be ready.
    m.listProviders.mockResolvedValue([anthropic(true)] as never);
    m.getSettings.mockResolvedValue(settings("sk-ant-yyy"));
    // Press the CTA WITHOUT clicking "Wake the crew" — the key must persist first.
    fireEvent.click(screen.getByText("Set a crew on it"));
    await waitFor(() => expect(m.saveProviders).toHaveBeenCalled());
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    // Order: key saved, THEN genesis proceeds (no Settings detour).
    expect(m.saveSettings.mock.calls[0][0].providerKeys.anthropic).toBe("sk-ant-yyy");
  });

  it("a cold user with NO key still proceeds (the honest Settings fallback path)", async () => {
    m.listProviders.mockResolvedValue([anthropic(false)] as never);
    m.getSettings.mockResolvedValue(settings());
    const onSubmit = vi.fn();
    render(<GenesisPrompt onSubmit={onSubmit} />);
    await screen.findByLabelText("Anthropic API key");
    fireEvent.change(screen.getByPlaceholderText(/Describe what you want to build/i), {
      target: { value: "a todo cli" },
    });
    fireEvent.click(screen.getByText("Set a crew on it"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(m.saveProviders).not.toHaveBeenCalled(); // nothing to save
  });

  it("the key CTA speaks in the serif voice and takes its brass-ghost fill only once a key is typed", async () => {
    m.listProviders.mockResolvedValue([anthropic(false)] as never);
    m.getSettings.mockResolvedValue(settings());
    render(<GenesisPrompt onSubmit={vi.fn()} />);
    await screen.findByLabelText("Anthropic API key");
    const cta = screen.getByRole("button", { name: "Wake the crew" });
    expect(cta).toHaveClass("font-serif");
    expect(cta.className).not.toMatch(/uppercase|font-mono/);
    expect(cta).toBeDisabled();
    expect(cta.style.background).not.toContain("--brass-ghost");
    fireEvent.change(screen.getByLabelText("Anthropic API key"), { target: { value: "sk-ant-zzz" } });
    expect(cta).toBeEnabled();
    expect(cta.style.background).toContain("--brass-ghost");
  });

  it("'or think it through first' reads as a link, like its siblings", async () => {
    m.listProviders.mockResolvedValue([anthropic(true)] as never);
    m.getSettings.mockResolvedValue(settings("sk-ant-xxx"));
    render(<GenesisPrompt onSubmit={vi.fn()} onSketch={vi.fn()} />);
    const link = screen.getByRole("button", { name: /think it through first/i });
    expect(link).toHaveClass("underline", "text-octo-ivory");
    expect(link).not.toHaveClass("text-octo-mute");
    await screen.findByLabelText("Crew model");
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
