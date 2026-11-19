// The ⌘K "Groups" section: every rail group, in the order the rail draws
// them, found by name. Choosing one reveals it in the rail (`revealGroup`).

import type { Group, TintName, Workspace } from "./types";
import { layoutProjects, missionGroupsOf, projectGroupsOf, type RailProject } from "./railGroups";

/** Prefix on a Groups row's cmdk `value` (`group:<id>`). The row is scored
 *  on its keywords (the group's name, and its project's for a mission
 *  group), never on the id. */
export const GROUP_VALUE_PREFIX = "group:";

/** One row of the ⌘K Groups section. */
export interface PaletteGroup {
  id: string;
  name: string;
  tint: TintName | null;
  /** `project`: a section of projects; `workspace`: a folder of missions. */
  scope: Group["scope"];
  /** The meta line: `acme-api · 3 missions`, `2 projects`, `acme-api · empty`. */
  meta: string;
  keywords: string[];
}

interface ProjectLike extends RailProject {
  name: string;
  workspaces: Workspace[];
}

const count = (n: number, one: string) => (n === 0 ? "empty" : `${n} ${one}${n === 1 ? "" : "s"}`);

/**
 * The groups of the open projects, in the rail's reading order: each project
 * group, then the mission groups of the projects inside it, then a loose
 * project's mission groups. A mission group of a project that is not open
 * (closed, so not in the rail) is left out: there is nothing to reveal.
 */
export function paletteGroups(projects: readonly ProjectLike[] | undefined, groups: readonly Group[]): PaletteGroup[] {
  const open = (projects ?? []).filter((p) => !!p?.id);
  const rows: PaletteGroup[] = [];
  const missionGroups = (project: ProjectLike) => {
    for (const g of missionGroupsOf(groups, project.id)) {
      const members = (project.workspaces ?? []).filter((w) => w?.groupId === g.id).length;
      rows.push({
        id: g.id,
        name: g.name,
        tint: g.tint,
        scope: "workspace",
        meta: `${project.name} · ${count(members, "mission")}`,
        keywords: [g.name, project.name],
      });
    }
  };
  for (const item of layoutProjects(open, projectGroupsOf(groups))) {
    if (item.kind === "project") {
      missionGroups(item.project);
      continue;
    }
    rows.push({
      id: item.group.id,
      name: item.group.name,
      tint: item.group.tint,
      scope: "project",
      meta: count(item.projects.length, "project"),
      keywords: [item.group.name],
    });
    for (const project of item.projects) missionGroups(project);
  }
  return rows;
}
