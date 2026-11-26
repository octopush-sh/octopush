// `rail-project-groups` — `default` with six more projects in the rail and
// two project groups ("Client work", "Side projects"): a pinned loose project
// above them and a loose one after, so the rail shows where a group ends.
// Moves, pins and reorders made during a demo last until the page reloads.
import type { Scenario } from "./types";
import type { Group, ProjectInfo, TintName, Workspace } from "../../../src/lib/types";
import { defaultScenario, DEFAULT_FIXTURES } from "./default";

const { PROJECT, WORKSPACES } = DEFAULT_FIXTURES;
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
const SIDE: Group = {
  id: "pgroup-side",
  scope: "project",
  projectId: null,
  name: "Side projects",
  tint: "indigo",
  sortOrder: 1,
  createdAt: "2026-11-11T09:00:00Z",
};

const project = (name: string, groupId: string | null, tint: TintName | null = null): ProjectInfo => ({
  id: `proj-${name}`,
  name,
  path: `/Users/dev/code/${name}`,
  jiraProjectKey: null,
  pinned: false,
  tint,
  groupId,
});

const EXTRA: ProjectInfo[] = [
  project("acme-api", CLIENT.id),
  project("acme-web", CLIENT.id, "rouge"),
  project("acme-admin", CLIENT.id),
  project("notebook-cli", SIDE.id),
  project("weather-bot", SIDE.id),
  project("dotfiles", null),
];

const mission = (owner: ProjectInfo, name: string, minute: number, tint: Workspace["tint"]): Workspace => ({
  ...MAIN,
  id: `ws-${owner.name}-${name}`,
  projectId: owner.id,
  name,
  branch: name,
  task: "",
  worktreePath: name === "main" ? owner.path : `${owner.path}/.octopus-worktrees/${name}`,
  createdAt: `2026-11-10T10:${String(minute).padStart(2, "0")}:00Z`,
  tint,
  fromBranch: name === "main" ? null : "main",
  groupId: null,
});

const [API, WEB, ADMIN, NOTEBOOK, WEATHER, DOTFILES] = EXTRA;
const MISSIONS: Record<string, Workspace[]> = {
  [PROJECT.id]: WORKSPACES,
  [API.id]: [mission(API, "main", 0, "bone"), mission(API, "rate-limit-headers", 1, "verdigris")],
  [WEB.id]: [mission(WEB, "main", 0, "smoke"), mission(WEB, "checkout-copy", 1, "lavender")],
  [ADMIN.id]: [mission(ADMIN, "main", 0, "indigo")],
  [NOTEBOOK.id]: [mission(NOTEBOOK, "main", 0, "brass"), mission(NOTEBOOK, "export-markdown", 1, "rouge")],
  [WEATHER.id]: [mission(WEATHER, "main", 0, "verdigris")],
  [DOTFILES.id]: [mission(DOTFILES, "main", 0, "smoke")],
};

// What a demo changed since the page loaded.
let projects: ProjectInfo[] = [PROJECT, ...EXTRA];
let groups: Group[] = [CLIENT, SIDE];

/** The backend's order: pinned first, then the manual order (the array's). */
const listed = () => [...projects.filter((p) => p.pinned), ...projects.filter((p) => !p.pinned)];

export const railProjectGroups: Scenario = {
  ...defaultScenario,
  name: "rail-project-groups",
  description:
    "`default` with seven projects in the rail: a pinned one, two project groups (“Client work”, “Side projects”) and a loose project after them.",
  commands: {
    ...defaultScenario.commands,
    list_recent_projects: () => listed(),
    list_workspaces: (a) => MISSIONS[String(a.projectId)] ?? [],
    workspaces_git_summary: (a) =>
      a.projectId === PROJECT.id ? DEFAULT_FIXTURES.GIT_SUMMARIES : [],
    list_groups: () => groups,
    set_project_order: (a) => {
      const ids = a.ids as string[];
      projects = [...projects].sort((x, y) => ids.indexOf(x.id) - ids.indexOf(y.id));
      return null;
    },
    set_project_pinned: (a) => {
      projects = projects.map((p) => (p.id === a.projectId ? { ...p, pinned: Boolean(a.pinned) } : p));
      return null;
    },
    set_item_group: (a) => {
      if (a.kind !== "project") return null;
      const groupId = (a.groupId as string | null) ?? null;
      projects = projects.map((p) => (p.id === a.itemId ? { ...p, groupId } : p));
      return null;
    },
    create_group: (a) => {
      const memberIds = (a.memberIds as string[] | undefined) ?? [];
      const group: Group = {
        id: `pgroup-new-${groups.length + 1}`,
        scope: a.scope === "workspace" ? "workspace" : "project",
        projectId: a.scope === "workspace" ? String(a.projectId) : null,
        name: String(a.name),
        tint: (a.tint as TintName | null | undefined) ?? null,
        sortOrder: groups.length,
        createdAt: "2026-11-18T09:00:00Z",
      };
      groups = [...groups, group];
      if (group.scope === "project") {
        projects = projects.map((p) => (memberIds.includes(p.id) ? { ...p, groupId: group.id } : p));
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
    delete_group: (a) => {
      groups = groups.filter((g) => g.id !== a.groupId);
      projects = projects.map((p) => (p.groupId === a.groupId ? { ...p, groupId: null } : p));
      return null;
    },
  },
};
