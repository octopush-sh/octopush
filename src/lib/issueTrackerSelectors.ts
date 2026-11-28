import type { Issue, LinkedIssueRef, ProjectInfo, TrackerKind, Workspace } from "./types";
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

/** What the workspace menu and the ticket picker call a ticket (#1127). */
export function ticketNoun(tracker: TrackerKind | null): string {
  return tracker === "epiku" ? "Epiku story" : "Jira ticket";
}

/** The cached rows the ticket picker may offer a project. The list is the
 *  active project's tracker's: the Jira list serves any Jira project, an
 *  Epiku list only its own project. Anyone else gets none, only the
 *  exact-key fallback checked against its own tracker. */
export function pickerCandidates(
  issues: Issue[] | null,
  list: { scope: string | null; projectId: string | null },
  picker: { projectId: string | null; tracker: TrackerKind | null },
): Issue[] {
  // An Epiku scope may also name the Epiku project it reads (`trackerScope`),
  // so match it by the project the list is for.
  const same =
    picker.tracker === "epiku"
      ? picker.projectId !== null && list.projectId === picker.projectId && !!list.scope?.startsWith("epiku:")
      : picker.tracker === "jira" && list.scope === "jira";
  return same ? issues ?? [] : [];
}

/** How the ticket picker speaks of the list it searches (#1283): Jira's is
 *  the user's assigned tickets; Epiku's is the project's open stories, which
 *  aren't assigned to anyone. */
export function pickerListCopy(tracker: TrackerKind | null): { notListed: string; noMatches: string } {
  return tracker === "epiku"
    ? { notListed: "not in the open stories", noMatches: "No matches in the project's open stories." }
    : { notListed: "not assigned to you", noMatches: "No matches in your assigned tickets." };
}

/** What the new-mission wizard opens on for a ticket. */
export interface TicketWizardTarget {
  projectId: string;
  projectPath: string;
  initialTask: string;
  linkIssueKeyOnCreate: string;
  initialIntent?: "test";
}

/** "Create workspace" or "Test this ticket" (`initialIntent: "test"`) on an
 *  Epiku story: the wizard opens on the active project, whose backlog listed
 *  it. `null` under Jira, which finds the project by the key's prefix. */
export function epikuTicketTarget(
  issue: Pick<Issue, "key" | "summary">,
  activeTracker: TrackerKind | null,
  activeProject: Pick<ProjectInfo, "id" | "path"> | null,
  initialIntent?: "test",
): TicketWizardTarget | null {
  if (activeTracker !== "epiku" || !activeProject) return null;
  const target = { projectId: activeProject.id, projectPath: activeProject.path, initialTask: issue.summary, linkIssueKeyOnCreate: issue.key };
  return initialIntent ? { ...target, initialIntent } : target;
}

/** Where creating a workspace for a ticket goes once nothing stops it, the
 *  existing-workspace alert's Continue included (#1283): an Epiku story to
 *  its `epiku` target ({@link epikuTicketTarget}); a Jira ticket to the one
 *  project its key's prefix names, a choice of several, or none. */
export function ticketCreateRoute(
  ticket: Pick<Issue, "key" | "summary">,
  epiku: TicketWizardTarget | null,
  projects: ProjectInfo[],
  initialIntent?: "test",
):
  | { kind: "wizard"; target: TicketWizardTarget }
  | { kind: "pick"; candidates: ProjectInfo[] }
  | { kind: "unlinked"; prefix: string } {
  if (epiku) return { kind: "wizard", target: epiku };
  const prefix = ticket.key.split("-")[0];
  const candidates = projects.filter((p) => p.jiraProjectKey === prefix);
  if (candidates.length === 0) return { kind: "unlinked", prefix };
  if (candidates.length > 1) return { kind: "pick", candidates };
  return {
    kind: "wizard",
    target: {
      projectId: candidates[0].id,
      projectPath: candidates[0].path,
      initialTask: ticket.summary,
      linkIssueKeyOnCreate: ticket.key,
      initialIntent,
    },
  };
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
 *  active ticket (it's already shown in the ContextHeader). `wholeList`: the
 *  list is the project's already (Epiku, #1127), so no key-prefix filter. */
export function selectBacklog(
  allIssues: Issue[],
  projectKey: string | null,
  activeKey: string | null,
  wholeList = false,
): Issue[] {
  if (wholeList) return sortByStatusPriorityKey(allIssues.filter((i) => i.key !== activeKey));
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
