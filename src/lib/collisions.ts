/**
 * Collision radar (#732) — the pure half: turn a project's pairwise report
 * into what each workspace's indicator says. The scan itself is backend
 * (`project_collisions`, `src-tauri/src/collisions.rs`).
 */
import type { Collision, CollisionSeverity } from "./types";

/** One other workspace this workspace collides with. */
export interface WorkspaceCollision {
  otherId: string;
  otherName: string;
  files: string[];
  conflictingFiles: string[];
  severity: CollisionSeverity;
}

const RANK: Record<CollisionSeverity, number> = { lockfile: 0, overlap: 1, conflict: 2 };

/** Every workspace's collisions, worst first (conflict, then most files). */
export function collisionsByWorkspace(collisions: Collision[]): Record<string, WorkspaceCollision[]> {
  const out: Record<string, WorkspaceCollision[]> = {};
  const push = (id: string, entry: WorkspaceCollision) => {
    (out[id] ??= []).push(entry);
  };
  for (const c of collisions) {
    const shared = { files: c.files, conflictingFiles: c.conflictingFiles, severity: c.severity };
    push(c.a, { otherId: c.b, otherName: c.bName, ...shared });
    push(c.b, { otherId: c.a, otherName: c.aName, ...shared });
  }
  for (const list of Object.values(out)) {
    list.sort(
      (x, y) =>
        RANK[y.severity] - RANK[x.severity] ||
        y.files.length - x.files.length ||
        x.otherName.localeCompare(y.otherName),
    );
  }
  return out;
}

/** The collisions worth an indicator. Lockfile-only overlaps are regenerated
 *  on merge, so on their own they say nothing (minimal noise). */
export function notable(list: WorkspaceCollision[] | undefined): WorkspaceCollision[] {
  return (list ?? []).filter((c) => c.severity !== "lockfile");
}

/** The worst severity among the notable collisions, or null when none. */
export function worstSeverity(list: WorkspaceCollision[] | undefined): CollisionSeverity | null {
  const n = notable(list);
  return n.length ? n[0].severity : null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** At most `max` paths, then "+N more". */
export function fileList(files: string[], max = 4): string {
  const head = files.slice(0, max).join(", ");
  return files.length > max ? `${head} +${files.length - max} more` : head;
}

/** One line per other workspace, e.g.
 *  "Overlaps refund-webhooks · 2 files: src/billing/limits.ts, src/billing/plan.ts"
 *  "Will conflict with auth-flow in 1 file: src/billing/limits.ts" */
export function collisionLine(c: WorkspaceCollision): string {
  if (c.severity === "conflict") {
    return `Will conflict with ${c.otherName} in ${plural(c.conflictingFiles.length, "file")}: ${fileList(c.conflictingFiles)}`;
  }
  return `Overlaps ${c.otherName} · ${plural(c.files.length, "file")}: ${fileList(c.files)}`;
}

/** The indicator's tooltip: every notable collision, worst first. */
export function collisionTooltip(list: WorkspaceCollision[] | undefined): string | null {
  const n = notable(list);
  return n.length ? n.map(collisionLine).join("\n") : null;
}

/** The short meta segment (Mission Control, the collapsed rail flyout):
 *  "overlaps auth-flow · 2 files", "+1 more" when several workspaces collide. */
export function collisionSegment(list: WorkspaceCollision[] | undefined): string | null {
  const n = notable(list);
  if (!n.length) return null;
  const top = n[0];
  const head =
    top.severity === "conflict"
      ? `conflicts with ${top.otherName} · ${plural(top.conflictingFiles.length, "file")}`
      : `overlaps ${top.otherName} · ${plural(top.files.length, "file")}`;
  return n.length > 1 ? `${head} · +${n.length - 1} more` : head;
}
