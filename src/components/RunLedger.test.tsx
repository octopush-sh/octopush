import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { RunLedger } from "./RunLedger";
import type { Run, RunStage } from "../lib/ipc";

const baseRun = {
  id: "r1", status: "running", costUsd: 0.014, baselineUsd: 0.1,
} as unknown as Run;
const stages = [
  { id: "s1", role: "plan", costUsd: 0.01 },
  { id: "s2", role: "implement", costUsd: 0 },
] as unknown as RunStage[];

describe("RunLedger", () => {
  it("leads with savings and renders spent with tabular numerals", () => {
    render(<RunLedger run={baseRun} stages={stages} />);
    const strip = screen.getByRole("button", { name: /saved/i });
    expect(within(strip).getByText("$0.09")).toBeInTheDocument();   // saved
    expect(within(strip).getByText(/86% under all-premium/)).toBeInTheDocument();
    const spent = within(strip).getByText("$0.01");                  // spent
    expect(spent.className).toContain("octo-tabular");
    expect(within(strip).getByText("$0.09").className).toContain("octo-tabular");
  });

  it("groups thousands in large figures", () => {
    const big = { ...baseRun, costUsd: 12843.27, baselineUsd: 98236.72, budgetUsd: 20000 } as Run;
    render(<RunLedger run={big} stages={stages} />);
    const strip = screen.getByRole("button", { name: /saved/i });
    expect(within(strip).getByText("$85,393.45")).toBeInTheDocument();
    expect(within(strip).getByText("$12,843.27")).toBeInTheDocument();
    expect(within(strip).getByText(/budget \$20,000\.00/)).toBeInTheDocument();
  });

  it("shows 'baseline unavailable' instead of hiding the slot", () => {
    render(<RunLedger run={{ ...baseRun, baselineUsd: 0 } as Run} stages={stages} />);
    expect(screen.getByText("baseline unavailable")).toBeInTheDocument();
  });

  it("toggles the per-stage breakdown", () => {
    render(<RunLedger run={baseRun} stages={stages} />);
    const strip = screen.getByRole("button", { name: /saved/i });
    expect(strip).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(strip);
    expect(strip).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Plan")).toBeInTheDocument(); // only stages with cost > 0
    expect(screen.queryByText("Implement")).not.toBeInTheDocument();
  });

  it("renders the budget fragment in mute tabular numerals when under budget", () => {
    render(<RunLedger run={{ ...baseRun, budgetUsd: 0.05, detached: false } as Run} stages={stages} />);
    const frag = screen.getByText(/budget \$0\.05/);
    expect(frag.className).toContain("octo-tabular");
    expect(frag.className).toContain("text-octo-mute");
  });

  it("turns the budget fragment rouge when spend reaches the budget", () => {
    render(
      <RunLedger run={{ ...baseRun, costUsd: 0.05, budgetUsd: 0.05, detached: false } as Run} stages={stages} />,
    );
    expect(screen.getByText(/budget \$0\.05/).className).toContain("text-octo-rouge");
  });

  it("shows unpriced stages as unpriced and says the budget cannot see them", () => {
    const withUnpriced = [
      ...stages,
      { id: "s3", role: "review", agentModel: "claude-mythos-1", costUsd: 0, inputTokens: 5000, outputTokens: 400, unpricedModel: true },
    ] as unknown as RunStage[];
    render(<RunLedger run={{ ...baseRun, budgetUsd: 0.05, detached: false } as Run} stages={withUnpriced} />);
    const note = screen.getByTestId("ledger-budget-unenforceable");
    expect(note.textContent).toBe("· budget not enforceable: 1 stage unpriced");
    expect(note.getAttribute("title")).toContain("claude-mythos-1");
    fireEvent.click(screen.getByRole("button", { name: /saved/i }));
    const cell = screen.getByText("unpriced");
    expect(cell.getAttribute("title")).toContain("claude-mythos-1");
    expect(cell.parentElement!.textContent).not.toContain("$0.00");
  });

  it("shows a Codex stage stopped before reporting usage as 'usage not reported', never $0.00", () => {
    const withUnreported = [
      ...stages,
      { id: "s3", role: "implement", agentModel: "gpt-5", costUsd: 0, inputTokens: 0, outputTokens: 0, usageUnreported: true },
    ] as unknown as RunStage[];
    render(<RunLedger run={{ ...baseRun, budgetUsd: 0.05, detached: false } as Run} stages={withUnreported} />);
    const note = screen.getByTestId("ledger-budget-unenforceable");
    expect(note.textContent).toBe("· budget not enforceable: 1 stage unpriced");
    expect(note.getAttribute("title")).toContain("Codex stopped before reporting usage");
    expect(note.getAttribute("title")).not.toContain("No price for");
    fireEvent.click(screen.getByRole("button", { name: /saved/i }));
    const cell = screen.getByText("usage not reported");
    expect(cell.className).toContain("text-octo-mute");
    expect(cell.getAttribute("title")).toContain("cost is unknown");
    expect(cell.parentElement!.textContent).toBe("Implement usage not reported");
  });

  it("counts unpriced and unreported stages together in the budget note", () => {
    const mixed = [
      { id: "s3", role: "review", agentModel: "claude-mythos-1", costUsd: 0, inputTokens: 5000, outputTokens: 400, unpricedModel: true },
      { id: "s4", role: "implement", agentModel: "gpt-5", costUsd: 0.2, inputTokens: 900, outputTokens: 80, usageUnreported: true },
    ] as unknown as RunStage[];
    render(<RunLedger run={{ ...baseRun, budgetUsd: 0.05, detached: false } as Run} stages={mixed} />);
    const note = screen.getByTestId("ledger-budget-unenforceable");
    expect(note.textContent).toBe("· budget not enforceable: 2 stages unpriced");
    expect(note.getAttribute("title")).toContain("claude-mythos-1");
    expect(note.getAttribute("title")).toContain("Codex stopped before reporting usage");
    fireEvent.click(screen.getByRole("button", { name: /saved/i }));
    // A later attempt that reported keeps its figure and says part is unknown.
    expect(screen.getByText("$0.20").parentElement!.textContent).toContain("$0.20 + usage not reported");
  });

  it("leaves reported stages unchanged", () => {
    render(<RunLedger run={{ ...baseRun, budgetUsd: 0.05, detached: false } as Run} stages={stages} />);
    expect(screen.queryByTestId("ledger-budget-unenforceable")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /saved/i }));
    expect(screen.queryByText(/usage not reported/)).not.toBeInTheDocument();
  });

  it("omits the budget fragment when the run has no budget", () => {
    render(<RunLedger run={{ ...baseRun, budgetUsd: null, detached: false } as Run} stages={stages} />);
    expect(screen.queryByText(/budget/)).not.toBeInTheDocument();
  });

  it("reveals the completion moment when the run transitions to completed", () => {
    const { rerender } = render(<RunLedger run={baseRun} stages={stages} />);
    const moment = screen.getByText(/This run saved/);
    expect(moment.closest("[aria-hidden]")).toHaveAttribute("aria-hidden", "true");
    rerender(<RunLedger run={{ ...baseRun, status: "completed" } as Run} stages={stages} />);
    expect(moment.closest("[aria-hidden]")).toHaveAttribute("aria-hidden", "false");
  });
});
