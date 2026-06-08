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

const TERMINAL = new Set(["completed", "aborted", "failed"]);

interface RunsState {
  runsByWs: Record<string, Run[]>;
  activeRunIdByWs: Record<string, string | null>;
  detailByRun: Record<string, RunDetail>;
  selectedStageByRun: Record<string, string | null>;

  getRuns: (workspaceId: string) => Run[];
  getActiveRunId: (workspaceId: string) => string | null;
  getDetail: (runId: string) => RunDetail | undefined;
  getSelectedStageId: (runId: string) => string | null;

  loadRuns: (workspaceId: string) => Promise<void>;
  refreshDetail: (runId: string) => Promise<void>;
  begin: (
    workspaceId: string,
    pipelineId: string,
    task: string,
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

  getRuns: (workspaceId) => get().runsByWs[workspaceId] ?? EMPTY_RUNS,
  getActiveRunId: (workspaceId) => get().activeRunIdByWs[workspaceId] ?? null,
  getDetail: (runId) => get().detailByRun[runId],
  getSelectedStageId: (runId) => get().selectedStageByRun[runId] ?? null,

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
    const detail = await ipc.getRun(runId);
    set((s) => ({
      detailByRun: { ...s.detailByRun, [runId]: detail },
      ...(detail.run
        ? {
            runsByWs: {
              ...s.runsByWs,
              [detail.run.workspaceId]: replaceRunInList(
                s.runsByWs[detail.run.workspaceId] ?? EMPTY_RUNS,
                detail.run,
              ),
            },
          }
        : {}),
    }));
  },

  begin: async (workspaceId, pipelineId, task, linkedIssueKey) => {
    const runId = await ipc.createRun(workspaceId, pipelineId, task, undefined, linkedIssueKey);
    await ipc.startRun(runId);
    set((s) => ({ activeRunIdByWs: { ...s.activeRunIdByWs, [workspaceId]: runId } }));
    await get().loadRuns(workspaceId);
    await get().refreshDetail(runId);
  },

  resolve: async (runId, action, feedback, modelOverride) => {
    await ipc.resolveCheckpoint(runId, action, feedback, modelOverride);
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
