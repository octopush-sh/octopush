import { create } from "zustand";
import { ipc } from "../lib/ipc";
import { langForExtension } from "../lib/editorLang";
import { pushToast } from "../components/Toasts";

const LARGE_WARN_BYTES = 2 * 1024 * 1024;

export type BinaryReason = "binary" | "unsupportedEncoding";

export interface OpenFile {
  path: string;
  content: string;        // "" for binary
  savedContent: string;   // "" for binary
  lang: string;
  kind: "text" | "binary";
  binaryReason?: BinaryReason;
  mtime: number;
  size: number;
  /** Bumped whenever the buffer is replaced from disk (reload). The editor
   *  view watches this to rebuild its document state. */
  version: number;
  /** Disk changed (or file deleted) under a dirty buffer — surfaced as a
   *  quiet status-bar signal; the save guard owns the actual dialog. */
  diskStale: boolean;
}

/** A blocked save: the disk changed or vanished under the buffer. */
export interface SaveConflict {
  workspaceId: string;
  path: string;
  kind: "changed" | "deleted";
}

/** Async confirm injected by the UI so the store stays React-free. */
export type OpenConfirm = (sizeBytes: number, path: string) => Promise<boolean>;

/** A one-shot request to place the cursor on a line once the file is the
 *  active editor buffer (e.g. diff `o` → first changed line of the hunk).
 *  EditorPane consumes it via `clearPendingReveal`. */
export interface PendingReveal {
  path: string;
  line: number; // 1-based new-file line
}

// Stable empty list — returning a new array per call would bust React memo
// and cause an infinite re-render loop (same trap as terminalsStore/chatStore).
const EMPTY_FILES: OpenFile[] = [];

// ─── Store interface ──────────────────────────────────────────────

interface EditorStore {
  filesByWs: Record<string, OpenFile[]>;
  activeByWs: Record<string, string | null>;
  /** Set when a save was blocked by an external change; a dialog resolves it. */
  saveConflict: SaveConflict | null;
  /** One-shot open-at-line requests, keyed by workspace. */
  pendingRevealByWs: Record<string, PendingReveal | null>;

  // Selectors
  getFiles: (workspaceId: string) => OpenFile[];
  getActivePath: (workspaceId: string) => string | null;
  isDirty: (workspaceId: string, path: string) => boolean;
  getPendingReveal: (workspaceId: string) => PendingReveal | null;

  // Actions
  /** Open `path` as a tab and activate it. `line` (optional, 1-based)
   *  additionally requests a one-shot cursor reveal at that line. */
  openFile: (
    workspaceId: string,
    path: string,
    confirm?: OpenConfirm,
    line?: number,
  ) => Promise<void>;
  clearPendingReveal: (workspaceId: string) => void;
  closeFile: (workspaceId: string, path: string) => void;
  setActive: (workspaceId: string, path: string) => void;
  /** Move an open tab from one position to another (drag-reorder). */
  reorderFiles: (workspaceId: string, fromIndex: number, toIndex: number) => void;
  setContent: (workspaceId: string, path: string, content: string) => void;
  saveActive: (workspaceId: string, opts?: { force?: boolean }) => Promise<void>;
  clearSaveConflict: () => void;
  /** Replace the buffer with the disk contents (clears dirty + stale).
   *  `onlyIfClean` aborts the swap (and flags diskStale) when the buffer is
   *  dirty *at resolve time* — the silent focus path uses it so keystrokes
   *  typed during the disk read are never clobbered. */
  reloadFromDisk: (
    workspaceId: string,
    path: string,
    opts?: { onlyIfClean?: boolean },
  ) => Promise<boolean>;
  /** Window-focus check: silently reload a clean stale buffer; flag a dirty one. */
  checkActiveAgainstDisk: (workspaceId: string) => Promise<void>;
}

const fileName = (path: string) => path.split("/").pop() ?? path;

// ─── Implementation ───────────────────────────────────────────────

export const useEditorStore = create<EditorStore>((set, get) => {
  /** Immutably patch one open file in one workspace. */
  const patchFile = (
    workspaceId: string,
    path: string,
    patch: (f: OpenFile) => OpenFile,
  ) =>
    set((s) => {
      const prev = s.filesByWs[workspaceId] ?? EMPTY_FILES;
      return {
        filesByWs: {
          ...s.filesByWs,
          [workspaceId]: prev.map((f) => (f.path === path ? patch(f) : f)),
        },
      };
    });

  const findFile = (workspaceId: string, path: string) =>
    (get().filesByWs[workspaceId] ?? EMPTY_FILES).find((f) => f.path === path);

  return {
  filesByWs: {},
  activeByWs: {},
  saveConflict: null,
  pendingRevealByWs: {},

  // ── Selectors ─────────────────────────────────────────────────

  getFiles: (workspaceId) => get().filesByWs[workspaceId] ?? EMPTY_FILES,

  getActivePath: (workspaceId) => {
    const byWs = get().activeByWs;
    return workspaceId in byWs ? byWs[workspaceId] : null;
  },

  getPendingReveal: (workspaceId) =>
    get().pendingRevealByWs[workspaceId] ?? null,

  isDirty: (workspaceId, path) => {
    const file = (get().filesByWs[workspaceId] ?? EMPTY_FILES).find(
      (f) => f.path === path,
    );
    if (!file || file.kind === "binary") return false;
    return file.content !== file.savedContent;
  },

  // ── Actions ───────────────────────────────────────────────────

  openFile: async (workspaceId, path, confirm, line) => {
    // Every open supersedes any previous reveal: a plain open clears a stale
    // one, an open-at-line replaces it on success below.
    const setReveal = (reveal: PendingReveal | null) =>
      set((s) => ({
        pendingRevealByWs: { ...s.pendingRevealByWs, [workspaceId]: reveal },
      }));
    setReveal(null);

    const existing = (get().filesByWs[workspaceId] ?? EMPTY_FILES).find(
      (f) => f.path === path,
    );
    if (existing) {
      set((s) => ({ activeByWs: { ...s.activeByWs, [workspaceId]: path } }));
      if (line != null) setReveal({ path, line });
      return;
    }

    let res = await ipc.readFileChecked(path);

    let confirmed = false;
    if (res.kind === "tooLarge") {
      const ok = confirm ? await confirm(res.size, path) : false;
      if (!ok) return;
      confirmed = true;
      res = await ipc.readFileChecked(path, Number.MAX_SAFE_INTEGER);
    }

    let newFile: OpenFile;
    if (res.kind === "binary" || res.kind === "unsupportedEncoding") {
      newFile = {
        path, content: "", savedContent: "", lang: langForExtension(path),
        kind: "binary",
        binaryReason: res.kind === "binary" ? "binary" : "unsupportedEncoding",
        mtime: res.mtime, size: res.size,
        version: 0, diskStale: false,
      };
    } else if (res.kind === "tooLarge") {
      return; // re-read above already handled; a second tooLarge is unreachable
    } else {
      if (!confirmed && res.size > LARGE_WARN_BYTES) {
        const ok = confirm ? await confirm(res.size, path) : false;
        if (!ok) return;
      }
      newFile = {
        path, content: res.content, savedContent: res.content,
        lang: langForExtension(path), kind: "text",
        mtime: res.mtime, size: res.size,
        version: 0, diskStale: false,
      };
    }

    set((s) => {
      const prev = s.filesByWs[workspaceId] ?? EMPTY_FILES;
      return {
        filesByWs: { ...s.filesByWs, [workspaceId]: [...prev, newFile] },
        activeByWs: { ...s.activeByWs, [workspaceId]: path },
        ...(line != null
          ? {
              pendingRevealByWs: {
                ...s.pendingRevealByWs,
                [workspaceId]: { path, line },
              },
            }
          : {}),
      };
    });
  },

  clearPendingReveal: (workspaceId) =>
    set((s) => ({
      pendingRevealByWs: { ...s.pendingRevealByWs, [workspaceId]: null },
    })),

  closeFile: (workspaceId, path) => {
    set((s) => {
      const prev = s.filesByWs[workspaceId] ?? EMPTY_FILES;
      const remaining = prev.filter((f) => f.path !== path);

      const currentActive = s.activeByWs[workspaceId] ?? null;
      let nextActive: string | null = currentActive;

      if (currentActive === path) {
        const idx = prev.findIndex((f) => f.path === path);
        // Prefer the item after; fall back to the one before.
        nextActive = remaining[idx]?.path ?? remaining[idx - 1]?.path ?? null;
      }

      return {
        filesByWs: { ...s.filesByWs, [workspaceId]: remaining },
        activeByWs: { ...s.activeByWs, [workspaceId]: nextActive },
      };
    });
  },

  setActive: (workspaceId, path) =>
    set((s) => ({
      activeByWs: { ...s.activeByWs, [workspaceId]: path },
    })),

  reorderFiles: (workspaceId, fromIndex, toIndex) =>
    set((s) => {
      const prev = s.filesByWs[workspaceId] ?? EMPTY_FILES;
      if (
        fromIndex === toIndex ||
        fromIndex < 0 || fromIndex >= prev.length ||
        toIndex < 0 || toIndex >= prev.length
      ) {
        return {};
      }
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return { filesByWs: { ...s.filesByWs, [workspaceId]: next } };
    }),

  setContent: (workspaceId, path, content) =>
    set((s) => {
      const prev = s.filesByWs[workspaceId] ?? EMPTY_FILES;
      return {
        filesByWs: {
          ...s.filesByWs,
          [workspaceId]: prev.map((f) =>
            f.path === path ? { ...f, content } : f,
          ),
        },
      };
    }),

  saveActive: async (workspaceId, opts) => {
    const activePath = get().getActivePath(workspaceId);
    if (!activePath) return;

    const file = findFile(workspaceId, activePath);
    if (!file || file.kind === "binary") return;

    try {
      // External-change guard: refuse to blind-write over a file that was
      // changed or deleted under the buffer (agents, tree file ops, conflict
      // resolutions all write directly to disk). The UI resolves the conflict
      // via a dialog and re-enters with `force`.
      if (!opts?.force) {
        const meta = await ipc.fileMeta(activePath);
        if (meta === null) {
          // Flag the buffer too: if the user dismisses the dialog ("Keep
          // editing"), the rouge status-bar chip stays as the signal.
          patchFile(workspaceId, activePath, (f) => ({ ...f, diskStale: true }));
          set({ saveConflict: { workspaceId, path: activePath, kind: "deleted" } });
          return;
        }
        if (meta.mtimeMs !== file.mtime) {
          patchFile(workspaceId, activePath, (f) => ({ ...f, diskStale: true }));
          set({ saveConflict: { workspaceId, path: activePath, kind: "changed" } });
          return;
        }
      }

      // Re-read the buffer after the await — the user may have kept typing.
      const latest = findFile(workspaceId, activePath) ?? file;
      const { mtime } = await ipc.writeFile(activePath, latest.content);
      // Only what was actually written counts as saved — keystrokes typed
      // during the write await must leave the buffer dirty.
      patchFile(workspaceId, activePath, (f) => ({
        ...f, savedContent: latest.content, mtime, diskStale: false,
      }));
      set((s) => ({
        saveConflict: s.saveConflict?.path === activePath ? null : s.saveConflict,
      }));
    } catch (e) {
      pushToast({
        level: "error",
        title: "Couldn't save file",
        body: `${fileName(activePath)}: ${e instanceof Error ? e.message : String(e)}`,
        timeout: 7000,
      });
    }
  },

  clearSaveConflict: () => set({ saveConflict: null }),

  reloadFromDisk: async (workspaceId, path, opts) => {
    const file = findFile(workspaceId, path);
    if (!file || file.kind === "binary") return false;

    try {
      const res = await ipc.readFileChecked(path);
      if (opts?.onlyIfClean) {
        // Keystroke race: the user may have typed while the read was in
        // flight. Judge dirtiness from the CURRENT state, not the snapshot.
        const current = findFile(workspaceId, path);
        if (!current || current.kind !== "text") return false;
        if (current.content !== current.savedContent) {
          patchFile(workspaceId, path, (f) => ({ ...f, diskStale: true }));
          return false;
        }
      }
      if (res.kind !== "text") {
        pushToast({
          level: "error",
          title: "Couldn't reload file",
          body: `${fileName(path)}: no longer readable as text.`,
          timeout: 7000,
        });
        return false;
      }
      patchFile(workspaceId, path, (f) => ({
        ...f,
        content: res.content,
        savedContent: res.content,
        mtime: res.mtime,
        size: res.size,
        diskStale: false,
        version: f.version + 1,
      }));
      return true;
    } catch (e) {
      pushToast({
        level: "error",
        title: "Couldn't reload file",
        body: `${fileName(path)}: ${e instanceof Error ? e.message : String(e)}`,
        timeout: 7000,
      });
      return false;
    }
  },

  checkActiveAgainstDisk: async (workspaceId) => {
    const activePath = get().getActivePath(workspaceId);
    if (!activePath) return;

    const file = findFile(workspaceId, activePath);
    if (!file || file.kind !== "text") return;

    let meta;
    try {
      meta = await ipc.fileMeta(activePath);
    } catch {
      return; // stat failure: stay quiet, the save guard will catch real trouble
    }

    // Keystroke race: the user may have typed during the stat await. Judge
    // dirtiness (and everything else) from the CURRENT state, never from the
    // pre-await snapshot.
    const fresh = findFile(workspaceId, activePath);
    if (!fresh || fresh.kind !== "text") return;

    const setStale = (stale: boolean) => {
      if (fresh.diskStale !== stale)
        patchFile(workspaceId, activePath, (f) => ({ ...f, diskStale: stale }));
    };

    if (meta === null) {
      // Deleted on disk. Never auto-close or auto-clear the buffer — flag it
      // and let the save guard prompt when the user actually saves.
      setStale(true);
      return;
    }
    if (meta.mtimeMs === fresh.mtime) {
      setStale(false); // disk matches again (e.g. checkout back)
      return;
    }

    const dirty = fresh.content !== fresh.savedContent;
    if (dirty) {
      // Unsaved local edits + external change: quiet signal only; the
      // reload-or-overwrite dialog appears when they save.
      setStale(true);
      return;
    }

    // Clean buffer: silently refresh it from disk — but only if it is STILL
    // clean when the read resolves (the user may type meanwhile).
    const ok = await get().reloadFromDisk(workspaceId, activePath, { onlyIfClean: true });
    if (ok) {
      pushToast({
        level: "info",
        title: "Reloaded — changed on disk",
        body: fileName(activePath),
        timeout: 4000,
      });
    }
  },
  };
});
