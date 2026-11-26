import { describe, it, expect } from "vitest";
import { formatAttemptTime, rejectionReason, syncStatusLine, syncUnsentLine } from "./syncStatusLine";
import type { SyncAttempt } from "./types";

// Local times, so the assertions hold in any time zone.
const NOW = new Date(2026, 10, 9, 18, 30);
const at = (y: number, mo: number, d: number, h: number, mi: number) =>
  new Date(y, mo, d, h, mi).toISOString();
const sent = (count: number, when = at(2026, 10, 9, 14, 2)): SyncAttempt => ({
  at: when,
  outcome: "sent",
  count,
});

describe("syncStatusLine (#518, PM-approved strings)", () => {
  it("sent: time and plural runs / items", () => {
    expect(syncStatusLine("history", true, sent(3), NOW)).toEqual({
      text: "Last sent 14:02 · 3 runs",
      tone: "mute",
    });
    expect(syncStatusLine("library", true, sent(3), NOW)?.text).toBe("Last sent 14:02 · 3 items");
  });

  it("sent: singular for one", () => {
    expect(syncStatusLine("history", true, sent(1), NOW)?.text).toBe("Last sent 14:02 · 1 run");
    expect(syncStatusLine("library", true, sent(1), NOW)?.text).toBe("Last sent 14:02 · 1 item");
  });

  it("failed: amber, with the HTTP status", () => {
    const failed: SyncAttempt = { ...sent(3), outcome: "failed", httpStatus: 503 };
    expect(syncStatusLine("history", true, failed, NOW)).toEqual({
      text: "Last attempt failed 14:02 · HTTP 503 · Octopush retries with the next run",
      tone: "warning",
    });
  });

  it("failed without a status (network error) drops only that segment", () => {
    const failed: SyncAttempt = { ...sent(3), outcome: "failed", httpStatus: null };
    expect(syncStatusLine("library", true, failed, NOW)?.text).toBe(
      "Last attempt failed 14:02 · Octopush retries with the next run",
    );
  });

  it("adds the date when the attempt wasn't today", () => {
    const yesterday = sent(3, at(2026, 10, 8, 9, 5));
    expect(syncStatusLine("history", true, yesterday, NOW)?.text).toBe(
      "Last sent Nov 8 09:05 · 3 runs",
    );
    const lastYear = sent(2, at(2025, 11, 31, 23, 59));
    expect(syncStatusLine("library", true, lastYear, NOW)?.text).toBe(
      "Last sent Dec 31, 2025 23:59 · 2 items",
    );
    const failed: SyncAttempt = { ...yesterday, outcome: "failed", httpStatus: 502 };
    expect(syncStatusLine("history", true, failed, NOW)?.text).toBe(
      "Last attempt failed Nov 8 09:05 · HTTP 502 · Octopush retries with the next run",
    );
  });

  it("uses a middle dot, never an em dash", () => {
    for (const a of [sent(3), { ...sent(3), outcome: "failed" as const, httpStatus: 503 }]) {
      const text = syncStatusLine("history", true, a, NOW)!.text;
      expect(text).toContain(" · ");
      expect(text).not.toContain("—");
    }
  });

  it("shows nothing when the toggle is off, nothing is recorded, or the time is unreadable", () => {
    expect(syncStatusLine("history", false, sent(3), NOW)).toBeNull();
    expect(syncStatusLine("library", false, { ...sent(1), outcome: "failed", httpStatus: 503 }, NOW)).toBeNull();
    expect(syncStatusLine("history", true, null, NOW)).toBeNull();
    expect(syncStatusLine("history", true, undefined, NOW)).toBeNull();
    expect(syncStatusLine("history", true, { ...sent(3), at: "garbage" }, NOW)).toBeNull();
  });

  it("formatAttemptTime pads hours and minutes", () => {
    expect(formatAttemptTime(new Date(2026, 10, 9, 7, 4), NOW)).toBe("07:04");
  });
});

describe("syncUnsentLine (#799)", () => {
  const r = (kind: string, id: string, reason: string, name?: string | null) => ({ kind, id, reason, name });

  it("names up to two items with the reason, then counts the rest", () => {
    expect(syncUnsentLine(true, [r("pipeline", "p1", "oversize", "Big crew")])).toEqual({
      text: 'Not synced · pipeline "Big crew" (over the 64,000-byte limit)',
      tone: "warning",
    });
    const line = syncUnsentLine(true, [
      r("role", "my-role", "bad_stamp", "Mine"),
      r("pipeline", "p1", "future_stamp", "Big crew"),
      r("pipeline", "p2", "oversize", "A"),
      r("pipeline", "p3", "oversize", "B"),
    ]);
    expect(line?.text).toBe(
      'Not synced · role "Mine" (unreadable edit time) · pipeline "Big crew" (edit time over a day ahead of the sync service) · +2 more',
    );
  });

  it("falls back to the id, and to a plain reason for codes it doesn't know", () => {
    expect(syncUnsentLine(true, [r("role", "my-role", "something_new", null)])?.text).toBe(
      'Not synced · role "my-role" (refused by the sync service)',
    );
  });

  it("shows nothing when off or empty", () => {
    expect(syncUnsentLine(false, [r("pipeline", "p1", "oversize", "X")])).toBeNull();
    expect(syncUnsentLine(true, [])).toBeNull();
    expect(syncUnsentLine(true, undefined)).toBeNull();
  });

  it("reasons", () => {
    expect(rejectionReason("oversize")).toBe("over the 64,000-byte limit");
    expect(rejectionReason("bad_stamp")).toBe("unreadable edit time");
    expect(rejectionReason("future_stamp")).toBe("edit time over a day ahead of the sync service");
  });
});
