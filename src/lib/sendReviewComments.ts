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
import { useWorkspaceStore } from "../stores/workspaceStore";
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

/** Send the tray, empty it, and show where it went. Only a send that was
 *  refused before it went out (budget cap, no thread, an IPC that never took
 *  the message, a refused checkpoint) puts the comments back; the store it
 *  went to shows why. Talk's staged attachments stay staged: the message is
 *  the comments only.
 *
 *  A Talk turn can run for minutes and `chatStore.send` resolves only when
 *  it ends, so nothing here waits for that to tell the director: the app
 *  shows Talk as soon as the turn is dispatched, and a turn that fails
 *  later, with the message already in the thread, restores nothing (sending
 *  again would deliver the comments twice). */
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
      if (sent) {
        confirmGateSend(workspaceId, target, comments, errorsBefore);
        showWhereItWent(workspaceId, "direct");
      }
    } else {
      let dispatched = false;
      const ended = await useChatStore.getState().send(workspaceId, workspacePath, message, undefined, {
        attachments: false,
        onDispatched: () => {
          dispatched = true;
          showWhereItWent(workspaceId, "talk");
        },
      });
      // A dispatched turn that failed: the backend may have refused it before
      // taking the message (its own budget gate) or failed midway. The thread
      // says which; `send` has already read it again.
      sent = ended || (dispatched && inThread(workspaceId, message));
    }
  } finally {
    if (!sent) useReviewComments.getState().restore(workspaceId, comments);
  }
}

/** The message is a user turn of the workspace's thread on screen. */
function inThread(workspaceId: string, message: string): boolean {
  const messages = useChatStore.getState().messagesByWs[workspaceId] ?? [];
  return messages.some((m) => m.role === "user" && m.content.trim() === message.trim());
}

/** Switch to the mode the comments went to, in the workspace they were sent
 *  from. A director who has moved to another workspace meanwhile is not
 *  pulled out of it: a toast says where they went instead. */
function showWhereItWent(workspaceId: string, mode: "talk" | "direct"): void {
  const active = useWorkspaceStore.getState().activeId;
  if (active === null || active === workspaceId) {
    navigate({ kind: "mode", mode });
    return;
  }
  pushToast({
    level: "info",
    title: "Comments sent",
    body: mode === "talk"
      ? "They went to Talk in the workspace you sent them from."
      : "They went to the waiting gate in the workspace you sent them from.",
  });
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
