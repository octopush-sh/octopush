import { describe, it, expect } from "vitest";
import { budgetUnenforceableNote, modelCostCell, unpricedTitle } from "./cost";

const usd = (n: number) => `$${n.toFixed(2)}`;

describe("modelCostCell", () => {
  it("formats a priced model as money", () => {
    expect(modelCostCell({ model: "claude-opus-5-5", costUsd: 1.5, unpricedCalls: 0 }, usd)).toEqual({
      text: "$1.50",
      unpriced: false,
      title: undefined,
    });
    // Older payloads without the field are priced.
    expect(modelCostCell({ model: "claude-opus-5-5", costUsd: 0 }, usd).text).toBe("$0.00");
  });

  it("reads 'unpriced' for a model with no price, never $0.00", () => {
    const c = modelCostCell({ model: "claude-mythos-1", costUsd: 0, unpricedCalls: 3 }, usd);
    expect(c.text).toBe("unpriced");
    expect(c.unpriced).toBe(true);
    expect(c.title).toContain("claude-mythos-1");
  });

  it("keeps the priced figure when only some calls are unpriced", () => {
    const c = modelCostCell({ model: "custom-model", costUsd: 2, unpricedCalls: 1 }, usd);
    expect(c.text).toBe("$2.00");
    expect(c.title).toMatch(/^1 call unpriced/);
  });
});

describe("unpricedTitle", () => {
  it("names the models and says they are not counted", () => {
    expect(unpricedTitle(["a", "b"])).toMatch(/^No price for a, b — its calls are not counted as spend or as savings/);
    expect(unpricedTitle([])).toContain("this model");
  });
});

describe("budgetUnenforceableNote", () => {
  it("is empty when nothing is unpriced and counts stages otherwise", () => {
    expect(budgetUnenforceableNote(0)).toBe("");
    expect(budgetUnenforceableNote(1)).toBe("budget not enforceable: 1 stage unpriced");
    expect(budgetUnenforceableNote(3)).toBe("budget not enforceable: 3 stages unpriced");
  });
});
