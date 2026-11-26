import { sendNotification } from "@tauri-apps/plugin-notification";
import { useWorkspaceStore, findWorkspaceName } from "../stores/workspaceStore";
import { useNotifyPrefs } from "../stores/notifyPrefsStore";

/** A Talk approval card waiting on the user reaches them while Octopush is
 *  in the background: the same native notification path, and the same
 *  preference (Settings › General › "Notify when a crew needs you"), as a
 *  crew's gate (`crewNotifications.ts`) and Claude Code waiting in a
 *  terminal (`claudeWaiting.ts`). While the app has focus the rail, the
 *  Mode switcher and Mission Control say it instead. */

export interface ApprovalNotification {
  title: string;
  body: string;
}

/** Surrogate-safe head truncation for notification bodies. */
function trim(text: string, max: number): string {
  if (text.length <= max) return text;
  let head = text.slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return `${head}…`;
}

/** Pure: the notification for an approval card, or null while the app has
 *  focus. Only the command's first line: never anything the secret guard
 *  found. */
export function decideApprovalNotification(
  card: { command: string; secret?: boolean },
  workspaceName: string | null,
  appFocused: boolean,
): ApprovalNotification | null {
  if (appFocused) return null;
  const where = workspaceName ?? "a workspace";
  const command = trim(card.command.split("\n")[0].trim(), 70);
  return {
    title: "Talk needs a decision",
    body: card.secret
      ? `${where} — possible secret before ${command}`
      : `${where} — approve or deny ${command}`,
  };
}

/** Fire it for a card just raised in `workspaceId`. */
export function notifyApprovalWaiting(workspaceId: string, card: { command: string; secret?: boolean }): void {
  if (!useNotifyPrefs.getState().crewNotifications) return;
  const focused = typeof document !== "undefined" && document.hasFocus();
  const name = findWorkspaceName(useWorkspaceStore.getState().workspacesByProjectId, workspaceId);
  const n = decideApprovalNotification(card, name, focused);
  if (!n) return;
  try {
    sendNotification({ title: n.title, body: n.body });
  } catch {
    // Notification plumbing must never surface as an app error.
  }
}
