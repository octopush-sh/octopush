import { describe, it, expect, vi } from "vitest";

vi.mock("../stores/rolesStore", () => ({
  useRolesStore: { getState: () => ({ roles: [] }) },
}));

const {
  fmtTokensFull,
  fmtTokensShort,
  essenceShedsTokens,
  stageContextReading,
  contextToneClass,
  subjectShedsContext,
  currentContext,
} = await import("./stageMeta");

describe("fmtTokensFull", () => {
  it("keeps fmtTokens below a million and reads millions as M (#937)", () => {
    expect(fmtTokensFull(700)).toBe("700");
    expect(fmtTokensFull(18_412)).toBe("18.4k");
    expect(fmtTokensFull(999_949)).toBe("999.9k");
    expect(fmtTokensFull(999_950)).toBe("1.00M");
    expect(fmtTokensFull(1_240_000)).toBe("1.24M");
  });
});

describe("fmtTokensShort", () => {
  it("drops the decimal from 10k up and reads millions as M", () => {
    expect(fmtTokensShort(700)).toBe("700");
    expect(fmtTokensShort(3_100)).toBe("3.1k");
    expect(fmtTokensShort(18_412)).toBe("18k");
    expect(fmtTokensShort(184_000)).toBe("184k");
    expect(fmtTokensShort(999_600)).toBe("1.0M");
    expect(fmtTokensShort(1_240_000)).toBe("1.2M");
  });

  it("never reads 10.0k just under ten thousand", () => {
    expect(fmtTokensShort(9_949)).toBe("9.9k");
    expect(fmtTokensShort(9_950)).toBe("10k");
    expect(fmtTokensShort(9_999)).toBe("10k");
  });
});

describe("essenceShedsTokens", () => {
  it("keeps the pair while position, cost and tokens fit the card", () => {
    expect(essenceShedsTokens("2", "$0.30", "↑18k ↓3.1k")).toBe(false);
    expect(essenceShedsTokens("3", "$0.02", "↑9.1k ↓700")).toBe(false);
  });

  it("sheds the pair when the line would overflow", () => {
    expect(essenceShedsTokens("10", "$12.34", "↑184k ↓31k")).toBe(true);
    // The shown label counts, not a "$0.00" placeholder.
    expect(essenceShedsTokens("2", "unpriced", "↑18k ↓3.1k")).toBe(true);
  });
});

describe("stageContextReading (#895)", () => {
  it("reads ctx used / window through the shared context formatter", () => {
    expect(stageContextReading({ contextTokens: 142_312, contextWindow: 200_000 })?.label).toBe("ctx 142k / 200k");
    expect(stageContextReading({ contextTokens: 412_000, contextWindow: 1_000_000 })?.label).toBe("ctx 412k / 1M");
    // Never "1000k".
    expect(stageContextReading({ contextTokens: 999_800, contextWindow: 1_000_000 })?.label).toBe("ctx 1M / 1M");
  });

  it("tones with Talk's thresholds: amber from 80%, rouge from 95%", () => {
    const tone = (used: number) => stageContextReading({ contextTokens: used, contextWindow: 200_000 })!.tone;
    expect(tone(159_999)).toBe("ok");
    expect(tone(160_000)).toBe("warning");
    expect(tone(189_999)).toBe("warning");
    expect(tone(190_000)).toBe("rouge");
    expect(tone(194_000)).toBe("rouge"); // a 97%-full stage
    expect(contextToneClass("ok")).toBe("text-octo-mute");
    expect(contextToneClass("warning")).toBe("text-octo-warning");
    expect(contextToneClass("rouge")).toBe("text-octo-rouge");
  });

  it("is hidden over its window, never 400k / 200k", () => {
    expect(stageContextReading({ contextTokens: 400_000, contextWindow: 200_000 })).toBeNull();
    expect(stageContextReading({ contextTokens: 200_001, contextWindow: 200_000 })).toBeNull();
    expect(stageContextReading({ contextTokens: 200_000, contextWindow: 200_000 })?.tone).toBe("rouge");
    // A [1m] stage's window comes through as 1M.
    expect(stageContextReading({ contextTokens: 400_000, contextWindow: 1_000_000 })?.label).toBe("ctx 400k / 1M");
  });

  it("is hidden when the window is unknown, before the first message, and for Codex/API stages", () => {
    expect(stageContextReading({ contextTokens: 142_000, contextWindow: null })).toBeNull();
    expect(stageContextReading({ contextTokens: 142_000, contextWindow: 0 })).toBeNull();
    expect(stageContextReading({ contextTokens: 142_000 })).toBeNull();
    expect(stageContextReading({ contextTokens: null, contextWindow: 200_000 })).toBeNull();
    expect(stageContextReading({ contextTokens: 0, contextWindow: 200_000 })).toBeNull();
    expect(stageContextReading({})).toBeNull();
  });

  it("puts the exact figures and share in the tooltip", () => {
    expect(stageContextReading({ contextTokens: 194_000, contextWindow: 200_000 })?.title).toBe(
      "Context: 194,000 of 200,000 tokens (97%), the prompt of the stage's latest message",
    );
  });
});

describe("subjectShedsContext (#895)", () => {
  it("keeps the reading only when the short model, position, notes and pill leave room", () => {
    expect(subjectShedsContext("2", "opus", "ctx 142k / 200k", [])).toBe(false);
    expect(subjectShedsContext("2", "haiku", "ctx 142k / 200k", [])).toBe(false);
    expect(subjectShedsContext("3", "sonnet", "ctx 412k / 1M", [])).toBe(false);
  });

  it("sheds the reading first: the short model name is never squeezed for it", () => {
    // 2 · opus-5-5 · ctx 142k / 200k · CLI needs 33ch of the card's 30.
    expect(subjectShedsContext("2", "opus-5-5", "ctx 142k / 200k", [])).toBe(true);
    expect(subjectShedsContext("2", "sonnet-5-5", "ctx 412k / 1M", [])).toBe(true);
    expect(subjectShedsContext("2", "opus", "ctx 142k / 200k", ["high"])).toBe(true);
    expect(subjectShedsContext("2", "opus", "ctx 142k / 200k", ["ran on sonnet-5-5"])).toBe(true);
    expect(subjectShedsContext("100", "opus", "ctx 142k / 200k", [])).toBe(true);
  });
});

describe("currentContext (#895)", () => {
  it("prefers the newest live reading, a cleared one included, over the stage row", () => {
    const row = { contextTokens: 120_000, contextWindow: 200_000 };
    expect(currentContext(row, undefined)).toBe(row);
    expect(currentContext(row, { contextTokens: 150_000, contextWindow: 200_000 }).contextTokens).toBe(150_000);
    expect(currentContext(row, { contextTokens: null, contextWindow: null }).contextTokens).toBeNull();
  });
});
