import { create } from "zustand";
import { ipc, type PipelineWithStages } from "../lib/ipc";

interface PipelineState {
  pipelines: PipelineWithStages[];
  loaded: boolean;
  error: string | null;
  load: () => Promise<void>;
}

export const usePipelineStore = create<PipelineState>((set) => ({
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
}));
