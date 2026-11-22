/**
 * "Send to the agent" (#956): every comment in a workspace's Review tray as
 * one message — the Send-back feedback of the workspace's latest Direct run
 * when it is parked at a gate that can still send back, otherwise a user turn
 * in the workspace's open Talk thread (Talk makes one when there is none).
 */
import { commentsMessage, sendBackGate } from "./reviewComments";
import { pickBlockedStage } from "./planWait";
import { labelForRole } from "./stageMeta";
import { navigate } from "./tour/surfaces";
import { useReviewComments } from "../stores/reviewCommentsStore";
import { useRunsStore } from "../stores/runsStore";
import { useChatStore } from "../stores/chatStore";

export type CommentTarget =
  | { kind: "gate"; runId: string; stageId: string; role: string }
  | { kind: "talk" };

/** Where `sendReviewComments` would deliver now, read from the runs store. */
export function commentTarget(workspaceId: string): CommentTarget {
  const runs = useRunsStore.getState();
  const latest = runs.getRuns(workspaceId)[0];
  const stages = latest ? runs.getDetail(latest.id)?.stages ?? [] : [];
  const gate = sendBackGate(pickBlockedStage(stages), stages);
  if (latest && gate && !gate.atCap) {
    return { kind: "gate", runId: latest.id, stageId: gate.stage.id, role: labelForRole(gate.target.role) };
  }
  return { kind: "talk" };
}

/** Send the tray, empty it, and show where it went. A send that doesn't go
 *  out (budget cap, no thread, IPC error, a refused checkpoint) puts the
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
      navigate({ kind: "mode", mode: "direct" });
      sent = await useRunsStore.getState().resolve(target.runId, target.stageId, "send_back", { feedback: message });
    } else {
      navigate({ kind: "mode", mode: "talk" });
      sent = await useChatStore.getState().send(workspaceId, workspacePath, message, undefined, { attachments: false });
    }
  } finally {
    if (!sent) useReviewComments.getState().restore(workspaceId, comments);
  }
}
