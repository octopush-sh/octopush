import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { PlanSnapshot } from "../lib/ipc";

const getClaudePlan = vi.fn();
vi.mock("../lib/ipc", () => ({ ipc: { getClaudePlan: () => getClaudePlan() } }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

const { ClaudePlanLine } = await import("./ClaudePlanLine");
const { ClaudePlanCard } = await import("./settings/ClaudePlanCard");
const { useClaudePlanStore } = await import("../stores/claudePlanStore");

const soon = () => Math.floor(Date.now() / 1000) + 3600;
const win = (over: Partial<PlanSnapshot>): PlanSnapshot => ({
  kind: "five_hour",
  utilization: 0.62,
  resetsAt: soon(),
  status: "allowed",
  overageStatus: null,
  usingOverage: false,
  seenAt: new Date(Date.now() - 12 * 60_000).toISOString(),
  ...over,
});

beforeEach(() => {
  getClaudePlan.mockReset().mockResolvedValue([]);
  useClaudePlanStore.setState({ windows: [] });
});

describe("ClaudePlanLine", () => {
  it("renders nothing until a Claude-plan stage has reported", async () => {
    const { container } = await act(async () => render(<ClaudePlanLine />));
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the windows with their age, in sage while calm", async () => {
    getClaudePlan.mockResolvedValue([win({}), win({ kind: "seven_day", utilization: 0.31 })]);
    render(<ClaudePlanLine />);
    const line = await screen.findByText(/^Claude plan · 5h 62% · resets \d{2}:\d{2} · week 31%$/);
    expect(line.parentElement!.className).toContain("text-octo-sage");
    expect(screen.getByText("as of 12 min ago")).toBeInTheDocument();
    expect(screen.queryByTestId("claude-plan-warning")).toBeNull();
  });

  it("turns amber with a calm warning near the limit, rouge when used up", async () => {
    getClaudePlan.mockResolvedValue([win({ utilization: 0.84 })]);
    const { unmount } = render(<ClaudePlanLine />);
    const line = await screen.findByText(/5h 84%/);
    expect(line.parentElement!.className).toContain("text-octo-warning");
    expect(screen.getByTestId("claude-plan-warning").textContent).toMatch(/5-hour window is at 84% — it resets at/);
    unmount();

    getClaudePlan.mockResolvedValue([win({ status: "rejected", utilization: null })]);
    render(<ClaudePlanLine />);
    const limited = await screen.findByText(/5h limit reached/);
    expect(limited.parentElement!.className).toContain("text-octo-rouge");
    expect(screen.getByTestId("claude-plan-warning").textContent).toMatch(/is used up/);
  });
});

describe("ClaudePlanCard", () => {
  it("is hidden without a snapshot", async () => {
    const { container } = await act(async () => render(<ClaudePlanCard />));
    expect(container).toBeEmptyDOMElement();
  });

  it("lists every window with its reset and age, unknown kinds included", async () => {
    getClaudePlan.mockResolvedValue([
      win({ kind: "seven_day", utilization: 0.31 }),
      win({}),
      win({ kind: "seven_day_fixture_tier", utilization: null, status: "rejected", usingOverage: true }),
    ]);
    render(<ClaudePlanCard />);
    const list = await screen.findByTestId("usage-claude-plan");
    const rows = Array.from(list.querySelectorAll("li")).map((li) => li.textContent);
    expect(rows[0]).toMatch(/^5-hour window62%resets \d{2}:\d{2} · as of 12 min ago$/);
    expect(rows[1]).toMatch(/^Weekly window31%/);
    expect(rows[2]).toMatch(/^Weekly Fixture tier windowlimit reached.*using extra usage$/);
  });
});
