import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { SyncKind, SyncPrefs } from "../lib/types";

/** The user's cloud-sync opt-ins (Settings › Account › Sync). Both are **off by
 *  default** — including for existing users who never chose — and the Rust core
 *  re-checks them before every upload/download, so this store only drives UX:
 *  the toggles, and the App-level effects that run the one-shot backfill once a
 *  sync is turned on (and on each launch while it stays on).
 *
 *  Persisted in `~/.octopush/settings.json` (`historySyncEnabled` /
 *  `librarySyncEnabled`) via `get_sync_prefs` / `set_sync_pref`. */
interface SyncPrefsState extends SyncPrefs {
  loaded: boolean;
  /** The kind whose write is in flight, or null. */
  saving: SyncKind | null;
  error: string | null;
  load: () => Promise<void>;
  /** Persist one toggle. Returns true on success. On failure the toggle stays
   *  where it was and `error` says why (e.g. Pro required). */
  setPref: (kind: SyncKind, enabled: boolean) => Promise<boolean>;
}

const OFF: SyncPrefs = { historySync: false, librarySync: false };

export const useSyncPrefsStore = create<SyncPrefsState>((set) => ({
  ...OFF,
  loaded: false,
  saving: null,
  error: null,

  load: async () => {
    try {
      const prefs = await ipc.getSyncPrefs();
      set({ historySync: !!prefs.historySync, librarySync: !!prefs.librarySync, loaded: true });
    } catch {
      // Unreadable ⇒ treat as off (sync never turns itself on).
      set({ ...OFF, loaded: true });
    }
  },

  setPref: async (kind, enabled) => {
    set({ saving: kind, error: null });
    try {
      const prefs = await ipc.setSyncPref(kind, enabled);
      set({
        historySync: !!prefs.historySync,
        librarySync: !!prefs.librarySync,
        saving: null,
        loaded: true,
      });
      return true;
    } catch (e) {
      set({ saving: null, error: String(e) });
      return false;
    }
  },
}));
