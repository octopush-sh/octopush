import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PipelineStage, PipelineWithStages } from "../../lib/ipc";
import type { ModelInfo, ProviderConfig } from "../../lib/types";

const ipcMock = vi.hoisted(() => ({
  savePipeline: vi.fn(),
  listPipelines: vi.fn(),
  listProviders: vi.fn(),
  claudeModelFloorNote: vi.fn(),
}));
vi.mock("../../lib/ipc", () => ({ ipc: ipcMock }));
const cliMock = vi.hoisted(() => ({ loadClaudeCliVersion: vi.fn() }));
vi.mock("../../lib/claudeCli", () => cliMock);
const toastMock = vi.hoisted(() => ({ pushToast: vi.fn() }));
vi.mock("../Toasts", () => toastMock);

const { SupersededModelLine } = await import("./SupersededModelLine");
const { useProvidersStore } = await import("../../stores/providersStore");
const { useSupersededModelStore } = await import("../../stores/supersededModelStore");

function model(id: string, displayName: string, input: number, output: number, supersededBy?: string): ModelInfo {
  return {
    id, displayName, inputCostPerM: input, outputCostPerM: output, cacheReadCostPerM: 0, cacheCreationCostPerM: 0,
    maxContext: 1_000_000, supportsVision: true, supportsTools: true, supersededBy,
  };
}

const catalog = [
  {
    name: "anthropic",
    models: [
      model("claude-fable-5-2", "Claude Fable 5.2", 8, 40),
      model("claude-fable-5-1", "Claude Fable 5.1", 10, 50, "claude-fable-5-2"),
      model("claude-sonnet-5-5", "Claude Sonnet 5.5", 2, 10),
    ],
  },
] as unknown as ProviderConfig[];

function stage(position: number, agentModel: string, extra: Partial<PipelineStage> = {}): PipelineStage {
  return {
    id: `s${position}`, pipelineId: "p", position, role: "implement", agentModel, escalateModel: null,
    substrate: "api", checkpoint: false, loopTargetPosition: null, loopMaxIterations: 0, loopMode: null,
    maxIterations: 25, posX: null, posY: null, parents: [], tools: null, customName: null, instructions: null,
    ...extra,
  };
}

function crew(id: string, stages: PipelineStage[], isBuiltin = false): PipelineWithStages {
  return { pipeline: { id, name: "Relay", description: "", isBuiltin, createdAt: "t" }, stages };
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  useProvidersStore.setState({ providers: catalog, loaded: true });
  useSupersededModelStore.setState({ kept: {} });
  ipcMock.savePipeline.mockResolvedValue("p");
  ipcMock.listPipelines.mockResolvedValue([]);
  cliMock.loadClaudeCliVersion.mockResolvedValue(null);
  ipcMock.claudeModelFloorNote.mockResolvedValue(null);
});

describe("SupersededModelLine", () => {
  it("stays out of the way for a crew on current models", () => {
    render(<SupersededModelLine pipeline={crew("p", [stage(0, "claude-sonnet-5-5")])} onSwitched={vi.fn()} />);
    expect(screen.queryByTestId("pipeline-model-superseded")).not.toBeInTheDocument();
  });

  it("offers the switch for a crew on Fable 5.1, escalations included", () => {
    const p = crew("p", [stage(0, "claude-sonnet-5-5", { escalateModel: "claude-fable-5-1" })]);
    render(<SupersededModelLine pipeline={p} onSwitched={vi.fn()} />);
    expect(screen.getByText("Fable 5.1 → Fable 5.2: about 20% cheaper per token.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Switch this crew" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep 5.1" })).toBeInTheDocument();
  });

  it("Switch this crew saves only that pipeline, with every Fable 5.1 model moved", async () => {
    const onSwitched = vi.fn();
    const p = crew("p", [
      stage(0, "claude-fable-5-1"),
      stage(1, "claude-sonnet-5-5", { escalateModel: "claude-fable-5-1" }),
    ]);
    render(<SupersededModelLine pipeline={p} onSwitched={onSwitched} />);
    fireEvent.click(screen.getByRole("button", { name: "Switch this crew" }));
    await waitFor(() => expect(onSwitched).toHaveBeenCalledWith("p", "claude-fable-5-1", "claude-fable-5-2"));
    expect(ipcMock.savePipeline).toHaveBeenCalledTimes(1);
    const draft = ipcMock.savePipeline.mock.calls[0][0];
    expect(draft.pipelineId).toBe("p");
    expect(draft.stages.map((s: { agentModel: string; escalateModel: string | null }) => [s.agentModel, s.escalateModel]))
      .toEqual([["claude-fable-5-2", null], ["claude-sonnet-5-5", "claude-fable-5-2"]]);
  });

  it("a builtin is forked and the new crew reported", async () => {
    ipcMock.savePipeline.mockResolvedValue("fork-1");
    const onSwitched = vi.fn();
    render(<SupersededModelLine pipeline={crew("b", [stage(0, "claude-fable-5-1")], true)} onSwitched={onSwitched} />);
    fireEvent.click(screen.getByRole("button", { name: "Switch this crew" }));
    await waitFor(() => expect(onSwitched).toHaveBeenCalledWith("fork-1", "claude-fable-5-1", "claude-fable-5-2"));
    expect(ipcMock.savePipeline.mock.calls[0][0]).toMatchObject({ pipelineId: "b", name: "Relay (custom)" });
  });

  it("a refused save says so and keeps the offer", async () => {
    ipcMock.savePipeline.mockRejectedValue(new Error("other: a stage needs a model"));
    const onSwitched = vi.fn();
    render(<SupersededModelLine pipeline={crew("p", [stage(0, "claude-fable-5-1")])} onSwitched={onSwitched} />);
    fireEvent.click(screen.getByRole("button", { name: "Switch this crew" }));
    await waitFor(() => expect(toastMock.pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Couldn't switch this crew", body: "a stage needs a model" }),
    ));
    expect(onSwitched).not.toHaveBeenCalled();
    expect(screen.getByTestId("pipeline-model-superseded")).toBeInTheDocument();
  });

  it("Keep 5.1 dismisses it for that pipeline only, and saves nothing", () => {
    const { rerender } = render(
      <SupersededModelLine pipeline={crew("p", [stage(0, "claude-fable-5-1")])} onSwitched={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Keep 5.1" }));
    expect(screen.queryByTestId("pipeline-model-superseded")).not.toBeInTheDocument();
    expect(useSupersededModelStore.getState().kept).toEqual({ p: ["claude-fable-5-1"] });
    expect(ipcMock.savePipeline).not.toHaveBeenCalled();
    rerender(<SupersededModelLine pipeline={crew("q", [stage(0, "claude-fable-5-1")])} onSwitched={vi.fn()} />);
    expect(screen.getByTestId("pipeline-model-superseded")).toBeInTheDocument();
  });

  it("adds the Claude Code floor note when a CLI stage would move and the CLI is too old", async () => {
    cliMock.loadClaudeCliVersion.mockResolvedValue({ version: "2.1.316" });
    ipcMock.claudeModelFloorNote.mockResolvedValue({ label: "Fable 5.2", needs: "2.1.321", installed: "2.1.316" });
    render(
      <SupersededModelLine pipeline={crew("p", [stage(0, "claude-fable-5-1", { substrate: "cli" })])} onSwitched={vi.fn()} />,
    );
    expect(await screen.findByText("Fable 5.2 needs Claude Code 2.1.321 or newer.")).toBeInTheDocument();
    expect(ipcMock.claudeModelFloorNote).toHaveBeenCalledWith(["claude-fable-5-2"]);
  });

  it("no floor note for API stages or an unknown CLI version", async () => {
    ipcMock.claudeModelFloorNote.mockResolvedValue({ label: "Fable 5.2", needs: "2.1.321", installed: "2.1.316" });
    const { unmount } = render(
      <SupersededModelLine pipeline={crew("p", [stage(0, "claude-fable-5-1", { substrate: "cli" })])} onSwitched={vi.fn()} />,
    );
    await waitFor(() => expect(cliMock.loadClaudeCliVersion).toHaveBeenCalled());
    expect(ipcMock.claudeModelFloorNote).not.toHaveBeenCalled();
    unmount();
    cliMock.loadClaudeCliVersion.mockResolvedValue({ version: "2.1.316" });
    render(<SupersededModelLine pipeline={crew("p", [stage(0, "claude-fable-5-1")])} onSwitched={vi.fn()} />);
    expect(screen.queryByText(/needs Claude Code/)).not.toBeInTheDocument();
    expect(cliMock.loadClaudeCliVersion).toHaveBeenCalledTimes(1);
  });
});
