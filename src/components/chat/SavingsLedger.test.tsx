import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

// Catalog: a cheap model (used) + a pricey one (the "all-premium" baseline).
vi.mock("../../lib/ipc", () => ({
  ipc: {
    listProviders: vi.fn().mockResolvedValue([
      {
        models: [
          { id: "haiku", displayName: "Haiku", inputCostPerM: 1, outputCostPerM: 5, maxContext: 200000 },
          { id: "opus", displayName: "Opus", inputCostPerM: 15, outputCostPerM: 75, maxContext: 200000 },
        ],
      },
    ]),
  },
}));

const { useChatStore } = await import("../../stores/chatStore");
const { SavingsLedger } = await import("./SavingsLedger");

describe("SavingsLedger", () => {
  beforeEach(() => {
    useChatStore.setState({ messagesByWs: {} });
  });

  it("renders nothing when the conversation has no billed turns", () => {
    const { container } = render(<SavingsLedger workspaceId="ws-1" />);
    expect(container.firstChild).toBeNull();
  });

  it("shows spend and savings vs the priciest model", async () => {
    useChatStore.setState({
      messagesByWs: {
        "ws-1": [
          {
            id: 1, workspaceId: "ws-1", role: "assistant", content: "ok",
            model: "haiku", inputTokens: 1_000_000, outputTokens: 0, costUsd: 1,
            createdAt: "2026-05-17T10:00:00Z",
          },
        ],
      },
    });
    render(<SavingsLedger workspaceId="ws-1" />);
    // Let the listProviders promise resolve so the catalog loads.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // spent = $1.000 (actual costUsd). Baseline on Opus for 1M input = $15.000,
    // so saved = $14.000.
    expect(screen.getByText("$1.000")).toBeInTheDocument();
    expect(screen.getByText(/\$14\.000/)).toBeInTheDocument();
    expect(screen.getByText(/saved vs Opus/i)).toBeInTheDocument();
  });
});
