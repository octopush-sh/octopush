import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTips } from "./whatsNew";
import { runLaunchCheck, updateAlertVisible } from "./whatsNewLaunch";
import { useWhatsNewPrefs, useWhatsNewStore } from "../stores/whatsNewStore";

const cs = (title: string, kind = "feature") => `---\ntitle: ${title}\nkind: ${kind}\narea: app\n---\n${title} body.\n`;
const ALL = buildTips({
  "/whats-new/0.4.89/a.md": cs("A"),
  "/whats-new/0.4.90/b.md": cs("B"),
  "/whats-new/0.4.91/fix.md": cs("Quiet fix", "fix"),
});
const tips = () => ALL;

beforeEach(() => {
  localStorage.clear();
  useWhatsNewPrefs.setState({ lastSeenVersion: null });
  useWhatsNewStore.getState().close();
});

describe("runLaunchCheck", () => {
  it("an existing install without lastSeen still sees this version's tips", async () => {
    localStorage.setItem("octo-workspace-prefs", "{}");
    const r = await runLaunchCheck({ version: async () => "0.4.90", tips, canOpen: () => true });
    expect(r).toBe("opened");
    expect(useWhatsNewStore.getState().tips.map((t) => t.title)).toEqual(["B"]);
  });

  it("stops waiting once the user opened the dialog by hand", async () => {
    useWhatsNewPrefs.setState({ lastSeenVersion: "0.4.89" });
    let free = false;
    const p = runLaunchCheck({ version: async () => "0.4.90", tips, canOpen: () => free, pollMs: 5 });
    await new Promise((r) => setTimeout(r, 15));
    useWhatsNewStore.getState().open(ALL[0].tips);
    useWhatsNewStore.getState().close();
    free = true;
    expect(await p).toBe("silent");
    expect(useWhatsNewStore.getState().phase).toBe("closed");
    expect(useWhatsNewPrefs.getState().lastSeenVersion).toBe("0.4.90");
  });

  it("fresh install: records the version, opens nothing", async () => {
    const r = await runLaunchCheck({ version: async () => "0.4.90", tips, canOpen: () => true });
    expect(r).toBe("silent");
    expect(useWhatsNewStore.getState().phase).toBe("closed");
    expect(useWhatsNewPrefs.getState().lastSeenVersion).toBe("0.4.90");
  });

  it("upgrade across two versions: opens with both versions' tips, then marks seen", async () => {
    useWhatsNewPrefs.setState({ lastSeenVersion: "0.4.88" });
    const r = await runLaunchCheck({ version: async () => "0.4.90", tips, canOpen: () => true });
    expect(r).toBe("opened");
    const s = useWhatsNewStore.getState();
    expect(s.phase).toBe("modal");
    expect(s.tips.map((t) => t.title)).toEqual(["A", "B"]);
    expect(useWhatsNewPrefs.getState().lastSeenVersion).toBe("0.4.90");
  });

  it("upgrade with no tips in range: silent, still marks seen", async () => {
    useWhatsNewPrefs.setState({ lastSeenVersion: "0.4.90" });
    const r = await runLaunchCheck({ version: async () => "0.4.91", tips, canOpen: () => true });
    expect(r).toBe("silent");
    expect(useWhatsNewStore.getState().phase).toBe("closed");
    expect(useWhatsNewPrefs.getState().lastSeenVersion).toBe("0.4.91");
  });

  it("waits while something else holds the screen, and only marks seen once it opens", async () => {
    useWhatsNewPrefs.setState({ lastSeenVersion: "0.4.89" });
    let free = false;
    const p = runLaunchCheck({ version: async () => "0.4.90", tips, canOpen: () => free, pollMs: 5 });
    await new Promise((r) => setTimeout(r, 30));
    expect(useWhatsNewStore.getState().phase).toBe("closed");
    expect(useWhatsNewPrefs.getState().lastSeenVersion).toBe("0.4.89");
    free = true;
    await p;
    expect(useWhatsNewStore.getState().phase).toBe("modal");
    expect(useWhatsNewPrefs.getState().lastSeenVersion).toBe("0.4.90");
  });

  it("no version available (no Tauri): silent and untouched", async () => {
    const r = await runLaunchCheck({ version: vi.fn().mockRejectedValue(new Error("no tauri")), tips });
    expect(r).toBe("silent");
    expect(useWhatsNewPrefs.getState().lastSeenVersion).toBeNull();
  });

  it("persists lastSeenVersion to localStorage", async () => {
    await runLaunchCheck({ version: async () => "0.4.90", tips, canOpen: () => true });
    expect(localStorage.getItem("octo-whats-new")).toContain("0.4.90");
  });
});

describe("updateAlertVisible", () => {
  it("mirrors the update notifier's rule", () => {
    const u = {};
    expect(updateAlertVisible({ phase: "available", update: u, dismissed: false })).toBe(true);
    expect(updateAlertVisible({ phase: "available", update: u, dismissed: true })).toBe(false);
    expect(updateAlertVisible({ phase: "downloading", update: u, dismissed: true })).toBe(true);
    expect(updateAlertVisible({ phase: "no-update", update: null, dismissed: false })).toBe(false);
  });
});
