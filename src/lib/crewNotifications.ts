import { listen } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { RUN_EVENTS, type Run } from "./ipc";
import { useWorkspaceStore } from "../stores/workspaceStore";
import { useNotifyPrefs } from "../stores/notifyPrefsStore";

/** Crew notifications — the first piece of "crews that work while you don't":
 *  a native notification when a crew NEEDS the director (gate/halt) or
 *  finishes, so a fleet can run unattended with confidence. Anti-noise rules:
 *  only on a genuine status TRANSITION (first sight records, never notifies),
 *  only while the window is unfocused (you're already watching otherwise),
 *  and never for `aborted` (the director did that themselves). */

/** Last-known status per run, session-local. Mirrors the store's
 *  transition-tracking semantics: notify on change, not on sight. */
const lastStatus = new Map<string, string>();

export interface CrewNotification {
  title: string;
  body: string;
}

/** The pure decision: given the previously observed status and the updated
 *  run, what (if anything) should we say? Exported for tests. */
export function decideNotification(
  prev: string | undefined,
  run: Run,
  workspaceName: string | null,
): CrewNotification | null {
  if (prev === undefined || prev === run.status) return null;
  const wasActive = prev === "running" || prev === "paused";
  if (!wasActive) return null; // drafts becoming active etc. — not news
  const where = workspaceName ?? "a workspace";
  const brief = run.task.length > 70 ? `${run.task.slice(0, 70)}…` : run.task;
  if (run.status === "paused") {
    return {
      title: "The crew needs you",
      body: `${where} — ${brief}`,
    };
  }
  if (run.status === "completed") {
    return {
      title: "Crew finished",
      body: `${where} — ${brief} · $${run.costUsd.toFixed(2)}`,
    };
  }
  return null; // aborted = the director's own hand; anything else = not news
}

function workspaceName(workspaceId: string): string | null {
  for (const list of Object.values(useWorkspaceStore.getState().workspacesByProjectId)) {
    const ws = list.find((w) => w.id === workspaceId);
    if (ws) return ws.name;
  }
  return null;
}

let permissionKnownGranted = false;

async function fire(n: CrewNotification): Promise<void> {
  try {
    if (!permissionKnownGranted) {
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === "granted";
      if (!granted) return; // the OS said no — stay quiet, never nag
      permissionKnownGranted = true;
    }
    sendNotification({ title: n.title, body: n.body });
  } catch {
    // Notification plumbing must never surface as an app error.
  }
}

let initialized = false;

/** Wire the listener once (App calls this on mount). */
export function initCrewNotifications(): void {
  if (initialized) return;
  initialized = true;
  void listen<{ runId: string; run: Run }>(RUN_EVENTS.stageUpdate, (ev) => {
    const run = ev.payload.run;
    const prev = lastStatus.get(run.id);
    lastStatus.set(run.id, run.status);
    if (!useNotifyPrefs.getState().crewNotifications) return;
    if (document.hasFocus()) return; // you're watching — the UI is the signal
    const n = decideNotification(prev, run, workspaceName(run.workspaceId));
    if (n) void fire(n);
  });
}

/** Test hook — reset module state between cases. */
export function __resetCrewNotificationsForTests(): void {
  lastStatus.clear();
  initialized = false;
  permissionKnownGranted = false;
}
