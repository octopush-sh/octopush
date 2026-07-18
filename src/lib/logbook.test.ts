import { describe, it, expect } from "vitest";
import { fmtHours, periodRange, periodPhrase, logbookTotals, logbookToMarkdown } from "./logbook";
import type { LogbookMissionRow } from "./types";

function row(over: Partial<LogbookMissionRow>): LogbookMissionRow {
  return {
    missionId: "m",
    title: "A mission",
    intent: "build",
    status: "active",
    hoursSecs: 0,
    costUsd: 0,
    savingsUsd: 0,
    runsCount: 0,
    messagesCount: 0,
    perSurface: [],
    ...over,
  };
}

describe("fmtHours", () => {
  it("formats seconds, minutes, and hours compactly", () => {
    expect(fmtHours(45)).toBe("45s");
    expect(fmtHours(90)).toBe("2m"); // rounds to the nearest minute
    expect(fmtHours(3600)).toBe("1h");
    expect(fmtHours(3900)).toBe("1h 5m");
    expect(fmtHours(7200)).toBe("2h");
  });
});

describe("periodRange", () => {
  const now = new Date("2026-07-18T12:00:00.000Z");

  it("windows N days back to now", () => {
    expect(periodRange("7d", now)).toEqual({
      from: "2026-07-11T12:00:00.000Z",
      to: "2026-07-18T12:00:00.000Z",
    });
  });

  it("uses the epoch sentinel for all-time", () => {
    expect(periodRange("all", now).from).toBe("2000-01-01T00:00:00+00:00");
    expect(periodRange("all", now).to).toBe("2026-07-18T12:00:00.000Z");
  });
});

describe("periodPhrase", () => {
  it("prefixes 'Last' for windowed periods but not all-time (grammatical export copy)", () => {
    expect(periodPhrase("7d")).toBe("Last 7 days");
    expect(periodPhrase("30d")).toBe("Last 30 days");
    expect(periodPhrase("all")).toBe("All time");
  });
});

describe("logbookTotals", () => {
  it("sums across missions (disjoint work sums cleanly)", () => {
    const t = logbookTotals([
      row({ hoursSecs: 600, costUsd: 1.5, savingsUsd: 0.5 }),
      row({ hoursSecs: 300, costUsd: 2.0, savingsUsd: 1.0 }),
    ]);
    expect(t).toEqual({ hoursSecs: 900, costUsd: 3.5, savingsUsd: 1.5, missions: 2 });
  });
});

describe("logbookToMarkdown", () => {
  it("renders a header, totals line, and one row per mission sorted by cost", () => {
    const md = logbookToMarkdown(
      [
        row({ title: "Cheap", costUsd: 1.0, hoursSecs: 60 }),
        row({ title: "Pricey", costUsd: 9.0, hoursSecs: 120, savingsUsd: 3.0, runsCount: 2 }),
      ],
      { scopeLabel: "All missions", periodLabel: "Last 30 days" },
    );
    expect(md).toContain("# Logbook — All missions");
    expect(md).toContain("_Last 30 days_");
    expect(md).toContain("**Total:** 3m worked · $10.00 spent · saved $3.00 across 2 missions");
    // Pricey outranks Cheap (sorted by cost desc).
    expect(md.indexOf("Pricey")).toBeLessThan(md.indexOf("Cheap"));
    expect(md).toContain("| Pricey | build | 2m | $9.00 | $3.00 | 2 | 0 |");
  });

  it("escapes pipes in a mission title so the table can't break", () => {
    const md = logbookToMarkdown([row({ title: "a | b" })], {
      scopeLabel: "s",
      periodLabel: "p",
    });
    expect(md).toContain("| a \\| b |");
  });
});
