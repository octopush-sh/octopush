import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";

// ─── Mocks (must be set up BEFORE the component is imported) ──────────────────

const listProvidersMock = vi.fn().mockResolvedValue([]);

const getSettingsMock = vi.fn().mockResolvedValue({ providerKeys: {}, providerBaseUrls: {}, gitCredentials: {} });

vi.mock("../lib/ipc", () => ({
  ipc: {
    listProviders: listProvidersMock,
    getSettings: (...a: unknown[]) => getSettingsMock(...a),
  },
}));

// Dynamic import AFTER mocks are wired.
const { ModelPicker } = await import("./ModelPicker");
const { useProvidersStore } = await import("../stores/providersStore");

beforeEach(() => {
  listProvidersMock.mockResolvedValue([]);
  useProvidersStore.setState({ providers: [], loaded: false });
});

// ─── Shared fixture ───────────────────────────────────────────────────────────

const twoProviders = [
  {
    name: "anthropic",
    enabled: true,
    models: [
      {
        id: "claude-opus-4-6",
        displayName: "Opus 4.6",
        inputCostPerM: 15,
        outputCostPerM: 75,
        maxContext: 200000,
        supportsVision: true,
        supportsTools: true,
      },
    ],
    apiBase: "https://api.anthropic.com",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    protocol: "anthropic",
    local: false,
  },
  {
    name: "openai",
    enabled: true,
    models: [
      {
        id: "gpt-4o",
        displayName: "GPT-4o",
        inputCostPerM: 5,
        outputCostPerM: 15,
        maxContext: 128000,
        supportsVision: true,
        supportsTools: true,
      },
    ],
    apiBase: "https://api.openai.com",
    apiKeyEnv: "OPENAI_API_KEY",
    protocol: "openai",
    local: false,
  },
];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ModelPicker", () => {
  it("chip shows the active model name after providers load", async () => {
    listProvidersMock.mockResolvedValue(twoProviders);
    render(
      <ModelPicker
        activeModel="claude-opus-4-6"
        onSelectModel={vi.fn()}
      />,
    );
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByText("Opus 4.6")).toBeInTheDocument();
  });

  it("opens dropdown on chip click and shows both provider eyebrows + models", async () => {
    listProvidersMock.mockResolvedValue(twoProviders);
    render(
      <ModelPicker
        activeModel="claude-opus-4-6"
        onSelectModel={vi.fn()}
      />,
    );
    await act(async () => { await Promise.resolve(); });

    // Chip is visible; dropdown is not yet open.
    const chip = screen.getByRole("button", { name: /Opus 4\.6/i });
    fireEvent.click(chip);

    // Provider eyebrows.
    expect(screen.getByText("ANTHROPIC")).toBeInTheDocument();
    expect(screen.getByText("OPENAI")).toBeInTheDocument();
    // Model names in the dropdown.
    // (There are now 2 "Opus 4.6" nodes: the chip + the dropdown row.)
    expect(screen.getAllByText("Opus 4.6").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("GPT-4o")).toBeInTheDocument();
  });

  it("calls onSelectModel with the model id when an inactive model row is clicked", async () => {
    listProvidersMock.mockResolvedValue(twoProviders);
    const onSelect = vi.fn();
    render(
      <ModelPicker
        activeModel="claude-opus-4-6"
        onSelectModel={onSelect}
      />,
    );
    await act(async () => { await Promise.resolve(); });

    // Open dropdown.
    fireEvent.click(screen.getByRole("button", { name: /Opus 4\.6/i }));
    // Click the inactive GPT-4o row.
    fireEvent.click(screen.getByText("GPT-4o"));
    expect(onSelect).toHaveBeenCalledWith("gpt-4o");
  });

  it("closes dropdown when clicking outside", async () => {
    listProvidersMock.mockResolvedValue(twoProviders);
    render(
      <div>
        <ModelPicker
          activeModel="claude-opus-4-6"
          onSelectModel={vi.fn()}
        />
        <div data-testid="outside">outside</div>
      </div>,
    );
    await act(async () => { await Promise.resolve(); });

    // Open.
    fireEvent.click(screen.getByRole("button", { name: /Opus 4\.6/i }));
    expect(screen.getByText("ANTHROPIC")).toBeInTheDocument();

    // Click outside.
    fireEvent.pointerDown(screen.getByTestId("outside"));
    expect(screen.queryByText("ANTHROPIC")).not.toBeInTheDocument();
  });

  it("renders tag pills next to a model when the provider exposes tags", async () => {
    listProvidersMock.mockResolvedValue([
      {
        ...twoProviders[0],
        models: [
          {
            ...twoProviders[0].models[0],
            tags: ["largest ctx", "best reasoning"],
          },
        ],
      },
    ]);
    render(
      <ModelPicker activeModel="claude-opus-4-6" onSelectModel={vi.fn()} />,
    );
    await act(async () => { await Promise.resolve(); });

    fireEvent.click(screen.getByRole("button", { name: /Opus 4\.6/i }));
    // The tags appear once in the Recommended section + once in the provider
    // section because the only model has the matching tags.
    expect(screen.getAllByText("largest ctx").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("best reasoning").length).toBeGreaterThanOrEqual(1);
  });

  it("pins recently-used models into a Recents section read from localStorage", async () => {
    localStorage.setItem(
      "octopush.modelPicker.recents",
      JSON.stringify(["gpt-4o"]),
    );
    listProvidersMock.mockResolvedValue(twoProviders);
    render(
      <ModelPicker activeModel="claude-opus-4-6" onSelectModel={vi.fn()} />,
    );
    await act(async () => { await Promise.resolve(); });

    fireEvent.click(screen.getByRole("button", { name: /Opus 4\.6/i }));
    expect(screen.getByText("Recents")).toBeInTheDocument();
    // GPT-4o appears twice now: once in Recents, once under OPENAI.
    expect(screen.getAllByText("GPT-4o").length).toBeGreaterThanOrEqual(2);
    localStorage.clear();
  });

  it("appends a freshly selected model to the front of the Recents list", async () => {
    localStorage.clear();
    listProvidersMock.mockResolvedValue(twoProviders);
    const onSelect = vi.fn();
    render(<ModelPicker activeModel="claude-opus-4-6" onSelectModel={onSelect} />);
    await act(async () => { await Promise.resolve(); });

    fireEvent.click(screen.getByRole("button", { name: /Opus 4\.6/i }));
    fireEvent.click(screen.getByText("GPT-4o"));

    const stored = JSON.parse(
      localStorage.getItem("octopush.modelPicker.recents") ?? "[]",
    );
    expect(stored[0]).toBe("gpt-4o");
    localStorage.clear();
  });

  // The in-component Settings link was removed in favor of the
  // global AppTopBar Settings button — the model row no longer
  // duplicates that access point.

  it("shows Recommended section with intent rows when tags match", async () => {
    listProvidersMock.mockResolvedValue([
      {
        ...twoProviders[0],
        models: [
          {
            ...twoProviders[0].models[0],
            tags: ["best reasoning", "fast", "free"],
          },
        ],
      },
    ]);
    render(<ModelPicker activeModel="claude-opus-4-6" onSelectModel={vi.fn()} />);
    await act(async () => { await Promise.resolve(); });

    fireEvent.click(screen.getByRole("button", { name: /Opus 4\.6/i }));
    expect(screen.getByText("Recommended")).toBeInTheDocument();
    expect(screen.getByText("For depth")).toBeInTheDocument();
    expect(screen.getByText("For speed")).toBeInTheDocument();
    expect(screen.getByText("For cost")).toBeInTheDocument();
  });

  it("filters provider list to local-only when toggle is pressed", async () => {
    const localProvider = {
      ...twoProviders[1],
      name: "ollama",
      local: true,
      models: [
        {
          id: "llama3.3",
          displayName: "Llama 3.3",
          inputCostPerM: 0,
          outputCostPerM: 0,
          maxContext: 128_000,
          supportsVision: false,
          supportsTools: true,
        },
      ],
    };
    listProvidersMock.mockResolvedValue([twoProviders[0], localProvider]);
    render(<ModelPicker activeModel="claude-opus-4-6" onSelectModel={vi.fn()} />);
    await act(async () => { await Promise.resolve(); });

    fireEvent.click(screen.getByRole("button", { name: /Opus 4\.6/i }));
    expect(screen.getByText("ANTHROPIC")).toBeInTheDocument();
    expect(screen.getByText("OLLAMA · local")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Local only"));
    // After filtering, the cloud provider section disappears.
    expect(screen.queryByText("ANTHROPIC")).not.toBeInTheDocument();
    expect(screen.getByText("OLLAMA · local")).toBeInTheDocument();
  });

  it("renders per-provider rate (per-million) in the dropdown — never the dynamic per-turn estimate", async () => {
    listProvidersMock.mockResolvedValue(twoProviders);
    render(
      <ModelPicker activeModel="claude-opus-4-6" onSelectModel={vi.fn()} />,
    );
    await act(async () => { await Promise.resolve(); });

    fireEvent.click(screen.getByRole("button", { name: /Opus 4\.6/i }));
    // No "≈" estimate anywhere — the dropdown is a static reference surface.
    expect(screen.queryByText(/≈/)).not.toBeInTheDocument();
    // The per-million rate shape ($X/$Y · Nk ctx) is what we DO render.
    expect(screen.getAllByText(/\$\d+\/\$\d+ · \d+k ctx/i).length).toBeGreaterThan(0);
  });
});

describe("ModelPicker dropdown escapes clipping containers", () => {
  it("renders the open panel OUTSIDE the overflow-clipped container (portal)", async () => {
    listProvidersMock.mockResolvedValue([
      {
        name: "anthropic",
        enabled: true,
        models: [
          {
            id: "m1", displayName: "Model One",
            inputCostPerM: 1, outputCostPerM: 2,
            cacheReadCostPerM: 0, cacheCreationCostPerM: 0,
            maxContext: 200000, supportsVision: false, supportsTools: true, tags: [],
          },
        ],
      },
    ]);
    render(
      <div data-testid="clip" style={{ overflow: "hidden" }}>
        <ModelPicker activeModel="m1" onSelectModel={() => {}} />
      </div>,
    );
    const chip = await screen.findByRole("button", { name: /Model One/i });
    fireEvent.click(chip);
    const listbox = await screen.findByRole("listbox");
    const clip = screen.getByTestId("clip");
    // The dropdown must NOT be nested inside the overflow-clipped container.
    expect(clip.contains(listbox)).toBe(false);
  });
});

describe("ModelPicker — Auto (economy director)", () => {
  it("is absent unless offered, and never selectable as a plain model", async () => {
    listProvidersMock.mockResolvedValue(twoProviders);
    await act(async () => {
      render(<ModelPicker activeModel="gpt-4o" onSelectModel={() => {}} />);
    });
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.queryByTestId("model-picker-auto")).toBeNull();
  });

  it("offers Auto above the models, names the strong model it runs on, and selects it", async () => {
    listProvidersMock.mockResolvedValue(twoProviders);
    getSettingsMock.mockResolvedValue({ providerKeys: {}, providerBaseUrls: {}, gitCredentials: {}, modelTiers: { strong: "claude-opus-4-6" } });
    const onSelect = vi.fn();
    await act(async () => {
      render(<ModelPicker activeModel="gpt-4o" onSelectModel={onSelect} autoOption />);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { expanded: false }));
    });
    const auto = screen.getByTestId("model-picker-auto");
    expect(auto.textContent).toContain("director on Opus 4.6");
    fireEvent.click(auto);
    expect(onSelect).toHaveBeenCalledWith("auto");
  });

  it("shows the strong model on the chip while Auto is active, and says when the tier is unmapped", async () => {
    listProvidersMock.mockResolvedValue(twoProviders);
    getSettingsMock.mockResolvedValue({ providerKeys: {}, providerBaseUrls: {}, gitCredentials: {}, modelTiers: { strong: "claude-opus-4-6" } });
    await act(async () => {
      render(<ModelPicker activeModel="auto" onSelectModel={() => {}} autoOption />);
    });
    expect(screen.getByRole("button", { expanded: false }).textContent).toContain("Auto · Opus 4.6");
    getSettingsMock.mockResolvedValue({ providerKeys: {}, providerBaseUrls: {}, gitCredentials: {} });
    await act(async () => {
      render(<ModelPicker activeModel="auto" onSelectModel={() => {}} autoOption />);
    });
    const chips = screen.getAllByRole("button", { expanded: false });
    expect(chips[chips.length - 1].textContent).toContain("Auto");
    await act(async () => {
      fireEvent.click(chips[chips.length - 1]);
    });
    expect(screen.getByTestId("model-picker-auto").textContent).toContain("strong tier not mapped");
  });

  it("reflects a model added in Settings without a remount (re-reads on open)", async () => {
    listProvidersMock.mockResolvedValue(twoProviders);
    render(<ModelPicker activeModel="claude-opus-4-6" onSelectModel={vi.fn()} />);
    await act(async () => { await Promise.resolve(); });

    // A save in Settings · Models adds a model to the catalog on disk.
    const [anthropic, openai] = twoProviders;
    listProvidersMock.mockResolvedValue([
      {
        ...anthropic,
        models: [...anthropic.models, { ...anthropic.models[0], id: "claude-opus-5-5", displayName: "Opus 5.5" }],
      },
      openai,
    ]);

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Opus 4\.6/ })); });
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByText("Opus 5.5")).toBeInTheDocument();
  });
});
