// `rail-groups` — `default`, with more missions in the project and two
// mission groups in the rail ("Vulnerability fixes", "PR reviews"), a loose
// mission before them and one after, so the rail shows where a group ends.
import type { Scenario } from "./types";
import type { BranchPr, Group, Workspace, WorkspaceGitSummary } from "../../../src/lib/types";
import { defaultScenario, DEFAULT_FIXTURES } from "./default";

const { PROJECT, WORKSPACES, GIT_SUMMARIES } = DEFAULT_FIXTURES;
const [MAIN, SYNC] = WORKSPACES;

const GROUPS: Group[] = [
  {
    id: "group-vulns",
    scope: "workspace",
    projectId: PROJECT.id,
    name: "Vulnerability fixes",
    tint: "rouge",
    sortOrder: 0,
    createdAt: "2026-11-10T09:00:00Z",
  },
  {
    id: "group-reviews",
    scope: "workspace",
    projectId: PROJECT.id,
    name: "PR reviews",
    tint: "indigo",
    sortOrder: 1,
    createdAt: "2026-11-11T09:00:00Z",
  },
];

/** A mission of the project, created at `minute` past the hour (rail order). */
const mission = (
  id: string,
  name: string,
  minute: number,
  tint: Workspace["tint"],
  groupId: string | null,
): Workspace => ({
  ...SYNC,
  id,
  name,
  branch: name,
  task: "",
  worktreePath: `${PROJECT.path}/.octopus-worktrees/${name}`,
  createdAt: `2026-11-10T10:${String(minute).padStart(2, "0")}:00Z`,
  tint,
  groupId,
});

const RAIL: Workspace[] = [
  MAIN,
  SYNC,
  mission("ws-yaml", "patch-yaml-parser", 1, "bone", GROUPS[0].id),
  mission("ws-http", "patch-http-client", 2, "smoke", GROUPS[0].id),
  mission("ws-framework", "bump-web-framework", 3, "verdigris", GROUPS[0].id),
  mission("ws-review-a", "review-billing-limits", 4, "lavender", GROUPS[1].id),
  mission("ws-review-b", "review-auth-flow", 5, "brass", GROUPS[1].id),
  mission("ws-notes", "draft-release-notes", 6, "indigo", null),
];

const SUMMARIES: WorkspaceGitSummary[] = [
  ...GIT_SUMMARIES,
  { workspaceId: "ws-yaml", dirty: false, ahead: 3, behind: 0 },
  { workspaceId: "ws-framework", dirty: true, ahead: 0, behind: 0 },
];

const pr = (branch: string, number: number, title: string): BranchPr => ({
  branch,
  pr: { number, title, url: `https://github.com/octopush-sh/octopush/pull/${number}`, isDraft: false, state: "open" },
});
const OPEN_PRS: BranchPr[] = [
  pr("patch-yaml-parser", 412, "Patch the YAML parser"),
  pr("review-billing-limits", 418, "Billing limits"),
];

// Groups made during a demo ("New group…"), so a later `list_groups` still
// returns them. The fixture is otherwise static: a move lasts until the next
// reload of the rows.
const made: Group[] = [];

export const railGroups: Scenario = {
  ...defaultScenario,
  name: "rail-groups",
  description: "`default` with eight missions, two mission groups in the rail and a loose mission after them.",
  commands: {
    ...defaultScenario.commands,
    list_workspaces: RAIL,
    workspaces_git_summary: SUMMARIES,
    open_prs_for_project: OPEN_PRS,
    list_groups: () => [...GROUPS, ...made],
    create_group: (a) => {
      const group: Group = {
        id: `group-new-${made.length + 1}`,
        scope: "workspace",
        projectId: PROJECT.id,
        name: String(a.name),
        tint: null,
        sortOrder: GROUPS.length + made.length,
        createdAt: "2026-11-18T09:00:00Z",
      };
      made.push(group);
      return group;
    },
  },
};
