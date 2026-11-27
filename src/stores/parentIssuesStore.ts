import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { Issue, TrackerKind } from "../lib/types";

interface State {
  parents: Record<string, Issue>;
  loading: Record<string, boolean>;
  /** The active project and its tracker, set by `issuesStore.setProject`. An
   *  Epiku story's parent is its epic, which isn't a story: nothing to read. */
  projectId: string | null;
  tracker: TrackerKind | null;
  loadParent: (key: string) => Promise<void>;
  loadAncestors: (key: string, depth: number) => Promise<void>;
}

export const useParentIssuesStore = create<State>((set, get) => ({
  parents: {},
  loading: {},
  projectId: null,
  tracker: null,
  async loadParent(key) {
    const s = get();
    if (s.parents[key] || s.loading[key] || s.tracker === "epiku") return;
    set((c) => ({ loading: { ...c.loading, [key]: true } }));
    try {
      const issue = await ipc.getIssue(key, s.projectId);
      set((c) => ({
        parents: { ...c.parents, [key]: issue },
        loading: { ...c.loading, [key]: false },
      }));
    } catch {
      set((c) => ({ loading: { ...c.loading, [key]: false } }));
    }
  },
  async loadAncestors(key, depth) {
    if (depth <= 0) return;
    await get().loadParent(key);
    if (depth <= 1) return;
    const issue = get().parents[key];
    if (!issue?.parentKey) return;
    await get().loadAncestors(issue.parentKey, depth - 1);
  },
}));
