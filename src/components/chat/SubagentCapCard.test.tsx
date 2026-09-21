/**
 * The turn-limit card: a writing sub-agent stopped mid-work and the director
 * is waiting — grant more turns (with a chosen budget) or accept the partial
 * report.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SubagentCapCard, grantLabel, DEFAULT_CAP_TURNS } from "./SubagentCapCard";

const cap = {
  callId: "c1",
  threadId: "t1",
  description: "Implement the ledger migration",
  subagentType: "implementer",
  turnsUsed: 25,
};

describe("SubagentCapCard", () => {
  it("phrases the grant by turn count", () => {
    expect(grantLabel(25)).toBe("Give it 25 more turns");
    expect(grantLabel(1)).toBe("Give it 1 more turn");
  });

  it("names the sub-agent, its turns, and that the director waits", () => {
    render(<SubagentCapCard cap={cap} onRespond={vi.fn()} />);
    expect(screen.getByText("Turn limit reached")).toBeInTheDocument();
    expect(screen.getByText("Implement the ledger migration")).toBeInTheDocument();
    expect(screen.getByText(/used its 25 turns and stopped mid-work/)).toBeInTheDocument();
    expect(screen.getByText("the director is waiting")).toBeInTheDocument();
  });

  it("grants the chosen budget, or accepts the partial report", () => {
    const onRespond = vi.fn();
    render(<SubagentCapCard cap={cap} onRespond={onRespond} />);
    fireEvent.click(screen.getByRole("button", { name: grantLabel(DEFAULT_CAP_TURNS) }));
    expect(onRespond).toHaveBeenLastCalledWith(DEFAULT_CAP_TURNS);
    fireEvent.change(screen.getByLabelText("More turns to give"), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: "Give it 50 more turns" }));
    expect(onRespond).toHaveBeenLastCalledWith(50);
    fireEvent.click(screen.getByRole("button", { name: "Accept what it has" }));
    expect(onRespond).toHaveBeenLastCalledWith(null);
  });
});
