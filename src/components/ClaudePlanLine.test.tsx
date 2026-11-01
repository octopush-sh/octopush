import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import type { PlanSnapshot } from "../lib/ipc";

const getClaudePlan = vi.fn();
vi.mock("../lib/ipc", () => ({ ipc: { getClaudePlan: () => getClaudePlan() } }));
const listeners = vi.hoisted(() => new Map<string, () => void>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, cb: () => void) => {
    listeners.set(event, cb);
    return Promise.resolve(() => {});
  }),
}));

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

  it("colours the warning sentence with the warning token, rouge when used up", async () => {
    getClaudePlan.mockResolvedValue([win({ utilization: 0.94 })]);
    const { unmount } = render(<ClaudePlanLine />);
    const near = await screen.findByTestId("claude-plan-warning");
    expect(near.className).toContain("text-octo-warning");
    expect(near.className).not.toContain("text-octo-sage");
    unmount();

    getClaudePlan.mockResolvedValue([win({ status: "rejected", utilization: null })]);
    render(<ClaudePlanLine />);
    await screen.findByText(/5h limit reached/);
    expect(screen.getByTestId("claude-plan-warning").className).toContain("text-octo-rouge");
  });

  it("carries the age of its oldest figure, not its newest", async () => {
    // Only the 5-hour window was refreshed; the weekly figure is two days old.
    getClaudePlan.mockResolvedValue([
      win({ seenAt: new Date().toISOString() }),
      win({ kind: "seven_day", utilization: 0.31, seenAt: new Date(Date.now() - 2 * 86_400_000).toISOString() }),
    ]);
    render(<ClaudePlanLine />);
    await screen.findByText(/week 31%/);
    expect(screen.getByText("as of 2 days ago")).toBeInTheDocument();
    expect(screen.queryByText("as of just now")).toBeNull();
  });
});

describe("Claude plan loading", () => {
  it("stays hidden when the snapshot can't be read, and shows once a load succeeds", async () => {
    getClaudePlan.mockRejectedValue(new Error("db locked"));
    const line = await act(async () => render(<ClaudePlanLine reloadKey={1} />));
    const card = await act(async () => render(<ClaudePlanCard />));
    expect(line.container).toBeEmptyDOMElement();
    expect(card.container).toBeEmptyDOMElement();

    getClaudePlan.mockResolvedValue([win({})]);
    line.rerender(<ClaudePlanLine reloadKey={2} />);
    expect(await screen.findByText(/^Claude plan · 5h 62%/)).toBeInTheDocument();
    expect(await screen.findByTestId("usage-claude-plan")).toBeInTheDocument();
  });

  it("reloads when a stage reports new windows", async () => {
    const { container } = await act(async () => render(<ClaudePlanLine />));
    expect(container).toBeEmptyDOMElement();
    await vi.waitFor(() => expect(listeners.has("plan://updated")).toBe(true));
    const calls = getClaudePlan.mock.calls.length;

    getClaudePlan.mockResolvedValue([win({ utilization: 0.4 })]);
    await act(async () => listeners.get("plan://updated")!());
    expect(getClaudePlan.mock.calls.length).toBe(calls + 1);
    expect(await screen.findByText(/5h 40%/)).toBeInTheDocument();
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
    expect(screen.getByTestId("claude-plan-warning").className).toContain("text-octo-rouge");
  });

  it("hides a snapshot that is a week stale, as after a move to an API key", async () => {
    const old = new Date(Date.now() - 9 * 86_400_000).toISOString();
    const gone = Math.floor(Date.now() / 1000) - 8 * 86400;
    getClaudePlan.mockResolvedValue([win({ seenAt: old, resetsAt: gone }), win({ kind: "seven_day", seenAt: old, resetsAt: gone })]);
    const card = await act(async () => render(<ClaudePlanCard />));
    const line = await act(async () => render(<ClaudePlanLine />));
    expect(getClaudePlan).toHaveBeenCalled();
    expect(card.container).toBeEmptyDOMElement();
    expect(line.container).toBeEmptyDOMElement();
  });

  it("loads once on mount and refreshes only on plan://updated", async () => {
    vi.useFakeTimers();
    try {
      getClaudePlan.mockResolvedValue([win({})]);
      await act(async () => render(<ClaudePlanCard />));
      const calls = getClaudePlan.mock.calls.length;
      await act(async () => vi.advanceTimersByTime(5 * 60_000));
      expect(getClaudePlan.mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });

  it("names rows in the body face and draws the bar with tokens", async () => {
    getClaudePlan.mockResolvedValue([win({}), win({ kind: "overage", utilization: null, status: "rejected" })]);
    render(<ClaudePlanCard />);
    const list = await screen.findByTestId("usage-claude-plan");
    const name = list.querySelector("li span")!;
    expect(name.className).not.toContain("font-serif");
    const track = list.querySelector("li > div + div")!;
    expect(track.className).toContain("bg-octo-hairline");
    expect(track.getAttribute("style")).toBeNull();
    expect(track.firstElementChild!.className).toContain("ease-[var(--ease-octo)]");
    expect(list.querySelectorAll("li")[1].textContent).toMatch(/^Extra usageunavailable/);
  });

  it("colours its near-limit warning with the warning token", async () => {
    getClaudePlan.mockResolvedValue([win({ utilization: 0.9 })]);
    render(<ClaudePlanCard />);
    const warning = await screen.findByTestId("claude-plan-warning");
    expect(warning.textContent).toMatch(/5-hour window is at 90%/);
    expect(warning.className).toContain("text-octo-warning");
  });
});
