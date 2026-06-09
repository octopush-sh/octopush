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
}

/** Async confirm injected by the UI so the store stays React-free. */
export type OpenConfirm = (sizeBytes: number, path: string) => Promise<boolean>;

// Stable empty list — returning a new array per call would bust React memo
// and cause an infinite re-render loop (same trap as terminalsStore/chatStore).
const EMPTY_FILES: OpenFile[] = [];

// ─── Store interface ──────────────────────────────────────────────

interface EditorStore {
  filesByWs: Record<string, OpenFile[]>;
  activeByWs: Record<string, string | null>;

  // Selectors
  getFiles: (workspaceId: string) => OpenFile[];
  getActivePath: (workspaceId: string) => string | null;
  isDirty: (workspaceId: string, path: string) => boolean;

  // Actions
  openFile: (workspaceId: string, path: string, confirm?: OpenConfirm) => Promise<void>;
  closeFile: (workspaceId: string, path: string) => void;
  setActive: (workspaceId: string, path: string) => void;
  setContent: (workspaceId: string, path: string, content: string) => void;
  saveActive: (workspaceId: string) => Promise<void>;
}

// ─── Implementation ───────────────────────────────────────────────

export const useEditorStore = create<EditorStore>((set, get) => ({
  filesByWs: {},
  activeByWs: {},

  // ── Selectors ─────────────────────────────────────────────────

  getFiles: (workspaceId) => get().filesByWs[workspaceId] ?? EMPTY_FILES,

  getActivePath: (workspaceId) => {
    const byWs = get().activeByWs;
    return workspaceId in byWs ? byWs[workspaceId] : null;
  },

  isDirty: (workspaceId, path) => {
    const file = (get().filesByWs[workspaceId] ?? EMPTY_FILES).find(
      (f) => f.path === path,
    );
    if (!file || file.kind === "binary") return false;
    return file.content !== file.savedContent;
  },

  // ── Actions ───────────────────────────────────────────────────

  openFile: async (workspaceId, path, confirm) => {
    const existing = (get().filesByWs[workspaceId] ?? EMPTY_FILES).find(
      (f) => f.path === path,
    );
    if (existing) {
      set((s) => ({ activeByWs: { ...s.activeByWs, [workspaceId]: path } }));
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
      };
    }

    set((s) => {
      const prev = s.filesByWs[workspaceId] ?? EMPTY_FILES;
      return {
        filesByWs: { ...s.filesByWs, [workspaceId]: [...prev, newFile] },
        activeByWs: { ...s.activeByWs, [workspaceId]: path },
      };
    });
  },

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

  saveActive: async (workspaceId) => {
    const activePath = get().getActivePath(workspaceId);
    if (!activePath) return;

    const file = (get().filesByWs[workspaceId] ?? EMPTY_FILES).find(
      (f) => f.path === activePath,
    );
    if (!file || file.kind === "binary") return;

    try {
      const { mtime } = await ipc.writeFile(activePath, file.content);
      set((s) => {
        const prev = s.filesByWs[workspaceId] ?? EMPTY_FILES;
        return {
          filesByWs: {
            ...s.filesByWs,
            [workspaceId]: prev.map((f) =>
              f.path === activePath ? { ...f, savedContent: f.content, mtime } : f,
            ),
          },
        };
      });
    } catch (e) {
      const name = activePath.split("/").pop() ?? activePath;
      pushToast({
        level: "error",
        title: "Couldn't save file",
        body: `${name}: ${e instanceof Error ? e.message : String(e)}`,
        timeout: 7000,
      });
    }
  },
}));
