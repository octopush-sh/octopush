import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Shared ref so tests can reach the live EditorView mock instance.
const hoisted = vi.hoisted(() => ({ lastView: null as unknown as { setState: ReturnType<typeof vi.fn> } | null }));

// ─── Mock CodeMirror (JSDOM can't run it) ─────────────────────────
vi.mock("@codemirror/view", () => {
  class EditorViewMock {
    dom = document.createElement("div");
    state = { doc: { toString: () => "" }, selection: { main: { head: 0 } } };
    destroy = vi.fn();
    dispatch = vi.fn();
    setState = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_config: any) { hoisted.lastView = this; }
    static updateListener = { of: vi.fn(() => ({})) };
    static theme = vi.fn(() => ({}));
    static lineWrapping = {};
  }
  return {
    EditorView: EditorViewMock,
    lineNumbers: vi.fn(() => ({})),
    highlightActiveLineGutter: vi.fn(() => ({})),
    highlightActiveLine: vi.fn(() => ({})),
    drawSelection: vi.fn(() => ({})),
    rectangularSelection: vi.fn(() => ({})),
    crosshairCursor: vi.fn(() => ({})),
    keymap: { of: vi.fn(() => ({})) },
  };
});

vi.mock("@codemirror/state", () => {
  class CompartmentMock {
    of = vi.fn(() => ({}));
    reconfigure = vi.fn(() => ({}));
  }
  return {
    EditorState: {
      create: vi.fn().mockReturnValue({ doc: { toString: () => "" } }),
      tabSize: { of: vi.fn(() => ({})) },
    },
    Compartment: CompartmentMock,
    EditorSelection: { range: vi.fn(() => ({})), create: vi.fn(() => ({})) },
  };
});

vi.mock("@codemirror/search", () => ({
  search: vi.fn(() => ({})),
  searchKeymap: [],
  gotoLine: vi.fn(() => true),
}));

vi.mock("@codemirror/commands", () => ({
  defaultKeymap: [],
  indentWithTab: {},
  history: vi.fn(() => ({})),
  historyKeymap: [],
}));

vi.mock("@codemirror/language", () => ({
  indentOnInput: vi.fn(() => ({})),
  bracketMatching: vi.fn(() => ({})),
  foldGutter: vi.fn(() => ({})),
  indentUnit: { of: vi.fn(() => ({})) },
}));

vi.mock("./editor/multiCursor", () => ({
  selectAllOccurrences: vi.fn(() => true),
}));

vi.mock("../stores/editorPrefsStore", () => ({
  useEditorPrefs: vi.fn((selector: (s: unknown) => unknown) =>
    selector({ wrap: false, fontSize: 13, tabWidth: 2, lineNumbers: true }),
  ),
}));

vi.mock("./EditorStatusBar", () => ({
  EditorStatusBar: () => <div data-testid="status-bar" />,
}));

vi.mock("./EditorBinaryPane", () => ({
  EditorBinaryPane: () => <div data-testid="binary-pane" />,
}));

vi.mock("@codemirror/lang-javascript", () => ({
  javascript: vi.fn(() => ({})),
}));

vi.mock("../components/editor/atelierTheme", () => ({
  atelierTheme: [],
}));

vi.mock("../components/editor/diffGutter", () => ({
  diffGutter: vi.fn(() => ({})),
}));

vi.mock("../lib/diffParser", () => ({
  parseDiffForFile: vi.fn(() => []),
}));

// ─── Mock ConfirmDialog (ModalShell won't animate in JSDOM) ───────
vi.mock("./ConfirmDialog", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ConfirmDialog: (p: any) => (
    <div data-testid="confirm-dialog">
      <span data-testid="confirm-title">{p.title}</span>
      <button onClick={() => p.onConfirm()}>{p.destructiveLabel}</button>
      {p.secondaryLabel && (
        <button onClick={() => p.onSecondary?.()}>{p.secondaryLabel}</button>
      )}
      {/* Escape in the real dialog (ModalShell) maps to onCancel. */}
      <button onClick={() => p.onCancel()}>{p.cancelLabel}</button>
    </div>
  ),
}));

// ─── Mock editorStore ─────────────────────────────────────────────

const mockSaveActive = vi.fn().mockResolvedValue(undefined);
const mockCloseFile = vi.fn();
const mockReloadFromDisk = vi.fn().mockResolvedValue(true);
const mockCheckActiveAgainstDisk = vi.fn().mockResolvedValue(undefined);
const mockClearSaveConflict = vi.fn();

const mockStore = {
  saveConflict: null as
    | { workspaceId: string; path: string; kind: "changed" | "deleted" }
    | null,
};

vi.mock("../stores/editorStore", () => ({
  useEditorStore: vi.fn((selector: (s: unknown) => unknown) => {
    const state = {
      getActivePath: (wsId: string) =>
        wsId === "ws-active" ? "/repo/file.ts" : wsId === "ws-binary" ? "/repo/app.war" : null,
      getFiles: (wsId: string) =>
        wsId === "ws-active"
          ? [{ path: "/repo/file.ts", content: "hello", savedContent: "hello", lang: "javascript", kind: "text", mtime: 0, size: 5, version: 0, diskStale: false }]
          : wsId === "ws-binary"
          ? [{ path: "/repo/app.war", content: "", savedContent: "", lang: "plaintext", kind: "binary", binaryReason: "binary", mtime: 0, size: 2048, version: 0, diskStale: false }]
          : [],
      setContent: vi.fn(),
      saveActive: mockSaveActive,
      closeFile: mockCloseFile,
      reloadFromDisk: mockReloadFromDisk,
      checkActiveAgainstDisk: mockCheckActiveAgainstDisk,
      saveConflict: mockStore.saveConflict,
      clearSaveConflict: mockClearSaveConflict,
    };
    return selector(state);
  }),
}));

import { EditorPane } from "./EditorPane";

beforeEach(() => {
  vi.clearAllMocks();
  mockSaveActive.mockResolvedValue(undefined);
  mockReloadFromDisk.mockResolvedValue(true);
  mockCheckActiveAgainstDisk.mockResolvedValue(undefined);
  mockStore.saveConflict = null;
});

describe("EditorPane", () => {
  it("shows empty state when no file is active", () => {
    render(
      <EditorPane
        workspaceId="ws-no-active"
        workspacePath="/repo"
        diffText=""
      />,
    );
    expect(
      screen.getByText("Select a file from the tree to begin."),
    ).toBeInTheDocument();
  });

  it("renders editor-host div when a file is active", () => {
    render(
      <EditorPane
        workspaceId="ws-active"
        workspacePath="/repo"
        diffText=""
      />,
    );
    expect(screen.getByTestId("editor-host")).toBeInTheDocument();
  });

  it("renders the binary pane (not the status bar) for a binary file", () => {
    render(<EditorPane workspaceId="ws-binary" workspacePath="/repo" diffText="" />);
    expect(screen.getByTestId("binary-pane")).toBeInTheDocument();
    expect(screen.queryByTestId("status-bar")).not.toBeInTheDocument();
  });

  it("clears the editor view when the last tab closes (no stale content behind overlay)", () => {
    // Start with an active file, then re-render with no active file —
    // the same persistent view must be cleared so the previous file's
    // content does not linger behind the empty-state overlay.
    const { rerender } = render(
      <EditorPane workspaceId="ws-active" workspacePath="/repo" diffText="" />,
    );
    const view = hoisted.lastView!;
    expect(view).toBeTruthy();
    const callsBefore = view.setState.mock.calls.length;

    rerender(
      <EditorPane workspaceId="ws-no-active" workspacePath="/repo" diffText="" />,
    );

    expect(
      screen.getByText("Select a file from the tree to begin."),
    ).toBeInTheDocument();
    // The swap effect cleared the view (an extra setState after the close).
    expect(view.setState.mock.calls.length).toBeGreaterThan(callsBefore);
  });
});

describe("EditorPane — save-conflict dialog", () => {
  it("renders nothing when there is no conflict", () => {
    render(<EditorPane workspaceId="ws-active" workspacePath="/repo" diffText="" />);
    expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument();
  });

  it("ignores a conflict that belongs to another workspace", () => {
    mockStore.saveConflict = { workspaceId: "ws-other", path: "/repo/file.ts", kind: "changed" };
    render(<EditorPane workspaceId="ws-active" workspacePath="/repo" diffText="" />);
    expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument();
  });

  it("changed conflict: Overwrite force-saves; Reload from disk (secondary) reloads", () => {
    mockStore.saveConflict = { workspaceId: "ws-active", path: "/repo/file.ts", kind: "changed" };
    render(<EditorPane workspaceId="ws-active" workspacePath="/repo" diffText="" />);
    expect(screen.getByTestId("confirm-title")).toHaveTextContent("File changed on disk");

    fireEvent.click(screen.getByText("Overwrite"));
    expect(mockClearSaveConflict).toHaveBeenCalled();
    expect(mockSaveActive).toHaveBeenCalledWith("ws-active", { force: true });

    fireEvent.click(screen.getByText("Reload from disk"));
    expect(mockClearSaveConflict).toHaveBeenCalledTimes(2);
    expect(mockReloadFromDisk).toHaveBeenCalledWith("ws-active", "/repo/file.ts");
    expect(mockCloseFile).not.toHaveBeenCalled();
  });

  it("changed conflict: Keep editing (cancel / Escape path) only clears the conflict — nothing destructive", () => {
    mockStore.saveConflict = { workspaceId: "ws-active", path: "/repo/file.ts", kind: "changed" };
    render(<EditorPane workspaceId="ws-active" workspacePath="/repo" diffText="" />);

    fireEvent.click(screen.getByText("Keep editing"));
    expect(mockClearSaveConflict).toHaveBeenCalledTimes(1);
    expect(mockSaveActive).not.toHaveBeenCalled();
    expect(mockReloadFromDisk).not.toHaveBeenCalled();
    expect(mockCloseFile).not.toHaveBeenCalled();
  });

  it("deleted conflict: Save anyway force-saves; Close tab (secondary) closes the file", () => {
    mockStore.saveConflict = { workspaceId: "ws-active", path: "/repo/file.ts", kind: "deleted" };
    render(<EditorPane workspaceId="ws-active" workspacePath="/repo" diffText="" />);
    expect(screen.getByTestId("confirm-title")).toHaveTextContent("File deleted on disk");

    fireEvent.click(screen.getByText("Save anyway"));
    expect(mockSaveActive).toHaveBeenCalledWith("ws-active", { force: true });

    fireEvent.click(screen.getByText("Close tab"));
    expect(mockCloseFile).toHaveBeenCalledWith("ws-active", "/repo/file.ts");
    expect(mockReloadFromDisk).not.toHaveBeenCalled();
  });

  it("deleted conflict: Keep editing (cancel / Escape path) only clears the conflict — nothing destructive", () => {
    mockStore.saveConflict = { workspaceId: "ws-active", path: "/repo/file.ts", kind: "deleted" };
    render(<EditorPane workspaceId="ws-active" workspacePath="/repo" diffText="" />);

    fireEvent.click(screen.getByText("Keep editing"));
    expect(mockClearSaveConflict).toHaveBeenCalledTimes(1);
    expect(mockSaveActive).not.toHaveBeenCalled();
    expect(mockReloadFromDisk).not.toHaveBeenCalled();
    expect(mockCloseFile).not.toHaveBeenCalled();
  });
});

describe("EditorPane — focus / visibility disk check", () => {
  it("checks the active buffer against the disk when the window regains focus", () => {
    render(<EditorPane workspaceId="ws-active" workspacePath="/repo" diffText="" />);
    expect(mockCheckActiveAgainstDisk).not.toHaveBeenCalled();
    fireEvent(window, new Event("focus"));
    expect(mockCheckActiveAgainstDisk).toHaveBeenCalledWith("ws-active");
  });

  it("stops listening after unmount", () => {
    const { unmount } = render(
      <EditorPane workspaceId="ws-active" workspacePath="/repo" diffText="" />,
    );
    unmount();
    fireEvent(window, new Event("focus"));
    expect(mockCheckActiveAgainstDisk).not.toHaveBeenCalled();
  });
});
