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
});
