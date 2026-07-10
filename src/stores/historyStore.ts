import { create } from "zustand";
import { ipc, type SyncedRun } from "../lib/ipc";

/** Cross-machine run history (Pro-real Part B / B1). Holds the read-only mirror
 *  of the signed-in Pro user's Direct-run history synced from the cloud, plus the
 *  open/loading state for the global History sheet.
 *
 *  The Pro-vs-upgrade decision lives at the trigger (the top-bar button) — this
 *  store is only opened once the user is entitled, so its network calls never hit
 *  the upgrade path in the normal flow. */
interface HistoryState {
  open: boolean;
  runs: SyncedRun[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  /** Open the sheet: paint the local mirror instantly, then refresh from cloud. */
  openSheet: () => Promise<void>;
  close: () => void;
  /** Pull from the cloud and replace the mirror (drives the Refresh button). */
  refresh: () => Promise<void>;
  /** Once-per-launch backfill push + pull. Best-effort/silent; Pro-only (the
   *  caller gates on the entitlement). */
  syncOnLaunch: () => Promise<void>;
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  open: false,
  runs: [],
  loading: false,
  loaded: false,
  error: null,

  openSheet: async () => {
    set({ open: true });
    // Instant paint from the local mirror (no network) the first time.
    if (!get().loaded) {
      try {
        set({ runs: await ipc.historyList(), loaded: true });
      } catch {
        // Empty mirror is fine — the refresh below fills it.
      }
    }
    await get().refresh();
  },

  close: () => set({ open: false }),

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const runs = await ipc.historySyncPull();
      set({ runs, loading: false, loaded: true });
    } catch (e) {
      set({ loading: false, error: String(e) });
    }
  },

  syncOnLaunch: async () => {
    try {
      await ipc.historySyncPushAll();
      const runs = await ipc.historySyncPull();
      set({ runs, loaded: true });
    } catch {
      // Offline / not entitled → leave the mirror as-is; History opens on demand.
    }
  },
}));
