/** runSyncBackfill — the first backfill after turning sync on reports its
 *  outcome (toast); launch runs stay silent; concurrent runs share one flight. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const pushToast = vi.fn();
vi.mock("../components/Toasts", () => ({ pushToast: (t: unknown) => pushToast(t) }));

const historySyncPushAll = vi.fn();
const historySyncPull = vi.fn();
const librarySyncPushAll = vi.fn();
const librarySyncPull = vi.fn();
vi.mock("./ipc", () => ({
  ipc: {
    historySyncPushAll: () => historySyncPushAll(),
    historySyncPull: () => historySyncPull(),
    librarySyncPushAll: () => librarySyncPushAll(),
    librarySyncPull: () => librarySyncPull(),
  },
}));
vi.mock("../stores/pipelineStore", () => ({
  usePipelineStore: { getState: () => ({ load: vi.fn() }) },
}));
vi.mock("../stores/rolesStore", () => ({
  useRolesStore: { getState: () => ({ load: vi.fn() }) },
}));

const { runSyncBackfill } = await import("./syncBackfill");
const { useSyncPrefsStore } = await import("../stores/syncPrefsStore");

beforeEach(() => {
  pushToast.mockReset();
  for (const m of [historySyncPushAll, historySyncPull, librarySyncPushAll, librarySyncPull]) m.mockReset();
  historySyncPull.mockResolvedValue([]);
  librarySyncPull.mockResolvedValue(0);
  useSyncPrefsStore.setState({ historySync: true, librarySync: true });
});

describe("runSyncBackfill", () => {
  it("toasts a failure of the first backfill after enabling", async () => {
    historySyncPushAll.mockRejectedValue("Couldn't reach Octopush's sync service");
    await runSyncBackfill("history", { announce: true });
    expect(pushToast).toHaveBeenCalledOnce();
    expect(pushToast.mock.calls[0][0]).toMatchObject({
      level: "error",
      title: "Couldn't sync your run history",
    });
  });

  it("toasts the library failure too", async () => {
    librarySyncPushAll.mockRejectedValue("offline");
    await runSyncBackfill("library", { announce: true });
    expect(pushToast.mock.calls[0][0]).toMatchObject({
      level: "error",
      title: "Couldn't sync your library",
    });
  });

  it("confirms a successful first backfill", async () => {
    historySyncPushAll.mockResolvedValue(3);
    await runSyncBackfill("history", { announce: true });
    expect(pushToast.mock.calls[0][0]).toMatchObject({
      level: "success",
      body: "3 runs from this Mac uploaded.",
    });
  });

  it("stays silent on launch (no announce), success or failure", async () => {
    historySyncPushAll.mockRejectedValue("offline");
    await runSyncBackfill("history");
    librarySyncPushAll.mockResolvedValue(2);
    await runSyncBackfill("library");
    expect(pushToast).not.toHaveBeenCalled();
  });

  it("says nothing if the user turned sync off while it ran", async () => {
    historySyncPushAll.mockImplementation(async () => {
      useSyncPrefsStore.setState({ historySync: false });
      throw "disabled";
    });
    await runSyncBackfill("history", { announce: true });
    expect(pushToast).not.toHaveBeenCalled();
  });

  it("rapid on/off/on shares one in-flight backfill instead of starting two", async () => {
    let release: (n: number) => void = () => {};
    historySyncPushAll.mockReturnValue(new Promise((r) => (release = r)));
    const a = runSyncBackfill("history", { announce: true });
    const b = runSyncBackfill("history", { announce: true });
    expect(b).toBe(a);
    release(1);
    await a;
    expect(historySyncPushAll).toHaveBeenCalledOnce();
    // After it settles, a new turn-on starts a fresh run.
    historySyncPushAll.mockResolvedValue(0);
    await runSyncBackfill("history");
    expect(historySyncPushAll).toHaveBeenCalledTimes(2);
  });
});
