import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { Issue } from "../lib/types";

interface IssuesState {
  issues: Issue[] | null;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
}

export const useIssuesStore = create<IssuesState>((set, get) => ({
  issues: null,
  loading: false,
  error: null,
  load: async () => {
    if (get().loading) return;
    set({ loading: true, error: null });
    try {
      const issues = await ipc.listMyIssues();
      set({ issues, loading: false });
    } catch (e) {
      // Keep the last good list; surface the error quietly.
      set({ loading: false, error: String(e) });
    }
  },
}));
