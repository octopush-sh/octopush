import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("../hooks/useMissionLogbook", () => ({
  useMissionLogbook: () => ({
    missionId: "m1",
    loaded: true,
    row: { missionId: "m1", hoursSecs: 3600, costUsd: 0.41, savingsUsd: 0.2, runsCount: 1, messagesCount: 2 },
  }),
}));

const { LogbookCard } = await import("./LogbookCard");

describe("LogbookCard", () => {
  it("sets the mission's spend in ivory, not brass, beside verdigris savings", () => {
    render(<LogbookCard workspaceId="w1" />);
    const spend = screen.getByTitle("Spend on this mission");
    expect(spend.textContent).toBe("$0.41");
    expect(spend).toHaveClass("octo-tabular", "text-octo-ivory");
    expect(spend.className).not.toContain("brass");
    expect(screen.getByTitle("Saved vs an all-premium baseline")).toHaveClass("text-octo-verdigris");
  });
});
