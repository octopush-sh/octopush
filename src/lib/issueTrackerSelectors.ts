import type { Issue, ProjectInfo, Workspace } from "./types";
import { detectIssueKey } from "./detectIssueKey";

export type LinkageState =
  | { kind: "linked"; key: string; source: "manual" | "detected" }
  | { kind: "dismissed" }
  | { kind: "unlinked" };

export function resolveLinkage(ws: Workspace, branch: string): LinkageState {
  if (ws.linkedIssueKey) {
    return { kind: "linked", key: ws.linkedIssueKey, source: "manual" };
  }
  const detected = detectIssueKey(branch);
  if (detected) {
    return { kind: "linked", key: detected, source: "detected" };
  }
  if (ws.issueLinkDismissed) {
    return { kind: "dismissed" };
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

export function selectBacklog(
  allIssues: Issue[],
  projectKey: string | null,
  activeKey: string | null,
): Issue[] {
  if (projectKey == null) return [];
  const prefix = projectKey + "-";
  return allIssues
    .filter((i) => i.key.startsWith(prefix) && i.key !== activeKey)
    .sort((a, b) => {
      const s = STATUS_RANK[a.statusCategory] - STATUS_RANK[b.statusCategory];
      if (s !== 0) return s;
      const p = priorityRank(a.priority) - priorityRank(b.priority);
      if (p !== 0) return p;
      return a.key.localeCompare(b.key);
    });
}

export function selectElsewhereCount(
  allIssues: Issue[],
  projectKey: string | null,
): number {
  if (projectKey == null) return 0;
  const prefix = projectKey + "-";
  return allIssues.filter(
    (i) => !i.key.startsWith(prefix) && i.statusCategory === "inProgress",
  ).length;
}

/** Map an Issue to a Tailwind text-color class based on its issue type.
 *  Locale-independent for Epic (hierarchyLevel) and Sub-task (boolean);
 *  falls back to localized-name matching for Story / Bug / Task with
 *  English + Spanish aliases. Unmapped types use brass (brand fallback).
 *
 *  Used by the ticket chip in `ContextHeader` to color each key in the
 *  parent chain by its own type. */
export function issueTypeToken(issue: Issue): string {
  if (issue.hierarchyLevel === 1) return "text-state-purple";   // Epic
  if (issue.subtask) return "text-state-blue";                  // Sub-task
  const name = issue.issueType.toLowerCase();
  if (name === "story" || name === "historia") return "text-octo-verdigris";
  if (name === "bug" || name === "error" || name === "incidencia") return "text-octo-rouge";
  if (name === "task" || name === "tarea") return "text-state-blue";
  return "text-octo-brass";
}
