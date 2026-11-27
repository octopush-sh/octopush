import { describe, it, expect } from "vitest";
import { deriveChatTitle, deriveChatMeta, shortUrl, ticketKey } from "./chatTitle";
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

  it("drops a /skill token and reads a tracker URL as its ticket key", () => {
    expect(
      deriveChatTitle([msg("user", "/ship-ticket https://acme.atlassian.net/browse/GUIDE-123")]),
    ).toBe("GUIDE-123");
    expect(
      deriveChatTitle([msg("user", "/review-pr please look at https://linear.app/acme/issue/ENG-42/fix-login")]),
    ).toBe("please look at ENG-42");
  });

  it("reads any other URL as its host and path tail", () => {
    expect(deriveChatTitle([msg("user", "why does https://github.com/acme/api/pull/918 fail?")])).toBe(
      "why does github.com/…/pull/918 fail?",
    );
    expect(deriveChatTitle([msg("user", "see https://www.example.com/docs")])).toBe("see example.com/docs");
    expect(deriveChatTitle([msg("user", "open https://example.com/")])).toBe("open example.com");
  });

  it("leaves paths alone, but drops @file mentions and fenced code", () => {
    expect(deriveChatTitle([msg("user", "run /usr/bin/env in @src/lib/a.ts now")])).toBe(
      "run /usr/bin/env in now",
    );
    expect(deriveChatTitle([msg("user", 'compare @"docs/my notes.md" and\n```ts\nconst a = 1;\n```\nfix it')])).toBe(
      "compare and fix it",
    );
  });

  it("titles from what was typed, not the @ blocks appended to it", () => {
    const typed = "explain this file ";
    const block = "\n\nsrc/a.ts\n```ts\nexport const secretSauce = 42;\n```";
    const m = msg("user", typed + block);
    m.contextBlocks = JSON.stringify([
      { token: "src/a.ts", kind: "file", label: "a.ts", tokens: 9, start: typed.length, end: typed.length + block.length },
    ]);
    expect(deriveChatTitle([m])).toBe("explain this file");
  });

  it("keeps a message that is only a skill readable", () => {
    expect(deriveChatTitle([msg("user", "/standup")])).toBe("/standup");
  });

  it("cuts a long message at a word boundary after tidying it", () => {
    const out = deriveChatTitle([
      msg("user", `/ship-ticket ${"word ".repeat(30)}https://example.com/a`),
    ]);
    expect(out.startsWith("word word")).toBe(true);
    expect(out.endsWith("word…")).toBe(true);
  });
});

describe("ticketKey", () => {
  it("finds a key in a tracker URL first, then in the text", () => {
    expect(ticketKey("look at OPS-9 and https://acme.atlassian.net/browse/GUIDE-123")).toBe("GUIDE-123");
    expect(ticketKey("https://acme.atlassian.net/jira/software/projects/G/boards/1?selectedIssue=GUIDE-7")).toBe("GUIDE-7");
    expect(ticketKey("fix GUIDE-123 today")).toBe("GUIDE-123");
  });

  it("doesn't take standards or versions for keys", () => {
    expect(ticketKey("read it as UTF-8 and hash with SHA-256")).toBeNull();
    expect(ticketKey("bump to ABC-1.2")).toBeNull();
    expect(ticketKey("nothing here")).toBeNull();
  });
});

describe("shortUrl", () => {
  it("decodes the path tail", () => {
    expect(shortUrl("https://example.com/a/b/my%20page")).toBe("example.com/…/b/my page");
  });

  it("drops trailing punctuation", () => {
    expect(shortUrl("https://example.com/docs.")).toBe("example.com/docs");
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
