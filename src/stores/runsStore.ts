import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import {
  ipc,
  RUN_EVENTS,
  type LiveEntry,
  type Run,
  type RunDetail,
  type CheckpointActionName,
  type RunStagePatch,
} from "../lib/ipc";
import { useUpgradeStore } from "./upgradeStore";
import { isUpgradeRequired } from "../lib/upgradeError";
import { pushToast } from "../components/Toasts";

export const EMPTY_RUNS: Run[] = [];
const EMPTY_ENTRIES: LiveEntry[] = [];
const beginningWs = new Set<string>();
const startingRuns = new Set<string>();
const MAX_LOG_LINES = 200;

const TERMINAL = new Set(["completed", "aborted", "failed"]);

/** Seed for the launcher when re-running a finished pipeline (R3). */
export interface LauncherPrefill {
  task: string;
  pipelineId: string;
  /** [stage position, agent model] for every stage of the source run. */
  overrides: [number, string][];
}

const inflightDetail = new Set<string>();
const dirtyDetail = new Set<string>();

interface RunsState {
  runsByWs: Record<string, Run[]>;
  /** True once loadRuns has resolved for a workspace at least once this
   *  session — lets panels distinguish "still loading" from "truly empty". */
  loadedByWs: Record<string, boolean>;
  activeRunIdByWs: Record<string, string | null>;
  detailByRun: Record<string, RunDetail>;
  selectedStageByRun: Record<string, string | null>;
  /** The run the canvas is VIEWING per workspace. Absent = default (active run);
   *  null = the launcher (explicit "new run"); a runId = view that run. */
  selectedRunIdByWs: Record<string, string | null>;
  /** Structured live activity entries per stage id, streamed from both substrates. */
  liveByStage: Record<string, LiveEntry[]>;
  /** One-shot launcher seed set by "Run it again"; consumed (and cleared) by
   *  PipelineSetup on its next mount. */
  launcherPrefill: LauncherPrefill | null;
  /** Runs observed reaching a terminal state THIS SESSION (runId → epoch ms).
   *  They linger on Mission Control's "Settled" band until dismissed — nothing
   *  that finishes while you're away silently vanishes. Session-local. */
  settledAt: Record<string, number>;
  /** When each run's status last changed, as observed by this session (runId →
   *  epoch ms). Drives Mission Control's time-in-state timer; best-effort — a
   *  run hydrated at launch has no entry and falls back to createdAt. */
  statusSince: Record<string, number>;

  getRuns: (workspaceId: string) => Run[];
  getActiveRunId: (workspaceId: string) => string | null;
  getDetail: (runId: string) => RunDetail | undefined;
  getSelectedStageId: (runId: string) => string | null;
  getViewedRunId: (workspaceId: string) => string | null;
  hasExecutingRun: (workspaceId: string) => boolean;
  selectRun: (workspaceId: string, runId: string | null) => void;
  getLiveEntries: (stageId: string) => LiveEntry[];
  appendEntry: (stageId: string, entry: LiveEntry) => void;
  clearLog: (stageId: string) => void;
  /** Restore a terminal stage's journal from the persisted log (D1). Only
   *  fills an EMPTY buffer — a live stream is never clobbered. */
  hydrateLog: (stageId: string, entries: LiveEntry[]) => void;

  /** `background: true` = a passive refetch (e.g. window focus): the runs
   *  list refreshes, but the workspace's ACTIVE run — and therefore the
   *  default-viewed canvas — is never reassigned under the user. A newly
   *  staged draft surfaces in the RUNS list; it never steals the view. */
  loadRuns: (workspaceId: string, opts?: { background?: boolean }) => Promise<void>;
  /** Hydrate the `running`/`paused` runs across ALL workspaces (incl. ones not
   *  opened this session) — drives the global "Runs in progress" tray. */
  loadActiveRuns: () => Promise<void>;
  refreshDetail: (runId: string) => Promise<void>;
  begin: (
    workspaceId: string,
    pipelineId: string,
    task: string,
    stageOverrides: [number, string][],
    linkedIssueKey?: string,
    budgetUsd?: number | null,
  ) => Promise<void>;
  /** Start a STAGED (draft) run — e.g. one authored by octopush-mcp for the
   *  user to launch from DIRECT. Unlike `begin`, there is nothing to create,
   *  and the draft is prior user data: a refused start (over quota / the
   *  concurrency gate) shows the upgrade sheet and LEAVES the draft intact. */
  start: (runId: string) => Promise<void>;
  resolve: (
    runId: string,
    action: CheckpointActionName,
    feedback?: string,
    modelOverride?: string,
    maxTurnsOverride?: number,
  ) => Promise<void>;
  abort: (runId: string) => Promise<void>;
  /** Stop the in-flight stage (fire-and-forget — run:// events carry the fallout). */
  stopStage: (runId: string) => Promise<void>;
  /** Ask the run to pause at its next stage boundary (parks the next stage). */
  pauseRun: (runId: string) => Promise<void>;
  /** Hot-edit a pending, not-yet-started stage. Applies `patch` optimistically
   *  for instant gate/model feedback, then the validated IPC write, then
   *  `refreshDetail` reconciles — or reverts, if the backend rejected it. */
  updateStage: (runId: string, stageId: string, patch: RunStagePatch) => Promise<void>;
  /** Re-run a finished (done/failed) stage and everything downstream of it,
   *  in place — no restart, no reload. */
  rerunFromStage: (runId: string, stageId: string) => Promise<void>;
  /** null clears a manual pin — the canvas falls back to the active stage. */
  selectStage: (runId: string, stageId: string | null) => void;
  setLauncherPrefill: (prefill: LauncherPrefill | null) => void;
  /** Returns the pending prefill and clears it — consumed exactly once. */
  consumeLauncherPrefill: () => LauncherPrefill | null;
  /** Drop one settled run from the Mission Control board (session-local). */
  dismissSettled: (runId: string) => void;
  /** Clear the whole settled band. */
  clearSettled: () => void;

  applyStageUpdate: (runId: string, run: Run) => void;
  applyCost: (runId: string, costUsd: number, baselineUsd: number) => void;
}

function replaceRunInList(list: Run[], run: Run): Run[] {
  const idx = list.findIndex((r) => r.id === run.id);
  if (idx === -1) return [run, ...list];
  const next = list.slice();
  next[idx] = run;
  return next;
}

/** Mission Control board tracking, applied by EVERY path that writes a run row
 *  into `runsByWs` (stage events, refreshDetail, loadRuns) — a terminal status
 *  can arrive through any of them first, and a transition observed by one must
 *  not be invisible to the others. Returns the `statusSince`/`settledAt` deltas
 *  for an observed status change: stamps time-in-state, and parks an
 *  active→terminal run on the Settled band. First sight of a row (no previous
 *  status) stamps nothing — time-in-state falls back to `createdAt`, and a run
 *  never seen active doesn't belong on the board. */
function trackTransition(
  s: Pick<RunsState, "runsByWs" | "statusSince" | "settledAt">,
  acc: { statusSince?: Record<string, number>; settledAt?: Record<string, number> },
  run: Run,
): void {
  const prev = (s.runsByWs[run.workspaceId] ?? EMPTY_RUNS).find((r) => r.id === run.id)?.status;
  if (prev === undefined || prev === run.status) return;
  acc.statusSince = { ...(acc.statusSince ?? s.statusSince), [run.id]: Date.now() };
  const wasActive = prev === "running" || prev === "paused";
  if (wasActive && TERMINAL.has(run.status)) {
    acc.settledAt = { ...(acc.settledAt ?? s.settledAt), [run.id]: Date.now() };
  }
}

export const useRunsStore = create<RunsState>((set, get) => ({
  runsByWs: {},
  loadedByWs: {},
  activeRunIdByWs: {},
  detailByRun: {},
  selectedStageByRun: {},
  selectedRunIdByWs: {},
  liveByStage: {},
  launcherPrefill: null,
  settledAt: {},
  statusSince: {},

  getRuns: (workspaceId) => get().runsByWs[workspaceId] ?? EMPTY_RUNS,
  getActiveRunId: (workspaceId) => get().activeRunIdByWs[workspaceId] ?? null,
  getDetail: (runId) => get().detailByRun[runId],
  getSelectedStageId: (runId) => get().selectedStageByRun[runId] ?? null,
  getViewedRunId: (workspaceId) => {
    const sel = get().selectedRunIdByWs;
    return workspaceId in sel ? sel[workspaceId] : get().getActiveRunId(workspaceId);
  },
  hasExecutingRun: (workspaceId) =>
    get().getRuns(workspaceId).some((r) => r.status === "running" || r.status === "paused"),
  selectRun: (workspaceId, runId) =>
    set((s) => ({ selectedRunIdByWs: { ...s.selectedRunIdByWs, [workspaceId]: runId } })),
  getLiveEntries: (stageId) => get().liveByStage[stageId] ?? EMPTY_ENTRIES,

  appendEntry: (stageId, entry) =>
    set((s) => {
      const prev = s.liveByStage[stageId] ?? EMPTY_ENTRIES;
      const next =
        prev.length >= MAX_LOG_LINES
          ? [...prev.slice(prev.length - MAX_LOG_LINES + 1), entry]
          : [...prev, entry];
      return { liveByStage: { ...s.liveByStage, [stageId]: next } };
    }),

  hydrateLog: (stageId, entries) =>
    set((s) => {
      if ((s.liveByStage[stageId] ?? EMPTY_ENTRIES).length > 0) return {};
      return {
        liveByStage: {
          ...s.liveByStage,
          [stageId]: entries.slice(Math.max(0, entries.length - MAX_LOG_LINES)),
        },
      };
    }),

  clearLog: (stageId) =>
    set((s) => {
      if (!s.liveByStage[stageId]) return {};
      const next = { ...s.liveByStage };
      delete next[stageId];
      return { liveByStage: next };
    }),

  loadRuns: async (workspaceId, opts) => {
    const runs = await ipc.listRuns(workspaceId);
    let nextActive: string | null = null;
    set((s) => {
      const acc: { statusSince?: Record<string, number>; settledAt?: Record<string, number> } = {};
      for (const run of runs) trackTransition(s, acc, run);
      if (opts?.background) {
        // Sticky active: keep the user's canvas exactly where it is. Only
        // recompute when the current active run vanished or turned terminal —
        // and even then adopt only an EXECUTING run (an externally staged
        // draft must not clobber the launcher, incl. a half-typed brief).
        const cur = s.activeRunIdByWs[workspaceId] ?? null;
        const curValid = cur !== null && runs.some((r) => r.id === cur && !TERMINAL.has(r.status));
        nextActive = curValid
          ? cur
          : runs.find((r) => r.status === "running" || r.status === "paused")?.id ?? null;
      } else {
        // First load / workspace switch: present the freshest non-terminal
        // run (incl. a staged draft — the DraftBar makes it launchable).
        nextActive = runs.find((r) => !TERMINAL.has(r.status))?.id ?? null;
      }
      return {
        runsByWs: { ...s.runsByWs, [workspaceId]: runs },
        loadedByWs: { ...s.loadedByWs, [workspaceId]: true },
        activeRunIdByWs: { ...s.activeRunIdByWs, [workspaceId]: nextActive },
        ...acc,
      };
    });
    if (nextActive) await get().refreshDetail(nextActive);
  },

  loadActiveRuns: async () => {
    let active: Run[];
    try {
      active = await ipc.listActiveRuns();
    } catch (e) {
      console.error("Failed to load active runs:", e);
      return;
    }
    set((s) => {
      const runsByWs = { ...s.runsByWs };
      const activeRunIdByWs = { ...s.activeRunIdByWs };
      const acc: { statusSince?: Record<string, number>; settledAt?: Record<string, number> } = {};
      for (const run of active) {
        trackTransition(s, acc, run);
        runsByWs[run.workspaceId] = replaceRunInList(runsByWs[run.workspaceId] ?? [], run);
        activeRunIdByWs[run.workspaceId] = run.id;
      }
      return { runsByWs, activeRunIdByWs, ...acc };
    });
  },

  refreshDetail: async (runId) => {
    if (inflightDetail.has(runId)) {
      dirtyDetail.add(runId);
      return;
    }
    inflightDetail.add(runId);
    try {
      const detail = await ipc.getRun(runId);
      set((s) => {
        const next: any = { detailByRun: { ...s.detailByRun, [runId]: detail } };
        if (detail.run) {
          const acc: { statusSince?: Record<string, number>; settledAt?: Record<string, number> } = {};
          trackTransition(s, acc, detail.run);
          Object.assign(next, acc);
          const wsId = detail.run.workspaceId;
          const wsList = s.runsByWs[wsId] ?? EMPTY_RUNS;
          next.runsByWs = { ...s.runsByWs, [wsId]: replaceRunInList(wsList, detail.run) };
        }
        return next;
      });
    } finally {
      inflightDetail.delete(runId);
      if (dirtyDetail.has(runId)) {
        dirtyDetail.delete(runId);
        void get().refreshDetail(runId);
      }
    }
  },

  begin: async (workspaceId, pipelineId, task, stageOverrides, linkedIssueKey, budgetUsd) => {
    if (beginningWs.has(workspaceId)) return; // guard against double-click double-start
    beginningWs.add(workspaceId);
    try {
      const runId = await ipc.createRun(workspaceId, pipelineId, task, undefined, linkedIssueKey, stageOverrides);
      try {
        await ipc.startRun(runId, budgetUsd ?? null);
      } catch (e) {
        // start was refused — drop the orphaned draft.
        await ipc.abortRun(runId).catch(() => {});
        // Over the Free monthly Direct-run cap → show the upgrade sheet, not an error.
        const upgrade = isUpgradeRequired(e);
        if (upgrade) {
          useUpgradeStore.getState().show(upgrade);
          return;
        }
        throw e;
      }
      set((s) => ({ activeRunIdByWs: { ...s.activeRunIdByWs, [workspaceId]: runId } }));
      await get().loadRuns(workspaceId);
      get().selectRun(workspaceId, runId);
    } finally {
      beginningWs.delete(workspaceId);
    }
  },

  start: async (runId) => {
    if (startingRuns.has(runId)) return; // guard against double-click double-start
    startingRuns.add(runId);
    try {
      try {
        await ipc.startRun(runId, null);
      } catch (e) {
        // Over the Free cap / concurrency gate → upgrade sheet; the draft
        // survives (it's staged user data, not our own orphaned scaffolding).
        const upgrade = isUpgradeRequired(e);
        if (upgrade) {
          useUpgradeStore.getState().show(upgrade);
          return;
        }
        // Any other refusal must be VISIBLE — the caller fire-and-forgets, and
        // a silently dead "Begin this run" button is indistinguishable from a bug.
        pushToast({
          level: "error",
          title: "Couldn't start the run",
          body: String(e).split("\n")[0],
        });
        return;
      }
      // Refresh INSIDE the guard: releasing early lets a fast second click
      // re-enter while the just-started run still reads as draft (at the Free
      // cap that second attempt pops a spurious upgrade sheet).
      await get().refreshDetail(runId).catch(() => {});
    } finally {
      startingRuns.delete(runId);
    }
  },

  resolve: async (runId, action, feedback, modelOverride, maxTurnsOverride) => {
    await ipc.resolveCheckpoint(runId, action, feedback, modelOverride, maxTurnsOverride);
    await get().refreshDetail(runId);
  },

  abort: async (runId) => {
    await ipc.abortRun(runId);
    await get().refreshDetail(runId);
  },

  stopStage: async (runId) => {
    await ipc.stopStage(runId);
  },

  pauseRun: async (runId) => {
    await ipc.requestRunPause(runId);
  },

  updateStage: async (runId, stageId, patch) => {
    set((s) => {
      const detail = s.detailByRun[runId];
      if (!detail) return {};
      const stages = detail.stages.map((st) => {
        if (st.id !== stageId) return st;
        return {
          ...st,
          ...(patch.checkpoint !== undefined ? { checkpoint: patch.checkpoint } : {}),
          ...(patch.instructions !== undefined ? { instructions: patch.instructions } : {}),
          ...(patch.agentModel !== undefined ? { agentModel: patch.agentModel } : {}),
          ...(patch.maxIterations !== undefined ? { maxIterations: patch.maxIterations } : {}),
          ...(patch.loopMode !== undefined ? { loopMode: patch.loopMode } : {}),
        };
      });
      return { detailByRun: { ...s.detailByRun, [runId]: { ...detail, stages } } };
    });
    try {
      await ipc.updateRunStage(runId, stageId, patch);
    } finally {
      // Reconciles the optimistic patch with truth — and snaps it back if the
      // backend rejected the edit (e.g. the stage started in the meantime).
      await get().refreshDetail(runId);
    }
  },

  rerunFromStage: async (runId, stageId) => {
    try {
      await ipc.rerunFromStage(runId, stageId);
    } finally {
      // Re-syncs with backend truth whether the call succeeded or was
      // rejected by a guard (e.g. a race with a concurrent resolve/rerun) —
      // same reconciliation shape as updateStage.
      await get().refreshDetail(runId);
    }
  },

  selectStage: (runId, stageId) =>
    set((s) => ({ selectedStageByRun: { ...s.selectedStageByRun, [runId]: stageId } })),

  setLauncherPrefill: (prefill) => set({ launcherPrefill: prefill }),

  consumeLauncherPrefill: () => {
    const prefill = get().launcherPrefill;
    if (prefill) set({ launcherPrefill: null });
    return prefill;
  },

  dismissSettled: (runId) =>
    set((s) => {
      if (!(runId in s.settledAt)) return {};
      const next = { ...s.settledAt };
      delete next[runId];
      return { settledAt: next };
    }),

  clearSettled: () => set({ settledAt: {} }),

  applyStageUpdate: (runId, run) => {
    set((s) => {
      const prevDetail = s.detailByRun[runId];
      const detail: RunDetail = prevDetail
        ? { ...prevDetail, run }
        : { run, stages: [] };
      const wsList = s.runsByWs[run.workspaceId] ?? EMPTY_RUNS;
      const next: Partial<RunsState> = {
        detailByRun: { ...s.detailByRun, [runId]: detail },
        runsByWs: { ...s.runsByWs, [run.workspaceId]: replaceRunInList(wsList, run) },
      };
      const acc: { statusSince?: Record<string, number>; settledAt?: Record<string, number> } = {};
      trackTransition(s, acc, run);
      Object.assign(next, acc);
      return next;
    });
    void get().refreshDetail(runId);
  },

  applyCost: (runId, costUsd, baselineUsd) => {
    set((s) => {
      const prev = s.detailByRun[runId];
      if (prev?.run) {
        const run = { ...prev.run, costUsd, baselineUsd };
        const wsList = s.runsByWs[run.workspaceId] ?? EMPTY_RUNS;
        return {
          detailByRun: { ...s.detailByRun, [runId]: { ...prev, run } },
          runsByWs: { ...s.runsByWs, [run.workspaceId]: replaceRunInList(wsList, run) },
        };
      }
      // No detail loaded for this run (e.g. the panel listed runs but never
      // opened it) — still apply the cost event to the run row itself so the
      // ledger and row costs don't silently drop events. The payload carries
      // no workspaceId, so find the row in whichever list holds it.
      for (const [wsId, list] of Object.entries(s.runsByWs)) {
        const idx = list.findIndex((r) => r.id === runId);
        if (idx === -1) continue;
        const next = list.slice();
        next[idx] = { ...next[idx], costUsd, baselineUsd };
        return { runsByWs: { ...s.runsByWs, [wsId]: next } };
      }
      return {};
    });
  },
}));

void listen<{ runId: string; run: Run }>(RUN_EVENTS.stageUpdate, (ev) => {
  useRunsStore.getState().applyStageUpdate(ev.payload.runId, ev.payload.run);
});
void listen<{ runId: string; costUsd: number; baselineUsd: number }>(
  RUN_EVENTS.cost,
  (ev) =>
    useRunsStore
      .getState()
      .applyCost(ev.payload.runId, ev.payload.costUsd, ev.payload.baselineUsd),
);
void listen<{ runId: string }>(RUN_EVENTS.checkpoint, (ev) => {
  void useRunsStore.getState().refreshDetail(ev.payload.runId);
});
void listen<{ runId: string; error: string }>(RUN_EVENTS.error, (ev) => {
  void useRunsStore.getState().refreshDetail(ev.payload.runId);
});
void listen<{ runId: string; stageId: string; entry?: LiveEntry; reset?: boolean }>(
  RUN_EVENTS.log,
  (ev) => {
    const store = useRunsStore.getState();
    if (ev.payload.reset) store.clearLog(ev.payload.stageId);
    else if (ev.payload.entry) store.appendEntry(ev.payload.stageId, ev.payload.entry);
  },
);
