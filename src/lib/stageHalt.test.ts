import { describe, it, expect } from "vitest";
import { haltCause } from "./stageHalt";

describe("haltCause", () => {
  it("explains a turn-budget halt", () => {
    const c = haltCause("claude stopped early (error_max_turns) — review…", 25);
    expect(c.title).toContain("turn limit");
    expect(c.title).toContain("25");
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
