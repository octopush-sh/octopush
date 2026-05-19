import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { Budget, BudgetPeriod, BudgetScope, SpendSnapshot } from "../lib/types";

export const BUDGET_CAP_MSG = "Budget cap reached — click Override to send this turn anyway.";

interface BudgetsStore {
  budgets: Budget[];
  /** Cached spend per scope key. Key: `${scopeType}:${scopeId}:${period}`. */
  spend: Record<string, SpendSnapshot>;
  /**
   * Thresholds already toasted this session so we don't repeat.
   * Key: `${scopeType}:${scopeId}:${period}:${thresholdPct}`.
   */
  notifiedThresholds: Set<string>;
  /** Per-turn override — set when the user clicks "Override for this turn". */
  overrideActive: boolean;

  loadAll(): Promise<void>;
  setBudget(scope: BudgetScope, scopeId: string, period: BudgetPeriod, limitUsd: number): Promise<void>;
  clearBudget(scope: BudgetScope, scopeId: string, period: BudgetPeriod): Promise<void>;
  refreshSpend(scope: BudgetScope, scopeId: string, period: BudgetPeriod): Promise<void>;
  refreshAllSpend(): Promise<void>;
  /** Check if any budget (global, project, or workspace) is at or over limit. */
  isOverBudget(scope: BudgetScope, scopeId: string): boolean;
  /** Returns true if override was active (consuming it), false otherwise. */
  consumeOverride(): boolean;
  enableOverride(): void;
}

function spendKey(scope: BudgetScope, scopeId: string, period: BudgetPeriod): string {
  return `${scope}:${scopeId}:${period}`;
}

export const useBudgetsStore = create<BudgetsStore>((set, get) => ({
  budgets: [],
  spend: {},
  notifiedThresholds: new Set(),
  overrideActive: false,

  async loadAll() {
    const budgets = await ipc.listBudgets();
    set({ budgets });
    await get().refreshAllSpend();
  },

  async setBudget(scope, scopeId, period, limitUsd) {
    await ipc.setBudget(scope, scopeId, period, limitUsd);
    const budgets = await ipc.listBudgets();
    set({ budgets });
    await get().refreshSpend(scope, scopeId, period);
  },

  async clearBudget(scope, scopeId, period) {
    await ipc.clearBudget(scope, scopeId, period);
    const budgets = await ipc.listBudgets();
    set({ budgets });
  },

  async refreshSpend(scope, scopeId, period) {
    try {
      const snap = await ipc.currentSpend(scope, scopeId, period);
      const key = spendKey(scope, scopeId, period);
      set((s) => {
        const prevSnap = s.spend[key];
        // If spend dropped (period rolled over), clear notified thresholds for this key
        let notifiedThresholds = s.notifiedThresholds;
        if (prevSnap && snap.costUsd < prevSnap.costUsd) {
          notifiedThresholds = new Set(
            [...notifiedThresholds].filter(
              (k) => !k.startsWith(`${scope}:${scopeId}:${period}:`),
            ),
          );
        }
        return {
          spend: { ...s.spend, [key]: snap },
          notifiedThresholds,
        };
      });
    } catch {
      // Non-fatal: spend stays at last known value
    }
  },

  async refreshAllSpend() {
    const { budgets } = get();
    const seen = new Set<string>();
    const promises: Promise<void>[] = [];
    for (const b of budgets) {
      const key = spendKey(b.scopeType as BudgetScope, b.scopeId, b.period as BudgetPeriod);
      if (!seen.has(key)) {
        seen.add(key);
        promises.push(get().refreshSpend(b.scopeType as BudgetScope, b.scopeId, b.period as BudgetPeriod));
      }
    }
    // Also refresh global daily + monthly if not already
    for (const period of ["daily", "monthly"] as BudgetPeriod[]) {
      const key = spendKey("global", "", period);
      if (!seen.has(key)) {
        seen.add(key);
        promises.push(get().refreshSpend("global", "", period));
      }
    }
    await Promise.allSettled(promises);
  },

  isOverBudget(scope, scopeId) {
    const { budgets, spend } = get();

    const check = (s: BudgetScope, id: string): boolean => {
      return (["daily", "monthly"] as BudgetPeriod[]).some((period) => {
        const budget = budgets.find(
          (b) => b.scopeType === s && b.scopeId === id && b.period === period,
        );
        if (!budget || budget.limitUsd <= 0) return false;
        const key = spendKey(s, id, period);
        const snap = spend[key];
        if (!snap) return false;
        return snap.costUsd >= budget.limitUsd;
      });
    };

    // Global always checked
    if (check("global", "")) return true;
    // For workspace scope, also check workspace-level budget
    if (scope === "workspace" && check("workspace", scopeId)) return true;
    // For project scope
    if (scope === "project" && check("project", scopeId)) return true;
    return false;
  },

  consumeOverride() {
    const active = get().overrideActive;
    if (active) {
      set({ overrideActive: false });
    }
    return active;
  },

  enableOverride() {
    set({ overrideActive: true });
  },
}));
