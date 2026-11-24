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
    const { container } = render(<WorkBlock calls={5} entries={[round(1, tools)]} />);
    // No summary row (its accessible name starts with the count)…
    expect(screen.queryByRole("button", { name: /5 tool calls/ })).toBeNull();
    // …and the rows are shown, not folded away under a closed Reveal.
    expect(container.querySelector("div.grid[aria-hidden]")).toHaveAttribute("aria-hidden", "false");
    expect(container.querySelectorAll('[data-role="tool"]')).toHaveLength(5);
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

describe("WorkBlock — a round that grows or folds keeps its rows", () => {
  const reads = (n: number) => Array.from({ length: n }, (_, i) => t("read_file", { path: `src/f${i}.ts` }));
  const block = (n: number, live: boolean) => (
    <WorkBlock calls={n} live={live} entries={[round(1, reads(n))]} />
  );

  it("never folds while the turn streams: 5 → 6 calls keeps every row, its state and focus", () => {
    const { container, rerender } = render(block(5, true));
    const first = container.querySelector('[data-role="tool"]')!;
    const header = within(first as HTMLElement).getByRole("button", { name: "READ src/f0.ts" });
    fireEvent.click(header);
    header.focus();
    expect(header).toHaveAttribute("aria-expanded", "true");

    rerender(block(6, true));

    // Same node, still open, still focused, and no fold yet.
    expect(container.querySelector('[data-role="tool"]')).toBe(first);
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(document.activeElement).toBe(header);
    expect(screen.queryByRole("button", { name: /6 tool calls/ })).toBeNull();
    expect(container.querySelectorAll('[data-role="tool"]')).toHaveLength(6);
    expect(container.querySelector("div.grid[aria-hidden]")).toHaveAttribute("aria-hidden", "false");
  });

  it("folds when the turn ends, without remounting the rows", () => {
    const { container, rerender } = render(block(6, true));
    const first = container.querySelector('[data-role="tool"]');
    rerender(block(6, false));
    expect(container.querySelector('[data-role="tool"]')).toBe(first);
    const fold = screen.getByRole("button", { name: /6 tool calls/ });
    expect(fold).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector("div.grid[aria-hidden]")).toHaveAttribute("aria-hidden", "true");
  });

  it("stays open when the turn ends while the reader is in the round", () => {
    const { container, rerender } = render(block(6, true));
    const header = screen.getByRole("button", { name: "READ src/f3.ts" });
    header.focus();
    rerender(block(6, false));
    expect(document.activeElement).toBe(header);
    expect(screen.getByRole("button", { name: /6 tool calls/ })).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector("div.grid[aria-hidden]")).toHaveAttribute("aria-hidden", "false");
  });
});

describe("ledger row actions", () => {
  it("are titled icons in their own slot before the chevron, which is always the last column", () => {
    const onRun = vi.fn();
    const { container } = render(
      <WorkBlock
        calls={2}
        onRunInTerminal={onRun}
        entries={[round(1, [t("run_command", { command: "npm test" }), t("read_file", { path: "a.ts" })])]}
      />,
    );
    const [runRow, readRow] = Array.from(container.querySelectorAll('[data-role="tool"] .octo-ledger'));
    const send = within(runRow as HTMLElement).getByRole("button", { name: "Send to terminal" });
    expect(send.textContent).toBe("");
    expect(send).toHaveAttribute("title");
    // Shown on row hover/focus (CSS), and always in the actions slot.
    expect(send.closest(".octo-ledger-actions")).not.toBeNull();
    // Both rows end with the chevron.
    expect(runRow.lastElementChild!.getAttribute("aria-hidden")).toBe("true");
    expect(readRow.lastElementChild!.getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(send);
    expect(onRun).toHaveBeenCalledWith("npm test");
  });
});
