// @vitest-environment jsdom
/**
 * The work block: a turn's narration and tool calls on one hairline, each call
 * a quiet ledger row, a round of more than five calls folded into one summary
 * row that opens in place.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

vi.mock("../../lib/ipc", () => ({ ipc: { revealInFinder: vi.fn(), openFileInSystem: vi.fn() } }));

const { WorkBlock, roundSummary } = await import("./WorkBlock");
import type { WorkEntry } from "../../lib/talkWork";
import type { ToolExecution } from "../../stores/chatStore";

const t = (toolName: string, toolInput: Record<string, unknown>): ToolExecution => ({ toolName, toolInput, result: "ok" });
const round = (id: number, tools: ToolExecution[]): WorkEntry => ({
  kind: "round",
  id,
  tools: tools.map((tool, i) => ({ id: id + i, tool })),
});

describe("roundSummary", () => {
  it("joins calls of the same kind in a row and shortens file paths to their names", () => {
    expect(
      roundSummary([
        t("grep", { pattern: "RateLimiter" }),
        t("read_file", { path: "src/middleware/rateLimit.ts" }),
        t("read_file", { path: "src/lib/redis.ts" }),
        t("run_command", { command: "npm test" }),
        t("read_file", { path: "README.md" }),
      ]),
    ).toEqual([
      { verb: "grep", objects: ["RateLimiter"] },
      { verb: "read", objects: ["rateLimit.ts", "redis.ts"] },
      { verb: "run", objects: ["npm test"] },
      { verb: "read", objects: ["README.md"] },
    ]);
  });
});

describe("WorkBlock", () => {
  it("is one article whose narration and calls hang on a single hairline", () => {
    const { container } = render(
      <WorkBlock
        calls={2}
        entries={[
          { kind: "narration", id: 1, text: "Let me find where the limiter talks to Redis." },
          round(2, [t("grep", { pattern: "RateLimiter" }), t("read_file", { path: "src/lib/redis.ts" })]),
        ]}
      />,
    );
    const work = screen.getByRole("article", { name: "Work, 2 tool calls" });
    expect(work.className).toContain("border-l");
    expect(work.className).toContain("border-octo-hairline");
    // The narration drops its own rule: the block's hairline is the one rule.
    const narration = container.querySelector('[data-role="narration"]')!;
    expect(narration.className).not.toContain("border-l");
    const group = within(work).getByRole("group", { name: "2 tool calls" });
    expect(within(group).getByText("GREP")).toBeInTheDocument();
    expect(within(group).getByText("src/lib/redis.ts")).toBeInTheDocument();
  });

  it("renders each call as a quiet ledger row: no border, no fill, no brass", () => {
    const { container } = render(<WorkBlock calls={1} entries={[round(1, [t("read_file", { path: "a.ts" })])]} />);
    const row = container.querySelector('[data-role="tool"]') as HTMLElement;
    expect(row.style.border).toBe("");
    expect(row.style.background).toBe("");
    const header = within(row).getByRole("button", { name: "READ a.ts" });
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(row.outerHTML).not.toContain("--color-octo-brass");
    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(within(row).getByText("ok")).toBeInTheDocument();
  });

  it("shows a round of five calls in full", () => {
    const tools = Array.from({ length: 5 }, (_, i) => t("read_file", { path: `f${i}.ts` }));
    render(<WorkBlock calls={5} entries={[round(1, tools)]} />);
    expect(screen.queryByRole("button", { expanded: false, name: /Show the/ })).toBeNull();
    expect(screen.getAllByText("READ")).toHaveLength(5);
  });

  it("folds a round of more than five calls into one summary row that opens in place", () => {
    const tools = [
      t("grep", { pattern: "RateLimiter" }),
      ...Array.from({ length: 4 }, (_, i) => t("read_file", { path: `src/f${i}.ts` })),
      t("run_command", { command: "npm test" }),
    ];
    const { container } = render(<WorkBlock calls={6} entries={[round(1, tools)]} />);
    const group = screen.getByRole("group", { name: "6 tool calls" });
    const fold = within(group).getByRole("button", { name: /6 tool calls/ });
    expect(fold).toHaveAttribute("aria-expanded", "false");
    expect(fold).toHaveAttribute("data-tour", "talk-work-fold");
    expect(fold.textContent).toContain("f0.ts, f1.ts, f2.ts, f3.ts");
    expect(fold.textContent).toContain("npm test");
    // The rows stay mounted but inert and hidden while folded.
    const reveal = container.querySelector("div.grid[aria-hidden]")!;
    expect(reveal).toHaveAttribute("aria-hidden", "true");
    expect(reveal.querySelectorAll('[data-role="tool"]')).toHaveLength(6);
    fireEvent.click(fold);
    expect(fold).toHaveAttribute("aria-expanded", "true");
    expect(reveal).toHaveAttribute("aria-hidden", "false");
  });
});
