import { describe, it, expect, vi } from "vitest";

vi.mock("../stores/rolesStore", () => ({
  useRolesStore: { getState: () => ({ roles: [] }) },
}));

const { fmtTokensShort, essenceShedsTokens } = await import("./stageMeta");

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
