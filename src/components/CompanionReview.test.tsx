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

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1,2 @@
 const x = 1;
+const y = 2;
`;

beforeEach(() => {
  vi.clearAllMocks();
  listFileEdits.mockResolvedValue([]);
  getLastCommit.mockResolvedValue(null);
  getMessage.mockResolvedValue(null);
});

describe("CompanionReview", () => {
  it("shows a readiness verdict and scope", async () => {
    render(<CompanionReview workspaceId="w1" workspacePath="/repo" gitStatus={gitStatus()} gitDiff={DIFF} />);
    expect(screen.getByText(/1 change to review/i)).toBeInTheDocument();
    expect(screen.getByText(/1 file/i)).toBeInTheDocument();
  });

  it("flags conflicts in the verdict", () => {
    render(<CompanionReview workspaceId="w1" workspacePath="/repo" gitStatus={gitStatus({ conflicted: 2 })} gitDiff={DIFF} />);
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
    render(<CompanionReview workspaceId="w1" workspacePath="/repo" gitStatus={gitStatus()} gitDiff={DIFF} />);
    await waitFor(() => expect(screen.getByText(/shaped by/i)).toBeInTheDocument());
    expect(screen.getByText(/1 agent turn/i)).toBeInTheDocument();

    // Expanding the turn lazily fetches and shows the message.
    await userEvent.click(screen.getByRole("button", { name: /file/i }));
    await waitFor(() => expect(getMessage).toHaveBeenCalledWith(7));
    expect(await screen.findByText(/Added const y for the demo/i)).toBeInTheDocument();
  });

  it("notes hand-written changes when no agent edits are tracked", async () => {
    listFileEdits.mockResolvedValue([]);
    render(<CompanionReview workspaceId="w1" workspacePath="/repo" gitStatus={gitStatus()} gitDiff={DIFF} />);
    await waitFor(() => expect(screen.getByText(/likely hand-written/i)).toBeInTheDocument());
  });

  it("summarises branch publish state", async () => {
    getLastCommit.mockResolvedValue({ shortSha: "abc1234", subject: "do the thing", body: "" });
    render(<CompanionReview workspaceId="w1" workspacePath="/repo" gitStatus={gitStatus({ ahead: 2 })} gitDiff={DIFF} />);
    expect(screen.getByText(/2 ahead/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/do the thing/i)).toBeInTheDocument());
  });

  it("shows 'Not published yet' without an upstream", () => {
    render(<CompanionReview workspaceId="w1" workspacePath="/repo" gitStatus={gitStatus({ hasUpstream: false })} gitDiff={DIFF} />);
    expect(screen.getByText(/not published yet/i)).toBeInTheDocument();
  });
});
