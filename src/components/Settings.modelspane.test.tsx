/**
 * Behavioral tests for the Settings → Models pane (master-detail redesign).
 * The first provider is auto-selected; add/edit/remove of models and providers
 * happen through dialogs. The backend contract is unchanged — saving still calls
 * ipc.saveProviders + ipc.saveSettings with the edited catalog.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import type { ProviderConfig, AppSettings } from "../lib/types";

// ─── Fixtures ─────────────────────────────────────────────────────

const MOCK_PROVIDER: ProviderConfig = {
  name: "anthropic",
  apiBase: "https://api.anthropic.com",
  apiKeyEnv: "ANTHROPIC_API_KEY",
  models: [
    {
      id: "claude-sonnet-4-6",
      displayName: "Claude Sonnet 4.6",
      inputCostPerM: 3.0,
      outputCostPerM: 15.0,
      cacheReadCostPerM: 0.3,
      cacheCreationCostPerM: 3.75,
      maxContext: 200000,
      supportsVision: true,
      supportsTools: true,
      tags: ["balanced"],
    },
  ],
  enabled: true,
  protocol: "anthropic",
  local: false,
};

const MOCK_SETTINGS: AppSettings = {
  providerKeys: { anthropic: "sk-ant-test" },
  providerBaseUrls: {},
  gitCredentials: {},
};

const saveProvidersMock = vi.fn().mockResolvedValue(undefined);
const saveSettingsMock = vi.fn().mockResolvedValue(undefined);
const listProvidersMock = vi.fn().mockResolvedValue([MOCK_PROVIDER]);
const getSettingsMock = vi.fn().mockResolvedValue(MOCK_SETTINGS);
const getDefaultProvidersMock = vi.fn().mockResolvedValue([MOCK_PROVIDER]);
const listModelsMock = vi.fn().mockResolvedValue([]);

vi.mock("../lib/ipc", () => ({
  ipc: {
    listProviders: listProvidersMock,
    getSettings: getSettingsMock,
    saveSettings: saveSettingsMock,
    saveProviders: saveProvidersMock,
    getDefaultProviders: getDefaultProvidersMock,
    listModels: listModelsMock,
    refreshPricing: vi.fn().mockResolvedValue({ modelsUpdated: 0, modelsTotal: 0, fetchedAt: "" }),
  },
}));

// ─── Helpers ──────────────────────────────────────────────────────

async function renderModelsPane() {
  const { Settings } = await import("./Settings");
  let rendered: ReturnType<typeof render>;
  await act(async () => {
    rendered = render(<Settings open initialTab="models" onClose={vi.fn()} />);
  });
  return rendered!;
}

/** The add/edit-model dialog. */
function modelDialog() {
  return screen.getByRole("dialog", { name: /model/i });
}

// ─── Tests ────────────────────────────────────────────────────────

describe("ModelsPane — selection & detail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listProvidersMock.mockResolvedValue([MOCK_PROVIDER]);
    getSettingsMock.mockResolvedValue(MOCK_SETTINGS);
    saveProvidersMock.mockResolvedValue(undefined);
    saveSettingsMock.mockResolvedValue(undefined);
    getDefaultProvidersMock.mockResolvedValue([MOCK_PROVIDER]);
  });

  it("auto-selects the first provider and shows its model in the detail pane", async () => {
    await renderModelsPane();
    // Provider name appears both in the list item and the detail header.
    expect(screen.getAllByText("Anthropic").length).toBeGreaterThan(0);
    expect(screen.getByText("claude-sonnet-4-6")).toBeInTheDocument();
  });
});

describe("ModelsPane — model editing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listProvidersMock.mockResolvedValue([MOCK_PROVIDER]);
    getSettingsMock.mockResolvedValue(MOCK_SETTINGS);
    saveProvidersMock.mockResolvedValue(undefined);
    saveSettingsMock.mockResolvedValue(undefined);
    getDefaultProvidersMock.mockResolvedValue([MOCK_PROVIDER]);
  });

  it("adds a model through the dialog and saves both settings and providers", async () => {
    await renderModelsPane();

    // Open the add-model dialog.
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /add a model/i })); });

    const dialog = modelDialog();
    const idInput = within(dialog).getByPlaceholderText(/model id/i);
    await act(async () => { fireEvent.change(idInput, { target: { value: "claude-x" } }); });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: /^add model$/i })); });

    // The new model now appears in the detail list.
    expect(screen.getByText("claude-x")).toBeInTheDocument();

    // The unsaved-changes bar reveals a Save action.
    const saveBtn = screen.getByRole("button", { name: /save changes/i });
    await act(async () => { fireEvent.click(saveBtn); });

    await waitFor(() => {
      expect(saveProvidersMock).toHaveBeenCalledTimes(1);
      expect(saveSettingsMock).toHaveBeenCalledTimes(1);
    });

    const providersArg: ProviderConfig[] = saveProvidersMock.mock.calls[0][0];
    const anthropic = providersArg.find((p) => p.name === "anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic!.models.some((m) => m.id === "claude-x")).toBe(true);
  });

  it("blocks a model with an empty id", async () => {
    await renderModelsPane();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /add a model/i })); });

    const dialog = modelDialog();
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: /^add model$/i })); });

    expect(within(dialog).getByText(/model id is required/i)).toBeInTheDocument();
  });

  it("does not show an unsaved bar until something changes", async () => {
    await renderModelsPane();
    expect(screen.queryByRole("button", { name: /save changes/i })).not.toBeInTheDocument();
  });

  it("rejects a model whose id duplicates an existing one", async () => {
    await renderModelsPane();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /add a model/i })); });
    const dialog = modelDialog();
    await act(async () => {
      fireEvent.change(within(dialog).getByPlaceholderText(/model id/i), {
        target: { value: "claude-sonnet-4-6" },
      });
    });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: /^add model$/i })); });

    expect(within(dialog).getByText(/already exists/i)).toBeInTheDocument();
  });
});

describe("ModelsPane — provider display names", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSettingsMock.mockResolvedValue(MOCK_SETTINGS);
  });

  it("renders canonical capitalization for built-in providers (OpenAI, not Openai)", async () => {
    const openai: ProviderConfig = {
      name: "openai",
      apiBase: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      models: [],
      enabled: true,
      protocol: "openai-compatible",
      local: false,
    };
    listProvidersMock.mockResolvedValue([openai]);
    await renderModelsPane();
    expect(screen.getAllByText("OpenAI").length).toBeGreaterThan(0);
    expect(screen.queryByText("Openai")).not.toBeInTheDocument();
  });
});

describe("ModelsPane — custom provider management", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listProvidersMock.mockResolvedValue([MOCK_PROVIDER]);
    getSettingsMock.mockResolvedValue(MOCK_SETTINGS);
    saveProvidersMock.mockResolvedValue(undefined);
    saveSettingsMock.mockResolvedValue(undefined);
    getDefaultProvidersMock.mockResolvedValue([MOCK_PROVIDER]);
  });

  it("adds a custom local provider through the wizard and selects it", async () => {
    await renderModelsPane();

    // Open the add-provider wizard.
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /add a provider/i })); });

    const dialog = screen.getByRole("dialog", { name: /add a provider/i });
    await act(async () => {
      fireEvent.change(within(dialog).getByPlaceholderText(/my-gateway/i), { target: { value: "sonatype" } });
    });
    // Mark it local so the wizard finishes in one step (no endpoint needed).
    await act(async () => { fireEvent.click(within(dialog).getByRole("switch", { name: /runs locally/i })); });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: /add a provider/i })); });

    // New provider is selected — its name shows in the list and detail header.
    expect(screen.getAllByText("Sonatype").length).toBeGreaterThan(0);
  });

  it("shows an error when adding a provider with empty name", async () => {
    await renderModelsPane();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /add a provider/i })); });
    const dialog = screen.getByRole("dialog", { name: /add a provider/i });
    // Click Continue with no name.
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: /continue/i })); });

    expect(within(dialog).getByText(/name is required/i)).toBeInTheDocument();
  });

  it("removes a custom provider via confirm dialog", async () => {
    const customProvider: ProviderConfig = {
      name: "my-gateway",
      apiBase: "https://gw.example.com",
      apiKeyEnv: "",
      models: [],
      enabled: true,
      protocol: "anthropic",
      local: false,
    };
    listProvidersMock.mockResolvedValue([customProvider]);
    await renderModelsPane();

    // Auto-selected; "Remove" lives in the detail header.
    const removeBtn = screen.getByRole("button", { name: /^remove$/i });
    await act(async () => { fireEvent.click(removeBtn); });

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    const confirmBtn = screen.getByRole("button", { name: /remove provider/i });
    await act(async () => { fireEvent.click(confirmBtn); });

    expect(screen.queryByText("My-gateway")).not.toBeInTheDocument();
  });

  it("reset to defaults restores a builtin provider's models", async () => {
    const modifiedAnthropic: ProviderConfig = { ...MOCK_PROVIDER, models: [] };
    listProvidersMock.mockResolvedValue([modifiedAnthropic]);
    getDefaultProvidersMock.mockResolvedValue([MOCK_PROVIDER]);

    await renderModelsPane();
    expect(screen.queryByText("claude-sonnet-4-6")).not.toBeInTheDocument();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /reset to defaults/i })); });

    await waitFor(() => {
      expect(screen.getByText("claude-sonnet-4-6")).toBeInTheDocument();
    });
  });
});
