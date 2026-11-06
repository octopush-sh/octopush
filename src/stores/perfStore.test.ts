import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PerfStats } from "../lib/types";

const mockIpc = {
  getPerfStats: vi.fn<() => Promise<PerfStats>>(),
};
vi.mock("../lib/ipc", () => ({ ipc: mockIpc }));

const { usePerfStore } = await import("./perfStore");

const SAMPLE: PerfStats = {
  app: { rssBytes: 100, cpuPct: 1, processCount: 2 },
  daemon: { rssBytes: 50, cpuPct: 0.5, processCount: 1 },
  total: { rssBytes: 150, cpuPct: 1.5, processCount: 3 },
  disk: { freeBytes: 18 * 1024 * 1024 * 1024, totalBytes: 460 * 1024 * 1024 * 1024 },
  ts: 1,
};

beforeEach(() => {
  vi.useFakeTimers();
  usePerfStore.getState().stop();
  usePerfStore.setState({ stats: null, detailsOpen: false });
  mockIpc.getPerfStats.mockReset();
  mockIpc.getPerfStats.mockResolvedValue(SAMPLE);
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
});
afterEach(() => {
  usePerfStore.getState().stop();
  vi.useRealTimers();
});

describe("perfStore", () => {
  it("polls immediately on start and sets stats", async () => {
    usePerfStore.getState().start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockIpc.getPerfStats).toHaveBeenCalledTimes(1);
    expect(usePerfStore.getState().stats).toEqual(SAMPLE);
  });

  it("polls again after the interval", async () => {
    usePerfStore.getState().start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(mockIpc.getPerfStats).toHaveBeenCalledTimes(2);
  });

  it("skips the IPC call when the document is hidden", async () => {
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    usePerfStore.getState().start();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockIpc.getPerfStats).not.toHaveBeenCalled();
  });

  it("stop() halts polling", async () => {
    usePerfStore.getState().start();
    await vi.advanceTimersByTimeAsync(0);
    usePerfStore.getState().stop();
    await vi.advanceTimersByTimeAsync(4000);
    expect(mockIpc.getPerfStats).toHaveBeenCalledTimes(1);
  });

  it("start() is idempotent (no duplicate intervals)", async () => {
    usePerfStore.getState().start();
    usePerfStore.getState().start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(mockIpc.getPerfStats).toHaveBeenCalledTimes(2);
  });

  it("ignores opening the details before the first sample", async () => {
    usePerfStore.getState().setDetailsOpen(true);
    expect(usePerfStore.getState().detailsOpen).toBe(false);
    // The sample landing doesn't pop the details open on its own.
    usePerfStore.getState().start();
    await vi.advanceTimersByTimeAsync(0);
    expect(usePerfStore.getState().detailsOpen).toBe(false);

    usePerfStore.getState().setDetailsOpen(true);
    expect(usePerfStore.getState().detailsOpen).toBe(true);
    usePerfStore.getState().setDetailsOpen(false);
    expect(usePerfStore.getState().detailsOpen).toBe(false);
  });
});
