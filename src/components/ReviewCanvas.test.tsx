/**
 * ReviewCanvas tests (G3 integration)
 *
 * Covers:
 *  - Inline/Split + whitespace toolbar toggles drive the prefs store
 *  - Accept (hunk) calls ipc.stageHunk
 *  - Reject (hunk) calls ipc.revertHunk and shows the undo bar; Undo applies
 *  - Why? opens the agent-origin drawer and renders the linked message
 *  - Editor-mode toggle renders children
 *  - Accept-all calls ipc.stageAllChanges
 *  - Empty diff shows the empty state
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ReviewCanvas } from "./ReviewCanvas";
import { ipc } from "../lib/ipc";
import { useReviewPrefs } from "../stores/reviewPrefsStore";

// ─── Mock ipc ─────────────────────────────────────────────────────

vi.mock("../lib/ipc", () => ({
  ipc: {
    stageHunk: vi.fn(),
    revertHunk: vi.fn(),
    applyHunk: vi.fn(),
    stageAllChanges: vi.fn(),
    listFileEdits: vi.fn(),
    getMessage: vi.fn(),
    runTestCommand: vi.fn(),
    setWorkspaceTestCommand: vi.fn(),
    detectDefaultTestCommand: vi.fn(),
    getGitStatus: vi.fn(),
    getGitDiff: vi.fn(),
  },
}));

// Use unknown cast to avoid overlap error from partial mock typing.
const mockIpc = ipc as unknown as {
  stageHunk: MockedFunction<typeof ipc.stageHunk>;
  revertHunk: MockedFunction<typeof ipc.revertHunk>;
  applyHunk: MockedFunction<typeof ipc.applyHunk>;
  stageAllChanges: MockedFunction<typeof ipc.stageAllChanges>;
  listFileEdits: MockedFunction<typeof ipc.listFileEdits>;
  getMessage: MockedFunction<typeof ipc.getMessage>;
  runTestCommand: MockedFunction<typeof ipc.runTestCommand>;
  setWorkspaceTestCommand: MockedFunction<typeof ipc.setWorkspaceTestCommand>;
  detectDefaultTestCommand: MockedFunction<typeof ipc.detectDefaultTestCommand>;
};

// ─── Helpers ──────────────────────────────────────────────────────

const SAMPLE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index abc1234..def5678 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,4 +1,5 @@
 const x = 1;
-const y = 2;
+const y = 3;
+const z = 4;
 export { x, y };
`;

const SAMPLE_GIT_STATUS = {
  branch: "feat/test",
  changedFiles: [{ path: "src/foo.ts", status: "modified" as const, staged: false, unstaged: true, conflicted: false }],
  ahead: 0,
  behind: 0,
  hasUpstream: false,
  conflicted: 0,
  aheadBehindKnown: true,
  operation: null,
};

function renderCanvas(overrides?: Partial<Parameters<typeof ReviewCanvas>[0]>) {
  return render(
    <ReviewCanvas
      workspaceId="ws-1"
      workspacePath="/tmp/ws"
      gitStatus={SAMPLE_GIT_STATUS}
      gitDiff={SAMPLE_DIFF}
      {...overrides}
    />,
  );
}

// ─── Setup ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.resetAllMocks();
  mockIpc.stageHunk.mockResolvedValue(undefined);
  mockIpc.revertHunk.mockResolvedValue(undefined);
  mockIpc.applyHunk.mockResolvedValue(undefined);
  mockIpc.stageAllChanges.mockResolvedValue(undefined);
  mockIpc.listFileEdits.mockResolvedValue([]);
  mockIpc.getMessage.mockResolvedValue({
    id: 42,
    workspaceId: "ws-1",
    role: "assistant",
    content: "I updated the constant y to 3 and added z.",
    model: "claude-sonnet-4-6",
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    createdAt: new Date().toISOString(),
  });
  mockIpc.detectDefaultTestCommand.mockResolvedValue(null);
  useReviewPrefs.setState({ readingMode: "inline", ignoreWhitespace: false });
});

// ─── Toolbar toggles ───────────────────────────────────────────────

describe("ReviewCanvas toolbar", () => {
  it("Split toggle sets the store", () => {
    renderCanvas();
    fireEvent.click(screen.getByRole("button", { name: /split|side.?by.?side/i }));
    expect(useReviewPrefs.getState().readingMode).toBe("sbs");
  });

  it("Inline toggle sets the store back", () => {
    useReviewPrefs.setState({ readingMode: "sbs" });
    renderCanvas();
    fireEvent.click(screen.getByRole("button", { name: /^inline$/i }));
    expect(useReviewPrefs.getState().readingMode).toBe("inline");
  });

  it("whitespace toggle sets the store", () => {
    renderCanvas();
    fireEvent.click(screen.getByRole("button", { name: /ignore whitespace/i }));
    expect(useReviewPrefs.getState().ignoreWhitespace).toBe(true);
  });
});

// ─── Hunk actions ──────────────────────────────────────────────────

describe("ReviewCanvas hunk actions", () => {
  it("renders the file path", async () => {
    renderCanvas();
    await waitFor(() => {
      expect(screen.getByText(/src\/foo\.ts/)).toBeTruthy();
    });
  });

  it("Accept calls ipc.stageHunk with the hunk raw text", async () => {
    renderCanvas();
    const acceptBtn = await waitFor(
      () => screen.getByRole("button", { name: /accept hunk/i }),
      { timeout: 3000 },
    );
    fireEvent.click(acceptBtn);
    await waitFor(() => {
      expect(mockIpc.stageHunk).toHaveBeenCalledTimes(1);
      expect(mockIpc.stageHunk.mock.calls[0][0]).toBe("/tmp/ws");
      expect(mockIpc.stageHunk.mock.calls[0][1]).toContain("@@");
    });
  });

  it("Reject calls ipc.revertHunk and shows the undo bar; Undo applies the hunk", async () => {
    renderCanvas();
    const rejectBtn = await waitFor(
      () => screen.getByRole("button", { name: /reject hunk/i }),
      { timeout: 3000 },
    );
    fireEvent.click(rejectBtn);
    await waitFor(() => expect(mockIpc.revertHunk).toHaveBeenCalledTimes(1));

    // Undo bar appears
    const undoBtn = await waitFor(() => screen.getByText("Undo"), { timeout: 3000 });
    fireEvent.click(undoBtn);
    await waitFor(() => {
      expect(mockIpc.applyHunk).toHaveBeenCalledTimes(1);
      expect(mockIpc.applyHunk.mock.calls[0][1]).toContain("@@");
    });
  });
});

// ─── Why? drawer ───────────────────────────────────────────────────

describe("ReviewCanvas Why? drawer", () => {
  it("opens the agent-origin drawer and renders the linked message", async () => {
    mockIpc.listFileEdits.mockResolvedValue([
      {
        id: 1,
        workspaceId: "ws-1",
        filePath: "src/foo.ts",
        toolName: "write_file",
        messageId: 42,
        createdAt: new Date().toISOString(),
      },
    ]);

    renderCanvas();
    const whyBtn = await waitFor(
      () => screen.getByRole("button", { name: /why this change/i }),
      { timeout: 3000 },
    );
    fireEvent.click(whyBtn);

    await waitFor(() => expect(mockIpc.getMessage).toHaveBeenCalledWith(42), {
      timeout: 3000,
    });
    await waitFor(() => {
      expect(screen.getByText(/I updated the constant y to 3/)).toBeTruthy();
    }, { timeout: 3000 });
  });

  it("shows the not-linked message when no edit matches", async () => {
    renderCanvas();
    const whyBtn = await waitFor(
      () => screen.getByRole("button", { name: /why this change/i }),
      { timeout: 3000 },
    );
    fireEvent.click(whyBtn);
    await waitFor(() => {
      expect(screen.getByText(/isn't linked to an agent turn/)).toBeTruthy();
    });
  });
});

// ─── View mode + accept-all + empty ────────────────────────────────

describe("ReviewCanvas misc", () => {
  it("renders children (Editor mode) when toggle is clicked", async () => {
    renderCanvas({
      children: <div data-testid="editor-content">Editor here</div>,
    });
    const editorBtn = await waitFor(() => screen.getByText("Editor"), { timeout: 3000 });
    fireEvent.click(editorBtn);
    await waitFor(() => {
      expect(screen.getByTestId("editor-content")).toBeTruthy();
    }, { timeout: 3000 });
  });

  it("Accept all button calls ipc.stageAllChanges", async () => {
    const onDiffChange = vi.fn();
    renderCanvas({ onDiffChange });
    await waitFor(() => screen.getByText("Accept all"), { timeout: 3000 });
    fireEvent.click(screen.getByText("Accept all"));
    await waitFor(() => {
      expect(mockIpc.stageAllChanges).toHaveBeenCalledWith("/tmp/ws");
      expect(onDiffChange).toHaveBeenCalled();
    });
  });

  it("shows empty state when diff is empty", () => {
    renderCanvas({
      gitDiff: "",
      gitStatus: { branch: null, changedFiles: [], ahead: 0, behind: 0, hasUpstream: false, conflicted: 0, aheadBehindKnown: true, operation: null },
    });
    expect(screen.getByText(/Nothing to review/)).toBeTruthy();
  });
});
