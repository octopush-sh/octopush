import { create } from "zustand";
import { persist } from "zustand/middleware";

/** "Keep 5.1" on the launcher's superseded-model line: per pipeline, the
 *  superseded model ids the user chose to keep. Persisted, so the line stays
 *  gone for that crew; a model superseded later still asks once. */
interface SupersededModelState {
  /** pipeline id → superseded model ids kept on it. */
  kept: Record<string, string[]>;
  keep: (pipelineId: string, modelId: string) => void;
  isKept: (pipelineId: string, modelId: string) => boolean;
}

export const useSupersededModelStore = create<SupersededModelState>()(
  persist(
    (set, get) => ({
      kept: {},
      keep: (pipelineId, modelId) =>
        set((s) => {
          const ids = s.kept[pipelineId] ?? [];
          return ids.includes(modelId) ? s : { kept: { ...s.kept, [pipelineId]: [...ids, modelId] } };
        }),
      isKept: (pipelineId, modelId) => (get().kept[pipelineId] ?? []).includes(modelId),
    }),
    {
      name: "octo-superseded-models",
      partialize: (s) => ({ kept: s.kept }),
    },
  ),
);
