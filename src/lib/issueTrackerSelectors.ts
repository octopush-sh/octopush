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
