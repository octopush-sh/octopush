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

  it("folds a loaded skill to its name", () => {
    expect(roundSummary([t("Skill", { name: "code-review" }), t("read_file", { path: "a.ts" })])).toEqual([
      { verb: "skill", objects: ["code-review"] },
      { verb: "read", objects: ["a.ts"] },
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

  it("shows a skill the model loaded as a ledger row that names it", () => {
    const { container } = render(<WorkBlock calls={1} entries={[round(1, [t("Skill", { name: "code-review" })])]} />);
    const row = container.querySelector('[data-role="tool"]') as HTMLElement;
    expect(within(row).getByRole("button", { name: "SKILL used skill code-review" })).toBeInTheDocument();
    expect(within(row).getByText("used skill code-review")).toBeInTheDocument();
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

describe("a resolved row's verdict", () => {
  const failed: ToolExecution = {
    toolName: "run_command",
    toolInput: { command: "cargo test" },
    result: "test sync::gate ... FAILED\n(exit code 101)",
    ok: false,
    outcome: "failed",
    exitCode: 101,
  };
  const denied: ToolExecution = {
    toolName: "run_command",
    toolInput: { command: "git push --force" },
    result: "Command not run — the user declined to approve it (flagged: force push). Ask the user how to proceed.",
    ok: false,
    outcome: "denied",
  };
  const passed: ToolExecution = { ...t("run_command", { command: "npm test" }), ok: true, outcome: "ok", exitCode: 0 };

  const rowOf = (container: HTMLElement, i: number) => container.querySelectorAll<HTMLElement>('[data-role="tool"]')[i];

  it("a failure gets a rouge dot on the hairline and its exit code, titled in words", () => {
    const { container } = render(<WorkBlock calls={1} entries={[round(1, [failed])]} />);
    const row = rowOf(container, 0);
    expect(row).toHaveAttribute("data-outcome", "failed");
    const dot = within(row).getByTestId("tool-verdict-dot");
    expect(dot.style.background).toBe("var(--color-octo-rouge)");
    expect(dot).toHaveAttribute("aria-hidden");
    const meta = within(row).getByText("exit 101");
    expect(meta).toHaveAttribute("title", "Exited with code 101");
    expect(meta).toHaveAttribute("data-tour", "talk-tool-verdict");
    expect(meta.style.color).toBe("var(--color-octo-rouge)");
    // Said to assistive tech too, on the row's toggle.
    expect(within(row).getByRole("button", { name: "RUN cargo test, Exited with code 101" })).toBeInTheDocument();
  });

  it("a denial gets a mute mark and says it was denied", () => {
    const { container } = render(<WorkBlock calls={1} entries={[round(1, [denied])]} />);
    const row = rowOf(container, 0);
    expect(row).toHaveAttribute("data-outcome", "denied");
    expect(within(row).getByTestId("tool-verdict-dot").style.background).toBe("var(--color-octo-mute)");
    const meta = within(row).getByText("denied");
    expect(meta.style.color).toBe("var(--color-octo-mute)");
    expect(meta).toHaveAttribute("title", "Denied, not run: the user declined to approve it (flagged: force push)");
    expect(row.outerHTML).not.toContain("--color-octo-rouge");
  });

  it("a pass carries nothing extra", () => {
    const { container } = render(<WorkBlock calls={1} entries={[round(1, [passed])]} />);
    const row = rowOf(container, 0);
    expect(row).toHaveAttribute("data-outcome", "ok");
    expect(within(row).queryByTestId("tool-verdict-dot")).toBeNull();
    expect(row.querySelector('[data-tour="talk-tool-verdict"]')).toBeNull();
    expect(within(row).getByRole("button", { name: "RUN npm test" })).toBeInTheDocument();
  });

  it("an older row with no verdict reads it from its exit line", () => {
    const legacy: ToolExecution = { toolName: "run_command", toolInput: { command: "make" }, result: "boom\n(exit code 2)" };
    const { container } = render(<WorkBlock calls={1} entries={[round(1, [legacy])]} />);
    expect(rowOf(container, 0)).toHaveAttribute("data-outcome", "failed");
    expect(within(rowOf(container, 0)).getByText("exit 2")).toBeInTheDocument();
  });

  it("the gutter the dot sits in is never clipped by the round's Reveal", () => {
    const { container } = render(<WorkBlock calls={1} entries={[round(1, [failed])]} />);
    const reveal = container.querySelector("div.grid[aria-hidden]")!;
    // The Reveal reaches 16px into the gutter; the dot's left edge is 15.5px out.
    expect(reveal.className).toContain("-ml-4");
    expect(reveal.querySelector(".pl-4")).not.toBeNull();
  });

  it("a folded round counts its failures in rouge, and its denials", () => {
    const reads = Array.from({ length: 4 }, (_, i) => ({ ...t("read_file", { path: `src/f${i}.ts` }), ok: true, outcome: "ok" as const }));
    render(<WorkBlock calls={6} entries={[round(1, [...reads, failed, denied])]} />);
    const fold = screen.getByRole("button", { name: /6 tool calls/ });
    expect(within(fold).getByTestId("round-failed").textContent).toBe(" · 1 failed");
    expect(within(fold).getByTestId("round-failed").className).toContain("text-octo-rouge");
    expect(within(fold).getByTestId("round-denied").textContent).toBe(" · 1 denied");
    expect(within(fold).getByTestId("round-denied").className).not.toContain("rouge");
    expect(fold.getAttribute("title")).toMatch(/^Show the 6 tool calls \(1 failed, 1 denied\): /);
  });

  it("a folded round of passes says nothing extra", () => {
    const reads = Array.from({ length: 6 }, (_, i) => t("read_file", { path: `src/f${i}.ts` }));
    render(<WorkBlock calls={6} entries={[round(1, reads)]} />);
    const fold = screen.getByRole("button", { name: /6 tool calls/ });
    expect(within(fold).queryByTestId("round-failed")).toBeNull();
    expect(within(fold).queryByTestId("round-denied")).toBeNull();
    expect(fold.getAttribute("title")).toMatch(/^Show the 6 tool calls: /);
  });
});
