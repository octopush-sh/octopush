import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import {
  ipc,
  RUN_EVENTS,
  type Run,
  type RunDetail,
  type CheckpointActionName,
} from "../lib/ipc";

export const EMPTY_RUNS: Run[] = [];
const EMPTY_LOG: string[] = [];
const MAX_LOG_LINES = 200;

const TERMINAL = new Set(["completed", "aborted", "failed"]);

const inflightDetail = new Set<string>();
const dirtyDetail = new Set<string>();

interface RunsState {
  runsByWs: Record<string, Run[]>;
  activeRunIdByWs: Record<string, string | null>;
  detailByRun: Record<string, RunDetail>;
  selectedStageByRun: Record<string, string | null>;
  /** Live progress lines per stage id, streamed from the CLI substrate. */
  liveLogByStage: Record<string, string[]>;

  getRuns: (workspaceId: string) => Run[];
  getActiveRunId: (workspaceId: string) => string | null;
  getDetail: (runId: string) => RunDetail | undefined;
  getSelectedStageId: (runId: string) => string | null;
  getLiveLog: (stageId: string) => string;
  appendLog: (stageId: string, line: string) => void;
  clearLog: (stageId: string) => void;

  loadRuns: (workspaceId: string) => Promise<void>;
  refreshDetail: (runId: string) => Promise<void>;
  begin: (
    workspaceId: string,
    pipelineId: string,
    task: string,
    stageOverrides: [number, string][],
    linkedIssueKey?: string,
  ) => Promise<void>;
  resolve: (
    runId: string,
    action: CheckpointActionName,
    feedback?: string,
    modelOverride?: string,
  ) => Promise<void>;
  abort: (runId: string) => Promise<void>;
  selectStage: (runId: string, stageId: string) => void;

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

export const useRunsStore = create<RunsState>((set, get) => ({
  runsByWs: {},
  activeRunIdByWs: {},
  detailByRun: {},
  selectedStageByRun: {},
  liveLogByStage: {},

  getRuns: (workspaceId) => get().runsByWs[workspaceId] ?? EMPTY_RUNS,
  getActiveRunId: (workspaceId) => get().activeRunIdByWs[workspaceId] ?? null,
  getDetail: (runId) => get().detailByRun[runId],
  getSelectedStageId: (runId) => get().selectedStageByRun[runId] ?? null,
  getLiveLog: (stageId) => (get().liveLogByStage[stageId] ?? EMPTY_LOG).join("\n"),

  appendLog: (stageId, line) =>
    set((s) => {
      const prev = s.liveLogByStage[stageId] ?? EMPTY_LOG;
      // O(1) append; bound to the most recent lines without re-splitting.
      const next =
        prev.length >= MAX_LOG_LINES
          ? [...prev.slice(prev.length - MAX_LOG_LINES + 1), line]
          : [...prev, line];
      return { liveLogByStage: { ...s.liveLogByStage, [stageId]: next } };
    }),

  clearLog: (stageId) =>
    set((s) => {
      if (!s.liveLogByStage[stageId]) return {};
      const next = { ...s.liveLogByStage };
      delete next[stageId];
      return { liveLogByStage: next };
    }),

  loadRuns: async (workspaceId) => {
    const runs = await ipc.listRuns(workspaceId);
    const active = runs.find((r) => !TERMINAL.has(r.status)) ?? null;
    set((s) => ({
      runsByWs: { ...s.runsByWs, [workspaceId]: runs },
      activeRunIdByWs: { ...s.activeRunIdByWs, [workspaceId]: active?.id ?? null },
    }));
    if (active) await get().refreshDetail(active.id);
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

  begin: async (workspaceId, pipelineId, task, stageOverrides, linkedIssueKey) => {
    const runId = await ipc.createRun(workspaceId, pipelineId, task, undefined, linkedIssueKey, stageOverrides);
    await ipc.startRun(runId);
    set((s) => ({ activeRunIdByWs: { ...s.activeRunIdByWs, [workspaceId]: runId } }));
    await get().loadRuns(workspaceId);
  },

  resolve: async (runId, action, feedback, modelOverride) => {
    await ipc.resolveCheckpoint(runId, action, feedback, modelOverride);
    await get().refreshDetail(runId);
  },

  abort: async (runId) => {
    await ipc.abortRun(runId);
    await get().refreshDetail(runId);
  },

  selectStage: (runId, stageId) =>
    set((s) => ({ selectedStageByRun: { ...s.selectedStageByRun, [runId]: stageId } })),

  applyStageUpdate: (runId, run) => {
    set((s) => {
      const prevDetail = s.detailByRun[runId];
      const detail: RunDetail = prevDetail
        ? { ...prevDetail, run }
        : { run, stages: [] };
      const wsList = s.runsByWs[run.workspaceId] ?? EMPTY_RUNS;
      return {
        detailByRun: { ...s.detailByRun, [runId]: detail },
        runsByWs: { ...s.runsByWs, [run.workspaceId]: replaceRunInList(wsList, run) },
      };
    });
    void get().refreshDetail(runId);
  },

  applyCost: (runId, costUsd, baselineUsd) => {
    set((s) => {
      const prev = s.detailByRun[runId];
      if (!prev?.run) return {};
      const run = { ...prev.run, costUsd, baselineUsd };
      const wsList = s.runsByWs[run.workspaceId] ?? EMPTY_RUNS;
      return {
        detailByRun: { ...s.detailByRun, [runId]: { ...prev, run } },
        runsByWs: { ...s.runsByWs, [run.workspaceId]: replaceRunInList(wsList, run) },
      };
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
void listen<{ runId: string; stageId: string; line?: string; reset?: boolean }>(
  RUN_EVENTS.log,
  (ev) => {
    const store = useRunsStore.getState();
    if (ev.payload.reset) store.clearLog(ev.payload.stageId);
    else if (ev.payload.line != null) store.appendLog(ev.payload.stageId, ev.payload.line);
  },
);
