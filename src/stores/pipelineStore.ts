import { create } from "zustand";
import { ipc, type PipelineDraft, type PipelineWithStages } from "../lib/ipc";

interface PipelineState {
  pipelines: PipelineWithStages[];
  loaded: boolean;
  error: string | null;
  load: () => Promise<void>;
  /** Create / fork / update via save_pipeline; reloads the list. Returns the saved id. */
  save: (draft: PipelineDraft) => Promise<string>;
  /** Delete a custom pipeline; reloads the list. */
  remove: (pipelineId: string) => Promise<void>;
}

export const usePipelineStore = create<PipelineState>((set, get) => ({
  pipelines: [],
  loaded: false,
  error: null,
  load: async () => {
    try {
      const pipelines = await ipc.listPipelines();
      set({ pipelines, loaded: true, error: null });
    } catch (e) {
      set({ loaded: true, error: e instanceof Error ? e.message : String(e) });
    }
  },
  save: async (draft) => {
    const id = await ipc.savePipeline(draft);
    await get().load();
    return id;
  },
  remove: async (pipelineId) => {
    await ipc.deletePipeline(pipelineId);
    await get().load();
  },
}));
