import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

vi.mock("../lib/ipc", async () => {
  const actual = await vi.importActual<any>("../lib/ipc");
  return {
    ...actual,
    ipc: {
      ...actual.ipc,
      getGitDiff: vi.fn().mockResolvedValue(""),
      getStageLog: vi.fn().mockResolvedValue([]),
      listStageIterations: vi.fn().mockResolvedValue([]),
    },
  };
});

const { StageFocus } = await import("./StageFocus");
const { useRunsStore } = await import("../stores/runsStore");
const { ipc } = await import("../lib/ipc");

const baseStage = {
  id: "st1", runId: "r1", position: 0, role: "code_review", agentModel: "haiku",
  substrate: "api", checkpoint: false, status: "running", inputTokens: 0, outputTokens: 0,
  costUsd: 0, artifact: null, feedback: null, error: null, startedAt: null, finishedAt: null,
  loopTargetPosition: null, loopMaxIterations: 0, loopMode: null, loopIterations: 0,
} as any;

describe("StageFocus live journal", () => {
  beforeEach(() => {
    useRunsStore.setState({ liveByStage: {} });
    vi.mocked(ipc.getStageLog).mockResolvedValue([]);
    vi.mocked(ipc.listStageIterations).mockResolvedValue([]);
  });

  it("renders text as prose and a tool+result as one § card", () => {
    useRunsStore.setState({ liveByStage: { st1: [
      { kind: "text", text: "Inspecting the changes." },
      { kind: "tool", tool: "Read", hint: "src/auth.rs" },
      { kind: "tool_result", ok: true, detail: "142 lines" },
    ] } });
    render(<StageFocus stage={baseStage} workspacePath="/tmp" />);
    expect(screen.getByText("Inspecting the changes.")).toBeInTheDocument();
    expect(screen.getByText("Read")).toBeInTheDocument();          // tool name
    expect(screen.getByText("src/auth.rs")).toBeInTheDocument();   // hint
    expect(screen.getByText(/142 lines/)).toBeInTheDocument();     // result detail
    expect(screen.getByText(/reviewing…/)).toBeInTheDocument();    // running pulse (role verb for code_review)
  });

  it("shows the running indicator even when there are no entries yet", () => {
    render(<StageFocus stage={baseStage} workspacePath="/tmp" />);
    expect(screen.getByText(/reviewing…/)).toBeInTheDocument();
  });

  it("shows the role verb while running", () => {
    render(<StageFocus stage={{ ...baseStage, role: "plan" }} workspacePath="/tmp" />);
    expect(screen.getByText("planning…")).toBeInTheDocument();
  });

  it("renders a designed error banner plus the journal at full opacity on failure", () => {
    useRunsStore.setState({ liveByStage: { st1: [{ kind: "text", text: "evidence line" }] } });
    const { container } = render(
      <StageFocus stage={{ ...baseStage, status: "failed", error: "agent exploded" }} workspacePath="/tmp" />,
    );
    expect(screen.getByText("✕ stage halted")).toBeInTheDocument();
    expect(screen.getByText("agent exploded")).toBeInTheDocument();
    expect(screen.getByText("evidence line")).toBeInTheDocument(); // journal is evidence…
    expect(container.querySelector(".opacity-70")).toBeNull();     // …shown at full opacity
  });

  it("uses the serif empty state", () => {
    render(<StageFocus stage={null} workspacePath="/tmp" />);
    expect(screen.getByText("Pick a stage above to see its work.")).toBeInTheDocument();
  });

  it("keeps the work journal reachable on a done stage with an artifact (collapsed drawer)", async () => {
    const { fireEvent } = await import("@testing-library/react");
    useRunsStore.setState({ liveByStage: { st1: [
      { kind: "text", text: "history line one" },
      { kind: "tool", tool: "Edit", hint: "src/x.rs" },
      { kind: "tool_result", ok: true, detail: "3 lines" },
    ] } });
    const artifact = JSON.stringify({ kind: "note", text: "final artifact text" });
    render(<StageFocus stage={{ ...baseStage, status: "done", artifact }} workspacePath="/tmp" />);

    expect(screen.getByText("final artifact text")).toBeInTheDocument();
    // The drawer toggle is present and collapsed (content inert via Reveal).
    const toggle = screen.getByRole("button", { name: /work journal/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("history line one").closest('[aria-hidden="true"]')).not.toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("history line one").closest('[aria-hidden="true"]')).toBeNull();
    expect(screen.getByText("Edit")).toBeInTheDocument();
  });

  it("shows no journal drawer when a done stage has no live entries", () => {
    const artifact = JSON.stringify({ kind: "note", text: "final artifact text" });
    render(<StageFocus stage={{ ...baseStage, status: "done", artifact }} workspacePath="/tmp" />);
    expect(screen.queryByRole("button", { name: /work journal/i })).not.toBeInTheDocument();
  });
});

const archiveRow = {
  id: "it1", runId: "r1", stageId: "st1", iteration: 1, role: "code_review",
  agentModel: "haiku", status: "done",
  artifact: JSON.stringify({ kind: "note", text: "first attempt artifact" }),
  error: null, costUsd: 0.07, inputTokens: 10, outputTokens: 20,
  closingFeedback: "needs more tests", createdAt: "t",
};

describe("StageFocus iteration navigation (D5)", () => {
  beforeEach(() => {
    useRunsStore.setState({ liveByStage: {} });
    vi.mocked(ipc.getStageLog).mockResolvedValue([]);
    vi.mocked(ipc.listStageIterations).mockResolvedValue([]);
  });

  it("hides the attempt nav when the stage has no archived iterations", async () => {
    const artifact = JSON.stringify({ kind: "note", text: "current artifact text" });
    render(<StageFocus stage={{ ...baseStage, status: "done", artifact }} workspacePath="/tmp" />);
    await waitFor(() => expect(ipc.listStageIterations).toHaveBeenCalledWith("st1"));
    expect(screen.queryByText(/attempt/)).not.toBeInTheDocument();
  });

  it("shows the nav at the current attempt and walks back to the archived one", async () => {
    vi.mocked(ipc.listStageIterations).mockResolvedValue([archiveRow]);
    vi.mocked(ipc.getStageLog).mockResolvedValue([
      { kind: "text", text: "old journal line" },
      { kind: "reset" },
      { kind: "text", text: "new journal line" },
    ]);
    const artifact = JSON.stringify({ kind: "note", text: "current artifact text" });
    render(<StageFocus stage={{ ...baseStage, status: "done", artifact }} workspacePath="/tmp" />);

    // Default = current attempt (M+1 = 2 of 2), current body shown.
    expect(await screen.findByText("attempt 2 of 2")).toBeInTheDocument();
    expect(screen.getByText("current artifact text")).toBeInTheDocument();
    const prev = screen.getByRole("button", { name: "Previous attempt" });
    const next = screen.getByRole("button", { name: "Next attempt" });
    expect(next).toBeDisabled();

    // ‹ — archived attempt 1: eyebrow, artifact, cost, closing feedback, its journal segment.
    fireEvent.click(prev);
    expect(screen.getByText("attempt 1 of 2")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("archived attempt")).toBeInTheDocument());
    expect(screen.getByText("first attempt artifact")).toBeInTheDocument();
    expect(screen.getByText("$0.07")).toBeInTheDocument();
    expect(screen.getByText("sent back with")).toBeInTheDocument();
    expect(screen.getByText("needs more tests")).toBeInTheDocument();
    expect(screen.getByText("old journal line")).toBeInTheDocument(); // segment 0
    expect(screen.queryByText("current artifact text")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous attempt" })).toBeDisabled();

    // › — back to the current attempt.
    fireEvent.click(screen.getByRole("button", { name: "Next attempt" }));
    expect(screen.getByText("attempt 2 of 2")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("current artifact text")).toBeInTheDocument());
    expect(screen.queryByText("archived attempt")).not.toBeInTheDocument();
  });

  it("shows the archived error in the rouge banner style for a failed attempt", async () => {
    vi.mocked(ipc.listStageIterations).mockResolvedValue([
      { ...archiveRow, status: "failed", artifact: null, error: "attempt exploded", closingFeedback: null },
    ]);
    const artifact = JSON.stringify({ kind: "note", text: "current artifact text" });
    render(<StageFocus stage={{ ...baseStage, status: "done", artifact }} workspacePath="/tmp" />);
    fireEvent.click(await screen.findByRole("button", { name: "Previous attempt" }));
    await waitFor(() => expect(screen.getByText("attempt exploded")).toBeInTheDocument());
    expect(screen.getByText("✕ stage halted")).toBeInTheDocument();
    expect(screen.queryByText("sent back with")).not.toBeInTheDocument();
  });
});

describe("StageFocus journal hydration (D1)", () => {
  beforeEach(() => {
    useRunsStore.setState({ liveByStage: {} });
    vi.mocked(ipc.getStageLog).mockResolvedValue([]);
    vi.mocked(ipc.listStageIterations).mockResolvedValue([]);
  });

  it("hydrates a terminal stage's empty journal with the current log segment", async () => {
    vi.mocked(ipc.getStageLog).mockResolvedValue([
      { kind: "text", text: "a" },
      { kind: "reset" },
      { kind: "text", text: "b" },
      { kind: "text", text: "c" },
    ]);
    const artifact = JSON.stringify({ kind: "note", text: "current artifact text" });
    render(<StageFocus stage={{ ...baseStage, status: "done", artifact }} workspacePath="/tmp" />);
    await waitFor(() =>
      expect(useRunsStore.getState().getLiveEntries("st1")).toEqual([
        { kind: "text", text: "b" },
        { kind: "text", text: "c" },
      ]),
    );
    // The drawer now works after a reload.
    expect(screen.getByRole("button", { name: /work journal/i })).toBeInTheDocument();
  });

  it("never clobbers an already-populated journal", async () => {
    useRunsStore.setState({ liveByStage: { st1: [{ kind: "text", text: "live line" }] } });
    vi.mocked(ipc.getStageLog).mockResolvedValue([{ kind: "text", text: "stale persisted" }]);
    const artifact = JSON.stringify({ kind: "note", text: "current artifact text" });
    render(<StageFocus stage={{ ...baseStage, status: "done", artifact }} workspacePath="/tmp" />);
    await waitFor(() => expect(ipc.getStageLog).toHaveBeenCalledWith("st1"));
    expect(useRunsStore.getState().getLiveEntries("st1")).toEqual([
      { kind: "text", text: "live line" },
    ]);
  });

  it("does not hydrate a running stage from the persisted log", async () => {
    vi.mocked(ipc.getStageLog).mockResolvedValue([{ kind: "text", text: "persisted" }]);
    render(<StageFocus stage={baseStage} workspacePath="/tmp" />);
    await waitFor(() => expect(ipc.getStageLog).toHaveBeenCalledWith("st1"));
    expect(useRunsStore.getState().getLiveEntries("st1")).toEqual([]);
  });
});
