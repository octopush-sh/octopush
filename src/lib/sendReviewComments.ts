/**
 * "Send to the agent" (#956): every comment in a workspace's Review tray as
 * one message — the Send-back feedback of the workspace's latest Direct run
 * when it is parked at a gate that can still send back, otherwise a user turn
 * in the workspace's open Talk thread (Talk makes one when there is none).
 */
import { commentsMessage, sendBackGate, type ReviewComment } from "./reviewComments";
import { pickBlockedStage } from "./planWait";
import { isTerminalRun } from "./runStatus";
import { labelForRole } from "./stageMeta";
import { navigate } from "./tour/surfaces";
import { useReviewComments } from "../stores/reviewCommentsStore";
import { useRunsStore } from "../stores/runsStore";
import { useChatStore } from "../stores/chatStore";
import { pushToast } from "../components/Toasts";

export type CommentTarget =
  | { kind: "gate"; runId: string; stageId: string; role: string; iteration: number }
  | { kind: "talk" };

/** Where `sendReviewComments` would deliver now, read from the runs store.
 *  A run that has ended (the rule the run bar uses) has no gate to send back
 *  to, whatever its stage rows say: an abort leaves the parked stage at
 *  `awaiting_checkpoint`, and a send-back there would reach no agent. */
export function commentTarget(workspaceId: string): CommentTarget {
  const runs = useRunsStore.getState();
  const latest = runs.getRuns(workspaceId)[0];
  const detail = latest ? runs.getDetail(latest.id) : undefined;
  const stages = detail?.stages ?? [];
  const ended = !latest || isTerminalRun(latest.status) || (!!detail?.run && isTerminalRun(detail.run.status));
  const gate = sendBackGate(pickBlockedStage(stages), stages);
  if (latest && !ended && gate && !gate.atCap) {
    return { kind: "gate", runId: latest.id, stageId: gate.stage.id, role: labelForRole(gate.target.role), iteration: gate.iteration };
  }
  return { kind: "talk" };
}

/** Send the tray, empty it, and then show where it went. A send that doesn't
 *  go out (budget cap, no thread, IPC error, a refused checkpoint) puts the
 *  comments back; the store it went to shows why. Talk's staged attachments
 *  stay staged: the message is the comments only. */
export async function sendReviewComments(workspaceId: string, workspacePath: string): Promise<void> {
  const store = useReviewComments.getState();
  const live = store.liveByWs[workspaceId] ?? null;
  const target = commentTarget(workspaceId);
  const comments = store.take(workspaceId);
  if (comments.length === 0) return;
  const message = commentsMessage(comments, live);
  let sent = false;
  try {
    if (target.kind === "gate") {
      const errorsBefore = useRunsStore.getState().runErrors[target.runId]?.n ?? 0;
      sent = await useRunsStore.getState().resolve(target.runId, target.stageId, "send_back", { feedback: message });
      if (sent) confirmGateSend(workspaceId, target, comments, errorsBefore);
    } else {
      sent = await useChatStore.getState().send(workspaceId, workspacePath, message, undefined, { attachments: false });
    }
  } finally {
    if (!sent) useReviewComments.getState().restore(workspaceId, comments);
  }
  // Only once it went out: a refused send leaves the director in Review, with
  // the comments still in the tray.
  if (sent) navigate({ kind: "mode", mode: target.kind === "gate" ? "direct" : "talk" });
}

/** An accepted send-back is not yet an applied one: without detached runs the
 *  backend applies the decision in the background and reports a refusal
 *  ("run is already executing", say) as `run://error`. Watch the run until
 *  the gate's stage moved (applied: the comments are with the agent) or an
 *  error arrived while it still waits (refused: the comments go back). */
function confirmGateSend(
  workspaceId: string,
  target: Extract<CommentTarget, { kind: "gate" }>,
  comments: ReviewComment[],
  errorsBefore: number,
): void {
  const settled = (): boolean => {
    const runs = useRunsStore.getState();
    const stage = runs.detailByRun[target.runId]?.stages.find((s) => s.id === target.stageId);
    if (stage && (stage.status !== "awaiting_checkpoint" || stage.loopIterations !== target.iteration)) return true;
    const err = runs.runErrors[target.runId];
    if (!err || err.n <= errorsBefore) return false;
    useReviewComments.getState().restore(workspaceId, comments);
    pushToast({
      level: "info",
      title: "Comments not sent",
      body: `${err.error.split("\n")[0].replace(/[.\s]+$/, "")}. They are back in Review's tray.`,
    });
    return true;
  };
  if (settled()) return;
  const stop = useRunsStore.subscribe(() => {
    if (!settled()) return;
    stop();
    watching.delete(stop);
  });
  watching.add(stop);
}

const watching = new Set<() => void>();

/** Stop watching every send-back that is still unconfirmed (tests). */
export function forgetPendingGateSends(): void {
  watching.forEach((stop) => stop());
  watching.clear();
}
