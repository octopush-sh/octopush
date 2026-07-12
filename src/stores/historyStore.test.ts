/**
 * Unit tests for historyStore (cross-machine run history — Pro-real Part B / B1).
 *
 * 1. openSheet paints the local mirror, then refreshes from the cloud
 * 2. refresh replaces runs from the cloud pull
 * 3. refresh records an error (no throw) when the pull fails
 * 4. syncOnLaunch backfills + pulls, and stays silent on failure
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SyncedRun } from "../lib/ipc";

// ─── Mocks ────────────────────────────────────────────────────────────

const historyListMock = vi.fn<() => Promise<SyncedRun[]>>();
const historySyncPullMock = vi.fn<() => Promise<SyncedRun[]>>();
const historySyncPushAllMock = vi.fn<() => Promise<number>>();
const historyRunDetailMock = vi.fn();

vi.mock("../lib/ipc", () => ({
  ipc: {
    historyList: historyListMock,
    historySyncPull: historySyncPullMock,
    historySyncPushAll: historySyncPushAllMock,
    historyRunDetail: historyRunDetailMock,
  },
}));

const { useHistoryStore } = await import("./historyStore");

const mkRun = (id: string): SyncedRun => ({
  run_id: id,
  machine_id: "m",
  machine_name: "Mac",
  workspace_name: "ws",
  task: "t",
  status: "completed",
  cost_usd: 0,
  input_tokens: 0,
  output_tokens: 0,
  created_at: "2026-01-01T00:00:00Z",
  finished_at: null,
  stages: [],
});

beforeEach(() => {
  useHistoryStore.setState({
    open: false,
    runs: [],
    loading: false,
    loaded: false,
    error: null,
    viewedRunId: null,
    detailByRun: {},
    detailLoading: false,
    detailError: null,
  });
  historyListMock.mockReset();
  historySyncPullMock.mockReset();
  historySyncPushAllMock.mockReset();
  historyRunDetailMock.mockReset();
});

describe("historyStore", () => {
  it("openSheet paints the local mirror, then refreshes from the cloud", async () => {
    historyListMock.mockResolvedValue([mkRun("local")]);
    historySyncPullMock.mockResolvedValue([mkRun("cloud1"), mkRun("cloud2")]);

    await useHistoryStore.getState().openSheet();

    const s = useHistoryStore.getState();
    expect(s.open).toBe(true);
    expect(historyListMock).toHaveBeenCalledOnce();
    expect(historySyncPullMock).toHaveBeenCalledOnce();
    expect(s.runs.map((r) => r.run_id)).toEqual(["cloud1", "cloud2"]);
    expect(s.loading).toBe(false);
  });

  it("refresh replaces runs from the cloud pull", async () => {
    historySyncPullMock.mockResolvedValue([mkRun("a")]);

    await useHistoryStore.getState().refresh();

    const s = useHistoryStore.getState();
    expect(s.runs).toHaveLength(1);
    expect(s.loaded).toBe(true);
    expect(s.error).toBeNull();
  });

  it("refresh records an error without throwing when the pull fails", async () => {
    historySyncPullMock.mockRejectedValue(new Error("offline"));

    await expect(useHistoryStore.getState().refresh()).resolves.toBeUndefined();

    const s = useHistoryStore.getState();
    expect(s.loading).toBe(false);
    expect(s.error).toContain("offline");
  });

  it("syncOnLaunch backfills then pulls", async () => {
    historySyncPushAllMock.mockResolvedValue(3);
    historySyncPullMock.mockResolvedValue([mkRun("x")]);

    await useHistoryStore.getState().syncOnLaunch();

    expect(historySyncPushAllMock).toHaveBeenCalledOnce();
    expect(historySyncPullMock).toHaveBeenCalledOnce();
    expect(useHistoryStore.getState().runs).toHaveLength(1);
  });

  it("syncOnLaunch stays silent when not entitled / offline", async () => {
    historySyncPushAllMock.mockRejectedValue(new Error("upgrade required"));

    await expect(useHistoryStore.getState().syncOnLaunch()).resolves.toBeUndefined();
    expect(useHistoryStore.getState().runs).toHaveLength(0);
  });

  // ── B2: the drill-in detail ──

  it("openRun fetches the detail once and serves the cache after", async () => {
    historyRunDetailMock.mockResolvedValue({ run_id: "a", stages: [] });
    await useHistoryStore.getState().openRun("a");
    expect(useHistoryStore.getState().viewedRunId).toBe("a");
    expect(useHistoryStore.getState().detailByRun["a"]).toEqual({ run_id: "a", stages: [] });

    useHistoryStore.getState().closeRun();
    expect(useHistoryStore.getState().viewedRunId).toBeNull();

    await useHistoryStore.getState().openRun("a"); // cached — no second fetch
    expect(historyRunDetailMock).toHaveBeenCalledTimes(1);
  });

  it("openRun caches a server 'none' (pre-B2 run) as null — honest empty state", async () => {
    historyRunDetailMock.mockResolvedValue(null);
    await useHistoryStore.getState().openRun("old");
    expect(useHistoryStore.getState().detailByRun["old"]).toBeNull();
    await useHistoryStore.getState().openRun("old");
    expect(historyRunDetailMock).toHaveBeenCalledTimes(1); // the 'none' is cached too
  });

  it("openRun records a fetch failure WITHOUT caching it, so reopening retries", async () => {
    historyRunDetailMock.mockRejectedValue(new Error("offline"));
    await useHistoryStore.getState().openRun("b");
    expect(useHistoryStore.getState().detailError).toContain("offline");
    expect("b" in useHistoryStore.getState().detailByRun).toBe(false);

    historyRunDetailMock.mockResolvedValue({ run_id: "b", stages: [] });
    await useHistoryStore.getState().openRun("b"); // retry succeeds
    expect(useHistoryStore.getState().detailByRun["b"]).toBeTruthy();
    expect(useHistoryStore.getState().detailError).toBeNull();
  });
});
