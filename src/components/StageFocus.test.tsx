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
  diffSnapshot: null,
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

  it("pins the failed banner to the top of the scroll container, opaque (F2)", () => {
    render(
      <StageFocus stage={{ ...baseStage, status: "failed", error: "agent exploded" }} workspacePath="/tmp" />,
    );
    const banner = screen.getByText("✕ stage halted").closest(".sticky");
    expect(banner).not.toBeNull(); // sticky wrapper exists
    expect(banner!.className).toContain("top-0");
    expect(banner!.className).toContain("z-10");
    // Opaque layer under the rouge tint so scrolled journal lines never show through.
    expect(banner!.className).toContain("bg-octo-onyx");
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

  it("renders the journal in idle mode so a budget-parked stage shows its notice", () => {
    // awaiting_checkpoint + never started + no artifact = budget-parked; its
    // only content is the run://log notice — it must be visible, not
    // "Nothing produced yet."
    useRunsStore.setState({ liveByStage: { st1: [
      { kind: "notice", text: "budget reached — $0.02 of $0.01 spent" },
    ] } });
    render(<StageFocus stage={{ ...baseStage, status: "awaiting_checkpoint" }} workspacePath="/tmp" />);
    expect(screen.getByText(/budget reached/)).toBeInTheDocument();
    expect(screen.queryByText("Nothing produced yet.")).not.toBeInTheDocument();
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
  closingFeedback: "needs more tests", createdAt: "t", diffSnapshot: null,
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

const snapshotDiff = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -1,2 +1,3 @@",
  " keep",
  "+added by stage",
].join("\n");

describe("StageFocus diff snapshots", () => {
  beforeEach(() => {
    useRunsStore.setState({ liveByStage: {} });
    vi.mocked(ipc.getGitDiff).mockClear();
    vi.mocked(ipc.getStageLog).mockResolvedValue([]);
    vi.mocked(ipc.listStageIterations).mockResolvedValue([]);
  });

  const worktreeArtifact = JSON.stringify({
    kind: "diff", text: "implemented it", refsWorktree: true,
  });

  it("renders the snapshot with its label and never fetches the live diff", async () => {
    render(
      <StageFocus
        stage={{ ...baseStage, status: "done", artifact: worktreeArtifact, diffSnapshot: snapshotDiff }}
        workspacePath="/tmp"
      />,
    );
    expect(screen.getByText("worktree when this stage finished")).toBeInTheDocument();
    expect(screen.getByText("src/foo.ts")).toBeInTheDocument();      // DiffViewer file header
    expect(screen.getByText("+added by stage")).toBeInTheDocument(); // DiffViewer body line
    await waitFor(() => expect(ipc.listStageIterations).toHaveBeenCalledWith("st1"));
    expect(ipc.getGitDiff).not.toHaveBeenCalled();
  });

  it("falls back to the live diff fetch when the snapshot is null (legacy runs)", async () => {
    render(
      <StageFocus
        stage={{ ...baseStage, status: "done", artifact: worktreeArtifact, diffSnapshot: null }}
        workspacePath="/tmp"
      />,
    );
    await waitFor(() => expect(ipc.getGitDiff).toHaveBeenCalledWith("/tmp"));
    expect(screen.queryByText("worktree when this stage finished")).not.toBeInTheDocument();
  });

  it("shows a failed stage's snapshot beneath the error banner", () => {
    render(
      <StageFocus
        stage={{ ...baseStage, status: "failed", error: "agent exploded", diffSnapshot: snapshotDiff }}
        workspacePath="/tmp"
      />,
    );
    expect(screen.getByText("✕ stage halted")).toBeInTheDocument();
    expect(screen.getByText("worktree when this stage finished")).toBeInTheDocument();
    expect(screen.getByText("src/foo.ts")).toBeInTheDocument();
    expect(ipc.getGitDiff).not.toHaveBeenCalled();
  });

  it("renders an archived attempt's own snapshot beneath its artifact", async () => {
    vi.mocked(ipc.listStageIterations).mockResolvedValue([
      { ...archiveRow, diffSnapshot: snapshotDiff },
    ]);
    const artifact = JSON.stringify({ kind: "note", text: "current artifact text" });
    render(<StageFocus stage={{ ...baseStage, status: "done", artifact }} workspacePath="/tmp" />);
    fireEvent.click(await screen.findByRole("button", { name: "Previous attempt" }));
    await waitFor(() => expect(screen.getByText("first attempt artifact")).toBeInTheDocument());
    expect(screen.getByText("worktree when this stage finished")).toBeInTheDocument();
    expect(screen.getByText("src/foo.ts")).toBeInTheDocument();
    expect(screen.getByText("+added by stage")).toBeInTheDocument();
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
