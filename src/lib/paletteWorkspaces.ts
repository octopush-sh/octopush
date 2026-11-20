import type { Run } from "./ipc";
import type { Group, Workspace } from "./types";
import { needsYou } from "./runStatus";
import { resolveMonogram } from "./monogram";
import { defaultFilter } from "cmdk";
import { GROUP_VALUE_PREFIX } from "./paletteGroups";

/** Prefix on a workspace row's cmdk `value`. The value is the workspace id
 *  (unique, so two same-named rows stay apart for the keyboard), and the
 *  prefix lets {@link paletteFilter} keep that id out of the score. */
export const WORKSPACE_VALUE_PREFIX = "ws:";

/** Prefix on a Models row's cmdk `value` (`model:<provider>/<id>`). An
 *  explicit value lets the palette move the selection onto a model row
 *  (#897); the row is scored on its keywords (name, provider). */
export const MODEL_VALUE_PREFIX = "model:";

/** The palette's cmdk filter. A workspace row is scored on its keywords
 *  only (name, branch, project, group): its value is a UUID, and fuzzy-matching
 *  that would let any query of hex letters and digits ("772", "dec") hit
 *  most workspaces. A model row and a group row are scored on their keywords
 *  too, so the `model:` and `group:` prefixes never match. Every other row keeps cmdk's default
 *  scoring. */
export function paletteFilter(value: string, search: string, keywords?: string[]): number {
  if (
    value.startsWith(WORKSPACE_VALUE_PREFIX) ||
    value.startsWith(MODEL_VALUE_PREFIX) ||
    value.startsWith(GROUP_VALUE_PREFIX)
  ) {
    const text = (keywords ?? []).join(" ");
    return text ? defaultFilter(text, search) : 0;
  }
  return defaultFilter(value, search, keywords);
}

/** One row of the ⌘K Workspaces group. */
export interface PaletteWorkspace {
  id: string;
  name: string;
  branch: string;
  project: string;
  /** The mission group it sits in, or null (loose). */
  group: string | null;
  glyph: string;
  /** A crew in this workspace needs you (a paused run — the Dock badge's source). */
  needsYou: boolean;
  /** Something is working in it (chat, a Direct run, a busy terminal), the rail's marching edge. */
  running: boolean;
  /** cmdk's filter keywords: name, branch, project and mission group, so
   *  part of a branch finds the row, and a group's name finds its missions
   *  (as a group-name hit keeps a group's members in the rail filter). */
  keywords: string[];
}

interface ProjectLike {
  name: string;
  workspaces: Workspace[];
}

const ms = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? 0 : t;
};

/**
 * Every non-archived workspace across the open projects, in the order the
 * palette lists them: workspaces whose crew needs you first (longest waiting
 * first, like the fleet beacon), then running ones, then the rest by most
 * recent activity. Pure, so the order is testable on its own.
 */
export function paletteWorkspaces(
  projects: ProjectLike[] | undefined,
  runsByWs: Record<string, Pick<Run, "id" | "status">[]> | undefined,
  statusSince: Record<string, number> | undefined,
  runningByWs: Record<string, boolean> | undefined,
  groups: readonly Group[] = [],
): PaletteWorkspace[] {
  // A mission is in a group only when the group is its own project's (the
  // rail's `ownGroupId` rule): a stale id means loose here too.
  const groupById = new Map(groups.map((g) => [g.id, g] as const));
  const groupName = (ws: Workspace) => {
    const g = ws.groupId ? groupById.get(ws.groupId) : undefined;
    return g && g.scope === "workspace" && g.projectId === ws.projectId ? g.name : null;
  };
  const rows: (PaletteWorkspace & { waitingSince: number; lastActive: number })[] = [];
  for (const project of projects ?? []) {
    for (const ws of project?.workspaces ?? []) {
      if (!ws?.id || ws.status === "archived") continue;
      const waiting = (runsByWs?.[ws.id] ?? []).filter(needsYou);
      const waitingSince = waiting.length
        ? Math.min(...waiting.map((r) => statusSince?.[r.id] ?? Number.MAX_SAFE_INTEGER))
        : Number.MAX_SAFE_INTEGER;
      const name = ws.name || ws.branch || "Untitled";
      const group = groupName(ws);
      rows.push({
        id: ws.id,
        name,
        branch: ws.branch ?? "",
        project: project.name ?? "",
        group,
        // The rail's monogram, so the row reads like the rail.
        glyph: resolveMonogram(ws).glyph,
        needsYou: waiting.length > 0,
        running: Boolean(runningByWs?.[ws.id]),
        keywords: [name, ws.branch ?? "", project.name ?? "", group ?? ""].filter(Boolean),
        waitingSince,
        lastActive: ms(ws.lastActive),
      });
    }
  }
  const tier = (r: { needsYou: boolean; running: boolean }) => (r.needsYou ? 0 : r.running ? 1 : 2);
  rows.sort(
    (a, b) =>
      tier(a) - tier(b) ||
      (a.needsYou ? a.waitingSince - b.waitingSince : 0) ||
      b.lastActive - a.lastActive ||
      a.name.localeCompare(b.name),
  );
  return rows.map(({ waitingSince: _w, lastActive: _l, ...r }) => r);
}
