import { describe, it, expect } from "vitest";
import { formatDuration } from "./duration";

describe("formatDuration", () => {
  it("renders sub-minute values as one-decimal seconds", () => {
    expect(formatDuration(0)).toBe("0.0s");
    expect(formatDuration(400)).toBe("0.4s");
    expect(formatDuration(1234)).toBe("1.2s");
    expect(formatDuration(59_900)).toBe("59.9s");
  });

  it("renders a minute or more as m:ss", () => {
    expect(formatDuration(60_000)).toBe("1:00");
    expect(formatDuration(65_000)).toBe("1:05");
    expect(formatDuration(615_000)).toBe("10:15");
  });

  it("clamps negative input to zero", () => {
    expect(formatDuration(-500)).toBe("0.0s");
  });
});
