import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { Issue } from "../lib/types";

interface State {
  parents: Record<string, Issue>;
  loading: Record<string, boolean>;
  loadParent: (key: string) => Promise<void>;
  loadAncestors: (key: string, depth: number) => Promise<void>;
}

export const useParentIssuesStore = create<State>((set, get) => ({
  parents: {},
  loading: {},
  async loadParent(key) {
    const s = get();
    if (s.parents[key] || s.loading[key]) return;
    set((c) => ({ loading: { ...c.loading, [key]: true } }));
    try {
      const issue = await ipc.getIssue(key);
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
