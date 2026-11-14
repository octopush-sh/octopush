import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ModelRetirement, PipelineStage, PipelineWithStages } from "../../lib/ipc";

const ipcMock = vi.hoisted(() => ({
  savePipeline: vi.fn(),
  listPipelines: vi.fn(),
  modelRetirements: vi.fn(),
}));
vi.mock("../../lib/ipc", () => ({ ipc: ipcMock }));
const toastMock = vi.hoisted(() => ({ pushToast: vi.fn() }));
vi.mock("../Toasts", () => toastMock);

const { RetiringModelLine } = await import("./RetiringModelLine");
const { resetModelRetirementCache } = await import("../../lib/modelRetirement");

const retirement = (model: string): ModelRetirement => ({
  model, label: "Sonnet 4.5", retires: "2026-11-30", replacement: "claude-sonnet-5-5", replacementLabel: "Sonnet 5.5",
});

function stage(position: number, agentModel: string, escalateModel: string | null = null): PipelineStage {
  return {
    id: `s${position}`, pipelineId: "p", position, role: "implement", agentModel, escalateModel,
    substrate: "api", checkpoint: false, loopTargetPosition: null, loopMaxIterations: 0, loopMode: null,
    maxIterations: 25, posX: null, posY: null, parents: [], tools: null, customName: null, instructions: null,
  };
}

function crew(id: string, stages: PipelineStage[], isBuiltin = false): PipelineWithStages {
  return { pipeline: { id, name: "Relay", description: "", isBuiltin, createdAt: "t" }, stages };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-14T12:00:00Z"));
  vi.clearAllMocks();
  resetModelRetirementCache();
  ipcMock.savePipeline.mockResolvedValue("p");
  ipcMock.listPipelines.mockResolvedValue([]);
  ipcMock.modelRetirements.mockImplementation(async (models: string[]) =>
    models.filter((m) => m.startsWith("claude-sonnet-4-5")).map(retirement),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("RetiringModelLine", () => {
  it("stays out of the way for a crew on current models", async () => {
    render(<RetiringModelLine pipeline={crew("p", [stage(0, "claude-sonnet-5-5")])} overrides={{}} onSwitched={vi.fn()} />);
    await waitFor(() => expect(ipcMock.modelRetirements).toHaveBeenCalled());
    expect(screen.queryByTestId("launcher-model-retirement")).not.toBeInTheDocument();
  });

  it("warns in amber within 30 days, the dated id and escalations included", async () => {
    const p = crew("p", [stage(0, "claude-sonnet-4-5-20250929"), stage(1, "claude-opus-5-5", "claude-sonnet-4-5")]);
    render(<RetiringModelLine pipeline={p} overrides={{}} onSwitched={vi.fn()} />);
    const line = await screen.findByTestId("launcher-model-retirement");
    expect(line).toHaveAttribute("data-phase", "soon");
    expect(screen.getByText("Sonnet 4.5 retires Nov 30, so 2 stages on it will fail after that.")).toHaveClass("text-octo-warning");
    expect(screen.getByRole("button", { name: "Switch to Sonnet 5.5" })).toBeInTheDocument();
  });

  it("turns rouge once the model has retired", async () => {
    vi.setSystemTime(new Date("2026-12-01T09:00:00Z"));
    render(<RetiringModelLine pipeline={crew("p", [stage(0, "claude-sonnet-4-5")])} overrides={{}} onSwitched={vi.fn()} />);
    expect(await screen.findByText("Sonnet 4.5 retired Nov 30, so a stage on it will fail.")).toHaveClass("text-octo-rouge");
  });

  it("says nothing before the 30-day window", async () => {
    vi.setSystemTime(new Date("2026-10-15T09:00:00Z"));
    render(<RetiringModelLine pipeline={crew("p", [stage(0, "claude-sonnet-4-5")])} overrides={{}} onSwitched={vi.fn()} />);
    await waitFor(() => expect(ipcMock.modelRetirements).toHaveBeenCalled());
    expect(screen.queryByTestId("launcher-model-retirement")).not.toBeInTheDocument();
  });

  it("switches only after the user confirms, and saves only that crew", async () => {
    const onSwitched = vi.fn();
    const p = crew("p", [stage(0, "claude-sonnet-4-5-20250929"), stage(1, "claude-opus-5-5", "claude-sonnet-4-5")]);
    render(<RetiringModelLine pipeline={p} overrides={{}} onSwitched={onSwitched} />);
    fireEvent.click(await screen.findByRole("button", { name: "Switch to Sonnet 5.5" }));
    expect(ipcMock.savePipeline).not.toHaveBeenCalled();
    expect(screen.getByText("Every stage of this crew on Sonnet 4.5, escalations included, moves to Sonnet 5.5.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Switch this crew" }));
    await waitFor(() => expect(onSwitched).toHaveBeenCalledWith(
      "p", expect.arrayContaining(["claude-sonnet-4-5-20250929", "claude-sonnet-4-5"]), "claude-sonnet-5-5",
    ));
    expect(ipcMock.savePipeline).toHaveBeenCalledTimes(1);
    const draft = ipcMock.savePipeline.mock.calls[0][0];
    expect(draft.pipelineId).toBe("p");
    expect(draft.stages.map((s: { agentModel: string; escalateModel: string | null }) => [s.agentModel, s.escalateModel]))
      .toEqual([["claude-sonnet-5-5", null], ["claude-opus-5-5", "claude-sonnet-5-5"]]);
  });

  it("Not now backs out without saving", async () => {
    render(<RetiringModelLine pipeline={crew("p", [stage(0, "claude-sonnet-4-5")])} overrides={{}} onSwitched={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Switch to Sonnet 5.5" }));
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.getByRole("button", { name: "Switch to Sonnet 5.5" })).toBeInTheDocument();
    expect(ipcMock.savePipeline).not.toHaveBeenCalled();
  });

  it("a builtin is forked and the new crew reported", async () => {
    ipcMock.savePipeline.mockResolvedValue("fork-1");
    const onSwitched = vi.fn();
    render(<RetiringModelLine pipeline={crew("b", [stage(0, "claude-sonnet-4-5")], true)} overrides={{}} onSwitched={onSwitched} />);
    fireEvent.click(await screen.findByRole("button", { name: "Switch to Sonnet 5.5" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch this crew" }));
    await waitFor(() => expect(onSwitched).toHaveBeenCalledWith("fork-1", ["claude-sonnet-4-5"], "claude-sonnet-5-5"));
    expect(ipcMock.savePipeline.mock.calls[0][0]).toMatchObject({ pipelineId: "b", name: "Relay (custom)" });
  });

  it("a refused save says so and keeps the line", async () => {
    ipcMock.savePipeline.mockRejectedValue(new Error("other: a stage needs a model"));
    render(<RetiringModelLine pipeline={crew("p", [stage(0, "claude-sonnet-4-5")])} overrides={{}} onSwitched={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Switch to Sonnet 5.5" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch this crew" }));
    await waitFor(() => expect(toastMock.pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Couldn't switch this crew", body: "a stage needs a model" }),
    ));
    expect(screen.getByTestId("launcher-model-retirement")).toBeInTheDocument();
  });

  it("a launcher pick alone warns but offers no switch of the saved crew", async () => {
    render(
      <RetiringModelLine pipeline={crew("p", [stage(0, "claude-sonnet-5-5")])} overrides={{ 0: "claude-sonnet-4-5" }} onSwitched={vi.fn()} />,
    );
    expect(await screen.findByTestId("launcher-model-retirement")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Switch to Sonnet 5.5" })).not.toBeInTheDocument();
  });
});
