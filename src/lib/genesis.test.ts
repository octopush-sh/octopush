import { describe, it, expect } from "vitest";
import { deriveProjectName, GENESIS_PROMISE } from "./genesis";

describe("deriveProjectName", () => {
  it("drops filler words and keeps the significant tokens", () => {
    expect(deriveProjectName("Build me an iOS app to track my daily tasks")).toBe(
      "ios-track-daily-tasks",
    );
  });

  it("caps at four tokens", () => {
    expect(
      deriveProjectName("a habit tracker with streaks charts reminders widgets"),
    ).toBe("habit-tracker-streaks-charts");
  });

  it("falls back to the raw tokens when everything is filler", () => {
    // Unusual, but never lose the prompt entirely.
    expect(deriveProjectName("build me an app please")).toBe("build-me-an-app");
  });

  it("empty / whitespace → new-project (submit is disabled upstream anyway)", () => {
    expect(deriveProjectName("")).toBe("new-project");
    expect(deriveProjectName("   ")).toBe("new-project");
  });

  it("strips punctuation and non-ascii into a clean slug", () => {
    expect(deriveProjectName("Café ordering system!!!")).toBe("caf-ordering-system");
  });

  it("caps each token so a giant no-whitespace paste can't blow the name limit", () => {
    const huge = "x".repeat(500);
    const out = deriveProjectName(`a ${huge} thing`);
    // Each token ≤ 24 chars.
    for (const token of out.split("-")) expect(token.length).toBeLessThanOrEqual(24);
  });
});

describe("GENESIS_PROMISE", () => {
  it("is honest — never promises a finished app", () => {
    const banned = ["complete", "production-ready", "app store", "fully functional", "in minutes"];
    const lower = GENESIS_PROMISE.toLowerCase();
    for (const b of banned) expect(lower).not.toContain(b);
    expect(lower).toContain("first working slice");
  });
});
