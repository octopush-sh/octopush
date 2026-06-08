import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/ipc", () => ({
  ipc: {
    listPipelines: vi.fn(),
  },
}));

import { ipc } from "../lib/ipc";
import { usePipelineStore } from "./pipelineStore";

const SAMPLE = [
  {
    pipeline: { id: "p1", name: "Feature Factory", description: "d", isBuiltin: true, createdAt: "t" },
    stages: [
      { id: "s1", pipelineId: "p1", position: 0, role: "plan", agentModel: "m", substrate: "api", checkpoint: false },
    ],
  },
];

describe("pipelineStore", () => {
  beforeEach(() => {
    usePipelineStore.setState({ pipelines: [], loaded: false, error: null });
    vi.clearAllMocks();
  });

  it("loads pipelines from ipc and marks loaded", async () => {
    (ipc.listPipelines as any).mockResolvedValue(SAMPLE);
    await usePipelineStore.getState().load();
    expect(usePipelineStore.getState().pipelines).toHaveLength(1);
    expect(usePipelineStore.getState().pipelines[0].pipeline.name).toBe("Feature Factory");
    expect(usePipelineStore.getState().loaded).toBe(true);
  });

  it("records an error message when loading fails", async () => {
    (ipc.listPipelines as any).mockRejectedValue(new Error("boom"));
    await usePipelineStore.getState().load();
    expect(usePipelineStore.getState().loaded).toBe(true);
    expect(usePipelineStore.getState().error).toBe("boom");
    expect(usePipelineStore.getState().pipelines).toHaveLength(0);
  });
});
