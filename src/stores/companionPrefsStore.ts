import { create } from "zustand";
import { persist } from "zustand/middleware";

interface CompanionPrefsStore {
  /** Work-context panel collapse state, keyed by PROJECT id. Absent key =
   *  no explicit user choice yet — callers fall back to a mode-aware
   *  default (expanded in Talk, collapsed elsewhere). */
  workContextCollapsed: Record<string, boolean>;
  setWorkContextCollapsed: (projectId: string, v: boolean) => void;
}

export const useCompanionPrefs = create<CompanionPrefsStore>()(
  persist(
    (set) => ({
      workContextCollapsed: {},
      setWorkContextCollapsed: (projectId, v) =>
        set((s) => ({
          workContextCollapsed: { ...s.workContextCollapsed, [projectId]: v },
        })),
    }),
    {
      name: "octo-companion-prefs",
      partialize: (s) => ({ workContextCollapsed: s.workContextCollapsed }),
    },
  ),
);
