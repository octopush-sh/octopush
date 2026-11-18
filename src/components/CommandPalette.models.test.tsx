/**
 * The Command Palette "Models" group: rows carry the bare model name (the
 * MODELS heading already says what they are), and the provider meta is the
 * part that gives way first when a row is too narrow, with its full text in a
 * title.
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import type { ModelWithProvider } from "../lib/types";

const { model } = vi.hoisted(() => ({
  model: (id: string, displayName: string, provider: string): ModelWithProvider => ({
    provider,
    model: {
      id, displayName, inputCostPerM: 15, outputCostPerM: 75, cacheReadCostPerM: 0,
      cacheCreationCostPerM: 0, maxContext: 200000, supportsVision: true, supportsTools: true,
    },
  }),
}));

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  ipc: {
    listModels: vi.fn().mockResolvedValue([
      model("opus-46", "Claude Opus 4.6", "anthropic"),
      model("opus-47", "Claude Opus 4.7", "openrouter-with-a-long-provider-name"),
    ]),
    listTemplates: vi.fn().mockResolvedValue([]),
  },
}));

import { CommandPalette } from "./CommandPalette";

// cmdk observes item sizes; JSDOM has no ResizeObserver.
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(globalThis, "ResizeObserver", {
  writable: true,
  configurable: true,
  value: ResizeObserverMock,
});

// cmdk scrolls the selected item into view; JSDOM has no scrollIntoView.
const originalScrollIntoView = Element.prototype.scrollIntoView;
Element.prototype.scrollIntoView = vi.fn();
afterAll(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

async function renderPalette() {
  await act(async () => {
    render(<CommandPalette open onClose={vi.fn()} onNewSession={vi.fn()} onToggleTokens={vi.fn()} />);
  });
}

describe("CommandPalette · Models group", () => {
  it("labels rows with the bare model name, no redundant prefix", async () => {
    await renderPalette();
    expect(screen.getByText("Claude Opus 4.6")).toBeInTheDocument();
    expect(screen.getByText("Claude Opus 4.7")).toBeInTheDocument();
    expect(screen.queryByText(/^Model:/)).toBeNull();
  });

  it("lets the provider meta shrink before the model name, keeping both in titles", async () => {
    await renderPalette();
    const name = screen.getByText("Claude Opus 4.7");
    expect(name.className).toContain("flex-auto");
    expect(name.className).not.toContain("flex-1");
    expect(name).toHaveAttribute("title", "Claude Opus 4.7");

    const detail = screen.getByText("openrouter-with-a-long-provider-name · $15/M in");
    expect(detail.className).toContain("shrink-[100]");
    expect(detail.className).toContain("truncate");
    expect(detail.className).not.toContain("shrink-0");
    expect(detail).toHaveAttribute("title", "openrouter-with-a-long-provider-name · $15/M in");
  });

  it("anchors the group for the tour", async () => {
    await renderPalette();
    const group = document.querySelector('[data-tour="palette-models"]');
    expect(group).not.toBeNull();
    expect(group).toHaveTextContent("Claude Opus 4.6");
  });

  it("previews three models with no query, then shows all on demand or while searching (#850)", async () => {
    const { ipc } = await import("../lib/ipc");
    const many = ["Llama 3", "Qwen 2.5", "GPT-4o mini", "DeepSeek V3", "Mistral Large"].map((n, i) =>
      model(`m${i}`, n, "openrouter"),
    );
    vi.mocked(ipc.listModels).mockResolvedValueOnce(many);
    await renderPalette();
    expect(screen.getByText("Llama 3")).toBeInTheDocument();
    expect(screen.getByText("GPT-4o mini")).toBeInTheDocument();
    expect(screen.queryByText("DeepSeek V3")).toBeNull();
    expect(screen.getByText("Show all models")).toBeInTheDocument();
    expect(screen.getByText("2 more")).toBeInTheDocument();
    expect(document.querySelector('[data-tour="palette-models-more"]')).not.toBeNull();

    // Typing searches every model, the hidden ones included.
    const input = screen.getByPlaceholderText("Type a command, or search…");
    await act(async () => {
      fireEvent.change(input, { target: { value: "deepseek" } });
    });
    expect(screen.getByText("DeepSeek V3")).toBeInTheDocument();
    expect(screen.queryByText("Show all models")).toBeNull();

    await act(async () => {
      fireEvent.change(input, { target: { value: "" } });
    });
    expect(screen.queryByText("DeepSeek V3")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByText("Show all models"));
    });
    expect(screen.getByText("DeepSeek V3")).toBeInTheDocument();
    expect(screen.getByText("Mistral Large")).toBeInTheDocument();
    expect(screen.queryByText("Show all models")).toBeNull();
  });
});
