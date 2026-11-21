import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { listFileEdits, getMessage, getLastCommit, secretScanStaged, secretScanBranch } = vi.hoisted(() => ({
  listFileEdits: vi.fn(),
  getMessage: vi.fn(),
  getLastCommit: vi.fn(),
  secretScanStaged: vi.fn(),
  secretScanBranch: vi.fn(),
}));

vi.mock("../lib/ipc", () => ({
  ipc: { listFileEdits, getMessage, getLastCommit, secretScanStaged, secretScanBranch },
}));

import { CompanionReview, SECRET_RESCAN_MS } from "./CompanionReview";
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
  secretScanStaged.mockResolvedValue({ findings: [], total: 0, partial: false });
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

describe("CompanionReview — secret guard verdict (#835)", () => {
  const stagedA = gitStatus({
    changedFiles: [{ path: "src/a.ts", status: "modified", staged: true, unstaged: false, conflicted: false }],
  } as Partial<GitStatus>);
  const finding = { file: "src/a.ts", line: 3, rule: "github-token", kind: "GitHub token", yours: false };

  it("names what Commit would stop for, with a jump to it", async () => {
    secretScanStaged.mockResolvedValue({ findings: [finding], total: 1, partial: false });
    const onJump = vi.fn();
    const { container } = render(
      <CompanionReview workspaceId="w1" workspacePath="/repo" gitStatus={stagedA} onJump={onJump} />,
    );
    await waitFor(() =>
      expect(container.querySelector('[data-tour="review-companion-secret"]')).toHaveTextContent(
        "possible secret · GitHub token in src/a.ts:3",
      ),
    );
    expect(secretScanStaged).toHaveBeenCalledWith("/repo");
    expect(screen.getByText("1 staged · the secret guard will ask first.")).toBeInTheDocument();
    expect(screen.queryByText(/ready to commit/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show it" }));
    expect(onJump).toHaveBeenCalledWith("src/a.ts", 3);
  });

  it("says a partial scan too, and stays quiet on a clean or unstaged change", async () => {
    secretScanStaged.mockResolvedValue({ findings: [], total: 0, partial: true });
    const { container, unmount } = render(
      <CompanionReview workspaceId="w1" workspacePath="/repo" gitStatus={stagedA} />,
    );
    await waitFor(() =>
      expect(container.querySelector('[data-tour="review-companion-secret"]')).toHaveTextContent(
        "scanned the first 16 MB; the rest wasn't checked",
      ),
    );
    unmount();

    secretScanStaged.mockClear();
    secretScanStaged.mockResolvedValue({ findings: [], total: 0, partial: false });
    const clean = render(<CompanionReview workspaceId="w1" workspacePath="/repo" gitStatus={stagedA} />);
    await waitFor(() => expect(secretScanStaged).toHaveBeenCalled());
    expect(await screen.findByText("1 staged · ready to commit.")).toBeInTheDocument();
    expect(clean.container.querySelector('[data-tour="review-companion-secret"]')).toBeNull();
    clean.unmount();

    // Nothing staged: nothing for Commit to scan, so no call.
    secretScanStaged.mockClear();
    render(<CompanionReview workspaceId="w1" workspacePath="/repo" gitStatus={gitStatus()} />);
    expect(secretScanStaged).not.toHaveBeenCalled();
  });

  it("rescans on a fresh status even when the staged set looks the same", async () => {
    // Accepting a hunk into an already-staged file keeps path/status/unstaged.
    const partlyStaged = () =>
      gitStatus({
        changedFiles: [{ path: "src/a.ts", status: "modified", staged: true, unstaged: true, conflicted: false }],
      } as Partial<GitStatus>);
    secretScanStaged.mockResolvedValueOnce({ findings: [], total: 0, partial: false });
    const { container, rerender } = render(
      <CompanionReview workspaceId="w1" workspacePath="/repo" gitStatus={partlyStaged()} />,
    );
    expect(await screen.findByText("1 staged · ready to commit.")).toBeInTheDocument();
    expect(secretScanStaged).toHaveBeenCalledTimes(1);

    secretScanStaged.mockResolvedValueOnce({ findings: [finding], total: 1, partial: false });
    rerender(<CompanionReview workspaceId="w1" workspacePath="/repo" gitStatus={partlyStaged()} />);
    await waitFor(() => expect(secretScanStaged).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("1 staged · the secret guard will ask first.")).toBeInTheDocument();
    const line = container.querySelector('[data-tour="review-companion-secret"]');
    expect(line).toHaveTextContent("possible secret · GitHub token in src/a.ts:3");
    expect(line?.querySelector("span[title]")).toHaveAttribute(
      "title",
      "Secret guard: Commit will ask before recording this",
    );

    // And back: unstaging the secret's hunk clears the rouge verdict.
    secretScanStaged.mockResolvedValueOnce({ findings: [], total: 0, partial: false });
    rerender(<CompanionReview workspaceId="w1" workspacePath="/repo" gitStatus={partlyStaged()} />);
    expect(await screen.findByText("1 staged · ready to commit.")).toBeInTheDocument();
  });

  it("drops a scan result that a newer scan has overtaken", async () => {
    let resolveOld: (v: unknown) => void = () => {};
    secretScanStaged.mockImplementationOnce(() => new Promise((r) => { resolveOld = r; }));
    secretScanStaged.mockResolvedValueOnce({ findings: [], total: 0, partial: false });
    const fresh = () =>
      gitStatus({
        changedFiles: [{ path: "src/a.ts", status: "modified", staged: true, unstaged: false, conflicted: false }],
      } as Partial<GitStatus>);
    const { rerender } = render(<CompanionReview workspaceId="w1" workspacePath="/repo" gitStatus={fresh()} />);
    await waitFor(() => expect(secretScanStaged).toHaveBeenCalledTimes(1));
    rerender(<CompanionReview workspaceId="w1" workspacePath="/repo" gitStatus={fresh()} />);
    await waitFor(() => expect(secretScanStaged).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("1 staged · ready to commit.")).toBeInTheDocument();
    resolveOld({ findings: [finding], total: 1, partial: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText("1 staged · ready to commit.")).toBeInTheDocument();
  });

  it("rescans on a heartbeat while something is staged", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<CompanionReview workspaceId="w1" workspacePath="/repo" gitStatus={stagedA} />);
      expect(await screen.findByText("1 staged · ready to commit.")).toBeInTheDocument();
      expect(secretScanStaged).toHaveBeenCalledTimes(1);
      // An agent re-added the file between polls: same status, new staged diff.
      secretScanStaged.mockResolvedValue({ findings: [finding], total: 1, partial: false });
      await vi.advanceTimersByTimeAsync(SECRET_RESCAN_MS);
      expect(await screen.findByText("1 staged · the secret guard will ask first.")).toBeInTheDocument();
      expect(secretScanStaged).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a failed scan or the guard turned off as nothing to say", async () => {
    secretScanStaged.mockResolvedValue(null);
    const { container, unmount } = render(
      <CompanionReview workspaceId="w1" workspacePath="/repo" gitStatus={stagedA} />,
    );
    await waitFor(() => expect(secretScanStaged).toHaveBeenCalled());
    expect(screen.getByText("1 staged · ready to commit.")).toBeInTheDocument();
    expect(container.querySelector('[data-tour="review-companion-secret"]')).toBeNull();
    unmount();
    secretScanStaged.mockRejectedValue(new Error("not a repo"));
    render(<CompanionReview workspaceId="w1" workspacePath="/repo" gitStatus={stagedA} />);
    await waitFor(() => expect(secretScanStaged).toHaveBeenCalledTimes(2));
    expect(screen.getByText("1 staged · ready to commit.")).toBeInTheDocument();
  });
});

describe("CompanionReview — branch secret scan (#820)", () => {
  const committed = (commits: number, mergeBase = "abc1234", head: string | null = "def5678") =>
    ({ base: "main", mergeBase, head, commits, diff: "" });
  const setCommitted = async (c: ReturnType<typeof committed> | null) => {
    const { useReviewSource } = await import("../stores/reviewSourceStore");
    useReviewSource.getState().setCommitted("w1", c);
  };

  it("scans only when asked, and lists what it found with masked previews", async () => {
    await setCommitted(committed(3));
    let resolve: (v: unknown) => void = () => {};
    secretScanBranch.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const { container } = render(<CompanionReview workspaceId="w1" workspacePath="/repo" gitStatus={gitStatus()} />);
    expect(secretScanBranch).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Scan this branch's commits" }));
    expect(secretScanBranch).toHaveBeenCalledWith("/repo", "main");
    expect(screen.getByText("Scanning 3 commits…")).toBeInTheDocument();
    resolve({
      findings: [{ file: "cfg.ts", line: 1, rule: "github-token", kind: "GitHub token", yours: false, preview: "gho_…Q2xz" }],
      total: 1,
      partial: false,
    });
    const result = await waitFor(() => {
      const el = container.querySelector('[data-tour="review-companion-scan-result"]');
      expect(el).not.toBeNull();
      return el!;
    });
    expect(result).toHaveTextContent("1 possible secret in this branch's commits.");
    expect(result).toHaveTextContent("GitHub token");
    expect(result).toHaveTextContent("cfg.ts:1");
    expect(result).toHaveTextContent("gho_…Q2xz");
    expect(result).toHaveTextContent(/rotate a real one/);
    expect(screen.getByRole("button", { name: "Scan again" })).toBeInTheDocument();
    await act(() => setCommitted(null));
  });

  it("says a clean branch is clean, a failure plainly, and drops a result once the branch moves", async () => {
    await setCommitted(committed(1));
    secretScanBranch.mockResolvedValueOnce({ findings: [], total: 0, partial: false });
    const { container } = render(<CompanionReview workspaceId="w1" workspacePath="/repo" gitStatus={gitStatus()} />);
    await userEvent.click(screen.getByRole("button", { name: "Scan this branch's commits" }));
    expect(await screen.findByText("No possible secrets in 1 commit.")).toBeInTheDocument();

    // A new commit: the old answer no longer covers the branch.
    await act(() => setCommitted(committed(2)));
    expect(container.querySelector('[data-tour="review-companion-scan-result"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Scan this branch's commits" })).toBeInTheDocument();

    secretScanBranch.mockRejectedValueOnce("secret scan: this branch shares no history with main");
    await userEvent.click(screen.getByRole("button", { name: "Scan this branch's commits" }));
    expect(await screen.findByText("Couldn't read this branch's commits.")).toBeInTheDocument();
    await act(() => setCommitted(null));
  });

  it("drops a clean result after an amend that keeps the count and merge base", async () => {
    await setCommitted(committed(3));
    secretScanBranch.mockResolvedValueOnce({ findings: [], total: 0, partial: false });
    const { container } = render(<CompanionReview workspaceId="w1" workspacePath="/repo" gitStatus={gitStatus()} />);
    await userEvent.click(screen.getByRole("button", { name: "Scan this branch's commits" }));
    expect(await screen.findByText("No possible secrets in 3 commits.")).toBeInTheDocument();

    // Same commits and merge base, new HEAD: those commits were never scanned.
    await act(() => setCommitted(committed(3, "abc1234", "9a8b7c6")));
    expect(screen.queryByText("No possible secrets in 3 commits.")).not.toBeInTheDocument();
    expect(container.querySelector('[data-tour="review-companion-scan-result"]')).toBeNull();
    expect(screen.getByRole("button", { name: "Scan this branch's commits" })).toBeInTheDocument();
    await act(() => setCommitted(null));
  });

  it("offers no scan without commits since the base", async () => {
    await setCommitted(committed(0));
    render(<CompanionReview workspaceId="w1" workspacePath="/repo" gitStatus={gitStatus()} />);
    expect(screen.queryByRole("button", { name: "Scan this branch's commits" })).not.toBeInTheDocument();
    await setCommitted(null);
  });
});

describe("CompanionReview — collision verdict (#732)", () => {
  it("adds one line naming the other workspace, with a jump to it", async () => {
    const { useCollisionStore } = await import("../stores/collisionStore");
    const { useWorkspaceStore } = await import("../stores/workspaceStore");
    const { collisionsByWorkspace } = await import("../lib/collisions");
    const select = vi.fn();
    useWorkspaceStore.setState({ select } as any);
    const { container, rerender } = render(
      <CompanionReview workspaceId="w1" workspacePath="/repo" gitStatus={gitStatus()} />,
    );
    expect(container.querySelector('[data-tour="review-companion-collision"]')).toBeNull();

    useCollisionStore.setState({
      byWorkspace: collisionsByWorkspace([
        {
          a: "w1",
          aName: "auth-flow",
          b: "w2",
          bName: "refund-webhooks",
          files: ["src/billing/limits.ts"],
          truncated: 0,
          conflictingTruncated: 0,
          conflictingFiles: ["src/billing/limits.ts"],
          severity: "conflict",
          confirmed: true,
        },
      ]),
    });
    rerender(<CompanionReview workspaceId="w1" workspacePath="/repo" gitStatus={gitStatus()} />);
    const line = container.querySelector('[data-tour="review-companion-collision"]');
    expect(line).toHaveTextContent("Will conflict with refund-webhooks in 1 file.");
    // Warn only: the commit verdict above is unchanged.
    expect(screen.getByText("1 file to review.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open refund-webhooks" }));
    expect(select).toHaveBeenCalledWith("w2");
    useCollisionStore.getState().reset();
  });
});
