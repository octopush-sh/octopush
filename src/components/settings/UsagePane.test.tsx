/**
 * Settings → Usage: the report is fetched for the chosen period and mode
 * (local-calendar range, viewer's UTC offset), the honest cache figures
 * render (a "—" when no cache data exists, never a fake 0%), sources show
 * their full names, and stale pricing gets the refresh nudge.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor, within } from "@testing-library/react";
import type { UsageReport } from "../../lib/types";

const getUsageReport = vi.fn();
const getUsageBreakdown = vi.fn();
const refreshPricing = vi.fn();
vi.mock("../../lib/ipc", () => ({
  ipc: {
    getUsageReport: (...a: unknown[]) => getUsageReport(...a),
    getUsageBreakdown: (...a: unknown[]) => getUsageBreakdown(...a),
    refreshPricing: (...a: unknown[]) => refreshPricing(...a),
    exportTokenEventsCsv: vi.fn().mockResolvedValue(""),
    writeFile: vi.fn().mockResolvedValue(undefined),
    listBudgets: vi.fn().mockResolvedValue([]),
    currentSpend: vi.fn().mockResolvedValue({ costUsd: 0, tokens: 0 }),
    setBudget: vi.fn().mockResolvedValue(undefined),
    clearBudget: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock("../Toasts", () => ({ pushToast: vi.fn() }));

import { UsagePane, periodRange, pricingAgeDays } from "./UsagePane";

const slice = (over: Partial<UsageReport["totals"]> = {}): UsageReport["totals"] => ({
  inputTokens: 10_000,
  outputTokens: 2_000,
  cacheReadTokens: 80_000,
  cacheCreationTokens: 10_000,
  costUsd: 12.5,
  calls: 40,
  cacheHitPct: 80,
  cacheTracked: true,
  ...over,
});

const REPORT: UsageReport = {
  start: "2026-08-20T05:00:00.000Z",
  end: "2026-09-19T14:00:00.000Z",
  surface: null,
  totals: slice(),
  bySurface: [
    { surface: "run", ...slice({ costUsd: 4, cacheReadTokens: 0, cacheCreationTokens: 0, cacheHitPct: null, cacheTracked: false }) },
    { surface: "talk", ...slice({ costUsd: 8.5 }) },
  ],
  byModel: [{ model: "claude-opus-5", ...slice() }],
  bySource: [
    {
      id: "w1",
      label: "billing-reconciliation-fix",
      kind: "workspace",
      project: "Atlas",
      lastTs: "2026-09-19T13:00:00Z",
      ...slice({ costUsd: 9 }),
      surfaces: [{ surface: "talk", costUsd: 6 }, { surface: "direct", costUsd: 3 }],
    },
    { id: "sess-9", label: "sess-9", kind: "other", project: null, lastTs: "2026-09-18T13:00:00Z", ...slice({ costUsd: 3.5 }), surfaces: [{ surface: "run", costUsd: 3.5 }] },
  ],
  trend: [{ bucket: "2026-09-18", costUsd: 5, tokens: 1000 }],
  trendBucket: "day",
  activeDays: 5,
  perActiveDayUsd: 2.5,
  last24hUsd: 1.25,
  unpricedCalls: 0,
  pricingRefreshedAt: new Date().toISOString(),
};

beforeEach(() => {
  getUsageReport.mockReset().mockResolvedValue(REPORT);
  getUsageBreakdown.mockReset().mockResolvedValue({ cloudCostUsd: 12.5, cloudTokens: 12_000, localTokens: 0, estimatedLocalSavingsUsd: 0 });
  refreshPricing.mockReset().mockResolvedValue({ modelsUpdated: 3, modelsTotal: 5, fetchedAt: new Date().toISOString() });
});

describe("periodRange", () => {
  it("spans whole local days for presets and custom ranges", () => {
    const now = new Date(2026, 8, 19, 15, 30); // local Sep 19 15:30
    const week = periodRange("7d", { from: "", to: "" }, now);
    expect(new Date(week.start).getTime()).toBe(new Date(2026, 8, 13, 0, 0, 0, 0).getTime());
    expect(week.end).toBe(now.toISOString());
    const month = periodRange("month", { from: "", to: "" }, now);
    expect(new Date(month.start).getTime()).toBe(new Date(2026, 8, 1).getTime());
    const custom = periodRange("custom", { from: "2026-09-01", to: "2026-09-03" }, now);
    expect(new Date(custom.start).getTime()).toBe(new Date(2026, 8, 1).getTime());
    expect(new Date(custom.end).getTime()).toBe(new Date(2026, 8, 3, 23, 59, 59, 999).getTime());
    // An inverted custom range falls back to 30 days instead of an empty query.
    const bad = periodRange("custom", { from: "2026-09-05", to: "2026-09-01" }, now);
    expect(bad).toEqual(periodRange("30d", { from: "", to: "" }, now));
  });
});

describe("pricingAgeDays", () => {
  it("is null when never refreshed and whole days otherwise", () => {
    expect(pricingAgeDays(null)).toBeNull();
    expect(pricingAgeDays("garbage")).toBeNull();
    const now = new Date("2026-09-19T12:00:00Z");
    expect(pricingAgeDays("2026-07-19T00:00:00Z", now)).toBe(62);
  });
});

describe("UsagePane", () => {
  it("fetches 30 days for every mode with the viewer's offset and renders the honest figures", async () => {
    await act(async () => {
      render(<UsagePane />);
    });
    await waitFor(() => expect(getUsageReport).toHaveBeenCalled());
    const [start, end, surface, offset] = getUsageReport.mock.calls[0];
    expect(surface).toBeNull();
    expect(offset).toBe(-new Date().getTimezoneOffset());
    expect(Date.parse(end) - Date.parse(start)).toBeGreaterThan(29 * 86_400_000);

    expect(within(screen.getByTestId("usage-stat-cost")).getByText("$12.50")).toBeInTheDocument();
    expect(within(screen.getByTestId("usage-stat-per-day")).getByText("5 days with spend")).toBeInTheDocument();
    expect(within(screen.getByTestId("usage-stat-cache")).getByText("80%")).toBeInTheDocument();

    // RUN has no cache data → "—", not 0%; TALK shows its own ratio.
    const modes = screen.getByTestId("usage-by-mode");
    const runCard = within(modes).getByRole("button", { name: /run/i });
    expect(runCard.textContent).toContain("hit —");
    expect(within(modes).getByRole("button", { name: /talk/i }).textContent).toContain("hit 80%");

    // Sources carry their full names and what they are.
    const sources = screen.getAllByTestId("usage-source");
    expect(sources[0].textContent).toContain("billing-reconciliation-fix");
    expect(sources[0].textContent).toContain("workspace · Atlas");
    expect(sources[1].textContent).toContain("unattributed");
    expect(screen.queryByTestId("usage-pricing-stale")).toBeNull();
  });

  it("refetches with the surface when a mode is chosen and clears it from the card", async () => {
    await act(async () => {
      render(<UsagePane />);
    });
    await waitFor(() => expect(getUsageReport).toHaveBeenCalledTimes(1));
    await act(async () => {
      fireEvent.click(within(screen.getByTestId("usage-mode")).getByRole("radio", { name: "Run" }));
    });
    await waitFor(() => expect(getUsageReport).toHaveBeenCalledTimes(2));
    expect(getUsageReport.mock.calls[1][2]).toBe("run");
    // The pressed mode card toggles back to every mode.
    const runCard = within(screen.getByTestId("usage-by-mode")).getByRole("button", { name: /run/i });
    expect(runCard).toHaveAttribute("aria-pressed", "true");
    await act(async () => {
      fireEvent.click(runCard);
    });
    await waitFor(() => expect(getUsageReport).toHaveBeenCalledTimes(3));
    expect(getUsageReport.mock.calls[2][2]).toBeNull();
  });

  it("'Today' starts at local midnight and 'Custom' reveals the date inputs", async () => {
    await act(async () => {
      render(<UsagePane />);
    });
    await waitFor(() => expect(getUsageReport).toHaveBeenCalledTimes(1));
    await act(async () => {
      fireEvent.click(within(screen.getByTestId("usage-period")).getByRole("radio", { name: "Today" }));
    });
    await waitFor(() => expect(getUsageReport).toHaveBeenCalledTimes(2));
    const start = new Date(getUsageReport.mock.calls[1][0] as string);
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    await act(async () => {
      fireEvent.click(within(screen.getByTestId("usage-period")).getByRole("radio", { name: "Custom" }));
    });
    expect(screen.getByLabelText("From")).toBeInTheDocument();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-09-01" } });
    });
    await waitFor(() => expect(getUsageReport.mock.calls.length).toBeGreaterThanOrEqual(4));
    const last = getUsageReport.mock.calls.at(-1) as string[];
    expect(new Date(last[0]).getTime()).toBe(new Date(2026, 8, 1).getTime());
  });

  it("nudges to refresh stale pricing and reloads after the refresh", async () => {
    getUsageReport.mockResolvedValue({ ...REPORT, pricingRefreshedAt: "2026-01-01T00:00:00Z" });
    await act(async () => {
      render(<UsagePane />);
    });
    const notice = await screen.findByTestId("usage-pricing-stale");
    expect(notice.textContent).toMatch(/refreshed \d+ days ago/);
    await act(async () => {
      fireEvent.click(within(notice).getByRole("button", { name: /refresh pricing/i }));
    });
    await waitFor(() => expect(refreshPricing).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getUsageReport.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("says when nothing was billed and shows unpriced calls", async () => {
    getUsageReport.mockResolvedValue({
      ...REPORT,
      totals: slice({ costUsd: 0, calls: 3, cacheHitPct: null, cacheTracked: false }),
      bySurface: [],
      bySource: [],
      byModel: [],
      trend: [],
      unpricedCalls: 3,
      pricingRefreshedAt: null,
    });
    await act(async () => {
      render(<UsagePane />);
    });
    expect(await screen.findByText("Nothing billed in this period.")).toBeInTheDocument();
    expect(screen.getByText(/3 calls carried tokens but no price/)).toBeInTheDocument();
    expect(within(screen.getByTestId("usage-stat-cache")).getByText("—")).toBeInTheDocument();
    expect(screen.getByTestId("usage-pricing-stale").textContent).toMatch(/never been refreshed/);
  });
});
