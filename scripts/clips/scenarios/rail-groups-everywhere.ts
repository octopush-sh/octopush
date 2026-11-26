// `rail-groups-everywhere` — `default` with a project group ("Client work")
// holding `acme-api` and `acme-web`, and a mission group ("Fixes") in
// `acme-api`, so groups show beyond the rail: ⌘K's Groups section, a crew card
// in Mission Control reading `Fixes · fix-json-parser`, and an archived
// mission of the group in Archived workspaces. Moves and groups made during a
// demo last until the page reloads.
import type { Scenario } from "./types";
import type { Run } from "../../../src/lib/ipc";
import type { Group, ProjectInfo, TintName, Workspace } from "../../../src/lib/types";
import { defaultScenario, DEFAULT_FIXTURES } from "./default";

const { PROJECT, WORKSPACES, RUN, RUN_STAGES } = DEFAULT_FIXTURES;
const [MAIN] = WORKSPACES;

const CLIENT: Group = {
  id: "pgroup-client",
  scope: "project",
  projectId: null,
  name: "Client work",
  tint: "verdigris",
  sortOrder: 0,
  createdAt: "2026-11-10T09:00:00Z",
};

const project = (name: string, groupId: string | null): ProjectInfo => ({
  id: `proj-${name}`,
  name,
  path: `/Users/dev/code/${name}`,
  jiraProjectKey: null,
  pinned: false,
  tint: null,
  groupId,
});
const API = project("acme-api", CLIENT.id);
const WEB = project("acme-web", CLIENT.id);

const FIXES: Group = {
  id: "group-fixes",
  scope: "workspace",
  projectId: API.id,
  name: "Fixes",
  tint: "rouge",
  sortOrder: 0,
  createdAt: "2026-11-10T09:30:00Z",
};

const mission = (
  owner: ProjectInfo,
  name: string,
  minute: number,
  tint: TintName,
  groupId: string | null,
  status: Workspace["status"] = "active",
): Workspace => ({
  ...MAIN,
  id: `ws-${owner.name}-${name}`,
  projectId: owner.id,
  name,
  branch: name,
  task: "",
  status,
  worktreePath: name === "main" ? owner.path : `${owner.path}/.octopus-worktrees/${name}`,
  createdAt: `2026-11-10T10:${String(minute).padStart(2, "0")}:00Z`,
  tint,
  fromBranch: name === "main" ? null : "main",
  groupId,
});

let missions: Record<string, Workspace[]> = {
  [PROJECT.id]: WORKSPACES,
  [API.id]: [
    mission(API, "main", 0, "bone", null),
    mission(API, "refactor-auth", 1, "indigo", null),
    mission(API, "fix-json-parser", 2, "verdigris", FIXES.id),
    mission(API, "fix-netty-codec", 3, "smoke", FIXES.id),
    mission(API, "monthly-report", 4, "lavender", null),
    mission(API, "bump-framework", 5, "brass", null),
  ],
  [WEB.id]: [mission(WEB, "main", 0, "smoke", null), mission(WEB, "checkout-copy", 1, "rouge", null)],
};
const ARCHIVED: Workspace[] = [mission(API, "fix-yaml-loader", 6, "bone", FIXES.id, "archived")];

/** A crew at work in a mission of "Fixes", for Mission Control's atom. */
const FIX_RUN: Run = {
  ...RUN,
  id: "run-fix",
  workspaceId: `ws-${API.name}-fix-json-parser`,
  task: "Patch the JSON parser advisory",
  status: "running",
  // Started a few minutes before the page loads, so the card's timer reads
  // like a crew at work rather than a fixture from last week.
  createdAt: new Date(Date.now() - 4 * 60_000).toISOString(),
  finishedAt: null,
};

let projects: ProjectInfo[] = [PROJECT, API, WEB];
let groups: Group[] = [CLIENT, FIXES];

export const railGroupsEverywhere: Scenario = {
  ...defaultScenario,
  name: "rail-groups-everywhere",
  description:
    "`default` with a project group (“Client work”: `acme-api`, `acme-web`), a mission group (“Fixes”) in `acme-api`, a crew at work in one of its missions and an archived one.",
  commands: {
    ...defaultScenario.commands,
    list_recent_projects: () => projects,
    list_workspaces: (a) => missions[String(a.projectId)] ?? [],
    workspaces_git_summary: (a) => (a.projectId === PROJECT.id ? DEFAULT_FIXTURES.GIT_SUMMARIES : []),
    list_archived_workspaces: (a) => (a.projectId === API.id ? ARCHIVED : []),
    list_active_runs: [FIX_RUN],
    list_runs: (a) => (a.workspaceId === FIX_RUN.workspaceId ? [FIX_RUN] : a.workspaceId === RUN.workspaceId ? [RUN] : []),
    get_run: (a) =>
      a.runId === FIX_RUN.id
        ? { run: FIX_RUN, stages: RUN_STAGES.map((s, i) => ({ ...s, runId: FIX_RUN.id, status: i === 1 ? "running" : i === 0 ? "done" : "pending" })) }
        : a.runId === RUN.id
          ? { run: RUN, stages: RUN_STAGES }
          : { run: null, stages: [] },
    list_groups: () => groups,
    set_item_group: (a) => {
      const groupId = (a.groupId as string | null) ?? null;
      if (a.kind === "project") {
        projects = projects.map((p) => (p.id === a.itemId ? { ...p, groupId } : p));
      } else {
        missions = Object.fromEntries(
          Object.entries(missions).map(([id, list]) => [id, list.map((w) => (w.id === a.itemId ? { ...w, groupId } : w))]),
        );
      }
      return null;
    },
    create_group: (a) => {
      const memberIds = (a.memberIds as string[] | undefined) ?? [];
      const scope = a.scope === "workspace" ? "workspace" : "project";
      const group: Group = {
        id: `group-new-${groups.length + 1}`,
        scope,
        projectId: scope === "workspace" ? String(a.projectId) : null,
        name: String(a.name),
        tint: (a.tint as TintName | null | undefined) ?? null,
        sortOrder: groups.length,
        createdAt: "2026-11-19T09:00:00Z",
      };
      groups = [...groups, group];
      if (scope === "project") {
        projects = projects.map((p) => (memberIds.includes(p.id) ? { ...p, groupId: group.id } : p));
      } else {
        missions = Object.fromEntries(
          Object.entries(missions).map(([id, list]) => [
            id,
            list.map((w) => (memberIds.includes(w.id) ? { ...w, groupId: group.id } : w)),
          ]),
        );
      }
      return group;
    },
    rename_group: (a) => {
      groups = groups.map((g) => (g.id === a.groupId ? { ...g, name: String(a.name) } : g));
      return null;
    },
    set_group_tint: (a) => {
      groups = groups.map((g) => (g.id === a.groupId ? { ...g, tint: (a.tint as TintName | null) ?? null } : g));
      return null;
    },
  },
};
