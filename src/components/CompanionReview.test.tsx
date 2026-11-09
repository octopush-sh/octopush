import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { listFileEdits, getMessage, getLastCommit } = vi.hoisted(() => ({
  listFileEdits: vi.fn(),
  getMessage: vi.fn(),
  getLastCommit: vi.fn(),
}));

vi.mock("../lib/ipc", () => ({
  ipc: { listFileEdits, getMessage, getLastCommit },
}));

import { CompanionReview } from "./CompanionReview";
import type { GitStatus } from "../lib/types";

function gitStatus(over: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: "feat/x",
    changedFiles: [
      { path: "src/a.ts", status: "modified", staged: false, unstaged: true, conflicted: false },
    ],
    ahead: 0,
    behind: 0,
    hasUpstream: true,
    conflicted: 0,
    aheadBehindKnown: true,
    operation: null,
    ...over,
  } as GitStatus;
}

beforeEach(() => {
  vi.clearAllMocks();
  listFileEdits.mockResolvedValue([]);
  getLastCommit.mockResolvedValue(null);
  getMessage.mockResolvedValue(null);
});

describe("CompanionReview", () => {
  it("shows a readiness verdict that names files as its unit", () => {
    const two = gitStatus({
      changedFiles: [
        { path: "src/a.ts", status: "modified", staged: false, unstaged: true, conflicted: false },
        { path: "src/b.ts", status: "modified", staged: false, unstaged: true, conflicted: false },
      ],
    } as Partial<GitStatus>);
    const { rerender } = render(<CompanionReview workspaceId="w1" workspacePath="/repo" gitStatus={two} />);
    expect(screen.getByText("2 files to review.")).toBeInTheDocument();
    rerender(<CompanionReview workspaceId="w1" workspacePath="/repo" gitStatus={gitStatus()} />);
    expect(screen.getByText("1 file to review.")).toBeInTheDocument();
  });

  it("leaves the file count and +/− stat to the mode band's tail", () => {
    render(<CompanionReview workspaceId="w1" workspacePath="/repo" gitStatus={gitStatus()} />);
    // Only the verdict mentions the file count; no separate "1 file" meta line.
    expect(screen.getAllByText(/\b1 file\b/)).toHaveLength(1);
    expect(screen.queryByText(/^\+\d+$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^−\d+$/)).not.toBeInTheDocument();
  });

  it("shows — rather than 'Up to date' when ahead/behind is unknown", () => {
    const { rerender } = render(
      <CompanionReview workspaceId="w1" workspacePath="/repo" gitStatus={gitStatus({ aheadBehindKnown: false })} />,
    );
    expect(screen.queryByText("Up to date with origin")).not.toBeInTheDocument();
    expect(screen.getByText("—")).toHaveAttribute("title", expect.stringContaining("Ahead/behind unknown"));

    rerender(<CompanionReview workspaceId="w1" workspacePath="/repo" gitStatus={gitStatus()} />);
    expect(screen.getByText("Up to date with origin")).toBeInTheDocument();
    // Unpublished wins: there is nothing to compare with.
    rerender(
      <CompanionReview workspaceId="w1" workspacePath="/repo" gitStatus={gitStatus({ hasUpstream: false, aheadBehindKnown: false })} />,
    );
    expect(screen.getByText("Not published yet")).toBeInTheDocument();
  });

  it("flags conflicts in the verdict", () => {
    render(<CompanionReview workspaceId="w1" workspacePath="/repo" gitStatus={gitStatus({ conflicted: 2 })} />);
    expect(screen.getByText(/resolve 2 conflicts first/i)).toBeInTheDocument();
  });

  it("tells the agentic provenance story and expands a turn's message", async () => {
    listFileEdits.mockResolvedValue([
      { id: 1, workspaceId: "w1", filePath: "src/a.ts", toolName: "edit_file", messageId: 7, createdAt: new Date().toISOString() },
    ]);
    getMessage.mockResolvedValue({
      id: 7, workspaceId: "w1", role: "assistant", content: "Added const y for the demo.",
      model: "claude-sonnet-4-6", inputTokens: null, outputTokens: null, costUsd: null, createdAt: new Date().toISOString(),
    });
    render(<CompanionReview workspaceId="w1" workspacePath="/repo" gitStatus={gitStatus()} />);
    await waitFor(() => expect(screen.getByText(/shaped by/i)).toBeInTheDocument());
    expect(screen.getByText(/1 agent turn/i)).toBeInTheDocument();

    // Expanding the turn lazily fetches and shows the message.
    await userEvent.click(screen.getByRole("button", { name: /file/i }));
    await waitFor(() => expect(getMessage).toHaveBeenCalledWith(7));
    expect(await screen.findByText(/Added const y for the demo/i)).toBeInTheDocument();
  });

  it("notes hand-written changes when no agent edits are tracked", async () => {
    listFileEdits.mockResolvedValue([]);
    render(<CompanionReview workspaceId="w1" workspacePath="/repo" gitStatus={gitStatus()} />);
    await waitFor(() => expect(screen.getByText(/likely hand-written/i)).toBeInTheDocument());
  });

  it("summarises branch publish state", async () => {
    getLastCommit.mockResolvedValue({ shortSha: "abc1234", subject: "do the thing", body: "" });
    render(<CompanionReview workspaceId="w1" workspacePath="/repo" gitStatus={gitStatus({ ahead: 2 })} />);
    expect(screen.getByText(/2 ahead/i)).toBeInTheDocument();
    await waitFor(() => expect(getLastCommit).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText(/do the thing/i)).toBeInTheDocument());
  });

  it("shows 'Not published yet' without an upstream", () => {
    render(<CompanionReview workspaceId="w1" workspacePath="/repo" gitStatus={gitStatus({ hasUpstream: false })} />);
    expect(screen.getByText(/not published yet/i)).toBeInTheDocument();
  });
});
