import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { LogbookRoom, optionLabelFits } from "./LogbookRoom";
import type { ProjectInfo } from "../lib/types";
import { useEntitlementStore } from "../stores/entitlementStore";

vi.mock("../lib/ipc", () => ({
  ipc: { logbookSummary: vi.fn() },
}));

import { ipc } from "../lib/ipc";
const logbookSummaryMock = vi.mocked(ipc.logbookSummary);

function setPlan(features: string[]) {
  useEntitlementStore.setState({
    entitlement: {
      plan: features.length ? "pro" : "free",
      features,
      directRunsPerMonth: null,
    },
    loaded: true,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  logbookSummaryMock.mockResolvedValue([]);
});

describe("LogbookRoom", () => {
  it("shows the upsell and never fetches for a free user (the Pro boundary)", () => {
    setPlan([]);
    render(<LogbookRoom open onClose={vi.fn()} project={null} />);
    expect(screen.getByText("Open the full logbook with Pro")).toBeInTheDocument();
    expect(logbookSummaryMock).not.toHaveBeenCalled();
  });

  it("draws the upsell CTA as a ceremonial brass-ghost phrase, not a solid-brass button", () => {
    setPlan([]);
    render(<LogbookRoom open onClose={vi.fn()} project={null} />);
    const cta = screen.getByRole("button", { name: "Open the full logbook with Pro" });
    expect(cta.className).toContain("bg-[var(--brass-ghost)]");
    expect(cta.className).toContain("border-[var(--brass-dim)]");
    expect(cta.className).toContain("font-serif");
    expect(cta.className).not.toMatch(/(^|\s)bg-octo-brass(\s|$)/);
    expect(screen.queryByText("Upgrade to Pro")).not.toBeInTheDocument();
  });

  it("fetches the global scope for a Pro user", async () => {
    setPlan(["logbook.reports"]);
    render(<LogbookRoom open onClose={vi.fn()} project={null} />);
    await waitFor(() => expect(logbookSummaryMock).toHaveBeenCalled());
    const [scope, scopeId] = logbookSummaryMock.mock.calls[0];
    expect(scope).toBe("global");
    expect(scopeId).toBeNull();
    // No upsell for an entitled user.
    expect(screen.queryByText("Open the full logbook with Pro")).not.toBeInTheDocument();
  });

  it("middle-truncates a long project name in the scope switch (E1)", () => {
    setPlan(["logbook.reports"]);
    const name = "octopush-enterprise-monorepo";
    render(
      <LogbookRoom open onClose={vi.fn()} project={{ id: "p1", name } as ProjectInfo} />,
    );
    const option = screen.getByTitle(name);
    expect(option).toHaveClass("flex", "w-[160px]", "min-w-0");
    expect(option).not.toHaveClass("truncate");
    expect(option.querySelector(".octo-midtrunc-tail")).toHaveTextContent("e-monorepo");
    // Short labels keep the plain line.
    expect(screen.getByRole("button", { name: "All missions" })).toHaveClass("truncate");
  });

  it("marks the active scope and period with a brass-ghost fill and ivory ink, not brass text", () => {
    setPlan(["logbook.reports"]);
    render(
      <LogbookRoom open onClose={vi.fn()} project={{ id: "p1", name: "atlas" } as ProjectInfo} />,
    );
    const active = screen.getAllByRole("button", { pressed: true });
    expect(active.map((b) => b.textContent)).toEqual(["atlas", "30 days"]);
    for (const b of active) {
      expect(b).toHaveClass("bg-[var(--brass-ghost)]", "text-octo-ivory");
      expect(b).not.toHaveClass("text-octo-brass");
    }
    const idle = screen.getByRole("button", { name: "All missions" });
    expect(idle).toHaveClass("text-octo-mute");
    expect(idle).not.toHaveClass("bg-[var(--brass-ghost)]");
  });

  it("sets the header spent total in ivory so only the table's spent cells are brass", async () => {
    setPlan(["logbook.reports"]);
    logbookSummaryMock.mockResolvedValue([
      {
        missionId: "m1",
        title: "Refund webhooks",
        intent: "build",
        hoursSecs: 3600,
        costUsd: 12.5,
        savingsUsd: 0,
        runsCount: 1,
        messagesCount: 2,
      } as never,
    ]);
    render(<LogbookRoom open onClose={vi.fn()} project={null} />);
    const total = await screen.findByTitle("Total spend");
    expect(total).toHaveClass("text-octo-ivory");
    expect(total).not.toHaveClass("text-octo-brass");
  });

  it("fits an option label by its mono character count", () => {
    expect(optionLabelFits("x".repeat(19))).toBe(true);
    expect(optionLabelFits("x".repeat(20))).toBe(false);
  });
});
