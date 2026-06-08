import { create } from "zustand";
import { ipc, type PipelineWithStages } from "../lib/ipc";

interface PipelineState {
  pipelines: PipelineWithStages[];
  loaded: boolean;
  load: () => Promise<void>;
  getById: (pipelineId: string) => PipelineWithStages | undefined;
}

export const usePipelineStore = create<PipelineState>((set, get) => ({
  pipelines: [],
  loaded: false,
  load: async () => {
    try {
      const pipelines = await ipc.listPipelines();
      set({ pipelines, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  getById: (pipelineId) =>
    get().pipelines.find((p) => p.pipeline.id === pipelineId),
}));
