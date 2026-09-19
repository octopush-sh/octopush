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
import { ChatMessage } from "./ChatMessage";

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
