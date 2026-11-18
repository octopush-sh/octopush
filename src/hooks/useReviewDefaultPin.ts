/**
 * useReviewDefaultPin — pin Review's default source once it is on screen
 * (#903), from fresh answers only.
 *
 * The default follows the tree's dirtiness, so without a pin a crew touching
 * a file would switch a reader of Since base to the working tree mid-read.
 * The pin must come from answers fetched during THIS Review visit for THIS
 * workspace: right after a switch from A to B, App's `gitStatus` still holds
 * A's tree for a render and `committedByWs[B]` may be cached from an earlier
 * visit, and entering Review from Talk starts from Talk's status. Pinning
 * from either would lock in a wrong default for the rest of the visit.
 *
 * So App hands over `answers`: the git status and committed answer one
 * Review refresh fetched together, tagged with their workspace id. App drops
 * them on a workspace switch and on leaving Review, and only Review's refresh
 * sets them, so a matching tag means both are fresh. An explicit pick still
 * wins; leaving Review drops the pins.
 */
import { useEffect } from "react";
import { resolveReviewSource } from "../lib/reviewSource";
import { useReviewSource } from "../stores/reviewSourceStore";

/** One Review refresh's answers, tagged with the workspace they came from. */
export interface ReviewAnswers {
  workspaceId: string;
  /** The working tree has changes. */
  dirty: boolean;
  /** Commits ahead of the base (0 when the committed answer is unavailable). */
  commitsAhead: number;
}

export function useReviewDefaultPin(
  mode: string,
  workspaceId: string | null,
  answers: ReviewAnswers | null,
): void {
  const pick = useReviewSource((s) => (workspaceId ? s.pickByWs[workspaceId] : undefined));
  const pinned = useReviewSource((s) => (workspaceId ? s.pinnedByWs[workspaceId] : undefined));
  useEffect(() => {
    const store = useReviewSource.getState();
    if (mode !== "review") {
      store.clearPins();
      return;
    }
    if (!workspaceId || pick || pinned) return;
    if (!answers || answers.workspaceId !== workspaceId || answers.commitsAhead <= 0) return;
    store.pinDefault(workspaceId, resolveReviewSource(undefined, answers.dirty, answers.commitsAhead));
  }, [mode, workspaceId, pick, pinned, answers]);
}
