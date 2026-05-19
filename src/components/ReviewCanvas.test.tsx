/**
 * ReviewCanvas tests
 *
 * Covers:
 *  - Renders a single-hunk diff
 *  - Accept button calls ipc.stageHunk and shows "Staged" badge
 *  - Reject removes the hunk from the list
 *  - Why? button fetches the agent message and renders its content
 *  - Editor-mode toggle renders children
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ReviewCanvas } from "./ReviewCanvas";
import { ipc } from "../lib/ipc";

// ─── Mock ipc ─────────────────────────────────────────────────────

vi.mock("../lib/ipc", () => ({
  ipc: {
    stageHunk: vi.fn(),
    revertHunk: vi.fn(),
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
  changedFiles: [{ path: "src/foo.ts", status: "modified" as const, staged: false, unstaged: true }],
  ahead: 0,
  behind: 0, hasUpstream: false,
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

// ─── Tests ─────────────────────────────────────────────────────────

beforeEach(() => {
  vi.resetAllMocks();
  mockIpc.stageHunk.mockResolvedValue(undefined);
  mockIpc.revertHunk.mockResolvedValue(undefined);
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
});

describe("ReviewCanvas", () => {
  it("renders the file path and hunk header", async () => {
    renderCanvas();
    await waitFor(() => {
      expect(screen.getByText(/src\/foo\.ts/)).toBeTruthy();
    });
    // Hunk header is now rendered as a human-readable line range
    // (e.g. "lines 1–4 → 1–5") instead of the raw @@ marker.
    expect(screen.getByText(/lines 1–4 → 1–5/)).toBeTruthy();
  });

  it("Accept button calls ipc.stageHunk and shows Staged badge", async () => {
    renderCanvas();
    // Wait for initial effects to settle
    await waitFor(() => expect(screen.queryAllByText("Accept").length).toBeGreaterThan(0), { timeout: 3000 });

    fireEvent.click(screen.getAllByText("Accept")[0]);

    await waitFor(() => {
      expect(mockIpc.stageHunk).toHaveBeenCalledTimes(1);
      expect(mockIpc.stageHunk.mock.calls[0][0]).toBe("/tmp/ws");
      // hunkText should contain the @@ header
      expect(mockIpc.stageHunk.mock.calls[0][1]).toContain("@@");
    });

    await waitFor(() => {
      expect(screen.getByText("Staged")).toBeTruthy();
    });
  });

  it("Reject removes the hunk card", async () => {
    renderCanvas();
    await waitFor(
      () => expect(screen.queryAllByText("Reject").length).toBeGreaterThan(0),
      { timeout: 3000 },
    );

    fireEvent.click(screen.getAllByText("Reject")[0]);
    await waitFor(() => expect(mockIpc.revertHunk).toHaveBeenCalledTimes(1), { timeout: 3000 });

    // After 400ms delay, the hunk card is removed
    await waitFor(() => {
      expect(screen.queryAllByText("Reject").length).toBe(0);
    }, { timeout: 2000 });
  });

  it("Why? fetches and renders the agent message", async () => {
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
    await waitFor(
      () => expect(screen.queryAllByText("Why?").length).toBeGreaterThan(0),
      { timeout: 3000 },
    );
    fireEvent.click(screen.getAllByText("Why?")[0]);

    await waitFor(() => {
      expect(mockIpc.getMessage).toHaveBeenCalledWith(42);
    }, { timeout: 3000 });

    await waitFor(() => {
      expect(screen.getByText(/I updated the constant y to 3/)).toBeTruthy();
    }, { timeout: 3000 });
  });

  it("renders children (Editor mode) when toggle is clicked", async () => {
    renderCanvas({
      children: <div data-testid="editor-content">Editor here</div>,
    });

    // The "Editor" button is in the toolbar, rendered immediately
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
    renderCanvas({ gitDiff: "", gitStatus: { branch: null, changedFiles: [], ahead: 0, behind: 0, hasUpstream: false } });
    expect(screen.getByText(/Nothing to review/)).toBeTruthy();
  });
});
