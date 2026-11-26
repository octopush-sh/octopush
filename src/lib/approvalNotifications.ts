import { sendNotification } from "@tauri-apps/plugin-notification";
import { useWorkspaceStore, findWorkspaceName } from "../stores/workspaceStore";
import { useNotifyPrefs } from "../stores/notifyPrefsStore";

/** A Talk approval card waiting on the user reaches them outside the window:
 *  the same native notification path, and the same preference (Settings ›
 *  General › "Notify when a crew needs you"), as a crew's gate
 *  (`crewNotifications.ts`).
 *
 *  Focus policy, as a crew's needs-you ping: it always fires. The app can't
 *  tell a locked screen from someone watching (`document.hasFocus()` stays
 *  true on a locked screen, and the window is neither hidden nor in the
 *  background), so suppressing on focus would miss exactly the case that
 *  costs a stalled turn; a banner while you watch costs nothing.
 *
 *  What it says: the kind of thing waiting and the workspace, never the
 *  command or its arguments (a notification shows on a lock screen, and
 *  can sync to other devices). */

export interface ApprovalNotification {
  title: string;
  body: string;
}

/** What a card is about, as far as a notification may say. */
export interface ApprovalCardKind {
  secret?: boolean;
  kind?: "mcp" | "read" | "write";
}

/** Pure: the notification for an approval card. */
export function decideApprovalNotification(card: ApprovalCardKind, workspaceName: string | null): ApprovalNotification {
  const what = card.secret
    ? "A commit or push is waiting for your approval (possible secret)"
    : card.kind === "mcp"
      ? "An MCP tool call is waiting for your approval"
      : card.kind === "read" || card.kind === "write"
        ? "A file access outside the workspace is waiting for your approval"
        : "A command is waiting for your approval";
  return { title: "Talk needs a decision", body: `${workspaceName ?? "A workspace"} — ${what}` };
}

/** Fire it for a card just raised in `workspaceId`. */
export function notifyApprovalWaiting(workspaceId: string, card: ApprovalCardKind): void {
  if (!useNotifyPrefs.getState().crewNotifications) return;
  const name = findWorkspaceName(useWorkspaceStore.getState().workspacesByProjectId, workspaceId);
  const n = decideApprovalNotification(card, name);
  try {
    sendNotification({ title: n.title, body: n.body });
  } catch {
    // Notification plumbing must never surface as an app error.
  }
}
