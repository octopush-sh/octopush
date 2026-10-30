/** syncPrefsStore — cloud sync opt-ins default OFF, and stay off on any failure. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getSyncPrefs = vi.fn();
const setSyncPref = vi.fn();
vi.mock("../lib/ipc", () => ({
  ipc: {
    getSyncPrefs: (...a: unknown[]) => getSyncPrefs(...a),
    setSyncPref: (...a: unknown[]) => setSyncPref(...a),
  },
}));

const { useSyncPrefsStore } = await import("./syncPrefsStore");

beforeEach(() => {
  useSyncPrefsStore.setState({
    historySync: false,
    librarySync: false,
    loaded: false,
    saving: null,
    error: null,
    justEnabled: {},
  });
  getSyncPrefs.mockReset();
  setSyncPref.mockReset();
});

describe("syncPrefsStore", () => {
  it("starts with both syncs off", () => {
    const s = useSyncPrefsStore.getState();
    expect(s.historySync).toBe(false);
    expect(s.librarySync).toBe(false);
  });

  it("an unreadable pref loads as off", async () => {
    useSyncPrefsStore.setState({ historySync: true });
    getSyncPrefs.mockRejectedValue(new Error("boom"));
    await useSyncPrefsStore.getState().load();
    expect(useSyncPrefsStore.getState().historySync).toBe(false);
    expect(useSyncPrefsStore.getState().loaded).toBe(true);
  });

  it("setPref persists and mirrors the backend's answer", async () => {
    setSyncPref.mockResolvedValue({ historySync: false, librarySync: true });
    expect(await useSyncPrefsStore.getState().setPref("library", true)).toBe(true);
    expect(setSyncPref).toHaveBeenCalledWith("library", true);
    expect(useSyncPrefsStore.getState().librarySync).toBe(true);
  });

  it("a refused turn-on (e.g. not Pro) leaves it off and records the error", async () => {
    setSyncPref.mockRejectedValue("UpgradeRequired");
    expect(await useSyncPrefsStore.getState().setPref("history", true)).toBe(false);
    expect(useSyncPrefsStore.getState().historySync).toBe(false);
    expect(useSyncPrefsStore.getState().error).toContain("UpgradeRequired");
  });

  it("a load that resolves after a write never overwrites the written value", async () => {
    let resolveLoad: (v: unknown) => void = () => {};
    getSyncPrefs.mockReturnValue(new Promise((r) => (resolveLoad = r)));
    setSyncPref.mockResolvedValue({ historySync: true, librarySync: false });
    const loading = useSyncPrefsStore.getState().load();
    await useSyncPrefsStore.getState().setPref("history", true);
    resolveLoad({ historySync: false, librarySync: false }); // stale answer
    await loading;
    expect(useSyncPrefsStore.getState().historySync).toBe(true);
  });

  it("load is skipped while a write is in flight", async () => {
    useSyncPrefsStore.setState({ saving: "history" });
    await useSyncPrefsStore.getState().load();
    expect(getSyncPrefs).not.toHaveBeenCalled();
  });

  it("marks a kind just enabled exactly once (drives the first-backfill toast)", async () => {
    setSyncPref.mockResolvedValue({ historySync: true, librarySync: false });
    await useSyncPrefsStore.getState().setPref("history", true);
    expect(useSyncPrefsStore.getState().consumeJustEnabled("history")).toBe(true);
    expect(useSyncPrefsStore.getState().consumeJustEnabled("history")).toBe(false);
    expect(useSyncPrefsStore.getState().consumeJustEnabled("library")).toBe(false);
  });
});
