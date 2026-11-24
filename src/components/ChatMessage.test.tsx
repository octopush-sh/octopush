/**
 * Assistant prose rendering: GitHub-flavored Markdown must be ON — models
 * write tables, task lists and strikethrough routinely, and without GFM a
 * table collapses into one run-on paragraph (the bug this guards).
 *
 * User-turn rendering: shown as written. The Composer lets the user break
 * lines (⇧↵), indent and type bullets; without `white-space: pre-wrap` the
 * browser collapsed every newline into a space and the sent message read as
 * one run-on paragraph (the bug the second block guards). The user's text is
 * never re-parsed as Markdown — a pasted log or snippet keeps its characters.
 */
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ChatMessage, usageFooter, turnTime } from "./ChatMessage";

const TABLE = [
  "Aquí están los resultados en una tabla:",
  "",
  "| Archivo | Líneas |",
  "|---------|--------|",
  "| package.json | 136 |",
  "| README.md | 197 |",
  "",
  "~~Tardó 25 s~~ Tardó 8 s.",
  "",
  "- [x] package.json",
  "- [ ] CLAUDE.md",
].join("\n");

describe("ChatMessage — GFM in assistant prose", () => {
  it("renders a GFM table as a real table, not a flattened paragraph", () => {
    const { container } = render(
      <ChatMessage message={{ role: "assistant", content: TABLE, model: "m" }} />,
    );
    const table = container.querySelector("table");
    expect(table).not.toBeNull();
    expect(container.querySelectorAll("th")).toHaveLength(2);
    expect(container.querySelectorAll("td")).toHaveLength(4);
    expect(screen.getByText("136")).toBeInTheDocument();
    // Never the raw pipe row.
    expect(container.textContent).not.toContain("|---------|");
  });

  it("renders strikethrough and task-list checkboxes", () => {
    const { container } = render(
      <ChatMessage message={{ role: "assistant", content: TABLE, model: "m" }} />,
    );
    expect(container.querySelector("del")?.textContent).toBe("Tardó 25 s");
    const boxes = container.querySelectorAll('input[type="checkbox"]');
    expect(boxes).toHaveLength(2);
    expect((boxes[0] as HTMLInputElement).checked).toBe(true);
    expect((boxes[1] as HTMLInputElement).checked).toBe(false);
  });

  it("still splits the lead sentence into the serif key phrase", () => {
    render(<ChatMessage message={{ role: "assistant", content: "Perfecto! Aquí va el resto.", model: "m" }} />);
    expect(screen.getByText("Perfecto!")).toBeInTheDocument();
    expect(screen.getByText("Aquí va el resto.")).toBeInTheDocument();
  });

  it("keeps a reply that opens with a URL whole, as one linked body", () => {
    const { container } = render(
      <ChatMessage
        message={{ role: "assistant", content: "The PR is open: https://github.com/acme/api/pull/12", model: "m" }}
      />,
    );
    // No serif lead cut at "github." …
    expect(container.querySelector(".animate-keyfade-key")).toBeNull();
    // …and the body links the whole address.
    const link = container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://github.com/acme/api/pull/12");
    expect(container.textContent).toContain("The PR is open: https://github.com/acme/api/pull/12");
  });

  it("renders inline code in the serif lead as code, not backticks", () => {
    const { container } = render(
      <ChatMessage message={{ role: "assistant", content: "Bumped `app` to v0.4.141. Tests pass.", model: "m" }} />,
    );
    const lead = container.querySelector(".animate-keyfade-key");
    expect(lead?.textContent).toBe("Bumped app to v0.4.141.");
    expect(lead?.querySelector("code")?.textContent).toBe("app");
    expect(lead?.querySelector("a")).toBeNull();
  });
});

const USER_TURN = [
  "Necesito entender esta parte del código antes de tocarla.",
  "",
  "1. ¿Qué esfuerzo se necesita?",
  "2. Un usuario reporta este error:",
  "   Digest: sha256:e716fb9dd11edf39b91dc9666a8fdc406b529d570457b5657ec0c93d6a0f33ab",
  "- viñeta uno",
  "- viñeta dos",
  "# not a heading, just what I typed",
].join("\n");

describe("ChatMessage — user turn is shown as written", () => {
  it("keeps the line breaks, indentation and typed bullets", () => {
    const { container } = render(<ChatMessage message={{ role: "user", content: USER_TURN }} />);
    const turn = container.querySelector('[data-role="user"]');
    expect(turn).not.toBeNull();
    // The text node still carries every newline and the leading indent…
    expect(turn!.textContent).toContain("1. ¿Qué esfuerzo se necesita?\n2. Un usuario reporta este error:\n   Digest:");
    expect(turn!.textContent).toContain("- viñeta uno\n- viñeta dos");
    // …and the content node asks the browser to honour them (the collapse
    // happened in CSS, so this is the property the regression lives in).
    const body = turn!.querySelector(".whitespace-pre-wrap");
    expect(body).not.toBeNull();
    expect(body!.textContent).toBe(USER_TURN);
  });

  it("never re-parses the user's text as Markdown", () => {
    const { container } = render(<ChatMessage message={{ role: "user", content: USER_TURN }} />);
    expect(container.querySelector("ol, ul, li, h1, h2, h3, p, code")).toBeNull();
    expect(container.textContent).toContain("# not a heading, just what I typed");
  });
});

describe("usageFooter — the honest turn figure", () => {
  it("reads the last prompt size, the cached share, the answer tokens and the cost", () => {
    expect(
      usageFooter({ role: "assistant", content: "x", inputTokens: 3_100, outputTokens: 2_100, cacheReadTokens: 200_000, cacheCreationTokens: 8_000, contextTokens: 211_000, costUsd: 0.42 }),
    ).toBe("211.0k in · 95% cached · 2.1k out · $0.42");
  });

  it("falls back to the uncached input for rows recorded before the cache split existed", () => {
    expect(usageFooter({ role: "assistant", content: "x", inputTokens: 106, outputTokens: 900 })).toBe("106 in · 900 out");
  });

  it("keeps a cheap turn visible at three decimals and omits a free one", () => {
    expect(usageFooter({ role: "assistant", content: "x", inputTokens: 10, outputTokens: 5, costUsd: 0.004 })).toBe("10 in · 5 out · $0.004");
    expect(usageFooter({ role: "assistant", content: "x", inputTokens: 10, outputTokens: 5, costUsd: 0 })).toBe("10 in · 5 out");
  });

  it("groups thousands in a large turn cost", () => {
    expect(usageFooter({ role: "assistant", content: "x", outputTokens: 5, costUsd: 1500 })).toBe("5 out · $1,500.00");
  });
});

describe("user message — skills invoked with it", () => {
  it("renders a known /skill token as a brass chip and leaves the rest as text", () => {
    render(
      <ChatMessage
        message={{ role: "user", content: "run /release and src/release now" }}
        skillNames={["release"]}
      />,
    );
    const chips = screen.getAllByTestId("skill-chip");
    expect(chips).toHaveLength(1);
    expect(chips[0]).toHaveTextContent("/release");
    expect(chips[0]).toHaveAttribute("title", "Skill invoked with this message: release");
  });

  it("renders several chips in order and keeps a sentence-ending period out of the chip", () => {
    render(
      <ChatMessage
        message={{ role: "user", content: "/code-review this, then /release." }}
        skillNames={["code-review", "release"]}
      />,
    );
    const chips = screen.getAllByTestId("skill-chip");
    expect(chips.map((c) => c.textContent)).toEqual(["/code-review", "/release"]);
  });

  it("paints no chip inside a fenced block — pasted file content is not an invocation", () => {
    render(
      <ChatMessage
        message={{ role: "user", content: "summarise\n\nCHANGELOG.md\n```\nrun /release first\n```" }}
        skillNames={["release"]}
      />,
    );
    expect(screen.queryByTestId("skill-chip")).toBeNull();
  });

  it("renders plain text when no skill names are known", () => {
    render(<ChatMessage message={{ role: "user", content: "run /release" }} />);
    expect(screen.queryByTestId("skill-chip")).toBeNull();
    expect(screen.getByText("run /release")).toBeInTheDocument();
  });
});

describe("turns read apart at a glance", () => {
  const SENT = "2026-11-24T14:02:00Z";

  it("sets a user turn on the panel surface, with the brass eyebrow and the time it was sent", () => {
    render(<ChatMessage message={{ role: "user", content: "Should it fail open?", createdAt: SENT }} />);
    const time = turnTime(SENT);
    const turn = screen.getByRole("article", { name: `You, ${time}` });
    expect(turn).toHaveAttribute("data-role", "user");
    expect(turn.className).toContain("bg-octo-panel");
    expect(turn.className).toContain("border-octo-hairline");
    expect(within(turn).getByText("— You").className).toContain("text-octo-brass");
    const stamp = turn.querySelector("time")!;
    expect(stamp).toHaveAttribute("dateTime", SENT);
    expect(stamp.textContent).toBe(time);
  });

  it("puts a user turn's actions in its header, between the eyebrow and the time", () => {
    render(
      <ChatMessage
        message={{ role: "user", content: "Do it", createdAt: SENT }}
        actions={<button type="button">Fork from here</button>}
      />,
    );
    const turn = screen.getByRole("article", { name: /^You/ });
    const header = within(turn).getByText("— You").parentElement!;
    const order = Array.from(header.children).map((el) => el.tagName.toLowerCase());
    expect(order).toEqual(["span", "div", "time"]);
    expect(within(header).getByRole("button", { name: "Fork from here" })).toBeInTheDocument();
    // The actions come before the text in the DOM, so focus reaches them
    // right after the ask's own label.
    const body = turn.querySelector(".whitespace-pre-wrap")!;
    expect(header.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("names a turn without a date just 'You'", () => {
    render(<ChatMessage message={{ role: "user", content: "hi" }} />);
    expect(screen.getByRole("article", { name: "You" }).querySelector("time")).toBeNull();
  });

  it("keeps the model's eyebrow mute: brass belongs to the director's turn", () => {
    render(<ChatMessage message={{ role: "assistant", content: "Done. All green.", model: "claude-opus-4-7" }} />);
    const answer = screen.getByRole("article", { name: "Opus 4.7" });
    const eyebrow = within(answer).getByText("— Opus 4.7");
    expect(eyebrow.className).toContain("text-octo-mute");
    expect(eyebrow.className).not.toContain("text-octo-brass");
  });
});

describe("turnTime", () => {
  const now = new Date(2026, 10, 24, 18, 0);

  it("is the clock time on the same day", () => {
    const iso = new Date(2026, 10, 24, 14, 2).toISOString();
    expect(turnTime(iso, now)).toBe(new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }));
  });

  it("puts the date in front on any other day", () => {
    const iso = new Date(2026, 10, 23, 9, 30).toISOString();
    const d = new Date(iso);
    expect(turnTime(iso, now)).toBe(
      `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`,
    );
  });

  it("adds the year for an earlier year", () => {
    const iso = new Date(2025, 11, 30, 9, 30).toISOString();
    const d = new Date(iso);
    expect(turnTime(iso, now)).toBe(
      `${d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}, ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`,
    );
    expect(turnTime(iso, now)).toContain("2025");
  });

  it("is empty for a missing or unreadable date", () => {
    expect(turnTime(null)).toBe("");
    expect(turnTime("not a date")).toBe("");
  });
});
