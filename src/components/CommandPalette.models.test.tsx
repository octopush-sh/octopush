/**
 * The Command Palette "Models" group: rows carry the bare model name (the
 * MODELS heading already says what they are), and the provider meta is the
 * part that gives way first when a row is too narrow, with its full text in a
 * title.
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import { render, screen, act } from "@testing-library/react";
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

vi.mock("../lib/ipc", () => ({
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
});
