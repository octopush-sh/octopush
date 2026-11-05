import { sendNotification } from "@tauri-apps/plugin-notification";
import type { PtyAttentionReason } from "./types";
import { useWorkspaceStore, findWorkspaceName } from "../stores/workspaceStore";
import { useNotifyPrefs } from "../stores/notifyPrefsStore";

/** What an interactive Claude Code session in a Run terminal is waiting on,
 *  as its own hooks report it (#287). The daemon's `idle` heuristic and the
 *  terminal bell don't know, so they keep the generic terminal copy. */
export type ClaudeWaitReason = "permission" | "input";

export function claudeWaitReason(reason: PtyAttentionReason | null | undefined): ClaudeWaitReason | null {
  return reason === "permission" || reason === "input" ? reason : null;
}

/** The one phrase Mission Control and the notification share. */
export function claudeWaitingCopy(reason: ClaudeWaitReason): string {
  return reason === "permission" ? "waiting on permission" : "waiting on your input";
}

export interface ClaudeWaitingNotification {
  title: string;
  body: string;
}

/** Pure: the notification for a hook signal, or null when the user is already
 *  looking at the terminal (pane on screen and Octopush focused). */
export function decideClaudeWaitingNotification(
  reason: ClaudeWaitReason,
  workspaceName: string | null,
  seen: boolean,
): ClaudeWaitingNotification | null {
  if (seen) return null;
  return {
    title: "Claude Code needs you",
    body: `${workspaceName ?? "a workspace"} — ${claudeWaitingCopy(reason)}`,
  };
}

/** Fire the native notification for a hook signal, under the same preference
 *  as crew notifications (Settings › General). */
export function notifyClaudeWaiting(workspaceId: string, reason: ClaudeWaitReason, paneShown: boolean): void {
  if (!useNotifyPrefs.getState().crewNotifications) return;
  const seen = paneShown && document.hasFocus();
  const name = findWorkspaceName(useWorkspaceStore.getState().workspacesByProjectId, workspaceId);
  const n = decideClaudeWaitingNotification(reason, name, seen);
  if (!n) return;
  try {
    sendNotification({ title: n.title, body: n.body });
  } catch {
    // Notification plumbing must never surface as an app error.
  }
}
