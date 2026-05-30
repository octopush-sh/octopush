import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { Issue } from "../lib/types";

interface State {
  parents: Record<string, Issue>;
  loading: Record<string, boolean>;
  loadParent: (key: string) => Promise<void>;
}

export const useParentIssuesStore = create<State>((set, get) => ({
  parents: {},
  loading: {},
  async loadParent(key: string) {
    const s = get();
    if (s.parents[key] || s.loading[key]) return;
    set((cur) => ({ loading: { ...cur.loading, [key]: true } }));
    try {
      const issue = await ipc.getIssue(key);
      set((cur) => ({
        parents: { ...cur.parents, [key]: issue },
        loading: { ...cur.loading, [key]: false },
      }));
    } catch {
      // Quiet failure: do not populate cache; clear loading so a retry is possible.
      set((cur) => ({ loading: { ...cur.loading, [key]: false } }));
    }
  },
}));
