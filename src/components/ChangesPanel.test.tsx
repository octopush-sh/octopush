import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Hoist the mocks so they are available when the vi.mock factories run.
const { ipcMock, pushToast } = vi.hoisted(() => ({
  ipcMock: {
    getGitStatus: vi.fn(),
    stageFile: vi.fn(), unstageFile: vi.fn(), unstageAllChanges: vi.fn(),
    commitChanges: vi.fn(), amendCommit: vi.fn(), pushBranch: vi.fn(),
    getStagedDiff: vi.fn(), getLastCommit: vi.fn(), discardFile: vi.fn(),
    aiComplete: vi.fn(), fetchChanges: vi.fn(), pull: vi.fn(),
    resolveConflictTake: vi.fn(), markConflictResolved: vi.fn(),
    continueOperation: vi.fn(), abortOperation: vi.fn(),
  },
  pushToast: vi.fn(),
}));
vi.mock("../lib/ipc", () => ({ ipc: ipcMock }));
vi.mock("./Toasts", () => ({ pushToast: (...a: unknown[]) => pushToast(...a) }));
// Stores referenced by handleCommitOrAmend — actual import paths used in ChangesPanel.tsx.
vi.mock("../stores/projectStore", () => ({ useProjectStore: { getState: () => ({ current: null }) } }));
vi.mock("../stores/workspaceStore", () => ({ useWorkspaceStore: { getState: () => ({ loadGitSummaries: vi.fn() }) } }));
// The AI modal has its own test file — here we only assert the wiring.
vi.mock("./ConflictAiModal", () => ({
  ConflictAiModal: ({ file, model }: { file: string; model: string }) => (
    <div data-testid="conflict-ai-modal">{file}:{model}</div>
  ),
}));

import { ChangesPanel } from "./ChangesPanel";

const STATUS = {
  branch: "main", ahead: 0, behind: 0, hasUpstream: true,
  conflicted: 0, aheadBehindKnown: true,
  changedFiles: [
    { path: "a.ts", status: "modified", staged: true, unstaged: false, conflicted: false },
    { path: "b.ts", status: "modified", staged: false, unstaged: true, conflicted: false },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  ipcMock.getGitStatus.mockResolvedValue(STATUS);
});

describe("ChangesPanel G4", () => {
  it("Draft fills the message from the staged diff via aiComplete", async () => {
    ipcMock.getStagedDiff.mockResolvedValue("DIFF");
    ipcMock.aiComplete.mockResolvedValue({ text: "feat: drafted", inputTokens: 1, outputTokens: 1, costUsd: 0 });
    render(<ChangesPanel projectPath="/repo" />);
    await screen.findByText("a.ts");
    await userEvent.click(screen.getByRole("button", { name: /draft/i }));
    await waitFor(() => expect(ipcMock.aiComplete).toHaveBeenCalled());
    expect(ipcMock.getStagedDiff).toHaveBeenCalledWith("/repo");
    expect((screen.getByPlaceholderText(/describe the change/i) as HTMLTextAreaElement).value).toBe("feat: drafted");
  });

  it("amend toggle pre-fills the last commit message and shows the pushed warning", async () => {
    ipcMock.getLastCommit.mockResolvedValue({ shortSha: "a3f12c8", subject: "fix: bug", body: "" });
    render(<ChangesPanel projectPath="/repo" />);
    await screen.findByText("a.ts");
    await userEvent.click(screen.getByLabelText(/amend last commit/i));
    await waitFor(() => expect(ipcMock.getLastCommit).toHaveBeenCalledWith("/repo"));
    expect((screen.getByPlaceholderText(/describe the change/i) as HTMLTextAreaElement).value).toBe("fix: bug");
    expect(screen.getByText(/rewrites history/i)).toBeInTheDocument();
  });

  it("committing with amend on routes to amendCommit", async () => {
    ipcMock.getLastCommit.mockResolvedValue({ shortSha: "a3f12c8", subject: "fix: bug", body: "" });
    ipcMock.amendCommit.mockResolvedValue("b4c5d6e");
    render(<ChangesPanel projectPath="/repo" />);
    await screen.findByText("a.ts");
    await userEvent.click(screen.getByLabelText(/amend last commit/i));
    await screen.findByDisplayValue("fix: bug");
    await userEvent.click(screen.getByRole("button", { name: /^amend$/i }));
    await waitFor(() => expect(ipcMock.amendCommit).toHaveBeenCalledWith("/repo", "fix: bug"));
    expect(ipcMock.commitChanges).not.toHaveBeenCalled();
  });

  it("discard opens a confirm and calls discardFile", async () => {
    ipcMock.discardFile.mockResolvedValue(undefined);
    render(<ChangesPanel projectPath="/repo" />);
    await screen.findByText("b.ts");
    await userEvent.click(screen.getByLabelText(/discard changes to b\.ts/i));
    await userEvent.click(await screen.findByRole("button", { name: /^discard$/i }));
    await waitFor(() => expect(ipcMock.discardFile).toHaveBeenCalledWith("/repo", "b.ts"));
  });

  it("does not enable amend when there is no last commit", async () => {
    ipcMock.getLastCommit.mockResolvedValue(null);
    render(<ChangesPanel projectPath="/repo" />);
    await screen.findByText("a.ts");
    const box = screen.getByLabelText(/amend last commit/i) as HTMLInputElement;
    await userEvent.click(box);
    await waitFor(() => expect(ipcMock.getLastCommit).toHaveBeenCalled());
    expect(box.checked).toBe(false);
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Nothing to amend" }));
  });

  it("Pull (ff-only ok) calls ipc.pull and toasts", async () => {
    ipcMock.getGitStatus.mockResolvedValue({
      branch: "main", ahead: 0, behind: 2, hasUpstream: true,
      conflicted: 0, aheadBehindKnown: true, changedFiles: [],
    });
    ipcMock.pull.mockResolvedValue({ kind: "ok", output: "Updated." });
    render(<ChangesPanel projectPath="/repo" />);
    await screen.findByRole("button", { name: /^pull$/i });
    await userEvent.click(screen.getByRole("button", { name: /^pull$/i }));
    await waitFor(() => expect(ipcMock.pull).toHaveBeenCalledWith("/repo", "ffOnly"));
  });

  it("diverged pull opens the reconcile dialog and routes Rebase", async () => {
    ipcMock.getGitStatus.mockResolvedValue({
      branch: "main", ahead: 1, behind: 1, hasUpstream: true,
      conflicted: 0, aheadBehindKnown: true, changedFiles: [],
    });
    ipcMock.pull
      .mockResolvedValueOnce({ kind: "diverged", output: "Not possible to fast-forward" })
      .mockResolvedValueOnce({ kind: "ok", output: "Rebased." });
    render(<ChangesPanel projectPath="/repo" />);
    await userEvent.click(await screen.findByRole("button", { name: /^pull$/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^rebase$/i }));
    await waitFor(() => expect(ipcMock.pull).toHaveBeenNthCalledWith(2, "/repo", "rebase"));
  });

  it("shows the conflict section header when conflicted > 0", async () => {
    ipcMock.getGitStatus.mockResolvedValue({
      branch: "main", ahead: 0, behind: 0, hasUpstream: true,
      conflicted: 2, aheadBehindKnown: true, operation: null,
      changedFiles: [{ path: "a.ts", status: "conflicted", staged: false, unstaged: true, conflicted: true }],
    });
    render(<ChangesPanel projectPath="/repo" />);
    expect(await screen.findByText(/2 conflicts/i)).toBeInTheDocument();
  });

  it("hides the ahead/behind badge when aheadBehindKnown is false", async () => {
    ipcMock.getGitStatus.mockResolvedValue({
      branch: "main", ahead: 0, behind: 0, hasUpstream: true,
      conflicted: 0, aheadBehindKnown: false, changedFiles: [],
    });
    render(<ChangesPanel projectPath="/repo" />);
    await screen.findByText("main");
    expect(screen.queryByTestId("ahead-behind")).not.toBeInTheDocument();
  });
});

// ─── G7 Slice II — conflict resolution ────────────────────────────

const CONFLICT_STATUS = {
  branch: "main", ahead: 0, behind: 0, hasUpstream: true,
  conflicted: 2, aheadBehindKnown: true, operation: "merge",
  changedFiles: [
    { path: "src/a.ts", status: "conflicted", staged: false, unstaged: true, conflicted: true },
    { path: "src/b.ts", status: "conflicted", staged: false, unstaged: true, conflicted: true },
  ],
};

const RESOLVED_PENDING_STATUS = {
  branch: "main", ahead: 0, behind: 0, hasUpstream: true,
  conflicted: 0, aheadBehindKnown: true, operation: "merge",
  changedFiles: [],
};

describe("ChangesPanel G7 conflicts", () => {
  it("renders a row per conflicted file with OURS/THEIRS chips and tooltips", async () => {
    ipcMock.getGitStatus.mockResolvedValue(CONFLICT_STATUS);
    render(<ChangesPanel projectPath="/repo" />);
    expect(await screen.findByText(/2 conflicts · merge/i)).toBeInTheDocument();
    const ours = screen.getAllByRole("button", { name: "OURS" });
    const theirs = screen.getAllByRole("button", { name: "THEIRS" });
    expect(ours).toHaveLength(2);
    expect(theirs).toHaveLength(2);
    expect(ours[0].title).toMatch(/keep our version/i);
    expect(theirs[0].title).toMatch(/keep their version/i);
  });

  it("OURS chip calls resolveConflictTake with side 'ours' and refreshes", async () => {
    ipcMock.getGitStatus.mockResolvedValue(CONFLICT_STATUS);
    ipcMock.resolveConflictTake.mockResolvedValue(undefined);
    render(<ChangesPanel projectPath="/repo" />);
    await screen.findByText(/2 conflicts · merge/i);
    const callsBefore = ipcMock.getGitStatus.mock.calls.length;
    await userEvent.click(screen.getAllByRole("button", { name: "OURS" })[0]);
    await waitFor(() =>
      expect(ipcMock.resolveConflictTake).toHaveBeenCalledWith("/repo", "src/a.ts", "ours"),
    );
    await waitFor(() =>
      expect(ipcMock.getGitStatus.mock.calls.length).toBeGreaterThan(callsBefore),
    );
  });

  it("THEIRS chip calls resolveConflictTake with side 'theirs'", async () => {
    ipcMock.getGitStatus.mockResolvedValue(CONFLICT_STATUS);
    ipcMock.resolveConflictTake.mockResolvedValue(undefined);
    render(<ChangesPanel projectPath="/repo" />);
    await screen.findByText(/2 conflicts · merge/i);
    await userEvent.click(screen.getAllByRole("button", { name: "THEIRS" })[1]);
    await waitFor(() =>
      expect(ipcMock.resolveConflictTake).toHaveBeenCalledWith("/repo", "src/b.ts", "theirs"),
    );
  });

  it("shows Continue/Abort when all conflicts are resolved but the operation is pending", async () => {
    ipcMock.getGitStatus.mockResolvedValue(RESOLVED_PENDING_STATUS);
    render(<ChangesPanel projectPath="/repo" />);
    expect(await screen.findByText(/all conflicts resolved · merge/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue merge/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^abort$/i })).toBeInTheDocument();
  });

  it("Abort asks for confirmation before calling abortOperation", async () => {
    ipcMock.getGitStatus.mockResolvedValue(RESOLVED_PENDING_STATUS);
    ipcMock.abortOperation.mockResolvedValue("ok");
    render(<ChangesPanel projectPath="/repo" />);
    await userEvent.click(await screen.findByRole("button", { name: /^abort$/i }));
    expect(ipcMock.abortOperation).not.toHaveBeenCalled();
    expect(
      screen.getByText(/abort the merge\? conflict resolutions in progress are discarded\./i),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /abort merge/i }));
    await waitFor(() => expect(ipcMock.abortOperation).toHaveBeenCalledWith("/repo"));
  });

  it("Continue with moreConflicts pushes a warning toast and refreshes", async () => {
    ipcMock.getGitStatus.mockResolvedValue(RESOLVED_PENDING_STATUS);
    ipcMock.continueOperation.mockResolvedValue({ kind: "moreConflicts", output: "CONFLICT (content)" });
    render(<ChangesPanel projectPath="/repo" />);
    await userEvent.click(await screen.findByRole("button", { name: /continue merge/i }));
    await waitFor(() => expect(ipcMock.continueOperation).toHaveBeenCalledWith("/repo"));
    expect(pushToast).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warning", title: "Next step has conflicts" }),
    );
  });

  it("Continue ok pushes a success toast", async () => {
    ipcMock.getGitStatus.mockResolvedValue(RESOLVED_PENDING_STATUS);
    ipcMock.continueOperation.mockResolvedValue({ kind: "ok", output: "All done." });
    render(<ChangesPanel projectPath="/repo" />);
    await userEvent.click(await screen.findByRole("button", { name: /continue merge/i }));
    await waitFor(() =>
      expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ level: "success" })),
    );
  });

  it("Continue error pushes an error toast with the output", async () => {
    ipcMock.getGitStatus.mockResolvedValue(RESOLVED_PENDING_STATUS);
    ipcMock.continueOperation.mockResolvedValue({ kind: "error", output: "fatal: oops" });
    render(<ChangesPanel projectPath="/repo" />);
    await userEvent.click(await screen.findByRole("button", { name: /continue merge/i }));
    await waitFor(() =>
      expect(pushToast).toHaveBeenCalledWith(
        expect.objectContaining({ level: "error", body: "fatal: oops" }),
      ),
    );
  });

  it("Sparkles opens the AI resolution modal for that file with the review model", async () => {
    ipcMock.getGitStatus.mockResolvedValue(CONFLICT_STATUS);
    render(<ChangesPanel projectPath="/repo" workspaceId="ws-1" />);
    await screen.findByText(/2 conflicts · merge/i);
    await userEvent.click(screen.getAllByRole("button", { name: /resolve with ai/i })[0]);
    const modal = await screen.findByTestId("conflict-ai-modal");
    expect(modal.textContent).toBe("src/a.ts:claude-sonnet-4-6");
  });

  it("Pencil routes through the panel's file-open path", async () => {
    ipcMock.getGitStatus.mockResolvedValue(CONFLICT_STATUS);
    const onFileClick = vi.fn();
    render(<ChangesPanel projectPath="/repo" onFileClick={onFileClick} />);
    await screen.findByText(/2 conflicts · merge/i);
    await userEvent.click(screen.getAllByRole("button", { name: /open in editor/i })[0]);
    expect(onFileClick).toHaveBeenCalledWith("src/a.ts");
  });
});
