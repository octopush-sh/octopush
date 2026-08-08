import { describe, it, expect } from "vitest";
import { diffStat, runTailState, modeMetaLabel, type ModeMetaInput } from "./modeMeta";

const base: ModeMetaInput = {
  terminalCount: 0,
  tokensUsed: 0,
  tokensLimit: 0,
  changedCount: 0,
  diffStat: { added: 0, removed: 0 },
  runState: "none",
};

describe("diffStat", () => {
  it("counts added and removed lines", () => {
    const diff = ["+one", "+two", "-gone", " context"].join("\n");
    expect(diffStat(diff)).toEqual({ added: 2, removed: 1 });
  });

  it("ignores the +++/--- file headers", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1,2 @@",
      "+added",
      "-removed",
    ].join("\n");
    expect(diffStat(diff)).toEqual({ added: 1, removed: 1 });
  });

  it("returns zeroes for an empty diff", () => {
    expect(diffStat("")).toEqual({ added: 0, removed: 0 });
  });
});

describe("runTailState", () => {
  it("reports none for a missing or empty list", () => {
    expect(runTailState(undefined)).toBe("none");
    expect(runTailState([])).toBe("none");
  });

  it("prefers running over paused", () => {
    expect(runTailState([{ status: "paused" }, { status: "running" }])).toBe("running");
  });

  it("reports paused when nothing is in flight", () => {
    expect(runTailState([{ status: "completed" }, { status: "paused" }])).toBe("paused");
  });

  it("reports settled when every run has finished", () => {
    expect(runTailState([{ status: "completed" }, { status: "failed" }])).toBe("settled");
  });
});

describe("modeMetaLabel", () => {
  it("pluralises terminals in run mode", () => {
    expect(modeMetaLabel("run", { ...base, terminalCount: 0 })).toBe("No terminals");
    expect(modeMetaLabel("run", { ...base, terminalCount: 1 })).toBe("1 terminal");
    expect(modeMetaLabel("run", { ...base, terminalCount: 3 })).toBe("3 terminals");
  });

  it("reports compact context in talk mode, and nothing before the first turn", () => {
    expect(modeMetaLabel("talk", { ...base, tokensUsed: 34120, tokensLimit: 200000 })).toBe(
      "34k / 200k context",
    );
    expect(modeMetaLabel("talk", { ...base, tokensUsed: 0, tokensLimit: 200000 })).toBeNull();
    expect(modeMetaLabel("talk", { ...base, tokensUsed: 500, tokensLimit: 0 })).toBeNull();
  });

  it("reports changed files and the diff stat in review mode", () => {
    expect(modeMetaLabel("review", base)).toBe("Nothing to review");
    expect(modeMetaLabel("review", { ...base, changedCount: 1 })).toBe("1 file changed");
    expect(
      modeMetaLabel("review", {
        ...base,
        changedCount: 7,
        diffStat: { added: 214, removed: 61 },
      }),
    ).toBe("7 files changed · +214 −61");
  });

  it("reports the crew's state in direct mode", () => {
    expect(modeMetaLabel("direct", { ...base, runState: "running" })).toBe("Crew running");
    expect(modeMetaLabel("direct", { ...base, runState: "paused" })).toBe("Crew waiting on you");
    expect(modeMetaLabel("direct", { ...base, runState: "settled" })).toBe("Crew idle");
    expect(modeMetaLabel("direct", { ...base, runState: "none" })).toBe("No runs yet");
  });
});
