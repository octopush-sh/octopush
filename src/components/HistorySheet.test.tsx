/**
 * HistorySheet — synced runs priced on another Mac. A stage whose model this
 * Mac can't price reads "unpriced", never "$0.00", and a run total with such a
 * stage gets " + unpriced".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import type { SyncedRun, SyncedRunDetail } from "../lib/ipc";

const unpricedModelsMock = vi.fn<(models: string[]) => Promise<string[]>>();

vi.mock("../lib/ipc", () => ({
  ipc: {
    unpricedModels: unpricedModelsMock,
    historyList: vi.fn(async () => []),
    historySyncPull: vi.fn(async () => []),
    historySyncPushAll: vi.fn(async () => 0),
    historyRunDetail: vi.fn(async () => null),
  },
}));

const { HistorySheet } = await import("./HistorySheet");
const { useHistoryStore } = await import("../stores/historyStore");
const { useSyncPrefsStore } = await import("../stores/syncPrefsStore");

const mkRun = (id: string, task: string, stages: SyncedRun["stages"], cost_usd: number): SyncedRun => ({
  run_id: id,
  machine_id: "m",
  machine_name: "Other Mac",
  workspace_name: "ws",
  task,
  status: "completed",
  cost_usd,
  input_tokens: 0,
  output_tokens: 0,
  created_at: "2026-11-01T00:00:00Z",
  finished_at: null,
  stages,
});

const priced = mkRun("r1", "Priced run", [{ role: "plan", model: "claude-opus-5-5", status: "done", cost_usd: 0.42 }], 0.42);
const mixed = mkRun(
  "r2",
  "Gateway run",
  [
    { role: "plan", model: "claude-opus-5-5", status: "done", cost_usd: 0.3 },
    { role: "implement", model: "gw/mystery-1", status: "done", cost_usd: 0 },
  ],
  0.3,
);

const mixedDetail: SyncedRunDetail = {
  run_id: "r2",
  stages: mixed.stages.map((s, position) => ({
    ...s,
    position,
    error: null,
    artifact: null,
    journal: [],
    diff: null,
  })),
};

beforeEach(() => {
  useSyncPrefsStore.setState({ historySync: true, librarySync: false, loaded: true });
  useHistoryStore.setState({
    open: true,
    runs: [priced, mixed],
    loading: false,
    loaded: true,
    error: null,
    viewedRunId: null,
    detailByRun: {},
    detailLoading: null,
    detailError: null,
  });
  unpricedModelsMock.mockReset();
  unpricedModelsMock.mockImplementation(async (models) => models.filter((m) => m.startsWith("gw/")));
});

describe("HistorySheet unpriced stages", () => {
  it("adds ' + unpriced' only to a run total with an unpriced stage", async () => {
    render(<HistorySheet />);
    const gateway = screen.getByText("Gateway run").closest("button")!;
    await waitFor(() => expect(within(gateway).getByText(/\+ unpriced/)).toBeInTheDocument());
    expect(within(gateway).getByText(/\+ unpriced/)).toHaveAttribute(
      "title",
      expect.stringContaining("No price for gw/mystery-1"),
    );
    const pricedRow = screen.getByText("Priced run").closest("button")!;
    expect(within(pricedRow).getByText("$0.42")).toBeInTheDocument();
    expect(within(pricedRow).queryByText(/unpriced/)).toBeNull();
    // One call for the whole distinct model set.
    expect(unpricedModelsMock).toHaveBeenCalledTimes(1);
    expect(unpricedModelsMock).toHaveBeenCalledWith(["claude-opus-5-5", "gw/mystery-1"]);
  });

  it("shows an unpriced $0 stage as 'unpriced' instead of $0.00", async () => {
    useHistoryStore.setState({ viewedRunId: "r2", detailByRun: { r2: mixedDetail } });
    render(<HistorySheet />);
    const stage = await screen.findByText("unpriced");
    expect(stage).toHaveAttribute("title", expect.stringContaining("No price for gw/mystery-1"));
    expect(screen.queryByText("$0.00")).toBeNull();
    // The priced stage keeps its figure; the run total says it is partial.
    expect(screen.getAllByText("$0.30").length).toBeGreaterThan(0);
    expect(screen.getByText(/\+ unpriced/)).toBeInTheDocument();
  });

  it("keeps $0.00 when the model is priced", async () => {
    const free = mkRun("r3", "Free run", [{ role: "plan", model: "llama3.3", status: "done", cost_usd: 0 }], 0);
    useHistoryStore.setState({
      runs: [free],
      viewedRunId: "r3",
      detailByRun: {
        r3: { run_id: "r3", stages: [{ ...free.stages[0], position: 0, error: null, artifact: null, journal: [], diff: null }] },
      },
    });
    render(<HistorySheet />);
    await waitFor(() => expect(unpricedModelsMock).toHaveBeenCalled());
    expect(screen.getAllByText("$0.00").length).toBe(2);
    expect(screen.queryByText(/unpriced/)).toBeNull();
  });

  it("shows an all-unpriced run total as 'unpriced', never '$0.00 + unpriced'", async () => {
    const dark = mkRun("r4", "Dark run", [{ role: "plan", model: "gw/mystery-1", status: "done", cost_usd: 0 }], 0);
    useHistoryStore.setState({ runs: [dark] });
    const { unmount } = render(<HistorySheet />);
    const row = screen.getByText("Dark run").closest("button")!;
    await waitFor(() => expect(within(row).getByText("unpriced")).toBeInTheDocument());
    expect(within(row).getByText("unpriced")).toHaveAttribute("title", expect.stringContaining("No price for gw/mystery-1"));
    expect(within(row).getByText("unpriced")).toHaveClass("text-octo-mute");
    expect(within(row).queryByText("$0.00")).toBeNull();
    expect(within(row).queryByText(/\+ unpriced/)).toBeNull();
    unmount();

    // The detail header and the stage both read "unpriced".
    useHistoryStore.setState({
      viewedRunId: "r4",
      detailByRun: {
        r4: { run_id: "r4", stages: [{ ...dark.stages[0], position: 0, error: null, artifact: null, journal: [], diff: null }] },
      },
    });
    render(<HistorySheet />);
    await waitFor(() => expect(screen.getAllByText("unpriced").length).toBe(2));
    expect(screen.queryByText("$0.00")).toBeNull();
    expect(screen.queryByText(/\+ unpriced/)).toBeNull();
  });

  it("keeps ' + unpriced' when the unpriced stages were folded into the summary stage (#978)", async () => {
    const summary = (includes_unpriced?: boolean) => ({
      role: "… (12 stages truncated)",
      model: null,
      status: "truncated",
      cost_usd: 0,
      ...(includes_unpriced === undefined ? {} : { includes_unpriced }),
    });
    const folded = mkRun(
      "r6",
      "Folded run",
      [{ role: "plan", model: "claude-opus-5-5", status: "done", cost_usd: 0.2 }, summary(true)],
      0.2,
    );
    const allFolded = mkRun("r7", "All folded run", [summary(true)], 0);
    const older = mkRun(
      "r8",
      "Older folded run",
      [{ role: "plan", model: "claude-opus-5-5", status: "done", cost_usd: 0.2 }, summary()],
      0.2,
    );
    useHistoryStore.setState({ runs: [folded, allFolded, older] });
    const { unmount } = render(<HistorySheet />);
    await waitFor(() => expect(unpricedModelsMock).toHaveBeenCalled());
    const row = screen.getByText("Folded run").closest("button")!;
    expect(within(row).getByText("$0.20")).toBeInTheDocument();
    expect(within(row).getByText(/\+ unpriced/)).toHaveAttribute(
      "title",
      expect.stringContaining("folded into one summary to fit the sync limit"),
    );
    const all = screen.getByText("All folded run").closest("button")!;
    expect(within(all).getByText("unpriced")).toBeInTheDocument();
    expect(within(all).queryByText("$0.00")).toBeNull();
    // A payload from before the marker (or one whose folded stages were all
    // priced) reads as it always did.
    const before = screen.getByText("Older folded run").closest("button")!;
    expect(within(before).getByText("$0.20")).toBeInTheDocument();
    expect(within(before).queryByText(/unpriced/)).toBeNull();
    unmount();

    // The detail header keeps it too, naming a model it can see as well.
    useHistoryStore.setState({
      runs: [mkRun("r9", "Mixed folded run", [...mixed.stages, summary(true)], 0.3)],
      viewedRunId: "r9",
      detailByRun: { r9: { ...mixedDetail, run_id: "r9" } },
    });
    render(<HistorySheet />);
    await waitFor(() => expect(screen.getByText(/\+ unpriced/)).toBeInTheDocument());
    const title = screen.getByText(/\+ unpriced/).getAttribute("title") ?? "";
    expect(title).toContain("No price for gw/mystery-1");
    expect(title).toContain("folded into one summary");
  });

  it("does not add ' + unpriced' for a stage priced on its origin Mac", async () => {
    const origin = mkRun(
      "r5",
      "Origin-priced run",
      [
        { role: "plan", model: "claude-opus-5-5", status: "done", cost_usd: 0.1 },
        { role: "implement", model: "gw/mystery-1", status: "done", cost_usd: 0.25 },
      ],
      0.35,
    );
    useHistoryStore.setState({
      runs: [origin],
      viewedRunId: "r5",
      detailByRun: {
        r5: {
          run_id: "r5",
          stages: origin.stages.map((s, position) => ({ ...s, position, error: null, artifact: null, journal: [], diff: null })),
        },
      },
    });
    render(<HistorySheet />);
    await waitFor(() => expect(unpricedModelsMock).toHaveBeenCalled());
    await unpricedModelsMock.mock.results[0].value;
    await screen.findByText("$0.25");
    expect(screen.getByText("$0.35")).toBeInTheDocument();
    expect(screen.queryByText(/unpriced/)).toBeNull();
  });
});
