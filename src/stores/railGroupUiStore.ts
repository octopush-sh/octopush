import { create } from "zustand";

/** How the rail shows its groups: which are folded, and which one has its name
 *  in inline edit. Folds are a preference of this Mac, kept in localStorage
 *  like the project folds (`railProjectCollapsed`); the database never stores
 *  them. The menus that create or rename a group are rendered outside the
 *  rail, so this state lives in a store rather than in the rail's own. */
interface RailGroupUiState {
  /** Folded groups by id. An absent id is an open group. */
  collapsed: Record<string, boolean>;
  /** The group whose header shows the rename input (one at a time). */
  renamingId: string | null;
  toggle: (groupId: string) => void;
  setCollapsed: (groupId: string, collapsed: boolean) => void;
  startRename: (groupId: string) => void;
  stopRename: () => void;
  /** Drop a removed group's fold, so the map never grows without bound. */
  forget: (groupId: string) => void;
  /** Keep only the folds (and the rename) of groups that still exist. Called
   *  with the ids of a fresh `list_groups`, so folds of groups removed while
   *  the app was closed, or in another window, do not pile up in storage. */
  prune: (existingIds: ReadonlySet<string>) => void;
}

export const GROUP_COLLAPSE_KEY = "railGroupCollapsed";

function readCollapsed(): Record<string, boolean> {
  try {
    const stored = localStorage.getItem(GROUP_COLLAPSE_KEY);
    const parsed: unknown = stored ? JSON.parse(stored) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, boolean>)
      : {};
  } catch {
    return {};
  }
}

function persist(collapsed: Record<string, boolean>) {
  try {
    localStorage.setItem(GROUP_COLLAPSE_KEY, JSON.stringify(collapsed));
  } catch (err) {
    console.error("Failed to persist railGroupCollapsed:", err);
  }
}

export const useRailGroupUi = create<RailGroupUiState>((set, get) => ({
  collapsed: readCollapsed(),
  renamingId: null,

  toggle: (groupId) => get().setCollapsed(groupId, !get().collapsed[groupId]),

  setCollapsed: (groupId, collapsed) => {
    if (!!get().collapsed[groupId] === collapsed) return;
    const next = { ...get().collapsed };
    // Open is the default, so an open group needs no entry.
    if (collapsed) next[groupId] = true;
    else delete next[groupId];
    persist(next);
    set({ collapsed: next });
  },

  startRename: (groupId) => set({ renamingId: groupId }),
  stopRename: () => set({ renamingId: null }),

  forget: (groupId) => {
    if (!(groupId in get().collapsed) && get().renamingId !== groupId) return;
    const { [groupId]: _gone, ...rest } = get().collapsed;
    persist(rest);
    set({ collapsed: rest, renamingId: get().renamingId === groupId ? null : get().renamingId });
  },

  prune: (existingIds) => {
    const { collapsed, renamingId } = get();
    const kept = Object.fromEntries(Object.entries(collapsed).filter(([id]) => existingIds.has(id)));
    const staleFolds = Object.keys(kept).length !== Object.keys(collapsed).length;
    const staleRename = renamingId !== null && !existingIds.has(renamingId);
    if (!staleFolds && !staleRename) return;
    if (staleFolds) persist(kept);
    set({ collapsed: staleFolds ? kept : collapsed, renamingId: staleRename ? null : renamingId });
  },
}));

/** Re-read the folds from localStorage (tests seed it before rendering). */
export function __reloadRailGroupUi(): void {
  useRailGroupUi.setState({ collapsed: readCollapsed(), renamingId: null });
}
