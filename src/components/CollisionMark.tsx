/**
 * Collision radar (#732) — the one glyph a workspace gets when another live
 * workspace of its project changes the same files. Amber (`warning`) for a
 * file overlap, rouge when an in-memory merge confirmed a conflict; never
 * brass (it is status, not the active thing) and never a beacon. Hidden when
 * there is nothing to say. Warn only — it blocks nothing.
 */
import { useMemo } from "react";
import { GitCompareArrows } from "lucide-react";
import { useCollisionStore } from "../stores/collisionStore";
import { collisionTooltip, worstSeverity, type WorkspaceCollision } from "../lib/collisions";

const EMPTY: WorkspaceCollision[] = [];

/** A workspace's collisions — a stable reference until the next report. */
export function useWorkspaceCollisions(workspaceId: string | null | undefined): WorkspaceCollision[] {
  return useCollisionStore((s) => (workspaceId ? s.byWorkspace[workspaceId] : undefined) ?? EMPTY);
}

export function collisionTone(severity: "overlap" | "conflict" | "lockfile" | null): string {
  return severity === "conflict" ? "text-octo-rouge" : "text-octo-warning";
}

export function CollisionMark({
  workspaceId,
  size = 11,
}: {
  workspaceId: string;
  size?: number;
}) {
  const list = useWorkspaceCollisions(workspaceId);
  const { severity, tip } = useMemo(
    () => ({ severity: worstSeverity(list), tip: collisionTooltip(list) }),
    [list],
  );
  if (!severity || !tip) return null;
  return (
    <span
      role="img"
      aria-label={tip}
      title={tip}
      data-tour="rail-collision"
      data-severity={severity}
      className={`octo-pop-in flex shrink-0 ${collisionTone(severity)}`}
    >
      <GitCompareArrows size={size} aria-hidden />
    </span>
  );
}
