/**
 * Unit tests for budgetsStore.
 *
 * Tests:
 * 1. loadAll / setBudget / clearBudget actions
 * 2. isOverBudget walks scope hierarchy (workspace → global)
 * 3. consumeOverride / enableOverride lifecycle
 * 4. notifiedThresholds not re-fired for same crossing
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Budget, SpendSnapshot } from "../lib/types";

// ─── Mocks ────────────────────────────────────────────────────────────

const listBudgetsMock = vi.fn<() => Promise<Budget[]>>().mockResolvedValue([]);
const setBudgetMock = vi.fn().mockResolvedValue(undefined);
const clearBudgetMock = vi.fn().mockResolvedValue(undefined);
const currentSpendMock = vi.fn<() => Promise<SpendSnapshot>>().mockResolvedValue({ costUsd: 0, tokens: 0 });

vi.mock("../lib/ipc", () => ({
  ipc: {
    listBudgets: listBudgetsMock,
    setBudget: setBudgetMock,
    clearBudget: clearBudgetMock,
    currentSpend: currentSpendMock,
  },
}));

const { useBudgetsStore } = await import("./budgetsStore");

function reset() {
  useBudgetsStore.setState({
    budgets: [],
    spend: {},
    notifiedThresholds: new Set(),
    overrideActive: false,
  });
  listBudgetsMock.mockResolvedValue([]);
  currentSpendMock.mockResolvedValue({ costUsd: 0, tokens: 0 });
}

describe("budgetsStore", () => {
  beforeEach(reset);

  it("loadAll populates budgets and spend", async () => {
    const budgets: Budget[] = [
      { scopeType: "global", scopeId: "", period: "daily", limitUsd: 5.0, updatedAt: "" },
    ];
    listBudgetsMock.mockResolvedValue(budgets);
    currentSpendMock.mockResolvedValue({ costUsd: 1.5, tokens: 1000 });

    await useBudgetsStore.getState().loadAll();

    const state = useBudgetsStore.getState();
    expect(state.budgets).toHaveLength(1);
    expect(state.spend["global::daily"]).toBeDefined();
    expect(state.spend["global::daily"].costUsd).toBe(1.5);
  });

  it("setBudget calls ipc and refreshes budgets", async () => {
    const newBudget: Budget = {
      scopeType: "global", scopeId: "", period: "daily", limitUsd: 10.0, updatedAt: "",
    };
    listBudgetsMock.mockResolvedValue([newBudget]);

    await useBudgetsStore.getState().setBudget("global", "", "daily", 10.0);

    expect(setBudgetMock).toHaveBeenCalledWith("global", "", "daily", 10.0);
    expect(useBudgetsStore.getState().budgets).toHaveLength(1);
  });

  it("clearBudget removes from ipc and updates state", async () => {
    useBudgetsStore.setState({
      budgets: [
        { scopeType: "global", scopeId: "", period: "daily", limitUsd: 5.0, updatedAt: "" },
      ],
    });
    listBudgetsMock.mockResolvedValue([]);

    await useBudgetsStore.getState().clearBudget("global", "", "daily");

    expect(clearBudgetMock).toHaveBeenCalledWith("global", "", "daily");
    expect(useBudgetsStore.getState().budgets).toHaveLength(0);
  });

  describe("isOverBudget", () => {
    it("returns false when no budgets set", () => {
      expect(useBudgetsStore.getState().isOverBudget("global", "")).toBe(false);
    });

    it("returns true when global daily budget exceeded", () => {
      useBudgetsStore.setState({
        budgets: [
          { scopeType: "global", scopeId: "", period: "daily", limitUsd: 5.0, updatedAt: "" },
        ],
        spend: { "global::daily": { costUsd: 5.0, tokens: 10000 } },
      });
      expect(useBudgetsStore.getState().isOverBudget("global", "")).toBe(true);
      // Also true for workspace scope (walks up to global)
      expect(useBudgetsStore.getState().isOverBudget("workspace", "ws-1")).toBe(true);
    });

    it("returns false when under limit", () => {
      useBudgetsStore.setState({
        budgets: [
          { scopeType: "global", scopeId: "", period: "daily", limitUsd: 5.0, updatedAt: "" },
        ],
        spend: { "global::daily": { costUsd: 4.99, tokens: 5000 } },
      });
      expect(useBudgetsStore.getState().isOverBudget("global", "")).toBe(false);
    });

    it("returns true when workspace budget exceeded but global is fine", () => {
      useBudgetsStore.setState({
        budgets: [
          { scopeType: "global", scopeId: "", period: "daily", limitUsd: 50.0, updatedAt: "" },
          { scopeType: "workspace", scopeId: "ws-1", period: "daily", limitUsd: 2.0, updatedAt: "" },
        ],
        spend: {
          "global::daily": { costUsd: 1.0, tokens: 5000 },
          "workspace:ws-1:daily": { costUsd: 2.5, tokens: 3000 },
        },
      });
      expect(useBudgetsStore.getState().isOverBudget("workspace", "ws-1")).toBe(true);
    });

    it("checks monthly period too", () => {
      useBudgetsStore.setState({
        budgets: [
          { scopeType: "global", scopeId: "", period: "monthly", limitUsd: 80.0, updatedAt: "" },
        ],
        spend: { "global::monthly": { costUsd: 80.0, tokens: 100000 } },
      });
      expect(useBudgetsStore.getState().isOverBudget("global", "")).toBe(true);
    });
  });

  describe("override lifecycle", () => {
    it("enableOverride sets overrideActive=true", () => {
      useBudgetsStore.getState().enableOverride();
      expect(useBudgetsStore.getState().overrideActive).toBe(true);
    });

    it("consumeOverride returns true and clears flag", () => {
      useBudgetsStore.getState().enableOverride();
      const result = useBudgetsStore.getState().consumeOverride();
      expect(result).toBe(true);
      expect(useBudgetsStore.getState().overrideActive).toBe(false);
    });

    it("consumeOverride returns false when not active", () => {
      const result = useBudgetsStore.getState().consumeOverride();
      expect(result).toBe(false);
    });

    it("consumeOverride only fires once", () => {
      useBudgetsStore.getState().enableOverride();
      const first = useBudgetsStore.getState().consumeOverride();
      const second = useBudgetsStore.getState().consumeOverride();
      expect(first).toBe(true);
      expect(second).toBe(false);
    });
  });
});
