/**
 * Assistant prose rendering: GitHub-flavored Markdown must be ON — models
 * write tables, task lists and strikethrough routinely, and without GFM a
 * table collapses into one run-on paragraph (the bug this guards).
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
