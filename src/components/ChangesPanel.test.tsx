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
    aiComplete: vi.fn(),
  },
  pushToast: vi.fn(),
}));
vi.mock("../lib/ipc", () => ({ ipc: ipcMock }));
vi.mock("./Toasts", () => ({ pushToast: (...a: unknown[]) => pushToast(...a) }));
// Stores referenced by handleCommitOrAmend — actual import paths used in ChangesPanel.tsx.
vi.mock("../stores/projectStore", () => ({ useProjectStore: { getState: () => ({ current: null }) } }));
vi.mock("../stores/workspaceStore", () => ({ useWorkspaceStore: { getState: () => ({ loadGitSummaries: vi.fn() }) } }));

import { ChangesPanel } from "./ChangesPanel";

const STATUS = {
  branch: "main", ahead: 0, behind: 0, hasUpstream: true,
  changedFiles: [
    { path: "a.ts", status: "modified", staged: true, unstaged: false },
    { path: "b.ts", status: "modified", staged: false, unstaged: true },
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
});
