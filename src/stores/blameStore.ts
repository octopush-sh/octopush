/**
 * blameStore — per-line git blame for the editor gutter (G7 slice III).
 *
 * `enabled` is the global toggle (palette: "Toggle blame"). Blame data is
 * cached per absolute file path; EditorPane re-loads on toggle/file switch/
 * save/reload, so the cache is only ever as stale as the last fetch trigger.
 */

import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { BlameLine } from "../lib/ipc";

interface BlameStore {
  enabled: boolean;
  /** Blame lines keyed by absolute file path. */
  linesByPath: Record<string, BlameLine[]>;
  /** Friendly fetch error keyed by absolute file path (e.g. "no committed
   *  history yet"). Mutually exclusive with a linesByPath entry. */
  errorByPath: Record<string, string>;

  toggle: () => void;
  /** Fetch blame for `absPath` inside `workspacePath` (always refetches). */
  load: (workspacePath: string, absPath: string) => Promise<void>;
  invalidate: (absPath: string) => void;
}

function relativeTo(workspacePath: string, absPath: string): string {
  return absPath.startsWith(workspacePath + "/")
    ? absPath.slice(workspacePath.length + 1)
    : absPath;
}

export const useBlameStore = create<BlameStore>((set) => ({
  enabled: false,
  linesByPath: {},
  errorByPath: {},

  toggle: () => set((s) => ({ enabled: !s.enabled })),

  load: async (workspacePath, absPath) => {
    try {
      const lines = await ipc.blameFile(workspacePath, relativeTo(workspacePath, absPath));
      set((s) => {
        const errorByPath = { ...s.errorByPath };
        delete errorByPath[absPath];
        return { linesByPath: { ...s.linesByPath, [absPath]: lines }, errorByPath };
      });
    } catch (e) {
      set((s) => {
        const linesByPath = { ...s.linesByPath };
        delete linesByPath[absPath];
        return {
          linesByPath,
          errorByPath: {
            ...s.errorByPath,
            [absPath]: e instanceof Error ? e.message : String(e),
          },
        };
      });
    }
  },

  invalidate: (absPath) =>
    set((s) => {
      const linesByPath = { ...s.linesByPath };
      const errorByPath = { ...s.errorByPath };
      delete linesByPath[absPath];
      delete errorByPath[absPath];
      return { linesByPath, errorByPath };
    }),
}));
