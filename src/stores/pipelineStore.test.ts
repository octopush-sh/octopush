import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/ipc", () => ({
  ipc: {
    listPipelines: vi.fn(),
    savePipeline: vi.fn(),
    deletePipeline: vi.fn(),
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

  it("replaces the list on repeated calls (focus-driven refresh is safe to call unconditionally)", async () => {
    (ipc.listPipelines as any).mockResolvedValue(SAMPLE);
    await usePipelineStore.getState().load();
    expect(usePipelineStore.getState().pipelines).toHaveLength(1);

    const externallyAuthored = [
      ...SAMPLE,
      {
        pipeline: { id: "p2", name: "MCP Pipeline", description: "d2", isBuiltin: false, createdAt: "t2" },
        stages: [
          { id: "s2", pipelineId: "p2", position: 0, role: "plan", agentModel: "m", substrate: "api", checkpoint: false },
        ],
      },
    ];
    (ipc.listPipelines as any).mockResolvedValue(externallyAuthored);
    await usePipelineStore.getState().load();
    expect(usePipelineStore.getState().pipelines).toHaveLength(2);
    expect(usePipelineStore.getState().pipelines.map((p) => p.pipeline.id)).toEqual(["p1", "p2"]);
  });

  it("clears a previous error once a repeated call succeeds", async () => {
    (ipc.listPipelines as any).mockRejectedValue(new Error("boom"));
    await usePipelineStore.getState().load();
    expect(usePipelineStore.getState().error).toBe("boom");

    (ipc.listPipelines as any).mockResolvedValue(SAMPLE);
    await usePipelineStore.getState().load();
    expect(usePipelineStore.getState().error).toBeNull();
    expect(usePipelineStore.getState().pipelines).toHaveLength(1);
  });

  it("save calls savePipeline and reloads the list", async () => {
    (ipc.savePipeline as any) = vi.fn().mockResolvedValue("new-id");
    (ipc.listPipelines as any).mockResolvedValue([]);
    const draft = { pipelineId: null, name: "Mine", description: "d", stages: [] as any[] };
    const id = await usePipelineStore.getState().save(draft as any);
    expect(id).toBe("new-id");
    expect(ipc.savePipeline).toHaveBeenCalledWith(draft);
    expect(ipc.listPipelines).toHaveBeenCalled(); // reloaded
  });

  it("remove calls deletePipeline and reloads the list", async () => {
    (ipc.deletePipeline as any) = vi.fn().mockResolvedValue(undefined);
    (ipc.listPipelines as any).mockResolvedValue([]);
    await usePipelineStore.getState().remove("p1");
    expect(ipc.deletePipeline).toHaveBeenCalledWith("p1");
    expect(ipc.listPipelines).toHaveBeenCalled();
  });
});
