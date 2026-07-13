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
