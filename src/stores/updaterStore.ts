/**
 * Updater state — shared between the launch alert (UpdateAlert), the
 * always-on auto-check (UpdateNotifier toast) and any user-driven "Check for
 * updates" surfaces (Settings › About, Command Palette).
 *
 * Single source of truth so a manual check and the auto-poll never
 * disagree, and so multiple UI surfaces can read the same "downloading
 * 45%" progress without re-fetching the manifest.
 *
 * The check / download / install run in Rust (`updater_check` /
 * `updater_install`) so the manifest follows the user's update channel
 * (stable = tauri.conf.json endpoints, beta = the beta manifest).
 */

import { create } from "zustand";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { ipc, type UpdateChannel, type UpdateInfo } from "../lib/ipc";
import { isModalOpen } from "../components/ModalShell";
import { rememberInstalledNotes } from "../lib/releaseNotes";

export type { UpdateChannel, UpdateInfo };

export type UpdaterPhase =
  | "idle"
  | "checking"
  | "available"
  | "no-update" // we just checked and there's nothing
  | "downloading"
  | "installing"
  | "error";

/** True while any dialog is on screen — a ModalShell (checkpoint gates,
 *  confirms, palettes…) or any other `aria-modal` surface. The launch alert
 *  waits for none to be open. */
export function isBlockingSurfaceOpen(): boolean {
  if (isModalOpen()) return true;
  if (typeof document === "undefined") return false;
  return document.querySelector('[aria-modal="true"]') !== null;
}

interface UpdaterState {
  phase: UpdaterPhase;
  /** The update found by the last check, when one is available. */
  update: UpdateInfo | null;
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

  /** Persisted update channel (Settings › About). */
  channel: UpdateChannel;
  /** Persisted "Skip this version" choice from the launch alert. */
  skippedVersion: string | null;
  /** The launch alert wants to show but a dialog is open — retried by
   *  `flushAlert()` until none is. */
  alertPending: boolean;
  /** The launch alert dialog is on screen. */
  alertOpen: boolean;

  /** Run a check against the current channel's manifest. `interactive`
   *  marks the check as user-initiated, which affects what "no-update"
   *  surfaces (the toast stays silent for auto-checks; the Settings panel
   *  shows a confirmation for interactive ones). */
  checkForUpdates: (interactive: boolean) => Promise<void>;
  /** Download + install the available update, then relaunch. */
  installAndRelaunch: () => Promise<void>;
  /** Hide the toast for the current version without forgetting it. */
  dismiss: () => void;

  /** Load the persisted channel + skipped version. */
  loadPrefs: () => Promise<void>;
  /** Persist a channel. Beta triggers a check; stable drops any offered
   *  beta (it never downgrades) and re-checks quietly. */
  setChannel: (channel: UpdateChannel) => Promise<void>;
  /** The silent launch check: alerts when an update is available and isn't
   *  the skipped version. Failures stay silent. */
  launchCheck: () => Promise<void>;
  /** Open the queued alert if no dialog is open. Returns whether it opened. */
  flushAlert: () => boolean;
  /** "Later" — close the alert (and the toast) for this launch. */
  dismissAlert: () => void;
  /** "Skip this version" — persist it and close the alert. */
  skipVersion: () => Promise<void>;
}

/** Bumped when the channel changes: a check started under an older
 *  generation finishes into the void instead of overwriting newer state. */
let checkGeneration = 0;
/** The running check, so concurrent callers share it instead of racing. */
let inflight: Promise<void> | null = null;
/** Bumped by every local prefs change, so a slower disk read can't undo it. */
let prefsEpoch = 0;

export const useUpdaterStore = create<UpdaterState>((set, get) => ({
  phase: "idle",
  update: null,
  progress: 0,
  error: null,
  dismissed: false,
  lastCheckedAt: null,
  currentVersion: null,
  channel: "stable",
  skippedVersion: null,
  alertPending: false,
  alertOpen: false,

  checkForUpdates: (interactive) => {
    // Never check while installing; share a check that is already running
    // (button mashing, the About mount check and the launch check overlap).
    if (get().phase === "downloading" || get().phase === "installing") return Promise.resolve();
    if (inflight) return inflight;
    const gen = checkGeneration;
    const run = (async () => {
    set({ phase: "checking", error: null });
    // Best-effort version lookup; harmless if it fails.
    if (!get().currentVersion) {
      getVersion()
        .then((v) => set({ currentVersion: v }))
        .catch(() => {});
    }
    try {
      const result = await ipc.updaterCheck();
      if (gen !== checkGeneration) return; // the channel changed meanwhile
      const now = Date.now();
      if (result && result.channel !== get().channel) {
        set({ phase: "no-update", update: null, lastCheckedAt: now });
      } else if (result) {
        const isNew = get().update?.version !== result.version;
        // A skipped version stays quiet unless the user asked to check.
        const skipped = !interactive && result.version === get().skippedVersion;
        set({
          phase: "available",
          update: result,
          dismissed: isNew ? skipped : get().dismissed,
          lastCheckedAt: now,
        });
      } else {
        set({ phase: "no-update", update: null, lastCheckedAt: now });
      }
    } catch (e) {
      if (gen !== checkGeneration) return;
      if (interactive) {
        set({ phase: "error", error: String(e) });
      } else {
        // Silent failure for background checks — log and reset.
        console.warn("update check failed:", e);
        set({ phase: "idle", error: null });
      }
    }
    })().finally(() => {
      if (inflight === run) inflight = null;
    });
    inflight = run;
    return run;
  },

  installAndRelaunch: async () => {
    const update = get().update;
    if (!update) return;
    set({ phase: "downloading", progress: 0, error: null });
    try {
      let downloaded = 0;
      let total = 0;
      // Keep the notes so About can show "this version" after the relaunch.
      rememberInstalledNotes(update.version, update.body);
      await ipc.updaterInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? 0;
            break;
          case "Progress":
            downloaded += event.data.chunkLength;
            if (total > 0) {
              set({ progress: Math.min(100, Math.round((downloaded / total) * 100)) });
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

  loadPrefs: async () => {
    const epoch = prefsEpoch;
    const [channel, skippedVersion] = await Promise.all([
      ipc.getUpdateChannel().catch(() => "stable" as UpdateChannel),
      ipc.getSkippedUpdateVersion().catch(() => null),
    ]);
    if (epoch !== prefsEpoch) return; // changed locally while reading
    set({ channel: channel === "beta" ? "beta" : "stable", skippedVersion });
  },

  setChannel: async (channel) => {
    if (get().channel === channel) return;
    const previous = get().channel;
    prefsEpoch++;
    // Results of checks against the old channel are now stale.
    checkGeneration++;
    inflight = null;
    set({ channel });
    try {
      await ipc.setUpdateChannel(channel);
    } catch (e) {
      set({ channel: previous, phase: "error", error: String(e), update: null });
      return;
    }
    const busy = get().phase === "downloading" || get().phase === "installing";
    if (busy) return;
    if (channel === "beta") {
      await get().checkForUpdates(true);
    } else {
      // Stop offering the beta; a stable check never downgrades.
      set({ phase: "idle", update: null, error: null, alertPending: false, alertOpen: false });
      await get().checkForUpdates(false);
    }
  },

  launchCheck: async () => {
    await get().loadPrefs().catch(() => {});
    await get().checkForUpdates(false);
    const { phase, update, skippedVersion } = get();
    if (phase !== "available" || !update) return;
    if (skippedVersion && skippedVersion === update.version) {
      // Skipped: the toast stays quiet for it too.
      set({ dismissed: true });
      return;
    }
    set({ alertPending: true });
    get().flushAlert();
  },

  flushAlert: () => {
    const { alertPending, update } = get();
    if (!alertPending) return false;
    if (!update) {
      set({ alertPending: false });
      return false;
    }
    if (isBlockingSurfaceOpen()) return false;
    set({ alertPending: false, alertOpen: true });
    return true;
  },

  dismissAlert: () => set({ alertOpen: false, alertPending: false, dismissed: true }),

  skipVersion: async () => {
    const version = get().update?.version ?? null;
    prefsEpoch++;
    set({ alertOpen: false, alertPending: false, dismissed: true, skippedVersion: version });
    try {
      await ipc.setSkippedUpdateVersion(version);
    } catch (e) {
      console.warn("could not persist skipped version:", e);
    }
  },
}));
