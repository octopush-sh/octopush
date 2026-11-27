import { create } from "zustand";
import { ipc, type Prerequisite, type PrerequisiteCondition } from "../lib/ipc";
import {
  metReason, notStartedText, prVerdict, runVerdict, stagedText, type PrerequisiteHold, type PrerequisiteVerdict,
} from "../lib/prerequisite";
import type { Workspace } from "../lib/types";
import { pushToast } from "../components/Toasts";
import { useWorkspaceStore } from "./workspaceStore";
import { useRunsStore } from "./runsStore";

// "Starts after" (#960, slice 2). The links live in the backend
// (`workspaces.after_*`); this store mirrors them, checks them on the app's
// 60 s PR poll, and once one is met offers the waiting mission's start once:
// the link is cleared, then the run is staged in the Direct launcher, or
// begun when the link opted in to auto-start.

interface PrerequisitesState {
  /** The link of each waiting mission, by its workspace id. */
  byWs: Record<string, Prerequisite>;
  /** Why a `run_finished` mission keeps waiting although its prerequisite's
   *  run stopped; absent while it is simply waiting. */
  holdByWs: Record<string, PrerequisiteHold>;
  /** Missions whose link is met but whose staging waits for the launcher
   *  slot: the mission whose seed holds it (`null`: a seed any launcher takes). */
  queuedByWs: Record<string, string | null>;
  /** Replace these projects' links with the backend's, then check. */
  load: (projectIds: string[]) => Promise<void>;
  /** Save a link; a refusal is toasted. Resolves to whether it was saved. */
  save: (projectId: string, workspaceId: string, afterWorkspaceId: string,
         condition: PrerequisiteCondition, autoStart: boolean) => Promise<boolean>;
  /** Clear a link; a refusal is toasted. Resolves to whether it was cleared. */
  clear: (workspaceId: string) => Promise<boolean>;
  /** Check every link; start the missions whose prerequisite is met. */
  check: () => Promise<void>;
}

/** Which project each loaded link came from, so `load` replaces only its own. */
const projectOf = new Map<string, string>();
/** Missions whose start was offered: never offered twice. */
const starting = new Set<string>();
/** When each `pr_merged` link last asked GitHub: once per 60 s poll, though
 *  the poll also fires on a workspace switch. */
const prAskedAt = new Map<string, number>();
const PR_ASK_MS = 50_000;
let checking: Promise<void> | null = null;
/** Opens a mission's Direct surface; App sets it. */
let openMission: (workspaceId: string) => void = () => {};

export const setPrerequisiteOpener = (open: (workspaceId: string) => void) => { openMission = open; };

/** Test-only: forget the module state. */
export const __resetPrerequisites = (): void => {
  [projectOf, starting, prAskedAt].forEach((m) => m.clear());
  checking = null;
};

const refusalText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^other: /, "");
const findWorkspace = (id: string): Workspace | undefined =>
  Object.values(useWorkspaceStore.getState().workspacesByProjectId).flat().find((w) => w.id === id);
/** The launcher prefill is one slot: while it holds another mission's
 *  unopened seed, staging this one would replace that seed. Resolves to the
 *  holder (`null` for a seed any launcher takes), or undefined when free. A
 *  seed for a mission that no longer exists is never taken: the slot is free. */
const slotHolder = (workspaceId: string): string | null | undefined => {
  const held = useRunsStore.getState().launcherPrefill;
  if (!held || held.workspaceId === workspaceId) return undefined;
  if (held.workspaceId && !findWorkspace(held.workspaceId)) return undefined;
  return held.workspaceId ?? null;
};

/** The prerequisite's newest run that is more than a draft. */
async function newestRun(workspaceId: string) {
  return (await ipc.listRuns(workspaceId)).find((r) => r.status !== "draft") ?? null;
}

async function verdictFor(link: Prerequisite, after: Workspace): Promise<PrerequisiteVerdict> {
  if (link.afterCondition === "pr_merged") {
    // `find_pr_for_branch` reads the branch checked out at the path: only the
    // prerequisite's own worktree has its branch. Without one, it's unreadable.
    if (!after.worktreePath) throw new Error("The prerequisite has no worktree.");
    return prVerdict(await ipc.findPrForBranch(after.worktreePath));
  }
  const run = await newestRun(after.id);
  const live = run && (run.status === "running" || run.status === "paused");
  return runVerdict(run, live ? (await ipc.getRun(run.id)).stages : []);
}

export const usePrerequisitesStore = create<PrerequisitesState>((set, get) => {
  const forget = (workspaceId: string) => {
    projectOf.delete(workspaceId);
    set((s) => {
      const { [workspaceId]: _link, ...byWs } = s.byWs;
      const { [workspaceId]: _hold, ...holdByWs } = s.holdByWs;
      const { [workspaceId]: _queued, ...queuedByWs } = s.queuedByWs;
      return { byWs, holdByWs, queuedByWs };
    });
  };
  const setQueued = (workspaceId: string, holder: string | null | undefined) =>
    set((s) => {
      const { [workspaceId]: _was, ...rest } = s.queuedByWs;
      return { queuedByWs: holder === undefined ? rest : { ...rest, [workspaceId]: holder } };
    });

  /** The condition holds: clear the link, then stage or begin the run. */
  const offerStart = async (link: Prerequisite, afterName: string) => {
    const ws = findWorkspace(link.workspaceId);
    if (!ws || starting.has(ws.id)) return;
    // The suggested crew: the one the prerequisite's newest run used.
    const crew = (await newestRun(link.afterWorkspaceId).catch(() => null))?.pipelineId ?? "";
    const task = ws.task.trim() ? ws.task : "";
    const canBegin = link.autoStart && !!crew && !!task;
    // Staging a seed needs the prefill slot; while another mission's seed
    // holds it, keep the link, say what it waits for, and stage it on a later
    // check once that seed was taken.
    const holder = slotHolder(ws.id);
    if (!canBegin && (task || crew) && holder !== undefined) {
      setQueued(ws.id, holder);
      return;
    }
    starting.add(ws.id);
    try {
      await ipc.clearWorkspacePrerequisite(ws.id);
    } catch {
      return; // Still marked: the next check doesn't offer it again.
    }
    forget(ws.id);
    const reason = metReason(link.afterCondition, afterName);
    const open = { label: "Open it", onClick: () => openMission(ws.id) };
    const runs = useRunsStore.getState();
    if (canBegin) {
      const before = runs.activeRunIdByWs[ws.id] ?? null;
      await runs.begin(ws.id, crew, task, [], ws.linkedIssueKey ?? undefined).catch(() => {});
      // `begin` also returns when the upgrade sheet refused the start.
      const now = useRunsStore.getState().activeRunIdByWs[ws.id] ?? null;
      if (now && now !== before) {
        pushToast({ level: "success", title: `${ws.name} started`, body: `${reason} Its crew is at work.`, action: open });
        return;
      }
    }
    const notStarted = link.autoStart ? `${notStartedText(!!task, !!crew)} ` : "";
    const ready = (body: string) =>
      pushToast({ level: "info", title: `${ws.name} is ready to start`, body: `${reason} ${notStarted}${body}`, timeout: 15_000, action: open });
    if ((task || crew) && slotHolder(ws.id) !== undefined) {
      // A refused auto-start while another mission's seed holds the slot:
      // nothing is seeded, so the toast doesn't say it is.
      ready("Open it in Direct to begin the run.");
      return;
    }
    if (task || crew) runs.setLauncherPrefill({ task, pipelineId: crew, overrides: [], workspaceId: ws.id });
    runs.selectRun(ws.id, null);
    ready(stagedText(!!task, !!crew));
  };

  const runCheck = async () => {
    for (const link of Object.values(get().byWs)) {
      const after = findWorkspace(link.afterWorkspaceId);
      if (starting.has(link.workspaceId) || !after || !findWorkspace(link.workspaceId)) continue;
      if (link.afterCondition === "pr_merged") {
        if (Date.now() - (prAskedAt.get(link.workspaceId) ?? -Infinity) < PR_ASK_MS) continue;
        prAskedAt.set(link.workspaceId, Date.now());
      }
      let verdict: PrerequisiteVerdict;
      try {
        verdict = await verdictFor(link, after);
      } catch {
        continue; // Unreadable now (offline, gh signed out): the next poll asks again.
      }
      if (!get().byWs[link.workspaceId]) continue; // Cleared meanwhile.
      if (verdict.met) {
        await offerStart(link, after.name);
        continue;
      }
      const { [link.workspaceId]: _was, ...rest } = get().holdByWs;
      set({ holdByWs: verdict.hold ? { ...rest, [link.workspaceId]: verdict.hold } : rest });
      setQueued(link.workspaceId, undefined);
    }
  };

  return {
    byWs: {},
    holdByWs: {},
    queuedByWs: {},

    load: async (projectIds) => {
      const read = (id: string) =>
        Promise.resolve().then(() => ipc.listWorkspacePrerequisites(id)).then((links) => ({ id, links: links ?? [] }), () => null);
      const fetched = await Promise.all(projectIds.map(read));
      const byWs = { ...get().byWs };
      for (const r of fetched) {
        if (!r) continue;
        for (const [ws, pid] of projectOf) {
          if (pid === r.id) { projectOf.delete(ws); delete byWs[ws]; }
        }
        for (const link of r.links) {
          projectOf.set(link.workspaceId, r.id);
          byWs[link.workspaceId] = link;
        }
      }
      set({ byWs });
      await get().check();
    },

    save: async (projectId, workspaceId, afterWorkspaceId, condition, autoStart) => {
      try {
        const link = await ipc.setWorkspacePrerequisite(workspaceId, afterWorkspaceId, condition, autoStart);
        forget(workspaceId);
        projectOf.set(workspaceId, projectId);
        starting.delete(workspaceId);
        prAskedAt.delete(workspaceId);
        set((s) => ({ byWs: { ...s.byWs, [workspaceId]: link } }));
        void get().check();
        return true;
      } catch (e) {
        pushToast({ level: "error", title: "Couldn't set Starts after", body: refusalText(e) });
        return false;
      }
    },

    clear: async (workspaceId) => {
      try {
        await ipc.clearWorkspacePrerequisite(workspaceId);
        forget(workspaceId);
        return true;
      } catch (e) {
        pushToast({ level: "error", title: "Couldn't stop the wait", body: refusalText(e) });
        return false;
      }
    },

    check: () => {
      // One check at a time; a call meanwhile waits for that one.
      checking ??= runCheck()
        .catch((e) => console.error("Starts after check failed:", e))
        .finally(() => {
          checking = null;
        });
      return checking;
    },
  };
});
