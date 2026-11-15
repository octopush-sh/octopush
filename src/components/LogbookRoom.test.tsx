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

  it("fits an option label by its mono character count", () => {
    expect(optionLabelFits("x".repeat(19))).toBe(true);
    expect(optionLabelFits("x".repeat(20))).toBe(false);
  });
});
