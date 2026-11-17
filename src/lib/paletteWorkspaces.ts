import type { Run } from "./ipc";
import type { Workspace } from "./types";
import { needsYou } from "./runStatus";

/** One row of the ⌘K Workspaces group. */
export interface PaletteWorkspace {
  id: string;
  name: string;
  branch: string;
  project: string;
  glyph: string;
  /** A crew in this workspace needs you (a paused run — the Dock badge's source). */
  needsYou: boolean;
  /** Something is working in it (chat, a Direct run, a busy terminal), the rail's marching edge. */
  running: boolean;
  /** cmdk's filter keywords: name, branch and project, so part of a branch finds the row. */
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
): PaletteWorkspace[] {
  const rows: (PaletteWorkspace & { waitingSince: number; lastActive: number })[] = [];
  for (const project of projects ?? []) {
    for (const ws of project?.workspaces ?? []) {
      if (!ws?.id || ws.status === "archived") continue;
      const waiting = (runsByWs?.[ws.id] ?? []).filter(needsYou);
      const waitingSince = waiting.length
        ? Math.min(...waiting.map((r) => statusSince?.[r.id] ?? Number.MAX_SAFE_INTEGER))
        : Number.MAX_SAFE_INTEGER;
      const name = ws.name || ws.branch || "Untitled";
      rows.push({
        id: ws.id,
        name,
        branch: ws.branch ?? "",
        project: project.name ?? "",
        glyph: ws.glyph || name.charAt(0).toUpperCase() || "?",
        needsYou: waiting.length > 0,
        running: Boolean(runningByWs?.[ws.id]),
        keywords: [name, ws.branch ?? "", project.name ?? ""].filter(Boolean),
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
