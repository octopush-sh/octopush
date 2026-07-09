import { create } from "zustand";
import { persist } from "zustand/middleware";
import { MODES, type WorkspaceMode } from "../lib/modes";

/** App-wide workspace defaults, persisted to localStorage (same class of
 *  preference as the attention chime toggle and editor prefs). */
export interface WorkspacePrefs {
  /** The mode a workspace opens in when it has no explicit mode set yet —
   *  i.e. freshly created workspaces, and any workspace after an app restart
   *  (mode isn't persisted per-workspace). Drives App.tsx's mode fallback. */
  defaultMode: WorkspaceMode;
}

interface WorkspacePrefsStore extends WorkspacePrefs {
  setDefaultMode: (mode: WorkspaceMode) => void;
}

/** Narrow an untrusted value (a stale/hand-edited persisted blob, or a value
 *  routed through the setter) to a known `WorkspaceMode`, or `null` if it names
 *  a mode that doesn't exist. The single guard both `setDefaultMode` and the
 *  persist `merge` rely on so a dead mode can never reach App.tsx's fallback. */
export function coerceWorkspaceMode(value: unknown): WorkspaceMode | null {
  return typeof value === "string" && (MODES as readonly string[]).includes(value)
    ? (value as WorkspaceMode)
    : null;
}

export const useWorkspacePrefs = create<WorkspacePrefsStore>()(
  persist(
    (set) => ({
      defaultMode: "talk",

      setDefaultMode: (mode) => {
        const m = coerceWorkspaceMode(mode);
        if (m) set({ defaultMode: m });
      },
    }),
    {
      name: "octo-workspace-prefs",
      partialize: (s) => ({ defaultMode: s.defaultMode }),
      // A persisted value from an older build (or hand-edited storage) could
      // name a mode that no longer exists; fall back to the initializer rather
      // than opening workspaces into a dead mode.
      merge: (persisted, current) => {
        const mode = coerceWorkspaceMode((persisted as Partial<WorkspacePrefs> | undefined)?.defaultMode);
        return { ...current, defaultMode: mode ?? current.defaultMode };
      },
    },
  ),
);
