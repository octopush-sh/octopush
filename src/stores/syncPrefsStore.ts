import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { SyncKind, SyncPrefs } from "../lib/types";

/** The signed-in user's cloud-sync opt-ins (Settings › Account › Sync). Both
 *  are **off by default** — including for existing users who never chose — and
 *  bound to the account that granted them (another user signing in on this Mac
 *  sees them off). The Rust core re-checks them before every upload/download,
 *  so this store only drives UX: the toggles, and the App-level effects that
 *  run the one-shot backfill once a sync is turned on (and on each launch
 *  while it stays on).
 *
 *  Persisted in `~/.octopush/settings.json` via `get_sync_prefs` /
 *  `set_sync_pref` — the only writer of those fields. */
interface SyncPrefsState extends SyncPrefs {
  loaded: boolean;
  /** The kind whose write is in flight, or null. */
  saving: SyncKind | null;
  error: string | null;
  /** Kinds the user turned ON in this session whose first backfill hasn't
   *  run yet — that run's outcome gets a toast. */
  justEnabled: Partial<Record<SyncKind, boolean>>;
  load: () => Promise<void>;
  /** Persist one toggle. Returns true on success. On failure the toggle stays
   *  where it was and `error` says why (e.g. Pro required). */
  setPref: (kind: SyncKind, enabled: boolean) => Promise<boolean>;
  /** Read-and-clear the "just turned on" mark for `kind`. */
  consumeJustEnabled: (kind: SyncKind) => boolean;
}

const OFF: SyncPrefs = { historySync: false, librarySync: false };

/** Bumped by every write, so a load that started before a write can never
 *  overwrite the value the write just set. */
let writeSeq = 0;

export const useSyncPrefsStore = create<SyncPrefsState>((set, get) => ({
  ...OFF,
  loaded: false,
  saving: null,
  error: null,
  justEnabled: {},

  load: async () => {
    if (get().saving) return; // a write is in flight — its answer wins
    const seq = writeSeq;
    let prefs: SyncPrefs;
    try {
      prefs = await ipc.getSyncPrefs();
    } catch {
      prefs = OFF; // unreadable ⇒ off (sync never turns itself on)
    }
    if (seq !== writeSeq) return; // a write landed meanwhile — keep it
    set({ historySync: !!prefs.historySync, librarySync: !!prefs.librarySync, loaded: true });
  },

  setPref: async (kind, enabled) => {
    writeSeq++;
    set({ saving: kind, error: null });
    try {
      const prefs = await ipc.setSyncPref(kind, enabled);
      writeSeq++;
      set((s) => ({
        historySync: !!prefs.historySync,
        librarySync: !!prefs.librarySync,
        saving: null,
        loaded: true,
        justEnabled: { ...s.justEnabled, [kind]: enabled },
      }));
      return true;
    } catch (e) {
      set({ saving: null, error: String(e) });
      return false;
    }
  },

  consumeJustEnabled: (kind) => {
    const was = !!get().justEnabled[kind];
    if (was) set((s) => ({ justEnabled: { ...s.justEnabled, [kind]: false } }));
    return was;
  },
}));
