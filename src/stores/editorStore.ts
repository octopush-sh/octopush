import { create } from "zustand";
import { ipc } from "../lib/ipc";
import { langForExtension } from "../lib/editorLang";

// ─── Types ────────────────────────────────────────────────────────

export interface OpenFile {
  path: string;
  content: string;
  savedContent: string;
  lang: string;
}

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
  openFile: (workspaceId: string, path: string) => Promise<void>;
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
    return file ? file.content !== file.savedContent : false;
  },

  // ── Actions ───────────────────────────────────────────────────

  openFile: async (workspaceId, path) => {
    const existing = (get().filesByWs[workspaceId] ?? EMPTY_FILES).find(
      (f) => f.path === path,
    );
    if (existing) {
      // File already open — just activate it.
      set((s) => ({
        activeByWs: { ...s.activeByWs, [workspaceId]: path },
      }));
      return;
    }

    const content = await ipc.readFile(path);
    const newFile: OpenFile = {
      path,
      content,
      savedContent: content,
      lang: langForExtension(path),
    };

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
    if (!file) return;

    await ipc.writeFile(activePath, file.content);

    // Update savedContent to mark the file clean.
    set((s) => {
      const prev = s.filesByWs[workspaceId] ?? EMPTY_FILES;
      return {
        filesByWs: {
          ...s.filesByWs,
          [workspaceId]: prev.map((f) =>
            f.path === activePath ? { ...f, savedContent: f.content } : f,
          ),
        },
      };
    });
  },
}));
