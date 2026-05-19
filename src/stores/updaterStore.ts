/**
 * Updater state — shared between the always-on auto-check (UpdateNotifier
 * toast) and any user-driven "Check for updates" surfaces (Settings,
 * Command Palette).
 *
 * Single source of truth so a manual check and the auto-poll never
 * disagree, and so multiple UI surfaces can read the same "downloading
 * 45%" progress without re-fetching the manifest.
 */

import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

export type UpdaterPhase =
  | "idle"
  | "checking"
  | "available"
  | "no-update" // we just checked and there's nothing
  | "downloading"
  | "installing"
  | "error";

interface UpdaterState {
  phase: UpdaterPhase;
  /** The Update handle returned by `check()` when one is available. */
  update: Update | null;
  /** Download progress as a percent 0..100. */
  progress: number;
  /** Last error message surfaced to the UI; cleared on next check(). */
  error: string | null;
  /** User has dismissed the current "available" notification; suppresses
   *  the toast until a NEW version is found. */
  dismissed: boolean;
  /** When the most recent successful check completed (Date.now() ms). */
  lastCheckedAt: number | null;
  /** The currently-running Octopush version, looked up once on first check. */
  currentVersion: string | null;

  /** Run a check against the configured updater endpoint. `interactive`
   *  marks the check as user-initiated, which affects what "no-update"
   *  surfaces (the toast stays silent for auto-checks; the Settings panel
   *  shows a confirmation for interactive ones). */
  checkForUpdates: (interactive: boolean) => Promise<void>;
  /** Download + install the available update, then relaunch. */
  installAndRelaunch: () => Promise<void>;
  /** Hide the toast for the current version without forgetting it. */
  dismiss: () => void;
}

export const useUpdaterStore = create<UpdaterState>((set, get) => ({
  phase: "idle",
  update: null,
  progress: 0,
  error: null,
  dismissed: false,
  lastCheckedAt: null,
  currentVersion: null,

  checkForUpdates: async (interactive) => {
    // Avoid stacked checks if the user mashes the button.
    if (
      get().phase === "checking" ||
      get().phase === "downloading" ||
      get().phase === "installing"
    ) {
      return;
    }
    set({ phase: "checking", error: null });
    // Best-effort version lookup; harmless if it fails.
    if (!get().currentVersion) {
      getVersion()
        .then((v) => set({ currentVersion: v }))
        .catch(() => {});
    }
    try {
      const result = await check();
      const now = Date.now();
      if (result?.available) {
        set({
          phase: "available",
          update: result,
          dismissed: false,
          lastCheckedAt: now,
        });
      } else {
        set({
          phase: "no-update",
          update: null,
          lastCheckedAt: now,
        });
      }
    } catch (e) {
      if (interactive) {
        set({ phase: "error", error: String(e) });
      } else {
        // Silent failure for background checks — log and reset.
        console.warn("update check failed:", e);
        set({ phase: "idle", error: null });
      }
    }
  },

  installAndRelaunch: async () => {
    const update = get().update;
    if (!update) return;
    set({ phase: "downloading", progress: 0, error: null });
    try {
      let downloaded = 0;
      let total = 0;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? 0;
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            if (total > 0) {
              set({ progress: Math.round((downloaded / total) * 100) });
            }
            break;
          case "Finished":
            set({ phase: "installing", progress: 100 });
            break;
        }
      });
      await relaunch();
    } catch (e) {
      console.error("update install failed:", e);
      set({ phase: "error", error: String(e), progress: 0 });
    }
  },

  dismiss: () => set({ dismissed: true }),
}));
