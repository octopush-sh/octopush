import { describe, it, expect } from "vitest";
import { haltCause } from "./stageHalt";

describe("haltCause", () => {
  it("explains a turn-budget halt", () => {
    const c = haltCause("claude stopped early (error_max_turns) — review…", 25);
    expect(c.title).toContain("turn limit");
    expect(c.title).toContain("25");
  });
  it("explains a budget stop as a budget stop, not a crash", () => {
    const c = haltCause(
      "budget reached mid-stage — Claude Code stopped at the run's remaining budget (error_max_budget_usd, $1.27 reported) — resume…",
      25,
    );
    expect(c.title).toBe("Claude stopped at the run's budget");
    expect(c.remedy).toMatch(/Resum/);
    // A sibling in a parallel batch can stop while the run is still under
    // budget, so the remedy must not promise a budget gate on every Resume.
    expect(c.remedy).toContain("within whatever budget is left");
    expect(c.remedy).not.toMatch(/approve the budget gate/);
  });
  it("explains an idle timeout", () => {
    expect(haltCause("claude timed out — no output for 5 minutes", 25).title).toMatch(/no output/i);
  });
  it("falls back to the first line", () => {
    expect(haltCause("something weird\nsecond line", 25).title).toBe("something weird");
  });
  it("handles null", () => {
    expect(haltCause(null, 25).title).toBe("Stage halted");
  });
});
