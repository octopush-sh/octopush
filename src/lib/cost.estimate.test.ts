import { describe, it, expect } from "vitest";
import {
  estimateBreakdownTitle,
  estimateRangeText,
  estimateSavingsText,
  formatEstimateUsd,
} from "./cost";
import type { RunEstimate, StageEstimate } from "./ipc";

const stage = (over: Partial<StageEstimate>): StageEstimate => ({
  position: 0, role: "plan", effort: null, model: "m", lowUsd: 0.1, highUsd: 0.2, samples: 5, rough: false, ...over,
});

describe("pre-run estimate copy", () => {
  it("formats a sub-cent amount as <$0.01, never $0.00", () => {
    expect(formatEstimateUsd(0.004)).toBe("<$0.01");
    expect(formatEstimateUsd(0)).toBe("$0.00");
    expect(formatEstimateUsd(1.234)).toBe("$1.23");
  });

  it("shows the p25–p75 range, or one figure when the ends round alike", () => {
    expect(estimateRangeText({ estimateUsd: 0.7, baselineUsd: 1, lowUsd: 0.4, highUsd: 1.1 })).toBe("$0.40–$1.10");
    expect(estimateRangeText({ estimateUsd: 0.4, baselineUsd: 1, lowUsd: 0.401, highUsd: 0.404 })).toBe("~$0.40");
    // An older single-figure shape still renders.
    expect(estimateRangeText({ estimateUsd: 0.43, baselineUsd: 1.95 })).toBe("~$0.43");
  });

  it("reads unpriced when no stage has a price, and keeps the priced part otherwise", () => {
    const none: RunEstimate = {
      estimateUsd: 0, baselineUsd: 0, lowUsd: 0, highUsd: 0,
      perStage: [stage({ lowUsd: null, highUsd: null })],
    };
    expect(estimateRangeText(none)).toBe("unpriced");
    const some: RunEstimate = {
      estimateUsd: 0.15, baselineUsd: 0.5, lowUsd: 0.1, highUsd: 0.2,
      perStage: [stage({}), stage({ position: 1, lowUsd: null, highUsd: null })],
    };
    expect(estimateRangeText(some)).toBe("$0.10–$0.20");
  });

  it("states savings as a share of the all-premium baseline, or nothing", () => {
    expect(estimateSavingsText({ estimateUsd: 0.7, baselineUsd: 1.84 })).toBe("saves ~62% vs all-premium");
    expect(estimateSavingsText({ estimateUsd: 1, baselineUsd: 1 })).toBe("");
    expect(estimateSavingsText({ estimateUsd: 0, baselineUsd: 0 })).toBe("");
  });

  it("breaks the estimate down per stage, naming rough and unpriced stages", () => {
    const title = estimateBreakdownTitle({
      estimateUsd: 0.2, baselineUsd: 0.6, lowUsd: 0.1, highUsd: 0.3,
      perStage: [
        stage({ role: "plan", model: "claude-haiku-4-5", effort: "high", samples: 1, lowUsd: 0.1, highUsd: 0.3 }),
        stage({ position: 1, role: "implement", model: "qwen-x", rough: true, samples: 0, lowUsd: null, highUsd: null }),
        stage({ position: 2, role: "test", rough: true, samples: 0, lowUsd: 0.02, highUsd: 0.06 }),
      ],
    });
    const lines = title.split("\n");
    expect(lines[0]).toBe("plan · claude-haiku-4-5 · high  $0.10–$0.30  (1 past run)");
    expect(lines[1]).toBe("implement · qwen-x  unpriced");
    expect(lines[2]).toBe("test · m  $0.02–$0.06  (rough)");
    expect(title).toContain("Rough: fewer than 3 past runs");
    expect(title).toContain("Unpriced stages are not counted");
  });

  it("has no breakdown without per-stage rows", () => {
    expect(estimateBreakdownTitle({ estimateUsd: 0.43, baselineUsd: 1.95 })).toBe("");
  });
});
