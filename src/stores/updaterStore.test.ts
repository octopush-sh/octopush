import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { UpdateInfo } from "../lib/ipc";

const { ipcMock, relaunchMock } = vi.hoisted(() => ({
  ipcMock: {
    getUpdateChannel: vi.fn(),
    setUpdateChannel: vi.fn(),
    getSkippedUpdateVersion: vi.fn(),
    setSkippedUpdateVersion: vi.fn(),
    updaterCheck: vi.fn(),
    updaterInstall: vi.fn(),
  },
  relaunchMock: vi.fn(),
}));
vi.mock("../lib/ipc", () => ({ ipc: ipcMock }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: relaunchMock }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "1.3.0") }));

import { useUpdaterStore } from "./updaterStore";

const UPDATE: UpdateInfo = {
  version: "1.4.0",
  currentVersion: "1.3.0",
  date: "2026-10-30T06:00:00Z",
  body: "## Features\n- A thing",
  channel: "stable",
};

const INITIAL = useUpdaterStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  useUpdaterStore.setState({ ...INITIAL }, true);
  ipcMock.getUpdateChannel.mockResolvedValue("stable");
  ipcMock.getSkippedUpdateVersion.mockResolvedValue(null);
  ipcMock.setUpdateChannel.mockImplementation(async (c: string) => c);
  ipcMock.setSkippedUpdateVersion.mockResolvedValue(undefined);
  ipcMock.updaterCheck.mockResolvedValue(UPDATE);
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("updaterStore — check via IPC", () => {
  it("keeps the phase/update API shape", async () => {
    await useUpdaterStore.getState().checkForUpdates(true);
    const s = useUpdaterStore.getState();
    expect(s.phase).toBe("available");
    expect(s.update?.version).toBe("1.4.0");
    expect(s.lastCheckedAt).not.toBeNull();
  });

  it("reports no-update and keeps background failures silent", async () => {
    ipcMock.updaterCheck.mockResolvedValueOnce(null);
    await useUpdaterStore.getState().checkForUpdates(false);
    expect(useUpdaterStore.getState().phase).toBe("no-update");
    ipcMock.updaterCheck.mockRejectedValueOnce(new Error("offline"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await useUpdaterStore.getState().checkForUpdates(false);
    expect(useUpdaterStore.getState().phase).toBe("idle");
    expect(useUpdaterStore.getState().error).toBeNull();
    warn.mockRestore();
  });

  it("installs with progress through IPC, then relaunches", async () => {
    ipcMock.updaterInstall.mockImplementation(async (on: (e: unknown) => void) => {
      on({ event: "Started", data: { contentLength: 100 } });
      on({ event: "Progress", data: { chunkLength: 50 } });
      expect(useUpdaterStore.getState().progress).toBe(50);
      on({ event: "Finished" });
    });
    await useUpdaterStore.getState().checkForUpdates(true);
    await useUpdaterStore.getState().installAndRelaunch();
    expect(useUpdaterStore.getState().phase).toBe("installing");
    expect(relaunchMock).toHaveBeenCalled();
  });
});

describe("updaterStore — channel", () => {
  it("loads the persisted channel", async () => {
    ipcMock.getUpdateChannel.mockResolvedValue("beta");
    await useUpdaterStore.getState().loadPrefs();
    expect(useUpdaterStore.getState().channel).toBe("beta");
  });

  it("switching to beta persists and checks", async () => {
    await useUpdaterStore.getState().setChannel("beta");
    expect(ipcMock.setUpdateChannel).toHaveBeenCalledWith("beta");
    expect(ipcMock.updaterCheck).toHaveBeenCalledTimes(1);
    expect(useUpdaterStore.getState().channel).toBe("beta");
  });

  it("switching back to stable drops the offered beta (no downgrade)", async () => {
    useUpdaterStore.setState({ channel: "beta", phase: "available", update: { ...UPDATE, channel: "beta" }, alertOpen: true });
    ipcMock.updaterCheck.mockResolvedValue(null);
    await useUpdaterStore.getState().setChannel("stable");
    const s = useUpdaterStore.getState();
    expect(ipcMock.setUpdateChannel).toHaveBeenCalledWith("stable");
    expect(s.update).toBeNull();
    expect(s.alertOpen).toBe(false);
    expect(s.phase).toBe("no-update");
  });

  it("reverts the channel when persisting fails", async () => {
    ipcMock.setUpdateChannel.mockRejectedValueOnce(new Error("disk"));
    await useUpdaterStore.getState().setChannel("beta");
    expect(useUpdaterStore.getState().channel).toBe("stable");
    expect(ipcMock.updaterCheck).not.toHaveBeenCalled();
  });
});

describe("updaterStore — launch alert", () => {
  it("opens the alert when an update is available", async () => {
    await useUpdaterStore.getState().launchCheck();
    expect(useUpdaterStore.getState().alertOpen).toBe(true);
  });

  it("stays quiet when nothing is available or the check fails", async () => {
    ipcMock.updaterCheck.mockResolvedValueOnce(null);
    await useUpdaterStore.getState().launchCheck();
    expect(useUpdaterStore.getState().alertOpen).toBe(false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    ipcMock.updaterCheck.mockRejectedValueOnce(new Error("offline"));
    await useUpdaterStore.getState().launchCheck();
    expect(useUpdaterStore.getState().alertOpen).toBe(false);
    expect(useUpdaterStore.getState().phase).toBe("idle");
    warn.mockRestore();
  });

  it("does not alert for the skipped version, but does for a newer one", async () => {
    ipcMock.getSkippedUpdateVersion.mockResolvedValue("1.4.0");
    await useUpdaterStore.getState().launchCheck();
    expect(useUpdaterStore.getState().alertOpen).toBe(false);
    expect(useUpdaterStore.getState().dismissed).toBe(true);

    ipcMock.updaterCheck.mockResolvedValue({ ...UPDATE, version: "1.5.0" });
    await useUpdaterStore.getState().launchCheck();
    expect(useUpdaterStore.getState().alertOpen).toBe(true);
  });

  it("Skip this version persists it and closes the alert", async () => {
    await useUpdaterStore.getState().launchCheck();
    await useUpdaterStore.getState().skipVersion();
    expect(ipcMock.setSkippedUpdateVersion).toHaveBeenCalledWith("1.4.0");
    const s = useUpdaterStore.getState();
    expect(s.alertOpen).toBe(false);
    expect(s.skippedVersion).toBe("1.4.0");
    expect(s.dismissed).toBe(true);
  });

  it("Later closes it for this launch without persisting", async () => {
    await useUpdaterStore.getState().launchCheck();
    useUpdaterStore.getState().dismissAlert();
    expect(useUpdaterStore.getState().alertOpen).toBe(false);
    expect(useUpdaterStore.getState().dismissed).toBe(true);
    expect(ipcMock.setSkippedUpdateVersion).not.toHaveBeenCalled();
  });

  it("queues while another dialog is open, then shows", async () => {
    const other = document.createElement("div");
    other.setAttribute("role", "dialog");
    other.setAttribute("aria-modal", "true");
    document.body.appendChild(other);

    await useUpdaterStore.getState().launchCheck();
    expect(useUpdaterStore.getState().alertOpen).toBe(false);
    expect(useUpdaterStore.getState().alertPending).toBe(true);
    expect(useUpdaterStore.getState().flushAlert()).toBe(false);

    other.remove();
    expect(useUpdaterStore.getState().flushAlert()).toBe(true);
    expect(useUpdaterStore.getState().alertOpen).toBe(true);
    expect(useUpdaterStore.getState().alertPending).toBe(false);
  });
});

describe("updaterStore — races between checks and channel changes", () => {
  it("a beta check that finishes after switching to stable is ignored", async () => {
    useUpdaterStore.setState({ channel: "beta" });
    let resolveBeta!: (u: UpdateInfo) => void;
    ipcMock.updaterCheck.mockImplementationOnce(() => new Promise((r) => { resolveBeta = r; }));
    const betaCheck = useUpdaterStore.getState().checkForUpdates(false);
    ipcMock.updaterCheck.mockResolvedValueOnce(null); // stable: nothing newer
    await useUpdaterStore.getState().setChannel("stable");
    resolveBeta({ ...UPDATE, version: "1.5.0-beta", channel: "beta" });
    await betaCheck;
    const s = useUpdaterStore.getState();
    expect(s.channel).toBe("stable");
    expect(s.update).toBeNull();
    expect(s.phase).toBe("no-update");
  });

  it("concurrent checks share one IPC call", async () => {
    const a = useUpdaterStore.getState().checkForUpdates(false);
    const b = useUpdaterStore.getState().checkForUpdates(true);
    await Promise.all([a, b]);
    expect(ipcMock.updaterCheck).toHaveBeenCalledTimes(1);
  });

  it("the launch check alerts even when another check was already running", async () => {
    const running = useUpdaterStore.getState().checkForUpdates(false);
    await useUpdaterStore.getState().launchCheck();
    await running;
    const s = useUpdaterStore.getState();
    expect(s.alertOpen || s.alertPending).toBe(true);
  });

  it("a skipped version stays quiet on background checks after a channel switch", async () => {
    useUpdaterStore.setState({ skippedVersion: "1.4.0", channel: "beta" });
    await useUpdaterStore.getState().setChannel("stable");
    expect(useUpdaterStore.getState().update?.version).toBe("1.4.0");
    expect(useUpdaterStore.getState().dismissed).toBe(true);
  });

  it("a slow prefs read does not undo a channel the user just chose", async () => {
    let resolveRead!: (c: string) => void;
    ipcMock.getUpdateChannel.mockImplementationOnce(() => new Promise((r) => { resolveRead = r; }));
    const load = useUpdaterStore.getState().loadPrefs();
    await useUpdaterStore.getState().setChannel("beta");
    resolveRead("stable");
    await load;
    expect(useUpdaterStore.getState().channel).toBe("beta");
  });
});
