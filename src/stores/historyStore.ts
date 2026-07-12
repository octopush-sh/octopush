import { create } from "zustand";
import { ipc, type SyncedRun, type SyncedRunDetail } from "../lib/ipc";

/** Cross-machine run history (Pro-real Part B). Holds the read-only mirror of
 *  the signed-in Pro user's Direct-run history synced from the cloud (B1), the
 *  open/loading state for the global History sheet, and the lazily-fetched
 *  per-run detail — journals · artifacts · diffs — for the drill-in view (B2).
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
  /** The run whose detail the sheet is showing; null = the list. */
  viewedRunId: string | null;
  /** Session cache of fetched details. `null` = the server has none for that
   *  run (synced before B2 / its detail push failed) — an honest empty state. */
  detailByRun: Record<string, SyncedRunDetail | null>;
  /** The runId whose detail fetch is in flight, or null. Keyed — a stale
   *  fetch settling must never dress a DIFFERENT viewed run in its outcome. */
  detailLoading: string | null;
  detailError: string | null;
  /** Open the sheet: paint the local mirror instantly, then refresh from cloud. */
  openSheet: () => Promise<void>;
  close: () => void;
  /** Pull from the cloud and replace the mirror (drives the Refresh button). */
  refresh: () => Promise<void>;
  /** Once-per-launch backfill push + pull. Best-effort/silent; Pro-only (the
   *  caller gates on the entitlement). */
  syncOnLaunch: () => Promise<void>;
  /** Drill into one run — serves the cached detail instantly, else fetches. */
  openRun: (runId: string) => Promise<void>;
  /** Back to the list (keeps the cache). */
  closeRun: () => void;
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  open: false,
  runs: [],
  loading: false,
  loaded: false,
  error: null,
  viewedRunId: null,
  detailByRun: {},
  detailLoading: null,
  detailError: null,

  openSheet: async () => {
    set({ open: true, viewedRunId: null });
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

  close: () => set({ open: false, viewedRunId: null, detailError: null }),

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

  openRun: async (runId) => {
    set({ viewedRunId: runId, detailError: null });
    if (runId in get().detailByRun) return; // cached (incl. a cached "none")
    set({ detailLoading: runId });
    try {
      const detail = await ipc.historyRunDetail(runId);
      set((s) => ({
        detailByRun: { ...s.detailByRun, [runId]: detail }, // cache always
        // Only release the spinner if this fetch is still the one in flight.
        detailLoading: s.detailLoading === runId ? null : s.detailLoading,
      }));
    } catch (e) {
      // Fetch failed (offline / transient) — honest error, NOT cached, so
      // re-opening retries. A stale failure never dresses another run.
      set((s) => ({
        detailLoading: s.detailLoading === runId ? null : s.detailLoading,
        detailError: s.viewedRunId === runId ? String(e) : s.detailError,
      }));
    }
  },

  closeRun: () => set({ viewedRunId: null, detailError: null }),
}));
