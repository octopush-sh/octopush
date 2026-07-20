import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { Mission } from "../lib/types";

/**
 * Missions store. Missions are the first-level unit of intent; a code mission
 * (build/fix) owns exactly one workspace. This store mirrors `workspaceStore`'s
 * shape but is NOT a second selection store — the active selection still lives
 * in `workspaceStore.activeId`; the "active mission" is derived from it via
 * `missionByWorkspaceId`.
 */
interface MissionsState {
  missionsByProjectId: Record<string, Mission[]>;
  /** Flattened index of the active mission per workspace (code missions are 1:1). */
  missionByWorkspaceId: Record<string, Mission>;

  load: (projectId: string) => Promise<void>;
  loadAll: (projectIds: string[]) => Promise<void>;
  create: (
    projectId: string,
    intent: string,
    title: string,
    gitIsolation: string,
    execIsolation: string,
    workspaceId: string | null,
    linkedIssueKey: string | null,
  ) => Promise<Mission>;
  update: (
    missionId: string,
    title: string | null,
    status: string | null,
    linkedIssueKey: string | null,
  ) => Promise<Mission>;
  /** Set a mission's execution isolation in place (e.g. the launcher's
   *  one-click "enable sandbox" for an unattended run). */
  setExecIsolation: (missionId: string, execIsolation: string) => Promise<Mission>;
  archive: (missionId: string) => Promise<void>;
}

function reindexByWorkspace(byProject: Record<string, Mission[]>): Record<string, Mission> {
  const byWs: Record<string, Mission> = {};
  for (const missions of Object.values(byProject)) {
    for (const m of missions) {
      if (m.workspaceId) byWs[m.workspaceId] = m;
    }
  }
  return byWs;
}

// Concurrent `load`/`loadAll` calls for the same project can resolve out of
// order (e.g. a focus-triggered `loadAll` issued before a mission's DB commit
// resolving after a fresher `load` issued right after that commit). Track the
// most-recently-*issued* request per project so a late-resolving older fetch
// can't clobber a newer one's result.
let missionsRequestSeq = 0;
const latestRequestSeqByProject: Record<string, number> = {};

export const useMissionsStore = create<MissionsState>((set, get) => ({
  missionsByProjectId: {},
  missionByWorkspaceId: {},

  async load(projectId) {
    const requestId = ++missionsRequestSeq;
    latestRequestSeqByProject[projectId] = requestId;
    const missions = await ipc.listMissions(projectId);
    if (latestRequestSeqByProject[projectId] !== requestId) return; // superseded by a newer load
    set((state) => {
      const byProject = { ...state.missionsByProjectId, [projectId]: missions };
      return {
        missionsByProjectId: byProject,
        missionByWorkspaceId: reindexByWorkspace(byProject),
      };
    });
  },

  async loadAll(projectIds) {
    const requestIds = projectIds.map((id) => {
      const requestId = ++missionsRequestSeq;
      latestRequestSeqByProject[id] = requestId;
      return requestId;
    });
    const results = await Promise.all(
      projectIds.map(async (id) => [id, await ipc.listMissions(id)] as const),
    );
    set((state) => {
      const byProject = { ...state.missionsByProjectId };
      results.forEach(([id, missions], i) => {
        if (latestRequestSeqByProject[id] === requestIds[i]) byProject[id] = missions;
      });
      return {
        missionsByProjectId: byProject,
        missionByWorkspaceId: reindexByWorkspace(byProject),
      };
    });
  },

  async create(projectId, intent, title, gitIsolation, execIsolation, workspaceId, linkedIssueKey) {
    const mission = await ipc.createMission(
      projectId,
      intent,
      title,
      gitIsolation,
      execIsolation,
      workspaceId,
      linkedIssueKey,
    );
    await get().load(projectId);
    return mission;
  },

  async update(missionId, title, status, linkedIssueKey) {
    const mission = await ipc.updateMission(missionId, title, status, linkedIssueKey);
    await get().load(mission.projectId);
    return mission;
  },

  async setExecIsolation(missionId, execIsolation) {
    const mission = await ipc.updateMission(missionId, null, null, null, execIsolation);
    await get().load(mission.projectId);
    return mission;
  },

  async archive(missionId) {
    // Fetch first so we know which project's list to refresh after archiving.
    const full = await ipc.getMission(missionId);
    await ipc.archiveMission(missionId);
    if (full) await get().load(full.projectId);
  },
}));
