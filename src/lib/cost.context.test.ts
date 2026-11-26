import { describe, it, expect } from "vitest";
import { formatContextTokens } from "./cost";

describe("formatContextTokens (#853)", () => {
  it("is the compact context format every surface shares", () => {
    expect(formatContextTokens(0)).toBe("0");
    expect(formatContextTokens(850)).toBe("850");
    expect(formatContextTokens(4200)).toBe("4k");
    expect(formatContextTokens(200_000)).toBe("200k");
    expect(formatContextTokens(1_000_000)).toBe("1M");
    expect(formatContextTokens(1_500_000)).toBe("1.5M");
    expect(formatContextTokens(2_000_000)).toBe("2M");
  });

  it("never reads 1000k, even where rounding crosses the million", () => {
    expect(formatContextTokens(999_600)).toBe("1M");
    expect(formatContextTokens(999_400)).toBe("999k");
    expect(formatContextTokens(1_048_576)).toBe("1M");
  });

  it("guards against non-finite input", () => {
    expect(formatContextTokens(Number.NaN)).toBe("0");
  });
});
