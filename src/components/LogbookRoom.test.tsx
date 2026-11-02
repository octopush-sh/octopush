import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { LogbookRoom } from "./LogbookRoom";
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
});
