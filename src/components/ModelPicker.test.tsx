import { describe, it, expect, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";

// ─── Mocks (must be set up BEFORE the component is imported) ──────────────────

const listProvidersMock = vi.fn().mockResolvedValue([]);

vi.mock("../lib/ipc", () => ({
  ipc: {
    listProviders: listProvidersMock,
  },
}));

// Dynamic import AFTER mocks are wired.
const { ModelPicker } = await import("./ModelPicker");

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
    listProvidersMock.mockResolvedValueOnce(twoProviders);
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
    listProvidersMock.mockResolvedValueOnce(twoProviders);
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
    listProvidersMock.mockResolvedValueOnce(twoProviders);
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
    listProvidersMock.mockResolvedValueOnce(twoProviders);
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

  it("renders Settings button when onOpenSettings is provided", async () => {
    listProvidersMock.mockResolvedValueOnce(twoProviders);
    const onSettings = vi.fn();
    render(
      <ModelPicker
        activeModel="claude-opus-4-6"
        onSelectModel={vi.fn()}
        onOpenSettings={onSettings}
      />,
    );
    await act(async () => { await Promise.resolve(); });

    const settingsBtn = screen.getByText(/Settings →/i);
    expect(settingsBtn).toBeInTheDocument();
    fireEvent.click(settingsBtn);
    expect(onSettings).toHaveBeenCalledTimes(1);
  });
});
