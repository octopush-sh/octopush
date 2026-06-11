import type { Issue, LinkedIssueRef, ProjectInfo, Workspace } from "./types";
import { detectIssueKey } from "./detectIssueKey";

export type LinkageState =
  | { kind: "linked"; key: string; source: "manual" | "detected" }
  | { kind: "unlinked" };

export function resolveLinkage(ws: Workspace, branch: string): LinkageState {
  if (ws.linkedIssueKey) {
    return { kind: "linked", key: ws.linkedIssueKey, source: "manual" };
  }
  const detected = detectIssueKey(branch);
  if (detected) {
    return { kind: "linked", key: detected, source: "detected" };
  }
  return { kind: "unlinked" };
}

export function resolveJiraProjectKey(
  project: ProjectInfo,
  workspace: Workspace,
  branch: string,
): string | null {
  if (project.jiraProjectKey) return project.jiraProjectKey;
  const linkage = resolveLinkage(workspace, branch);
  if (linkage.kind === "linked") {
    return linkage.key.split("-")[0];
  }
  return null;
}

// Order maps the spec's "inProgress → todo → unknown → done" rule.
const STATUS_RANK: Record<Issue["statusCategory"], number> = {
  inProgress: 0,
  todo: 1,
  unknown: 2,
  done: 3,
};

// Jira priorities normalized to a numeric rank; absent or unknown -> 99 (last).
const PRIORITY_RANK: Record<string, number> = {
  Highest: 0,
  High: 1,
  Medium: 2,
  Low: 3,
  Lowest: 4,
};
function priorityRank(p: string | null): number {
  return p != null && PRIORITY_RANK[p] !== undefined ? PRIORITY_RANK[p] : 99;
}

function sortByStatusPriorityKey(issues: Issue[]): Issue[] {
  return [...issues].sort((a, b) => {
    const s = STATUS_RANK[a.statusCategory] - STATUS_RANK[b.statusCategory];
    if (s !== 0) return s;
    const p = priorityRank(a.priority) - priorityRank(b.priority);
    if (p !== 0) return p;
    return a.key.localeCompare(b.key);
  });
}

/** "Mine" — the user's open assignments in this Jira project, minus the
 *  active ticket (it's already shown in the ContextHeader). */
export function selectBacklog(
  allIssues: Issue[],
  projectKey: string | null,
  activeKey: string | null,
): Issue[] {
  if (projectKey == null) return [];
  const prefix = projectKey + "-";
  return sortByStatusPriorityKey(
    allIssues.filter((i) => i.key.startsWith(prefix) && i.key !== activeKey),
  );
}

/** Tickets THIS ticket blocks. Source of truth: the active issue's
 *  inline issuelinks array (populated by getIssue). Returns [] when
 *  the active issue hasn't loaded yet. */
export function selectBlocking(activeIssue: Issue | null): LinkedIssueRef[] {
  return activeIssue?.blocks ?? [];
}

/** Tickets that block THIS ticket. */
export function selectBlockedBy(activeIssue: Issue | null): LinkedIssueRef[] {
  return activeIssue?.blockedBy ?? [];
}

/** Subtasks of the active ticket, OR sibling subtasks if the active
 *  ticket is itself a subtask. The pill in the UI relabels accordingly
 *  ("Subtasks" vs "Siblings"). The parent's inline `subtasks` carries
 *  the active among the siblings — we filter it out so the row doesn't
 *  duplicate what's in the ContextHeader. */
export function selectSubtasksOrSiblings(
  activeIssue: Issue | null,
  parents: Record<string, Issue>,
): LinkedIssueRef[] {
  if (!activeIssue) return [];
  if (activeIssue.subtask) {
    if (!activeIssue.parentKey) return [];
    const parent = parents[activeIssue.parentKey];
    const siblings = parent?.subtasks ?? [];
    return siblings.filter((s) => s.key !== activeIssue.key);
  }
  return activeIssue.subtasks ?? [];
}

/** Other open tickets in the same epic as the active ticket. Caller passes
 *  the epic-keyed cache from issuesStore; we filter the active out and
 *  apply the standard status/priority/key sort. */
export function selectEpicSiblings(
  epicIssues: Issue[] | undefined,
  activeKey: string | null,
): Issue[] {
  if (!epicIssues) return [];
  return sortByStatusPriorityKey(epicIssues.filter((i) => i.key !== activeKey));
}

/** Walk the parent chain to find the epic that contains `active`. For
 *  a story with `parentKey` = epic, that's parents[parentKey]. For a
 *  sub-task, the epic is two levels up. Returns null if no epic is
 *  reachable (e.g., orphan story, parent not loaded yet). */
export function resolveEpicKey(
  active: Issue | null,
  parents: Record<string, Issue>,
): string | null {
  if (!active) return null;
  if (active.hierarchyLevel === 1) return active.key; // active IS the epic
  if (!active.parentKey) return null;
  const parent = parents[active.parentKey];
  if (parent?.hierarchyLevel === 1) return parent.key;
  if (parent?.parentKey) {
    const grand = parents[parent.parentKey];
    if (grand?.hierarchyLevel === 1) return grand.key;
  }
  // Even when we can't confirm via the parents cache, the active
  // ticket's `parentKey` is usually the epic for non-sub-tasks — accept
  // it as a best-effort guess so the pill works before parents loads.
  if (!active.subtask) return active.parentKey;
  return null;
}

/** In-progress tickets outside the active project. Single source of truth
 *  for BOTH the ElsewhereFooter count and the ElsewhereModal list, so the
 *  number on the footer always equals the rows in the modal. */
export function selectElsewhereIssues(
  allIssues: Issue[],
  projectKey: string | null,
): Issue[] {
  if (projectKey == null) return [];
  const prefix = projectKey + "-";
  return allIssues.filter(
    (i) => !i.key.startsWith(prefix) && i.statusCategory === "inProgress",
  );
}

export function selectElsewhereCount(
  allIssues: Issue[],
  projectKey: string | null,
): number {
  return selectElsewhereIssues(allIssues, projectKey).length;
}

/** Map an issue (or a lightweight LinkedIssueRef) to a Tailwind text-color
 *  class based on its type. Locale-independent for Epic (hierarchyLevel)
 *  and Sub-task (boolean) when those fields are present; otherwise falls
 *  back to localized-name matching, with explicit handling for
 *  "Sub-task" / "Epic" type names so refs without the structured fields
 *  still color correctly. Unmapped types use brass (brand fallback). */
export function issueTypeToken(issue: {
  issueType: string;
  hierarchyLevel?: number;
  subtask?: boolean;
}): string {
  if (issue.hierarchyLevel === 1) return "text-state-purple";   // Epic
  if (issue.subtask) return "text-state-blue";                  // Sub-task
  const name = issue.issueType.toLowerCase();
  if (name === "epic" || name === "épica" || name === "epica") return "text-state-purple";
  if (name === "sub-task" || name === "subtask" || name === "subtarea") return "text-state-blue";
  if (name === "story" || name === "historia") return "text-octo-verdigris";
  if (name === "bug" || name === "error" || name === "incidencia") return "text-octo-rouge";
  if (name === "task" || name === "tarea") return "text-state-blue";
  return "text-octo-brass";
}
