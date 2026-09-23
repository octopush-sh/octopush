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
import { render, screen } from "@testing-library/react";
import { ChatMessage, usageFooter } from "./ChatMessage";

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
