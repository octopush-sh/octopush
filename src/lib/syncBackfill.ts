import { ipc } from "./ipc";
import type { SyncKind } from "./types";
import { pushToast } from "../components/Toasts";
import { useHistoryStore } from "../stores/historyStore";
import { usePipelineStore } from "../stores/pipelineStore";
import { useRolesStore } from "../stores/rolesStore";
import { useSyncPrefsStore } from "../stores/syncPrefsStore";

/** The one-shot cloud backfill for a sync kind — run on launch while the sync
 *  is on, and the moment the user turns it on. **Single-flight per kind:** a
 *  rapid on/off/on (or launch racing a toggle) shares the in-flight run instead
 *  of starting a second one. With `announce` (the first run after turning the
 *  sync on) the outcome is toasted; on launch it stays silent. The Rust core
 *  re-checks the opt-in before every request, so turning sync off mid-run
 *  stops what's left. */
const inflight: Partial<Record<SyncKind, Promise<void>>> = {};

const isOn = (kind: SyncKind) =>
  kind === "history"
    ? useSyncPrefsStore.getState().historySync
    : useSyncPrefsStore.getState().librarySync;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

async function backfillLibrary(): Promise<number> {
  const pushed = await ipc.librarySyncPushAll();
  const applied = await ipc.librarySyncPull();
  if (applied > 0) {
    await usePipelineStore.getState().load();
    await useRolesStore.getState().load();
  }
  return pushed;
}

export function runSyncBackfill(kind: SyncKind, opts: { announce?: boolean } = {}): Promise<void> {
  const existing = inflight[kind];
  if (existing) return existing;
  const announce = !!opts.announce;
  const run = (async () => {
    try {
      const pushed =
        kind === "history" ? await useHistoryStore.getState().backfill() : await backfillLibrary();
      if (announce && isOn(kind)) {
        pushToast({
          level: "success",
          title: kind === "history" ? "Run history is syncing" : "Library is syncing",
          body:
            kind === "history"
              ? `${plural(pushed, "run")} from this Mac uploaded.`
              : `${plural(pushed, "custom pipeline/role item")} from this Mac uploaded.`,
        });
      }
    } catch (e) {
      if (announce && isOn(kind)) {
        pushToast({
          level: "error",
          title: kind === "history" ? "Couldn't sync your run history" : "Couldn't sync your library",
          body: `Sync stays on and retries at the next launch. ${String(e)}`,
        });
      }
      // Launch: silent — offline just means it syncs on a later launch.
    } finally {
      delete inflight[kind];
    }
  })();
  inflight[kind] = run;
  return run;
}
