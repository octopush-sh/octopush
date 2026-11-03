import { create } from "zustand";

/** How many recently opened files each workspace remembers. */
const RECENT_CAP = 50;

const EMPTY: string[] = [];

/**
 * Files recently opened from the ⌘P finder, per workspace, most recent
 * first. Session-only: it only breaks ranking ties, so nothing is persisted.
 */
interface RecentFilesStore {
  byWs: Record<string, string[]>;
  record: (workspaceKey: string, relativePath: string) => void;
}

export const useRecentFilesStore = create<RecentFilesStore>((set) => ({
  byWs: {},
  record: (workspaceKey, relativePath) =>
    set((s) => {
      const prev = s.byWs[workspaceKey] ?? EMPTY;
      const next = [relativePath, ...prev.filter((p) => p !== relativePath)].slice(0, RECENT_CAP);
      return { byWs: { ...s.byWs, [workspaceKey]: next } };
    }),
}));
