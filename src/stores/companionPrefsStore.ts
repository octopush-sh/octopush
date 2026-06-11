import { create } from "zustand";
import { persist } from "zustand/middleware";

interface CompanionPrefsStore {
  /** Work-context panel collapse state, keyed by PROJECT id. Absent key =
   *  no explicit user choice yet — callers fall back to a mode-aware
   *  default (expanded in Talk, collapsed elsewhere). */
  workContextCollapsed: Record<string, boolean>;
  setWorkContextCollapsed: (projectId: string, v: boolean) => void;
  /** Last setup script used to create a workspace, keyed by PROJECT id.
   *  The workspace creator prefills step II with it and writes it back
   *  (even when empty — clearing it is a choice) on successful create. */
  setupScriptByProject: Record<string, string>;
  setSetupScriptForProject: (projectId: string, script: string) => void;
}

export const useCompanionPrefs = create<CompanionPrefsStore>()(
  persist(
    (set) => ({
      workContextCollapsed: {},
      setWorkContextCollapsed: (projectId, v) =>
        set((s) => ({
          workContextCollapsed: { ...s.workContextCollapsed, [projectId]: v },
        })),
      setupScriptByProject: {},
      setSetupScriptForProject: (projectId, script) =>
        set((s) => ({
          setupScriptByProject: { ...s.setupScriptByProject, [projectId]: script },
        })),
    }),
    {
      name: "octo-companion-prefs",
      partialize: (s) => ({
        workContextCollapsed: s.workContextCollapsed,
        setupScriptByProject: s.setupScriptByProject,
      }),
    },
  ),
);
