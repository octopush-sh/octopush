/**
 * Companion → Conversation: the context meter, the ledger-backed cost lines
 * (spent / sub-agents / saved vs all-strong) read from `get_thread_cost`,
 * and the pure `costLines` projection behind them.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
const getThreadCost = vi.fn();
const logbookSummary = vi.fn();
vi.mock("../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/ipc")>();
  return {
    ...actual,
    ipc: {
      ...actual.ipc,
      getThreadCost: (...a: unknown[]) => getThreadCost(...a),
      logbookSummary: (...a: unknown[]) => logbookSummary(...a),
    },
  };
});

import { useChatStore } from "../stores/chatStore";
import { CompanionContext, costLines, usd } from "./CompanionContext";
import type { Budget, SpendSnapshot, ThreadCost } from "../lib/types";

const cost = (over: Partial<ThreadCost> = {}): ThreadCost => ({
  spentUsd: 1.25,
  subagentsUsd: 0.4,
  baselineUsd: 3.0,
  strongPriced: true,
  calls: 12,
  cacheHitPct: 91.4,
  ...over,
});

beforeEach(() => {
  getThreadCost.mockReset().mockResolvedValue(cost());
  logbookSummary.mockReset().mockResolvedValue([]);
  useChatStore.setState({ activeThreadByWs: { ws: "t-1" }, messagesByWs: {}, streamingByWs: {}, continuingCalls: {} });
});

describe("costLines", () => {
  it("is empty until something was billed", () => {
    expect(costLines(null)).toEqual([]);
    expect(costLines(cost({ calls: 0 }))).toEqual([]);
  });

  it("lists spent, the sub-agents' share and the saving vs all-strong", () => {
    const lines = costLines(cost());
    expect(lines.map((l) => [l.label, l.value])).toEqual([
      ["spent", "$1.25"],
      ["of which sub-agents", "$0.40"],
      ["saved vs all-strong", "$1.75 · 58%"],
    ]);
  });

  it("omits the saving when the strong tier is unpriced or the thread cost more than all-strong", () => {
    expect(costLines(cost({ strongPriced: false, baselineUsd: 0 })).map((l) => l.key)).toEqual(["spent", "agents"]);
    expect(costLines(cost({ baselineUsd: 1.0 })).map((l) => l.key)).toEqual(["spent", "agents"]);
    expect(costLines(cost({ subagentsUsd: 0 })).map((l) => l.key)).toEqual(["spent", "saved"]);
  });

  it("never rounds a cheap turn down to free", () => {
    expect(usd(0.004)).toBe("$0.004");
    expect(usd(0.5)).toBe("$0.50");
    expect(usd(0)).toBe("$0.00");
  });
});

describe("CompanionContext", () => {
  it("shows the meter and the ledger cost of the active thread", async () => {
    await act(async () => {
      render(<CompanionContext tokensUsed={211_000} tokensLimit={1_000_000} unstaged={0} toolCalls={3} workspaceId="ws" />);
    });
    expect(screen.getByText("Conversation")).toBeInTheDocument();
    expect(screen.getByText("211k / 1M")).toBeInTheDocument();
    expect(getThreadCost).toHaveBeenCalledWith("t-1");
    const block = await screen.findByTestId("conversation-cost");
    expect(block).toHaveTextContent("spent$1.25");
    expect(block).toHaveTextContent("of which sub-agents$0.40");
    expect(block).toHaveTextContent("saved vs all-strong$1.75 · 58%");
    expect(screen.getByText("tool calls")).toBeInTheDocument();
  });

  it("renders no cost block when nothing was billed yet", async () => {
    getThreadCost.mockResolvedValue(cost({ calls: 0, spentUsd: 0 }));
    await act(async () => {
      render(<CompanionContext tokensUsed={0} tokensLimit={200_000} unstaged={0} toolCalls={0} workspaceId="ws" />);
    });
    expect(screen.queryByTestId("conversation-cost")).toBeNull();
  });

  it("re-reads the cost when a sub-agent continuation ends", async () => {
    await act(async () => {
      render(<CompanionContext tokensUsed={0} tokensLimit={200_000} unstaged={0} toolCalls={0} workspaceId="ws" />);
    });
    expect(getThreadCost).toHaveBeenCalledTimes(1);
    await act(async () => {
      useChatStore.setState({ continuingCalls: { c1: true } });
    });
    await act(async () => {
      useChatStore.setState({ continuingCalls: {} });
    });
    expect(getThreadCost.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("shows the capabilities and budget rows only when there is something to show", async () => {
    await act(async () => {
      render(
        <CompanionContext
          tokensUsed={0}
          tokensLimit={200_000}
          unstaged={0}
          toolCalls={0}
          workspaceId="ws"
          mcpServers={["jira"]}
          budgets={[{ id: "b", scopeType: "global", scopeId: "", period: "daily", limitUsd: 10, createdAt: "" } as never]}
          spend={{ "global::daily": { costUsd: 2.5 } as never }}
        />,
      );
    });
    expect(screen.getByText("can use")).toBeInTheDocument();
    expect(screen.getByText("jira")).toBeInTheDocument();
    expect(screen.getByText("budget · today")).toBeInTheDocument();
    expect(screen.getByText("$2.50 / $10.00")).toBeInTheDocument();
  });
});

describe("CompanionContext — budgets, capabilities, rows", () => {
  const baseProps = { tokensUsed: 10000, tokensLimit: 200000, unstaged: 1, toolCalls: 2 };

  it("renders no budget rows when no budgets are configured", async () => {
    await act(async () => {
      render(<CompanionContext {...baseProps} budgets={[]} spend={{}} />);
    });
    expect(screen.queryByText(/budget ·/)).toBeNull();
    expect(screen.queryByText(/No budget configured/i)).toBeNull();
  });

  it("omits the percentage text from budget rows (the bar encodes it)", async () => {
    const budgets: Budget[] = [{ scopeType: "global", scopeId: "", period: "daily", limitUsd: 5.0, updatedAt: "" }];
    const spend: Record<string, SpendSnapshot> = { "global::daily": { costUsd: 1.5, tokens: 10000 } };
    await act(async () => {
      render(<CompanionContext {...baseProps} budgets={budgets} spend={spend} />);
    });
    expect(screen.queryByText(/30%/)).toBeNull();
    expect(screen.getByText("budget · today")).toBeInTheDocument();
    expect(screen.getByText(/\$1\.50 \/ \$5\.00/)).toBeInTheDocument();
  });

  it("renders two rows when both daily and monthly budgets exist", async () => {
    const budgets: Budget[] = [
      { scopeType: "global", scopeId: "", period: "daily", limitUsd: 5.0, updatedAt: "" },
      { scopeType: "global", scopeId: "", period: "monthly", limitUsd: 80.0, updatedAt: "" },
    ];
    const spend: Record<string, SpendSnapshot> = {
      "global::daily": { costUsd: 2.0, tokens: 5000 },
      "global::monthly": { costUsd: 12.0, tokens: 50000 },
    };
    await act(async () => {
      render(<CompanionContext {...baseProps} budgets={budgets} spend={spend} />);
    });
    expect(screen.getByText("budget · today")).toBeInTheDocument();
    expect(screen.getByText("budget · this month")).toBeInTheDocument();
  });

  it("renders a 1M context window as 1M, not 1000k", async () => {
    await act(async () => {
      render(<CompanionContext {...baseProps} tokensUsed={250_000} tokensLimit={1_000_000} />);
    });
    expect(screen.getByText("250k / 1M")).toBeInTheDocument();
  });

  it("omits the capabilities row when there is no MCP server", async () => {
    await act(async () => {
      render(<CompanionContext {...baseProps} />);
    });
    expect(screen.queryByText("can use")).toBeNull();
  });

  it("the unstaged row navigates to Review when there are changes", async () => {
    const onReviewClick = vi.fn();
    await act(async () => {
      render(<CompanionContext {...baseProps} unstaged={3} onReviewClick={onReviewClick} />);
    });
    fireEvent.click(screen.getByText("unstaged"));
    expect(onReviewClick).toHaveBeenCalled();
  });

  it("prefers the workspace budget over global when workspaceId is provided", async () => {
    const budgets: Budget[] = [
      { scopeType: "global", scopeId: "", period: "daily", limitUsd: 50.0, updatedAt: "" },
      { scopeType: "workspace", scopeId: "ws-1", period: "daily", limitUsd: 2.0, updatedAt: "" },
    ];
    const spend: Record<string, SpendSnapshot> = {
      "global::daily": { costUsd: 1.0, tokens: 1000 },
      "workspace:ws-1:daily": { costUsd: 0.5, tokens: 500 },
    };
    await act(async () => {
      render(<CompanionContext {...baseProps} workspaceId="ws-1" budgets={budgets} spend={spend} />);
    });
    expect(screen.getByText(/\$0\.50 \/ \$2\.00/)).toBeInTheDocument();
    expect(screen.queryByText(/\$50\.00/)).toBeNull();
  });
});
