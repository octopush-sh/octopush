import { create } from "zustand";

/**
 * The rail's multi-selection of missions: ⌘-click (Ctrl-click off a Mac)
 * toggles a mission row, ⇧-click selects the run of rows from the anchor to
 * it. A selection lives inside one project, because a mission group lives
 * inside one project: selecting in another project starts a new selection.
 *
 * Selection is not activation. A plain click still opens the mission and
 * clears the selection; Escape clears it too, and so does typing a filter.
 * What a selection is for is its context menu: **Group N missions…** and
 * **Move N missions to group ›**.
 */
export interface RailSelection {
  projectId: string;
  /** In the order they were selected; callers that need rail order sort. */
  ids: string[];
  /** Where the next ⇧-click's run starts. */
  anchorId: string;
}

interface RailSelectionState {
  selection: RailSelection | null;
  /** ⌘-click: add or remove one mission. */
  toggle: (projectId: string, workspaceId: string) => void;
  /**
   * ⇧-click: select `ordered` from the anchor to `workspaceId`, inclusive.
   * `ordered` is the project's mission rows as the rail draws them. With no
   * anchor in this project, the run starts at `fallbackAnchor` (the active
   * mission, as a file list starts at the selected file) or else at the row
   * itself.
   */
  extend: (projectId: string, ordered: readonly string[], workspaceId: string, fallbackAnchor?: string | null) => void;
  clear: () => void;
}

/** The run of `ordered` between `a` and `b`, inclusive, in rail order. */
export function selectionRange(ordered: readonly string[], a: string, b: string): string[] {
  const i = ordered.indexOf(a);
  const j = ordered.indexOf(b);
  if (j === -1) return [];
  if (i === -1) return [b];
  return ordered.slice(Math.min(i, j), Math.max(i, j) + 1);
}

export const useRailSelection = create<RailSelectionState>((set, get) => ({
  selection: null,

  toggle: (projectId, workspaceId) => {
    const current = get().selection;
    if (!current || current.projectId !== projectId) {
      set({ selection: { projectId, ids: [workspaceId], anchorId: workspaceId } });
      return;
    }
    const has = current.ids.includes(workspaceId);
    const ids = has ? current.ids.filter((id) => id !== workspaceId) : [...current.ids, workspaceId];
    set({ selection: ids.length === 0 ? null : { projectId, ids, anchorId: workspaceId } });
  },

  extend: (projectId, ordered, workspaceId, fallbackAnchor) => {
    const current = get().selection;
    const anchor =
      current && current.projectId === projectId && ordered.includes(current.anchorId)
        ? current.anchorId
        : fallbackAnchor && ordered.includes(fallbackAnchor)
          ? fallbackAnchor
          : workspaceId;
    const ids = selectionRange(ordered, anchor, workspaceId);
    set({ selection: ids.length === 0 ? null : { projectId, ids, anchorId: anchor } });
  },

  clear: () => {
    if (get().selection) set({ selection: null });
  },
}));
