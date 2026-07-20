import { describe, it, expect } from "vitest";
import { isBudgetExceeded } from "./budgetError";

describe("isBudgetExceeded", () => {
  it("detects the structured BudgetExceeded error (object)", () => {
    const info = isBudgetExceeded({ kind: "BudgetExceeded", scope: "global daily", spent: 1.5, limit: 1 });
    expect(info).toEqual({ scope: "global daily", spent: 1.5, limit: 1 });
  });

  it("detects it when serialized as a JSON string", () => {
    const info = isBudgetExceeded(
      JSON.stringify({ kind: "BudgetExceeded", scope: "workspace monthly", spent: 20, limit: 10 }),
    );
    expect(info?.scope).toBe("workspace monthly");
  });

  it("returns null for other errors / plain strings", () => {
    expect(isBudgetExceeded("some other error")).toBeNull();
    expect(isBudgetExceeded({ kind: "UpgradeRequired", feature: "x", used: 1, limit: 1 })).toBeNull();
    expect(isBudgetExceeded(null)).toBeNull();
    // Malformed (missing numeric fields) is not a match.
    expect(isBudgetExceeded({ kind: "BudgetExceeded", scope: "x" })).toBeNull();
  });
});
