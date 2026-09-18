/**
 * JournalItems: the one journal renderer. Under test — flat lines, tool ↔
 * result pairing, and the Claude Code sub-agent hierarchy (entries tagged
 * with `parent` indent under their spawner; a spawner's own result is not
 * mistaken for its first child's).
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import type { LiveEntry } from "../../lib/ipc";
import { buildJournalItems } from "./JournalItems";

function renderItems(entries: LiveEntry[]) {
  return render(<div>{buildJournalItems(entries)}</div>).container;
}

describe("JournalItems", () => {
  it("pairs a tool with the result that follows it at the same level", () => {
    const c = renderItems([
      { kind: "tool", tool: "Read", hint: "a.rs" },
      { kind: "tool_result", ok: true, detail: "12 lines" },
    ]);
    expect(c.children[0].children).toHaveLength(1);
    expect(c.textContent).toContain("Read");
    expect(c.textContent).toContain("12 lines");
  });

  it("indents a sub-agent's entries under the Agent line and keeps the spawner's result separate", () => {
    const c = renderItems([
      { kind: "tool", tool: "Agent", hint: "Check the tests", agentId: "toolu_1" },
      { kind: "text", text: "running", parent: "toolu_1" },
      { kind: "tool", tool: "Bash", hint: "npm test", parent: "toolu_1" },
      { kind: "tool_result", ok: true, detail: "12 passed", parent: "toolu_1" },
      { kind: "tool_result", ok: true, detail: "Sub-agent report", parent: undefined },
    ]);
    const rows = Array.from(c.children[0].children);
    // Agent line (unpaired — its result comes after the children), text, Bash+result, spawner's result.
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveAttribute("data-agent-id", "toolu_1");
    expect(rows[0].className).not.toContain("border-l");
    expect(rows[1]).toHaveAttribute("data-parent", "toolu_1");
    expect(rows[1].className).toContain("border-l");
    expect(rows[2]).toHaveAttribute("data-parent", "toolu_1");
    expect(rows[2].textContent).toContain("12 passed");
    expect(rows[3].className).not.toContain("border-l");
    expect(rows[3].textContent).toContain("Sub-agent report");
  });
});
