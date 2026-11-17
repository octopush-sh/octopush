import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ProjectCollisions } from "../lib/types";

const mockIpc = { projectCollisions: vi.fn<(id: string) => Promise<ProjectCollisions>>() };
vi.mock("../lib/ipc", () => ({ ipc: mockIpc }));

const { useCollisionStore, MIN_REFRESH_MS, POLL_MS } = await import("./collisionStore");

const report = (pairs: Array<[string, string]>): ProjectCollisions => ({
  collisions: pairs.map(([a, b]) => ({
    a,
    aName: a,
    b,
    bName: b,
    files: ["src/x.ts"],
    conflictingFiles: [],
    severity: "overlap",
    confirmed: false,
  })),
  scanned: 3,
  capped: false,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-17T12:00:00Z"));
  useCollisionStore.getState().reset();
  mockIpc.projectCollisions.mockReset();
  mockIpc.projectCollisions.mockResolvedValue(report([["a", "b"]]));
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
});
afterEach(() => vi.useRealTimers());

describe("collisionStore", () => {
  it("indexes a report by workspace", async () => {
    await useCollisionStore.getState().refresh("p1");
    const by = useCollisionStore.getState().byWorkspace;
    expect(by.a[0].otherId).toBe("b");
    expect(by.b[0].otherId).toBe("a");
  });

  it("throttles a project to one scan per MIN_REFRESH_MS", async () => {
    const s = useCollisionStore.getState();
    await s.refresh("p1");
    await s.refresh("p1");
    vi.advanceTimersByTime(MIN_REFRESH_MS - 1);
    await s.refresh("p1");
    expect(mockIpc.projectCollisions).toHaveBeenCalledTimes(1);
    // Another project has its own budget.
    await s.refresh("p2");
    expect(mockIpc.projectCollisions).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    await s.refresh("p1");
    expect(mockIpc.projectCollisions).toHaveBeenCalledTimes(3);
  });

  it("force bypasses the throttle but never stacks on an in-flight scan", async () => {
    let release!: (r: ProjectCollisions) => void;
    mockIpc.projectCollisions.mockReturnValueOnce(new Promise((r) => (release = r)));
    const s = useCollisionStore.getState();
    const first = s.refresh("p1");
    await s.refresh("p1", { force: true }); // in flight: dropped
    expect(mockIpc.projectCollisions).toHaveBeenCalledTimes(1);
    release(report([]));
    await first;
    await s.refresh("p1", { force: true });
    expect(mockIpc.projectCollisions).toHaveBeenCalledTimes(2);
  });

  it("a new report replaces the project's previous entries", async () => {
    const s = useCollisionStore.getState();
    await s.refresh("p1");
    mockIpc.projectCollisions.mockResolvedValue(report([["b", "c"]]));
    await s.refresh("p1", { force: true });
    const by = useCollisionStore.getState().byWorkspace;
    expect(by.a).toBeUndefined();
    expect(by.b[0].otherId).toBe("c");
  });

  it("keeps the last report when a scan fails", async () => {
    const s = useCollisionStore.getState();
    await s.refresh("p1");
    mockIpc.projectCollisions.mockRejectedValue(new Error("boom"));
    await s.refresh("p1", { force: true });
    expect(useCollisionStore.getState().byWorkspace.a).toHaveLength(1);
  });

  it("polls at POLL_MS, and not while the window is hidden", async () => {
    const stop = useCollisionStore.getState().startPolling(() => ["p1"]);
    expect(mockIpc.projectCollisions).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(mockIpc.projectCollisions).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(mockIpc.projectCollisions).toHaveBeenCalledTimes(2);
    stop();
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(mockIpc.projectCollisions).toHaveBeenCalledTimes(2);
  });
});
