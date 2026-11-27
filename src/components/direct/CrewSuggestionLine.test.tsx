import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CrewReport, CrewSuggestion, PipelineStage, PipelineWithStages } from "../../lib/ipc";

const ipcMock = vi.hoisted(() => ({
  savePipeline: vi.fn(),
  listPipelines: vi.fn(),
  getCrewReport: vi.fn(),
}));
vi.mock("../../lib/ipc", () => ({ ipc: ipcMock }));
vi.mock("../Toasts", () => ({ pushToast: vi.fn() }));

const { CrewSuggestionLine } = await import("./CrewSuggestionLine");

function stage(position: number, customName: string, agentModel: string, escalateModel: string | null = null): PipelineStage {
  return {
    id: `s${position}`, pipelineId: "p", position, role: "implement", agentModel, escalateModel,
    substrate: "api", checkpoint: false, loopTargetPosition: null, loopMaxIterations: 0, loopMode: null,
    maxIterations: 25, posX: null, posY: null, parents: [], tools: null, customName, instructions: null,
  };
}

const crew = (isBuiltin = false): PipelineWithStages => ({
  pipeline: { id: "p", name: "Relay", description: "", isBuiltin, createdAt: "t" },
  stages: [stage(0, "Plan", "claude-sonnet-5-5", "claude-opus-5-5"), stage(1, "Implement", "claude-sonnet-5-5"), stage(2, "Code review", "claude-sonnet-5-5")],
});

const suggestion = (over: Partial<CrewSuggestion>): CrewSuggestion => ({
  kind: "startStrong", position: 0, role: "implement", runs: 10, count: 7, model: "claude-opus-5-5", modelLabel: "Opus 5.5",
  escalateModel: null, escalateLabel: null, savingUsd: 0.38, senderPosition: null, meanLoops: null, ...over,
});

const report = (suggestions: CrewSuggestion[]): CrewReport => ({ minRuns: 8, stages: [], suggestions });

beforeEach(() => {
  vi.clearAllMocks();
  ipcMock.savePipeline.mockResolvedValue("p");
  ipcMock.listPipelines.mockResolvedValue([]);
});

describe("CrewSuggestionLine", () => {
  it("says nothing when the runs suggest nothing", async () => {
    ipcMock.getCrewReport.mockResolvedValue(report([]));
    render(<CrewSuggestionLine pipeline={crew()} onApplied={vi.fn()} onOpenBuilder={vi.fn()} />);
    await waitFor(() => expect(ipcMock.getCrewReport).toHaveBeenCalledWith("p"));
    expect(screen.queryByTestId("launcher-crew-suggestion")).not.toBeInTheDocument();
  });

  it("names the first suggestion and changes the crew only after a confirm", async () => {
    ipcMock.getCrewReport.mockResolvedValue(report([suggestion({})]));
    const onApplied = vi.fn();
    render(<CrewSuggestionLine pipeline={crew()} onApplied={onApplied} onOpenBuilder={vi.fn()} />);
    fireEvent.click(await screen.findByText("1 suggestion · Plan escalates in 7 of 10 runs"));
    expect(screen.getByText("Escalated in 7 of 10 runs. Starting on Opus 5.5 would have cost about $0.38 less per run (estimate).")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: "Start Plan on Opus 5.5" }));
    expect(ipcMock.savePipeline).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("menuitem", { name: "Change this crew" }));
    await waitFor(() => expect(onApplied).toHaveBeenCalledWith("p", 0));
    const draft = ipcMock.savePipeline.mock.calls[0][0];
    expect(draft.stages.map((s: { agentModel: string; escalateModel: string | null }) => [s.agentModel, s.escalateModel]))
      .toEqual([["claude-opus-5-5", null], ["claude-sonnet-5-5", null], ["claude-sonnet-5-5", null]]);
  });

  it("a lighter tier keeps the current model as the escalation, and a builtin is forked", async () => {
    ipcMock.getCrewReport.mockResolvedValue(report([suggestion({
      kind: "lighterTier", position: 2, count: 18, runs: 20, model: "claude-haiku-5-5", modelLabel: "Haiku 5.5",
      escalateModel: "claude-sonnet-5-5", escalateLabel: "Sonnet 5.5", savingUsd: null,
    })]));
    ipcMock.savePipeline.mockResolvedValue("fork-1");
    const onApplied = vi.fn();
    render(<CrewSuggestionLine pipeline={crew(true)} onApplied={onApplied} onOpenBuilder={vi.fn()} />);
    fireEvent.click(await screen.findByTestId("launcher-crew-suggestion"));
    // Unpriced: no dollar figure at all.
    expect(screen.getByText("Passed first time in 18 of 20 runs. Try Haiku 5.5 here; Sonnet 5.5 stays as the escalation.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Try Haiku 5.5 on Code review" }));
    expect(screen.getByText(/Saves a copy of this crew\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Change this crew" }));
    await waitFor(() => expect(onApplied).toHaveBeenCalledWith("fork-1", 2));
    const draft = ipcMock.savePipeline.mock.calls[0][0];
    expect(draft).toMatchObject({ pipelineId: "p", name: "Relay (custom)" });
    expect(draft.stages[2]).toMatchObject({ agentModel: "claude-haiku-5-5", escalateModel: "claude-sonnet-5-5" });
  });

  it("a loop hotspot points at the builder and edits nothing", async () => {
    ipcMock.getCrewReport.mockResolvedValue(report([suggestion({
      kind: "loopHotspot", position: 1, model: null, modelLabel: null, savingUsd: null, senderPosition: 2, meanLoops: 1.8,
    })]));
    const onOpenBuilder = vi.fn();
    render(<CrewSuggestionLine pipeline={crew()} onApplied={vi.fn()} onOpenBuilder={onOpenBuilder} />);
    fireEvent.click(await screen.findByText("1 suggestion · Code review sends Implement back 1.8× per run"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open this crew in the builder" }));
    expect(onOpenBuilder).toHaveBeenCalledWith("p");
    expect(ipcMock.savePipeline).not.toHaveBeenCalled();
  });

  it("an unpriced start-strong holds for either kind of escalation", async () => {
    ipcMock.getCrewReport.mockResolvedValue(report([suggestion({ savingUsd: null })]));
    render(<CrewSuggestionLine pipeline={crew()} onApplied={vi.fn()} onOpenBuilder={vi.fn()} />);
    fireEvent.click(await screen.findByTestId("launcher-crew-suggestion"));
    expect(screen.getByText("Escalated in 7 of 10 runs, each paying for the earlier attempts and then for Opus 5.5.")).toBeInTheDocument();
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
  });

  it("renders nothing when the report can't be read", async () => {
    ipcMock.getCrewReport.mockRejectedValue(new Error("db locked"));
    render(<CrewSuggestionLine pipeline={crew()} onApplied={vi.fn()} onOpenBuilder={vi.fn()} />);
    await waitFor(() => expect(ipcMock.getCrewReport).toHaveBeenCalledWith("p"));
    await Promise.resolve();
    expect(screen.queryByTestId("launcher-crew-suggestion")).not.toBeInTheDocument();
  });

  it("a failed save says so and keeps the menu open", async () => {
    ipcMock.getCrewReport.mockResolvedValue(report([suggestion({})]));
    ipcMock.savePipeline.mockRejectedValue(new Error("other: disk full"));
    const { pushToast } = await import("../Toasts");
    const onApplied = vi.fn();
    render(<CrewSuggestionLine pipeline={crew()} onApplied={onApplied} onOpenBuilder={vi.fn()} />);
    fireEvent.click(await screen.findByTestId("launcher-crew-suggestion"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Start Plan on Opus 5.5" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Change this crew" }));
    await waitFor(() => expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ level: "error", body: "disk full" })));
    expect(onApplied).not.toHaveBeenCalled();
    expect(screen.getByRole("menu", { name: "Crew suggestions" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Change this crew" })).not.toBeDisabled());
  });

  it("\"Not now\" goes back to the offer without saving", async () => {
    ipcMock.getCrewReport.mockResolvedValue(report([suggestion({})]));
    render(<CrewSuggestionLine pipeline={crew()} onApplied={vi.fn()} onOpenBuilder={vi.fn()} />);
    fireEvent.click(await screen.findByTestId("launcher-crew-suggestion"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Start Plan on Opus 5.5" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Not now" }));
    expect(screen.getByRole("menuitem", { name: "Start Plan on Opus 5.5" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Change this crew" })).not.toBeInTheDocument();
    expect(ipcMock.savePipeline).not.toHaveBeenCalled();
  });

  it("Escape closes the menu, forgets the confirm step and saves nothing", async () => {
    ipcMock.getCrewReport.mockResolvedValue(report([suggestion({})]));
    render(<CrewSuggestionLine pipeline={crew()} onApplied={vi.fn()} onOpenBuilder={vi.fn()} />);
    const line = await screen.findByTestId("launcher-crew-suggestion");
    fireEvent.click(line);
    fireEvent.click(screen.getByRole("menuitem", { name: "Start Plan on Opus 5.5" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Crew suggestions" })).not.toBeInTheDocument();
    fireEvent.click(line);
    expect(screen.getByRole("menuitem", { name: "Start Plan on Opus 5.5" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Change this crew" })).not.toBeInTheDocument();
    expect(ipcMock.savePipeline).not.toHaveBeenCalled();
  });
});
