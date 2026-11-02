import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { RoutinesPane } from "./RoutinesPane";
import { useEntitlementStore } from "../../stores/entitlementStore";
import { useRoutinesStore } from "../../stores/routinesStore";
import { useProjectStore } from "../../stores/projectStore";
import { usePipelineStore } from "../../stores/pipelineStore";

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
  // Keep the pane's mount-time loads off IPC.
  useRoutinesStore.setState({ routines: [], load: vi.fn(async () => {}) });
  useProjectStore.setState({ recent: [], loadRecent: vi.fn(async () => {}) });
  usePipelineStore.setState({ pipelines: [], load: vi.fn(async () => {}) });
});

describe("RoutinesPane upgrade banner", () => {
  it("offers Pro as a ceremonial brass-ghost phrase for a free user", () => {
    setPlan([]);
    render(<RoutinesPane />);
    const cta = screen.getByRole("button", { name: "Put your crews on a schedule with Pro" });
    expect(cta.className).toContain("bg-[var(--brass-ghost)]");
    expect(cta.className).toContain("border-[var(--brass-dim)]");
    expect(cta.className).toContain("font-serif");
    expect(screen.queryByText("Upgrade to Pro")).not.toBeInTheDocument();
  });

  it("shows no upgrade banner for an entitled user", () => {
    setPlan(["routines.scheduled"]);
    render(<RoutinesPane />);
    expect(
      screen.queryByRole("button", { name: "Put your crews on a schedule with Pro" }),
    ).not.toBeInTheDocument();
  });
});
