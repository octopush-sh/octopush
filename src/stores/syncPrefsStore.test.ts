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
});
