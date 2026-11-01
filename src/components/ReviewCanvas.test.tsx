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
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { ReviewCanvas, REVIEWBAR_MORE_BELOW } from "./ReviewCanvas";
import { ipc } from "../lib/ipc";
import { useReviewPrefs } from "../stores/reviewPrefsStore";
import { useEditorStore } from "../stores/editorStore";
import type { OpenFile } from "../stores/editorStore";

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

  // Visual audit #358: on a narrow canvas the toolbar cut the AI button off at
  // its edge. The secondary toggles are one ladder rung (shed by the
  // `.octo-reviewbar` container query) and "More" grows in to replace them.
  it("the secondary toggles are one shed rung; AI and Accept all are the floor", () => {
    const { container } = renderCanvas();
    expect(container.querySelector("header")).toHaveClass("octo-reviewbar");
    const rung = screen.getByTestId("review-toolbar-secondary");
    expect(rung).toHaveClass("octo-demote", "octo-demote-secondary");
    for (const name of [/^inline$/i, /side.?by.?side/i, /ignore whitespace/i, /^tests$/i]) {
      expect(rung).toContainElement(screen.getByRole("button", { name }));
    }
    for (const name of [/review with ai/i, /accept all changes/i, /diff view/i]) {
      expect(rung).not.toContainElement(screen.getByRole("button", { name }));
    }
    expect(screen.getByRole("button", { name: /more view options/i }).parentElement).toHaveClass(
      "octo-demote",
      "octo-reviewbar-more",
    );
  });

  it("More holds the shed controls: layout, whitespace and tests", () => {
    renderCanvas();
    const more = screen.getByRole("button", { name: /more view options/i });
    fireEvent.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("menu", { name: /more view options/i });
    expect(menu).toHaveClass("octo-menu-enter");

    const inline = screen.getByRole("menuitemradio", { name: /inline diff/i });
    expect(inline).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: /side-by-side diff/i }));
    expect(useReviewPrefs.getState().readingMode).toBe("sbs");
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(more);
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /ignore whitespace/i }));
    expect(useReviewPrefs.getState().ignoreWhitespace).toBe(true);

    fireEvent.click(more);
    fireEvent.click(screen.getByRole("menuitem", { name: /set a test command/i }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByPlaceholderText("npm test")).toBeInTheDocument();
  });

  it("More closes on Escape and on an outside click, not on its own trigger", () => {
    renderCanvas();
    const more = screen.getByRole("button", { name: /more view options/i });
    fireEvent.click(more);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.mouseDown(more);
    fireEvent.click(more);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  // Review of #383: the toolbar's z-index escaped the canvas and competed
  // with the ContextHeader's (20), so its provenance popover painted under it.
  it("the canvas root is its own stacking context, so the toolbar's z-index stays local", () => {
    const { container } = renderCanvas();
    expect(container.firstElementChild).toHaveClass("isolate");
    expect(container.firstElementChild).toContainElement(container.querySelector("header.octo-reviewbar"));
  });

  it("More closes when the toolbar widens past the rung, since its trigger sheds", () => {
    const OriginalRO = globalThis.ResizeObserver;
    let notify: ((width: number) => void) | null = null;
    globalThis.ResizeObserver = class {
      cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) { this.cb = cb; }
      observe() {
        notify = (width) =>
          this.cb([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      renderCanvas();
      fireEvent.click(screen.getByRole("button", { name: /more view options/i }));
      act(() => notify?.(REVIEWBAR_MORE_BELOW));
      expect(screen.getByRole("menu")).toBeInTheDocument();
      act(() => notify?.(REVIEWBAR_MORE_BELOW + 1));
      expect(screen.queryByRole("menu")).toBeNull();
    } finally {
      globalThis.ResizeObserver = OriginalRO;
    }
  });

  it("More closes when the view switches to the editor", () => {
    renderCanvas();
    fireEvent.click(screen.getByRole("button", { name: /more view options/i }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /editor view/i }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("the tests popover toggles from its button without the outside-click reopening it", () => {
    renderCanvas();
    const tests = screen.getByRole("button", { name: /^tests$/i });
    fireEvent.mouseDown(tests);
    fireEvent.click(tests);
    expect(screen.getByPlaceholderText("npm test")).toBeInTheDocument();
    fireEvent.mouseDown(tests);
    fireEvent.click(tests);
    expect(screen.queryByPlaceholderText("npm test")).toBeNull();
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
      expect(screen.getByText(/isn't attributed to an agent turn/)).toBeTruthy();
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

// ─── Markdown view control ──────────────────────────────────────────

describe("ReviewCanvas — markdown view control", () => {
  const WS = "wsR";
  function seed(file: Pick<OpenFile, "path" | "lang" | "kind">) {
    const f = { content: "# D", savedContent: "# D", mtime: 0, size: 1, version: 0, diskStale: false, ...file } as OpenFile;
    useEditorStore.setState({ filesByWs: { [WS]: [f] }, activeByWs: { [WS]: f.path } });
  }
  beforeEach(() => {
    useEditorStore.setState({ filesByWs: {}, activeByWs: {} });
    useReviewPrefs.setState({ mdView: "split" });
  });

  function renderCanvas(viewMode: "diff" | "editor", active = true) {
    return render(
      <ReviewCanvas active={active} workspaceId={WS} workspacePath="/r" gitStatus={null} gitDiff="" viewMode={viewMode} onViewModeChange={() => {}}>
        <div />
      </ReviewCanvas>,
    );
  }

  const splitBtn = () => screen.queryByRole("button", { name: /markdown split view/i });

  it("shows all three layouts in editor mode for a markdown file", () => {
    seed({ path: "/r/README.md", lang: "markdown", kind: "text" });
    renderCanvas("editor");
    expect(screen.getByRole("group", { name: /markdown view/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /markdown source only/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /markdown split view/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /markdown reading view/i })).toBeInTheDocument();
  });

  it("marks the active layout with aria-pressed", () => {
    seed({ path: "/r/README.md", lang: "markdown", kind: "text" });
    useReviewPrefs.setState({ mdView: "reading" });
    renderCanvas("editor");
    expect(splitBtn()).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: /markdown reading view/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("hides the control in diff mode", () => {
    seed({ path: "/r/README.md", lang: "markdown", kind: "text" });
    renderCanvas("diff");
    expect(splitBtn()).toBeNull();
  });

  it("hides the control for a non-markdown file", () => {
    seed({ path: "/r/App.tsx", lang: "javascript", kind: "text" });
    renderCanvas("editor");
    expect(splitBtn()).toBeNull();
  });

  it("clicking a layout writes it to the pref", () => {
    seed({ path: "/r/README.md", lang: "markdown", kind: "text" });
    renderCanvas("editor");
    fireEvent.click(screen.getByRole("button", { name: /markdown reading view/i }));
    expect(useReviewPrefs.getState().mdView).toBe("reading");
    fireEvent.click(screen.getByRole("button", { name: /markdown source only/i }));
    expect(useReviewPrefs.getState().mdView).toBe("source");
  });

  // macOS turns ⌥M into "µ", so the handler keys off the physical code.
  it("⌥⌘M cycles the layout while the control is on screen", () => {
    seed({ path: "/r/README.md", lang: "markdown", kind: "text" });
    renderCanvas("editor");
    fireEvent.keyDown(window, { code: "KeyM", key: "µ", altKey: true, metaKey: true });
    expect(useReviewPrefs.getState().mdView).toBe("reading");
    fireEvent.keyDown(window, { code: "KeyM", key: "µ", altKey: true, metaKey: true });
    expect(useReviewPrefs.getState().mdView).toBe("source");
  });

  it("⌥⌘M does nothing when the control is hidden", () => {
    seed({ path: "/r/App.tsx", lang: "javascript", kind: "text" });
    renderCanvas("editor");
    fireEvent.keyDown(window, { code: "KeyM", key: "m", altKey: true, metaKey: true });
    expect(useReviewPrefs.getState().mdView).toBe("split");
  });

  it("ignores ⌘M without the Alt modifier", () => {
    seed({ path: "/r/README.md", lang: "markdown", kind: "text" });
    renderCanvas("editor");
    fireEvent.keyDown(window, { code: "KeyM", key: "m", metaKey: true });
    expect(useReviewPrefs.getState().mdView).toBe("split");
  });

  // ModeOverlay keeps its children mounted, so a window-level shortcut bound
  // here would otherwise keep firing from TALK, RUN and DIRECT.
  it("⌥⌘M does nothing while REVIEW is not the mode on screen", () => {
    seed({ path: "/r/README.md", lang: "markdown", kind: "text" });
    renderCanvas("editor", false);
    fireEvent.keyDown(window, { code: "KeyM", key: "µ", altKey: true, metaKey: true });
    expect(useReviewPrefs.getState().mdView).toBe("split");
  });

  // CodeMirror preventDefaults without stopping propagation, so a key another
  // surface already handled must not be handled a second time here.
  it("ignores a ⌥⌘M that another handler already consumed", () => {
    seed({ path: "/r/README.md", lang: "markdown", kind: "text" });
    renderCanvas("editor");
    const e = new KeyboardEvent("keydown", {
      code: "KeyM", key: "µ", altKey: true, metaKey: true, cancelable: true, bubbles: true,
    });
    e.preventDefault();
    window.dispatchEvent(e);
    expect(useReviewPrefs.getState().mdView).toBe("split");
  });
});
