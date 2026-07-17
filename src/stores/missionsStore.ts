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

export const useMissionsStore = create<MissionsState>((set, get) => ({
  missionsByProjectId: {},
  missionByWorkspaceId: {},

  async load(projectId) {
    const missions = await ipc.listMissions(projectId);
    set((state) => {
      const byProject = { ...state.missionsByProjectId, [projectId]: missions };
      return {
        missionsByProjectId: byProject,
        missionByWorkspaceId: reindexByWorkspace(byProject),
      };
    });
  },

  async loadAll(projectIds) {
    const results = await Promise.all(
      projectIds.map(async (id) => [id, await ipc.listMissions(id)] as const),
    );
    set((state) => {
      const byProject = { ...state.missionsByProjectId };
      for (const [id, missions] of results) byProject[id] = missions;
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

  async archive(missionId) {
    // Fetch first so we know which project's list to refresh after archiving.
    const full = await ipc.getMission(missionId);
    await ipc.archiveMission(missionId);
    if (full) await get().load(full.projectId);
  },
}));
