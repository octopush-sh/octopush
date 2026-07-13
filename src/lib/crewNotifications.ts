import { listen } from "@tauri-apps/api/event";
import { sendNotification } from "@tauri-apps/plugin-notification";
import { RUN_EVENTS, type Run } from "./ipc";
import { useRunsStore } from "../stores/runsStore";
import { useWorkspaceStore, findWorkspaceName } from "../stores/workspaceStore";
import { useNotifyPrefs } from "../stores/notifyPrefsStore";

/** Crew notifications — the first piece of "crews that work while you don't".
 *
 *  Triggers (each mapped to the orchestrator's REAL signal):
 *  - **Needs you** ← `run://checkpoint` — the one event every decision path
 *    emits (gate, halted stage, loop-at-cap, budget park). A `paused`
 *    stage-update is NOT the signal: gates/halts never emit one, and the
 *    director's own "pause at the next stage" does — the exact false
 *    negative/positive pair the naive design shipped with.
 *  - **Finished** ← a stage-update transitioning an active run to
 *    `completed` (with the cost). `aborted` is the director's own hand.
 *
 *  Focus policy, deliberately asymmetric: a NEEDS-YOU ping always fires —
 *  `document.hasFocus()` stays true on a locked screen, and a silent gate
 *  costs hours (a banner while you're watching costs nothing). A FINISHED
 *  ping is informative, not actionable, so it stays quiet while focused. */

const lastStatus = new Map<string, string>();
/** Checkpoint dedupe — one ping per parked stage, not per re-emit. */
const notifiedStages = new Set<string>();

export interface CrewNotification {
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

function describe(run: Run, workspaceName: string | null): string {
  const where = workspaceName ?? "a workspace";
  return `${where} — ${trim(run.task, 70)}`;
}

/** Pure: the FINISHED decision from a status transition. Exported for tests. */
export function decideCompletionNotification(
  prev: string | undefined,
  run: Run,
  workspaceName: string | null,
): CrewNotification | null {
  if (prev === undefined || prev === run.status) return null;
  const wasActive = prev === "running" || prev === "paused";
  if (!wasActive || run.status !== "completed") return null;
  return {
    title: "Crew finished",
    body: `${describe(run, workspaceName)} · $${run.costUsd.toFixed(2)}`,
  };
}

/** Pure: the NEEDS-YOU decision from a checkpoint event. Exported for tests. */
export function decideCheckpointNotification(
  stageId: string,
  alreadyNotified: ReadonlySet<string>,
  run: Run | undefined,
  workspaceName: string | null,
): CrewNotification | null {
  if (alreadyNotified.has(stageId)) return null;
  if (!run) return null; // row not hydrated yet — better silent than wrong
  return {
    title: "The crew needs you",
    body: describe(run, workspaceName),
  };
}

function fire(n: CrewNotification): void {
  try {
    // Desktop `isPermissionGranted` is hardcoded true (the permission model
    // is mobile); macOS decides at delivery time with its own prompt. Calling
    // directly also means a mid-session revocation isn't masked by a cache.
    sendNotification({ title: n.title, body: n.body });
  } catch {
    // Notification plumbing must never surface as an app error.
  }
}

function wsName(workspaceId: string): string | null {
  return findWorkspaceName(useWorkspaceStore.getState().workspacesByProjectId, workspaceId);
}

function findRun(runId: string): Run | undefined {
  for (const list of Object.values(useRunsStore.getState().runsByWs)) {
    const run = list.find((r) => r.id === runId);
    if (run) return run;
  }
  return undefined;
}

let initialized = false;

/** Wire the listeners once (App calls this on mount; idempotent — the App
 *  effect may re-run, and StrictMode double-fires effects). */
export function initCrewNotifications(): void {
  if (initialized) return;
  initialized = true;

  void listen<{ runId: string; stageId: string }>(RUN_EVENTS.checkpoint, (ev) => {
    if (!useNotifyPrefs.getState().crewNotifications) return;
    const n = decideCheckpointNotification(
      ev.payload.stageId,
      notifiedStages,
      findRun(ev.payload.runId),
      wsName(findRun(ev.payload.runId)?.workspaceId ?? ""),
    );
    notifiedStages.add(ev.payload.stageId);
    if (notifiedStages.size > 500) notifiedStages.clear(); // bounded, session-local
    if (n) fire(n); // ALWAYS — a silent gate costs hours (see focus policy)
  });

  void listen<{ runId: string; run: Run }>(RUN_EVENTS.stageUpdate, (ev) => {
    const run = ev.payload.run;
    const prev = lastStatus.get(run.id);
    lastStatus.set(run.id, run.status);
    if (lastStatus.size > 1000) lastStatus.clear(); // bounded, session-local
    if (!useNotifyPrefs.getState().crewNotifications) return;
    if (document.hasFocus()) return; // finished is informative, not actionable
    const n = decideCompletionNotification(prev, run, wsName(run.workspaceId));
    if (n) fire(n);
  });
}

/** Test hook — reset module state between cases. */
export function __resetCrewNotificationsForTests(): void {
  lastStatus.clear();
  notifiedStages.clear();
  initialized = false;
}
