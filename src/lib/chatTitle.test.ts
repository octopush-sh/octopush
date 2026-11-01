import { describe, it, expect } from "vitest";
import { deriveChatTitle, deriveChatMeta } from "./chatTitle";
import type { ChatMessage } from "./types";

function msg(
  role: ChatMessage["role"],
  content: string,
  createdAt = "2026-05-18T15:00:00Z",
): ChatMessage {
  return {
    id: Math.floor(Math.random() * 1_000_000),
    workspaceId: "ws-1",
    role,
    content,
    model: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    createdAt,
  };
}

describe("deriveChatTitle", () => {
  it("returns placeholder for empty message list", () => {
    expect(deriveChatTitle([])).toBe("New conversation");
  });

  it("returns placeholder when there are only assistant or tool messages", () => {
    expect(deriveChatTitle([msg("assistant", "hi there")])).toBe("New conversation");
    expect(deriveChatTitle([msg("tool", "{}")])).toBe("New conversation");
  });

  it("uses the first user message verbatim when short", () => {
    expect(deriveChatTitle([msg("user", "fix the bug")])).toBe("fix the bug");
  });

  it("ignores empty/whitespace user messages and picks the next one", () => {
    expect(
      deriveChatTitle([
        msg("user", "   "),
        msg("assistant", "noise"),
        msg("user", "actual question"),
      ]),
    ).toBe("actual question");
  });

  it("truncates long messages at a word boundary with an ellipsis", () => {
    const long =
      "I would like you to refactor the authentication module to support OAuth properly";
    const out = deriveChatTitle([msg("user", long)]);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(62); // 60 + maybe trailing space + …
    expect(out.startsWith("I would like you")).toBe(true);
  });

  it("collapses newlines to single spaces", () => {
    expect(deriveChatTitle([msg("user", "line one\n\nline two")])).toBe(
      "line one line two",
    );
  });
});

describe("deriveChatMeta", () => {
  // Local-time dates, so the calendar-day logic doesn't depend on the TZ the
  // tests run in.
  const local = (d: number, h: number, m = 0, mo = 4) => new Date(2026, mo, d, h, m);
  const now = local(18, 15);
  const at = (d: Date) => [msg("user", "hi", d.toISOString())];
  const clock = (d: Date) =>
    d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }).toUpperCase();

  it("returns NEW when there are no messages", () => {
    expect(deriveChatMeta([], now)).toBe("NEW");
  });

  it("returns the clock time for messages from today, not JUST NOW", () => {
    const tenSecondsAgo = new Date(now.getTime() - 10_000);
    expect(deriveChatMeta(at(tenSecondsAgo), now)).toBe(clock(tenSecondsAgo));
    expect(deriveChatMeta(at(tenSecondsAgo), now)).not.toBe("JUST NOW");
    expect(deriveChatMeta(at(local(18, 9, 5)), now)).toBe(clock(local(18, 9, 5)));
  });

  it("tells apart two rows active minutes apart today", () => {
    expect(deriveChatMeta(at(local(18, 14, 32)), now)).not.toBe(
      deriveChatMeta(at(local(18, 14, 41)), now),
    );
  });

  it("returns YESTERDAY for the previous calendar day, even under 24h ago", () => {
    expect(deriveChatMeta(at(local(17, 14)), now)).toBe("YESTERDAY");
    expect(deriveChatMeta(at(local(17, 23, 50)), local(18, 0, 10))).toBe("YESTERDAY");
  });

  it("returns days for messages within a week", () => {
    expect(deriveChatMeta(at(local(15, 15)), now)).toBe("3D AGO");
  });

  it("falls back to a locale date older than a week", () => {
    const out = deriveChatMeta(at(local(15, 15, 0, 3)), now);
    // Format depends on Intl locale, but should not contain "AGO".
    expect(out).not.toContain("AGO");
    expect(out.length).toBeGreaterThan(0);
  });
});
