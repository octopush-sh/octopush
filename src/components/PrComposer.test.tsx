/** PrComposer — readiness dead ends, draft states, create (push first), errors, Escape. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Workspace } from "../lib/types";

const ipcMock = {
  githubShipReadiness: vi.fn(),
  listBranches: vi.fn(),
  getGitStatus: vi.fn(),
  prDraftContext: vi.fn(),
  listFileEdits: vi.fn(),
  getMessage: vi.fn(),
  aiComplete: vi.fn(),
  pushBranch: vi.fn(),
  createPullRequest: vi.fn(),
  openFileInSystem: vi.fn(),
};
vi.mock("../lib/ipc", () => ({ ipc: ipcMock }));
const pushToast = vi.fn();
vi.mock("./Toasts", () => ({ pushToast }));

const { PrComposer } = await import("./PrComposer");
const { usePrStore } = await import("../stores/prStore");

const WS: Workspace = {
  id: "ws-1",
  projectId: "p",
  name: "csv",
  task: "Export CSV",
  branch: "feat/csv",
  worktreePath: "/w",
  setupScript: "",
  status: "active",
  createdAt: "",
  lastActive: "",
  glyph: null,
  tint: null,
  linkedIssueKey: "42",
  fromBranch: "main",
};

const status = (over: Partial<{ hasUpstream: boolean; ahead: number }> = {}) => ({
  branch: "feat/csv",
  changedFiles: [],
  ahead: 0,
  behind: 0,
  hasUpstream: true,
  conflicted: 0,
  aheadBehindKnown: true,
  ...over,
});

function ready() {
  ipcMock.githubShipReadiness.mockResolvedValue({ githubRemote: true, ghAuthenticated: true });
  ipcMock.listBranches.mockResolvedValue({ local: ["main", "feat/csv"], remote: ["origin/main"] });
  ipcMock.getGitStatus.mockResolvedValue(status());
  ipcMock.prDraftContext.mockResolvedValue({
    branch: "feat/csv",
    diff: "diff --git a/src/a.ts b/src/a.ts\n+x\n",
    commits: ["Add CSV export"],
    template: "## Summary\n\n## Checklist",
  });
  ipcMock.listFileEdits.mockResolvedValue([
    { id: 1, workspaceId: "ws-1", filePath: "src/a.ts", toolName: "Edit", messageId: 9, createdAt: "2026-11-01T10:00:00Z" },
  ]);
  ipcMock.getMessage.mockResolvedValue({ model: "claude-opus-4-1" });
  ipcMock.aiComplete.mockResolvedValue({ text: "Add CSV export\n\n## Summary\nExports.", inputTokens: 1, outputTokens: 1, costUsd: 0.02 });
}

const renderComposer = (onClose = vi.fn()) =>
  render(<PrComposer workspace={WS} workspacePath="/w" onClose={onClose} />);

beforeEach(() => {
  Object.values(ipcMock).forEach((m) => m.mockReset());
  pushToast.mockReset();
  usePrStore.setState({ byWorkspace: {}, composerFor: null });
});

describe("PrComposer", () => {
  it("no GitHub remote → honest dead end, nothing drafted", async () => {
    ipcMock.githubShipReadiness.mockResolvedValue({ githubRemote: false, ghAuthenticated: false });
    renderComposer();
    expect(await screen.findByText(/no GitHub remote/)).toBeTruthy();
    expect(ipcMock.aiComplete).not.toHaveBeenCalled();
    expect(document.querySelector('[data-tour="pr-composer-create"]')).toBeNull();
  });

  it("gh missing or signed out → points at gh auth login", async () => {
    ipcMock.githubShipReadiness.mockResolvedValue({ githubRemote: true, ghAuthenticated: false });
    renderComposer();
    expect(await screen.findByText(/gh auth login/)).toBeTruthy();
    expect(ipcMock.prDraftContext).not.toHaveBeenCalled();
  });

  it("drafts from the diff, template, ticket and provenance into editable fields", async () => {
    ready();
    renderComposer();
    await waitFor(() =>
      expect((screen.getByLabelText("Pull request title") as HTMLInputElement).value).toBe("Add CSV export"),
    );
    expect(ipcMock.prDraftContext).toHaveBeenCalledWith("/w", "main");
    const prompt = ipcMock.aiComplete.mock.calls[0][2] as string;
    expect(prompt).toContain("## Checklist");
    expect(prompt).toContain("claude-opus-4-1: a.ts");
    expect(prompt).toContain("Linked ticket: 42");
    const body = screen.getByLabelText("Pull request description") as HTMLTextAreaElement;
    expect(body.value).toBe("Closes #42\n\n## Summary\nExports.");
    expect(screen.getByText(/from the repo's template · \$0\.02/)).toBeTruthy();
    fireEvent.change(body, { target: { value: "edited" } });
    expect(body.value).toBe("edited");
  });

  it("a failed draft keeps the form usable and says why", async () => {
    ready();
    ipcMock.aiComplete.mockRejectedValue("budget exceeded");
    renderComposer();
    expect(await screen.findByText(/Couldn't draft: budget exceeded/)).toBeTruthy();
    expect((screen.getByLabelText("Pull request title") as HTMLInputElement).value).toBe("Export CSV");
    expect(screen.getByRole("button", { name: "Open the pull request" })).not.toBeDisabled();
  });

  it("pushes unpublished commits first, creates a draft PR and updates the chip store", async () => {
    ready();
    ipcMock.getGitStatus.mockResolvedValue(status({ ahead: 2 }));
    ipcMock.pushBranch.mockResolvedValue("ok");
    const pr = { number: 7, title: "Add CSV export", url: "https://github.com/o/r/pull/7", isDraft: true, state: "draft" };
    ipcMock.createPullRequest.mockResolvedValue(pr);
    const onClose = vi.fn();
    renderComposer(onClose);
    expect(await screen.findByText(/pushed first/)).toBeTruthy();
    await waitFor(() => expect(ipcMock.aiComplete).toHaveBeenCalled());
    await screen.findByDisplayValue("Add CSV export");
    fireEvent.click(screen.getByLabelText("Open as a draft"));
    fireEvent.click(screen.getByRole("button", { name: "Open the draft pull request" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(ipcMock.pushBranch).toHaveBeenCalledWith("/w");
    expect(ipcMock.pushBranch.mock.invocationCallOrder[0]).toBeLessThan(
      ipcMock.createPullRequest.mock.invocationCallOrder[0],
    );
    expect(ipcMock.createPullRequest).toHaveBeenCalledWith("/w", "main", "Add CSV export", "Closes #42\n\n## Summary\nExports.", true);
    expect(usePrStore.getState().byWorkspace["ws-1"]).toEqual(pr);
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Pull request #7 opened" }));
  });

  it("shows a create failure inline and stays open", async () => {
    ready();
    ipcMock.createPullRequest.mockRejectedValue("gh pr create failed: a pull request already exists");
    const onClose = vi.fn();
    renderComposer(onClose);
    await screen.findByDisplayValue("Add CSV export");
    fireEvent.click(screen.getByRole("button", { name: "Open the pull request" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/already exists/);
    expect(onClose).not.toHaveBeenCalled();
    expect(ipcMock.pushBranch).not.toHaveBeenCalled();
  });

  it("Escape closes", async () => {
    ipcMock.githubShipReadiness.mockResolvedValue({ githubRemote: false, ghAuthenticated: false });
    const onClose = vi.fn();
    renderComposer(onClose);
    await screen.findByText(/no GitHub remote/);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
