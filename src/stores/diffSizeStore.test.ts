import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/ipc", () => ({ ipc: { workspaceDiffSize: vi.fn() } }));

const { ipc } = await import("../lib/ipc");
const { useDiffSizeStore, diffSizeKey, diffSizeLabel, diffSizeTitle, orderSettled, resetDiffSizeQueueForTests, MAX_CONCURRENT_MEASURES } =
  await import("./diffSizeStore");

beforeEach(() => {
  useDiffSizeStore.setState({ byKey: {} });
  resetDiffSizeQueueForTests();
  vi.clearAllMocks();
});

const sz = (files: number, added: number, removed: number) => ({ files, added, removed, base: "main", untrackedSkipped: 0 });

describe("diffSizeStore", () => {
  it("measures a run state once, again only when the state changes", async () => {
    vi.mocked(ipc.workspaceDiffSize).mockResolvedValue({ files: 2, added: 5, removed: 1, base: "main", untrackedSkipped: 0 });
    const { ensure } = useDiffSizeStore.getState();
    ensure("r1", "paused", 10, "ws");
    ensure("r1", "paused", 10, "ws"); // in flight: no second call
    await vi.waitFor(() => expect(useDiffSizeStore.getState().byKey[diffSizeKey("r1", "paused", 10)]).toBeTruthy());
    ensure("r1", "paused", 10, "ws");
    await Promise.resolve();
    expect(ipc.workspaceDiffSize).toHaveBeenCalledTimes(1);
    ensure("r1", "completed", 30, "ws");
    await vi.waitFor(() => expect(ipc.workspaceDiffSize).toHaveBeenCalledTimes(2));
  });

  it("stores null — nothing to show — when the command fails or finds no worktree", async () => {
    vi.mocked(ipc.workspaceDiffSize).mockRejectedValueOnce(new Error("boom"));
    useDiffSizeStore.getState().ensure("r2", "completed", undefined, "ws");
    await vi.waitFor(() => expect(diffSizeKey("r2", "completed", undefined) in useDiffSizeStore.getState().byKey).toBe(true));
    expect(useDiffSizeStore.getState().byKey[diffSizeKey("r2", "completed", undefined)]).toBeNull();
  });

  it("labels the size and says what it was measured against", () => {
    expect(diffSizeLabel({ files: 6, added: 120, removed: 40, base: "main", untrackedSkipped: 0 })).toBe("+120 −40 · 6 files");
    expect(diffSizeLabel({ files: 1, added: 2000, removed: 0, base: "main", untrackedSkipped: 0 })).toBe("+2000 −0 · 1 file");
    expect(diffSizeLabel({ files: 0, added: 0, removed: 0, base: "main", untrackedSkipped: 0 })).toBe("no changes");
    expect(diffSizeTitle({ files: 0, added: 0, removed: 0, base: null, untrackedSkipped: 0 })).toBe("Uncommitted changes (no base branch): no changes");
  });

  it("orders smallest first with nothing-to-show runs last, keeping the oldest-first order among ties", () => {
    const runs = ["a", "b", "c", "d"];
    const sizes: Record<string, ReturnType<typeof sz> | null> = {
      a: sz(9, 900, 0),
      b: null,
      c: sz(1, 3, 1),
      d: sz(1, 3, 1),
    };
    expect(orderSettled(runs, "oldest", (r) => sizes[r])).toEqual(["a", "b", "c", "d"]);
    expect(orderSettled(runs, "smallest", (r) => sizes[r])).toEqual(["c", "d", "a", "b"]);
  });

  it("keeps the oldest-first order while any visible size is still loading", () => {
    const runs = ["a", "b", "c"];
    const sizes: Record<string, ReturnType<typeof sz> | null | undefined> = { a: sz(9, 900, 0), b: undefined, c: sz(1, 1, 0) };
    expect(orderSettled(runs, "smallest", (r) => sizes[r])).toEqual(["a", "b", "c"]);
    sizes.b = sz(2, 5, 0);
    expect(orderSettled(runs, "smallest", (r) => sizes[r])).toEqual(["c", "b", "a"]);
  });

  it("re-measures a run that pauses again (a new statusSince), not on the same pause", async () => {
    vi.mocked(ipc.workspaceDiffSize).mockResolvedValue(sz(1, 1, 0));
    const { ensure } = useDiffSizeStore.getState();
    ensure("r1", "paused", 100, "ws");
    await vi.waitFor(() => expect(diffSizeKey("r1", "paused", 100) in useDiffSizeStore.getState().byKey).toBe(true));
    ensure("r1", "paused", 100, "ws");
    ensure("r1", "paused", 200, "ws");
    await vi.waitFor(() => expect(ipc.workspaceDiffSize).toHaveBeenCalledTimes(2));
  });

  it("runs at most MAX_CONCURRENT_MEASURES diffs at once and queues the rest", async () => {
    const resolvers: ((v: unknown) => void)[] = [];
    vi.mocked(ipc.workspaceDiffSize).mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve as (v: unknown) => void)) as never,
    );
    const { ensure } = useDiffSizeStore.getState();
    for (let i = 0; i < 5; i++) ensure(`r${i}`, "completed", i, `ws${i}`);
    await vi.waitFor(() => expect(ipc.workspaceDiffSize).toHaveBeenCalledTimes(MAX_CONCURRENT_MEASURES));
    expect(MAX_CONCURRENT_MEASURES).toBe(2);
    resolvers[0](sz(1, 1, 0));
    await vi.waitFor(() => expect(ipc.workspaceDiffSize).toHaveBeenCalledTimes(3));
    expect(ipc.workspaceDiffSize).toHaveBeenLastCalledWith("ws2");
  });

  it("prune evicts sizes and queued measures of runs no longer shown", async () => {
    const resolvers: ((v: unknown) => void)[] = [];
    vi.mocked(ipc.workspaceDiffSize).mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve as (v: unknown) => void)) as never,
    );
    useDiffSizeStore.setState({ byKey: { [diffSizeKey("gone", "completed", 1)]: sz(1, 1, 0), [diffSizeKey("kept", "completed", 1)]: null } });
    const { ensure, prune } = useDiffSizeStore.getState();
    ensure("a", "completed", 1, "wa");
    ensure("b", "completed", 1, "wb");
    ensure("queued", "completed", 1, "wq"); // waits behind the two
    prune(["kept", "b"]);
    expect(Object.keys(useDiffSizeStore.getState().byKey)).toEqual([diffSizeKey("kept", "completed", 1)]);
    // "a" was measuring: its result is dropped; "queued" never runs.
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[0](sz(5, 5, 5));
    resolvers[1](sz(2, 2, 0));
    await vi.waitFor(() => expect(diffSizeKey("b", "completed", 1) in useDiffSizeStore.getState().byKey).toBe(true));
    expect(diffSizeKey("a", "completed", 1) in useDiffSizeStore.getState().byKey).toBe(false);
    expect(ipc.workspaceDiffSize).not.toHaveBeenCalledWith("wq");
  });
});
