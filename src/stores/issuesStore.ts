import { useCallback } from "react";
import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { Issue, ProjectIssueTracker, TrackerKind } from "../lib/types";
import { useParentIssuesStore } from "./parentIssuesStore";

interface IssuesState {
  issues: Issue[] | null;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;

  /** The project the tracker calls are for (#1127), the tracker it reads
   *  (resolved by the backend) and the scope of the caches below: `jira`
   *  for every Jira project (one list serves them all), `epiku:<project>`
   *  for an Epiku one ({@link trackerScope}). A scope change empties the
   *  caches, and an answer for a scope the user has left never lands. */
  projectId: string | null;
  tracker: TrackerKind | null;
  scope: string | null;
  /** Each project's tracker choice, as last read. */
  trackerByProject: Record<string, ProjectIssueTracker>;
  loadTracker: (projectId: string) => Promise<ProjectIssueTracker | null>;
  /** Make `projectId` the one the calls are for, re-reading its tracker. */
  setProject: (projectId: string | null) => Promise<void>;

  /** Detailed view of individual tickets (with `blocks`, `blockedBy`,
   *  `subtasks` populated by getIssue). Shared between ContextHeader and
   *  WorkContextPanel so a workspace switch fires one getIssue, not two.
   *  list_my_issues does NOT populate these fields, so this cache is the
   *  only place to read them from. */
  detailByKey: Record<string, Issue>;
  detailLoadingByKey: Record<string, boolean>;
  loadDetail: (key: string) => Promise<void>;

  /** Open backlog of each epic, fetched lazily when the WorkContext "Epic"
   *  pill is opened. Keyed by epic key (e.g., "CLPNSNS-220"). Survives
   *  pill switches inside the same workspace so re-opening Epic is instant. */
  epicIssuesByKey: Record<string, Issue[]>;
  epicLoadingByKey: Record<string, boolean>;
  loadEpic: (epicKey: string) => Promise<void>;
}

/** The cache scope of a project's tracker. An Epiku project that reads its
 *  own Epiku project adds it (`epiku:<project>:<epiku project>`), so choosing
 *  another one is a new scope and never shows the old one's stories (#1283). */
export function trackerScope(
  projectId: string | null,
  tracker: TrackerKind | null,
  epikuProject: string | null = null,
): string | null {
  if (tracker !== "epiku") return tracker;
  return epikuProject ? `epiku:${projectId}:${epikuProject}` : `epiku:${projectId}`;
}

/** Whether `key` is one of the loaded stories, or one `getIssue` read: what
 *  lets a dotted id in an Epiku branch count as linked (`detectTrackerKey`). */
export function isKnownStory(
  state: { issues: Issue[] | null; detailByKey: Record<string, Issue> },
  key: string,
): boolean {
  return (state.issues ?? []).some((i) => i.key === key) || Object.prototype.hasOwnProperty.call(state.detailByKey, key);
}

/** {@link isKnownStory} over the current caches, re-made when they change. */
export function useKnownStory(): (key: string) => boolean {
  const issues = useIssuesStore((s) => s.issues);
  const detailByKey = useIssuesStore((s) => s.detailByKey);
  return useCallback((key: string) => isKnownStory({ issues, detailByKey }, key), [issues, detailByKey]);
}

let projectSeq = 0;

export const useIssuesStore = create<IssuesState>((set, get) => ({
  issues: null,
  loading: false,
  error: null,
  load: async () => {
    if (get().loading) return;
    const { projectId, scope } = get();
    set({ loading: true, error: null });
    try {
      const issues = await ipc.listMyIssues(projectId);
      if (get().scope === scope) set({ issues, loading: false });
    } catch (e) {
      // Keep the last good list; surface the error quietly.
      if (get().scope === scope) set({ loading: false, error: String(e) });
    }
  },

  projectId: null,
  tracker: null,
  scope: null,
  trackerByProject: {},
  loadTracker: async (projectId) => {
    try {
      const t = await ipc.getProjectIssueTracker(projectId);
      set((s) => ({ trackerByProject: { ...s.trackerByProject, [projectId]: t } }));
      return t;
    } catch {
      return null;
    }
  },
  setProject: async (projectId) => {
    const seq = ++projectSeq;
    const t = projectId ? await get().loadTracker(projectId) : null;
    if (seq !== projectSeq) return;
    const tracker = t?.active ?? null;
    const scope = trackerScope(projectId, tracker, t?.epikuProject ?? null);
    useParentIssuesStore.setState({ projectId, tracker });
    if (scope === get().scope) {
      set({ projectId, tracker });
      return;
    }
    set({
      projectId, tracker, scope, issues: null, loading: false, error: null,
      detailByKey: {}, detailLoadingByKey: {}, epicIssuesByKey: {}, epicLoadingByKey: {},
    });
    useParentIssuesStore.setState({ parents: {}, loading: {} });
  },

  detailByKey: {},
  detailLoadingByKey: {},
  loadDetail: async (key) => {
    if (!key) return;
    if (get().detailLoadingByKey[key]) return;
    const { projectId, scope } = get();
    set((s) => ({ detailLoadingByKey: { ...s.detailLoadingByKey, [key]: true } }));
    try {
      const issue = await ipc.getIssue(key, projectId);
      if (get().scope !== scope) return;
      set((s) => ({
        detailByKey: { ...s.detailByKey, [key]: issue },
        detailLoadingByKey: { ...s.detailLoadingByKey, [key]: false },
      }));
    } catch {
      if (get().scope !== scope) return;
      set((s) => ({ detailLoadingByKey: { ...s.detailLoadingByKey, [key]: false } }));
    }
  },

  epicIssuesByKey: {},
  epicLoadingByKey: {},
  loadEpic: async (epicKey) => {
    if (!epicKey) return;
    if (get().epicLoadingByKey[epicKey]) return;
    const { projectId, scope } = get();
    set((s) => ({ epicLoadingByKey: { ...s.epicLoadingByKey, [epicKey]: true } }));
    try {
      const list = await ipc.listIssuesInEpic(epicKey, projectId);
      if (get().scope !== scope) return;
      set((s) => ({
        epicIssuesByKey: { ...s.epicIssuesByKey, [epicKey]: list },
        epicLoadingByKey: { ...s.epicLoadingByKey, [epicKey]: false },
      }));
    } catch {
      if (get().scope !== scope) return;
      set((s) => ({ epicLoadingByKey: { ...s.epicLoadingByKey, [epicKey]: false } }));
    }
  },
}));
