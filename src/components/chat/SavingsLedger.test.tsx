import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

// Catalog: a cheap model (used) + a pricey one (the "all-premium" baseline).
const getSettings = vi.fn();
vi.mock("../../lib/ipc", () => ({
  ipc: {
    listProviders: vi.fn().mockResolvedValue([
      {
        models: [
          { id: "haiku", displayName: "Haiku", inputCostPerM: 1, outputCostPerM: 5, maxContext: 200000 },
          { id: "sonnet", displayName: "Sonnet", inputCostPerM: 3, outputCostPerM: 15, maxContext: 200000 },
          { id: "opus", displayName: "Opus", inputCostPerM: 15, outputCostPerM: 75, maxContext: 200000 },
        ],
      },
    ]),
    getSettings: (...a: unknown[]) => getSettings(...a),
  },
}));

const { useChatStore } = await import("../../stores/chatStore");
const { SavingsLedger } = await import("./SavingsLedger");

describe("SavingsLedger", () => {
  beforeEach(() => {
    useChatStore.setState({ messagesByWs: {} });
    getSettings.mockReset().mockResolvedValue({ providerKeys: {}, providerBaseUrls: {}, gitCredentials: {} });
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

  it("counts sub-agents and measures against all-strong when the strong tier is mapped", async () => {
    getSettings.mockResolvedValue({ providerKeys: {}, providerBaseUrls: {}, gitCredentials: {}, modelTiers: { strong: "sonnet", fast: "haiku" } });
    useChatStore.setState({
      messagesByWs: {
        "ws-1": [
          {
            id: 1, workspaceId: "ws-1", role: "assistant", content: "ok",
            model: "sonnet", inputTokens: 1_000_000, outputTokens: 0, costUsd: 3,
            createdAt: "2026-05-17T10:00:00Z",
          },
          {
            id: 2, workspaceId: "ws-1", role: "tool",
            content: JSON.stringify({
              toolName: "Agent", toolInput: { description: "map code" }, result: "report", callId: "c1",
              agent: { ok: true, finished: true, closedAtCap: false, blocked: false, model: "haiku", tier: "fast", inputTokens: 1_000_000, outputTokens: 0, costUsd: 1, durationMs: 1, toolCalls: 1 },
            }),
            model: null, inputTokens: null, outputTokens: null, costUsd: null,
            createdAt: "2026-05-17T10:00:01Z",
          },
        ],
      },
    });
    render(<SavingsLedger workspaceId="ws-1" />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // spent = $3 (director) + $1 (sub-agent) = $4.000. All-strong on Sonnet:
    // 2M input × $3/M = $6.000 → saved $2.000 (33%), measured against the
    // strong tier, not the priciest model in the catalog (Opus).
    expect(screen.getByText("$4.000")).toBeInTheDocument();
    expect(screen.getByText(/\$2\.000/)).toBeInTheDocument();
    expect(screen.getByText(/saved vs all-strong · Sonnet/)).toBeInTheDocument();
    expect(screen.getByText("of which sub-agents")).toBeInTheDocument();
    expect(screen.getByText("$1.000")).toBeInTheDocument();
  });
});
