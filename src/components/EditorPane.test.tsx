import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Shared ref so tests can reach the live EditorView mock instance.
const hoisted = vi.hoisted(() => ({ lastView: null as unknown as { setState: ReturnType<typeof vi.fn> } | null }));

// ─── Mock CodeMirror (JSDOM can't run it) ─────────────────────────
vi.mock("@codemirror/view", () => {
  class EditorViewMock {
    dom = document.createElement("div");
    state = {
      doc: {
        toString: () => "",
        lines: 100,
        line: (n: number) => ({ from: n * 10 }),
      },
      selection: { main: { head: 0 } },
    };
    destroy = vi.fn();
    dispatch = vi.fn();
    setState = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_config: any) { hoisted.lastView = this; }
    static updateListener = { of: vi.fn(() => ({})) };
    static theme = vi.fn(() => ({}));
    static lineWrapping = {};
    static scrollIntoView = vi.fn((pos: number, opts: unknown) => ({ pos, opts }));
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
  setSearchQuery: { of: vi.fn(() => ({})) },
  SearchQuery: class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_opts: any) {}
  },
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
  buildEditorTheme: () => [],
}));

// The find overlay drives CodeMirror's search commands; stub them since the
// overlay isn't opened in these structural tests.
vi.mock("./editor/EditorSearch", () => ({
  EditorSearch: () => null,
}));

vi.mock("../components/editor/diffGutter", () => ({
  diffGutter: vi.fn(() => ({})),
}));

const { blameGutterMock } = vi.hoisted(() => ({
  blameGutterMock: vi.fn(() => ({ blame: true })),
}));
vi.mock("./editor/blameGutter", () => ({ blameGutter: blameGutterMock }));
// Builds its decorations at import time, so it needs the real @codemirror/view
// which this file replaces with a stub. Behaviour is covered by
// searchHighlight.test.ts; the marker object lets us assert it stays wired in.
vi.mock("./editor/searchHighlight", () => ({
  searchMatchHighlight: { __searchMatchHighlight: true },
}));
// Same story for the symbol layer: both build decorations at import time
// against the real @codemirror/view this file stubs out. Behaviour is covered
// by symbolIndex.test.ts / definitionSearch.test.ts; the markers let us assert
// they stay wired into the editor's extensions.
const { searchWorkspaceTextMock, pushToastMock, mockOpenFile } = vi.hoisted(() => ({
  searchWorkspaceTextMock: vi.fn(),
  pushToastMock: vi.fn(),
  mockOpenFile: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/ipc", () => ({
  ipc: { searchWorkspaceText: searchWorkspaceTextMock },
}));
vi.mock("./Toasts", () => ({ pushToast: pushToastMock }));

vi.mock("./editor/symbolHighlight", () => ({
  symbolOccurrenceHighlight: { __symbolOccurrenceHighlight: true },
}));
type NavRequest = { name: string; from: number; to: number };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NavHandler = (req: NavRequest, view: any) => void;
const { symbolNavMock } = vi.hoisted(() => ({
  symbolNavMock: vi.fn((_onRequest: unknown) => ({ __symbolNav: true })),
}));
vi.mock("./editor/symbolNav", () => ({
  symbolNav: symbolNavMock,
  goToDefinitionCommand: vi.fn(() => () => true),
}));

// Controllable blame store — EditorPane reads enabled/linesByPath via
// selector and calls getState().load() to fetch.
const mockBlameLoad = vi.fn().mockResolvedValue(undefined);
const mockBlameState = {
  enabled: false,
  linesByPath: {} as Record<string, unknown>,
  errorByPath: {} as Record<string, string>,
  load: mockBlameLoad,
  toggle: vi.fn(),
  invalidate: vi.fn(),
};
vi.mock("../stores/blameStore", () => ({
  useBlameStore: Object.assign(
    vi.fn((selector: (s: unknown) => unknown) => selector(mockBlameState)),
    { getState: () => mockBlameState },
  ),
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

const mockClearPendingReveal = vi.fn();

const mockStore = {
  saveConflict: null as
    | { workspaceId: string; path: string; kind: "changed" | "deleted" }
    | null,
  pendingReveal: null as { path: string; line: number } | null,
};

const buildEditorState = () => ({
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
    getPendingReveal: (wsId: string) =>
      wsId === "ws-active" ? mockStore.pendingReveal : null,
    clearPendingReveal: mockClearPendingReveal,
    openFile: mockOpenFile,
});

vi.mock("../stores/editorStore", () => ({
  useEditorStore: Object.assign(
    vi.fn((selector: (s: unknown) => unknown) => selector(buildEditorState())),
    { getState: () => buildEditorState() },
  ),
}));

import { EditorState } from "@codemirror/state";
import { EditorPane } from "./EditorPane";

beforeEach(() => {
  vi.clearAllMocks();
  mockSaveActive.mockResolvedValue(undefined);
  mockReloadFromDisk.mockResolvedValue(true);
  mockCheckActiveAgainstDisk.mockResolvedValue(undefined);
  mockOpenFile.mockResolvedValue(undefined);
  searchWorkspaceTextMock.mockResolvedValue([]);
  mockStore.saveConflict = null;
  mockStore.pendingReveal = null;
  mockBlameState.enabled = false;
  mockBlameState.linesByPath = {};
  mockBlameLoad.mockResolvedValue(undefined);
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

describe("EditorPane — blame gutter (G7 slice III)", () => {
  const LINES = [
    { line: 1, shaShort: "abc1234", authorName: "Ada", timestampMs: 1, summary: "first" },
  ];

  it("blame off: no fetch, no gutter extension built", () => {
    render(<EditorPane workspaceId="ws-active" workspacePath="/repo" diffText="" />);
    expect(mockBlameLoad).not.toHaveBeenCalled();
    expect(blameGutterMock).not.toHaveBeenCalled();
  });

  it("blame on: fetches blame for the active file and installs the gutter via the compartment", () => {
    mockBlameState.enabled = true;
    mockBlameState.linesByPath = { "/repo/file.ts": LINES };
    render(<EditorPane workspaceId="ws-active" workspacePath="/repo" diffText="" />);
    expect(mockBlameLoad).toHaveBeenCalledWith("/repo", "/repo/file.ts");
    expect(blameGutterMock).toHaveBeenCalledWith(LINES);
    // The reconfigure landed on the live view.
    const view = hoisted.lastView as unknown as { dispatch: ReturnType<typeof vi.fn> };
    expect(view.dispatch).toHaveBeenCalled();
  });

  it("blame on without an active file: no fetch", () => {
    mockBlameState.enabled = true;
    render(<EditorPane workspaceId="ws-no-active" workspacePath="/repo" diffText="" />);
    expect(mockBlameLoad).not.toHaveBeenCalled();
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

describe("EditorPane — open at line (pending reveal)", () => {
  it("scrolls the view to the requested line and consumes the reveal", () => {
    mockStore.pendingReveal = { path: "/repo/file.ts", line: 5 };
    render(<EditorPane workspaceId="ws-active" workspacePath="/repo" diffText="" />);

    const view = hoisted.lastView! as unknown as {
      dispatch: ReturnType<typeof vi.fn>;
    };
    // doc.line(5).from === 50 in the mock — cursor placed there, scrolled into view.
    const revealCall = view.dispatch.mock.calls.find(
      (c) => (c[0] as { selection?: { anchor: number } })?.selection?.anchor === 50,
    );
    expect(revealCall).toBeTruthy();
    expect(mockClearPendingReveal).toHaveBeenCalledWith("ws-active");
  });

  it("releases a held reveal as soon as the column comes back", async () => {
    const proto = HTMLElement.prototype as unknown as { checkVisibility?: () => boolean };
    let visible = false;
    proto.checkVisibility = () => visible;
    try {
      mockStore.pendingReveal = { path: "/repo/file.ts", line: 4 };
      render(<EditorPane workspaceId="ws-active" workspacePath="/repo" diffText="" />);
      expect(mockClearPendingReveal).not.toHaveBeenCalled();
      // ModeOverlay hides the canvas at unchanged width, so nothing resizes —
      // the hold has to be released by polling, not by an observer.
      visible = true;
      await waitFor(() => expect(mockClearPendingReveal).toHaveBeenCalledWith("ws-active"));
    } finally {
      delete proto.checkVisibility;
    }
  });

  it("drops a reveal that stays unlandable, so it can't ambush later", async () => {
    vi.useFakeTimers();
    const proto = HTMLElement.prototype as unknown as { checkVisibility?: () => boolean };
    proto.checkVisibility = () => false;
    try {
      mockStore.pendingReveal = { path: "/repo/file.ts", line: 4 };
      render(<EditorPane workspaceId="ws-active" workspacePath="/repo" diffText="" />);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(mockClearPendingReveal).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(6_000);
      expect(mockClearPendingReveal).toHaveBeenCalledWith("ws-active");
    } finally {
      delete proto.checkVisibility;
      vi.useRealTimers();
    }
  });

  it("holds the reveal while the editor column is hidden, instead of spending it", () => {
    // Markdown "reading" mode collapses this column to zero width rather than
    // unmounting it. Scrolling a hidden viewport does nothing, so consuming the
    // reveal there would silently throw a ⌘⇧F hit away.
    const proto = HTMLElement.prototype as unknown as { checkVisibility?: () => boolean };
    proto.checkVisibility = () => false;
    try {
      mockStore.pendingReveal = { path: "/repo/file.ts", line: 4 };
      render(<EditorPane workspaceId="ws-active" workspacePath="/repo" diffText="" />);
      expect(mockClearPendingReveal).not.toHaveBeenCalled();
    } finally {
      delete proto.checkVisibility;
    }
  });

  it("clamps an out-of-range line to the end of the document", () => {
    mockStore.pendingReveal = { path: "/repo/file.ts", line: 9999 };
    render(<EditorPane workspaceId="ws-active" workspacePath="/repo" diffText="" />);

    const view = hoisted.lastView! as unknown as {
      dispatch: ReturnType<typeof vi.fn>;
    };
    // The mock doc has 100 lines — line(100).from === 1000.
    const revealCall = view.dispatch.mock.calls.find(
      (c) => (c[0] as { selection?: { anchor: number } })?.selection?.anchor === 1000,
    );
    expect(revealCall).toBeTruthy();
    expect(mockClearPendingReveal).toHaveBeenCalledWith("ws-active");
  });

  it("ignores a reveal that targets a different file than the active one", () => {
    mockStore.pendingReveal = { path: "/repo/other.ts", line: 5 };
    render(<EditorPane workspaceId="ws-active" workspacePath="/repo" diffText="" />);

    const view = hoisted.lastView! as unknown as {
      dispatch: ReturnType<typeof vi.fn>;
    };
    const revealCall = view.dispatch.mock.calls.find(
      (c) => (c[0] as { selection?: unknown })?.selection !== undefined,
    );
    expect(revealCall).toBeFalsy();
    expect(mockClearPendingReveal).not.toHaveBeenCalled();
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

describe("EditorPane · search highlighting", () => {
  it("registers searchMatchHighlight in the editor's extensions", async () => {
    // Without it, @codemirror/search paints nothing while our overlay owns ⌘F —
    // the original bug. The behaviour lives in searchHighlight.test.ts; this
    // only guards the wiring, which nothing else here would notice losing.
    render(<EditorPane workspaceId="ws-active" workspacePath="/repo" diffText="" />);
    const create = vi.mocked(EditorState.create);
    expect(create).toHaveBeenCalled();
    const lastCall = create.mock.calls.at(-1) as [{ extensions: unknown[] }] | undefined;
    expect(lastCall).toBeDefined();
    expect(lastCall![0].extensions).toContainEqual({ __searchMatchHighlight: true });
  });
});

describe("EditorPane · symbol navigation", () => {
  it("registers the occurrence highlighter and the ⌘-click plugin", async () => {
    // Same contract as the search highlighter above: the behaviour is covered
    // by symbolIndex.test.ts, this guards the wiring nothing else would miss.
    render(<EditorPane workspaceId="ws-active" workspacePath="/repo" diffText="" />);
    const create = vi.mocked(EditorState.create);
    const lastCall = create.mock.calls.at(-1) as [{ extensions: unknown[] }] | undefined;
    expect(lastCall).toBeDefined();
    expect(lastCall![0].extensions).toContainEqual({ __symbolOccurrenceHighlight: true });
    expect(lastCall![0].extensions).toContainEqual({ __symbolNav: true });
    expect(symbolNavMock).toHaveBeenCalledWith(expect.any(Function));
  });
});

// ─── Go to definition ─────────────────────────────────────────────
//
// `symbolNav` is mocked, so the plugin's own gesture handling is covered in
// symbolNav.test.ts. What is exercised here is the RESOLUTION handler EditorPane
// hands it: which of the open document and the workspace gets asked, and in
// what order.

const NAV_DOC = [
  "function run(input) {",   // 1
  "  return parse(input);",  // 2
  "}",                       // 3
  "run(1);",                 // 4
].join("\n");

/** A stand-in for the live EditorView the gesture would pass in. */
function navView(doc = NAV_DOC) {
  return {
    state: {
      doc: {
        toString: () => doc,
        lineAt: (pos: number) => ({ number: doc.slice(0, pos).split("\n").length }),
      },
    },
    dispatch: vi.fn(),
    focus: vi.fn(),
  };
}

/** The handler EditorPane gave to symbolNav, after rendering the pane. */
function definitionHandler() {
  render(<EditorPane workspaceId="ws-active" workspacePath="/repo" diffText="" />);
  const onRequest = symbolNavMock.mock.calls.at(-1)?.[0] as NavHandler | undefined;
  expect(onRequest).toBeTypeOf("function");
  return onRequest!;
}

const at = (needle: string, doc = NAV_DOC) => {
  const from = doc.indexOf(needle);
  return { name: needle.replace(/\W.*$/, ""), from, to: from + needle.length };
};

describe("EditorPane · go to definition", () => {
  it("jumps within the open document without touching the workspace", async () => {
    const onRequest = definitionHandler();
    const view = navView();
    // `run` at the call on line 4 — its declaration is line 1.
    onRequest({ name: "run", from: NAV_DOC.lastIndexOf("run"), to: NAV_DOC.lastIndexOf("run") + 3 }, view);
    await waitFor(() => expect(view.dispatch).toHaveBeenCalled());
    const spec = view.dispatch.mock.calls[0][0];
    expect(spec.selection).toEqual({ anchor: NAV_DOC.indexOf("run"), head: NAV_DOC.indexOf("run") + 3 });
    expect(searchWorkspaceTextMock).not.toHaveBeenCalled();
  });

  it("says so when the reader is already standing on the declaration", async () => {
    // The regression: the clicked site was filtered out locally AND dropped
    // from the workspace hits, so ⌘-clicking `function run` threw the reader
    // into an unrelated `run` in another file — or claimed nothing declared it.
    const onRequest = definitionHandler();
    const view = navView();
    onRequest(at("run(input)"), view);
    await waitFor(() =>
      expect(pushToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Already at the definition" }),
      ),
    );
    expect(searchWorkspaceTextMock).not.toHaveBeenCalled();
    expect(view.dispatch).not.toHaveBeenCalled();
  });

  it("falls through to the workspace and opens the single candidate", async () => {
    searchWorkspaceTextMock.mockResolvedValue([
      { file: "src/parser.ts", line: 12, col: 17, preview: "export function parse(x) {" },
    ]);
    const onRequest = definitionHandler();
    onRequest(at("parse(input)"), navView());
    await waitFor(() =>
      expect(mockOpenFile).toHaveBeenCalledWith("ws-active", "/repo/src/parser.ts", undefined, 12),
    );
  });

  it("reports when the workspace declares nothing", async () => {
    searchWorkspaceTextMock.mockResolvedValue([
      { file: "src/other.ts", line: 3, col: 10, preview: "  return parse(x);" },
    ]);
    const onRequest = definitionHandler();
    onRequest(at("parse(input)"), navView());
    await waitFor(() =>
      expect(pushToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: "No definition found" }),
      ),
    );
  });

  it("refuses to escalate a statement head to a workspace-wide search", async () => {
    // `F12` on `if` must not become a literal hunt for the word. The refusal
    // lives here rather than at the gesture, so ⌘-click still works normally
    // for identifiers that merely resemble a keyword.
    const onRequest = definitionHandler();
    onRequest({ name: "if", from: 0, to: 2 }, navView());
    await waitFor(() =>
      expect(pushToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: "No definition found" }),
      ),
    );
    expect(searchWorkspaceTextMock).not.toHaveBeenCalled();
  });

  it("still escalates ordinary names that only look like keywords", async () => {
    // Gating this on the broad ambient-noise pool silently refused cross-file
    // lookup for `type`, `get`, `use`, `record` — all perfectly normal names.
    const onRequest = definitionHandler();
    onRequest({ name: "type", from: 0, to: 4 }, navView());
    await waitFor(() => expect(searchWorkspaceTextMock).toHaveBeenCalledWith("/repo", "type", true));
  });

  it("lets an in-file jump supersede a workspace scan still in flight", async () => {
    // The generation is bumped for EVERY request, not just the ones that
    // search: otherwise the earlier scan lands afterwards and yanks the reader
    // out of the file they just jumped to.
    let resolveScan: (hits: unknown[]) => void = () => {};
    searchWorkspaceTextMock.mockImplementationOnce(
      () => new Promise((r) => { resolveScan = r as typeof resolveScan; }),
    );
    const onRequest = definitionHandler();
    onRequest(at("parse(input)"), navView());
    await waitFor(() => expect(searchWorkspaceTextMock).toHaveBeenCalled());

    const view = navView();
    onRequest({ name: "run", from: NAV_DOC.lastIndexOf("run"), to: NAV_DOC.lastIndexOf("run") + 3 }, view);
    await waitFor(() => expect(view.dispatch).toHaveBeenCalled());

    resolveScan([{ file: "src/parser.ts", line: 12, col: 17, preview: "function parse(x) {" }]);
    await waitFor(() => expect(searchWorkspaceTextMock).toHaveBeenCalledTimes(1));
    expect(mockOpenFile).not.toHaveBeenCalled();
  });

  it("retires the chip when a later request answers without searching", async () => {
    // A superseded scan's own `finally` is generation-guarded and declines to
    // touch the state, so the newer request has to clear the chip — otherwise
    // "Looking for …" stays on screen for the rest of the session.
    let resolveScan: (hits: unknown[]) => void = () => {};
    searchWorkspaceTextMock.mockImplementationOnce(
      () => new Promise((r) => { resolveScan = r as typeof resolveScan; }),
    );
    const onRequest = definitionHandler();
    onRequest(at("parse(input)"), navView());
    await waitFor(() => expect(screen.getByText(/Looking for/)).toBeTruthy());

    const view = navView();
    onRequest({ name: "run", from: NAV_DOC.lastIndexOf("run"), to: NAV_DOC.lastIndexOf("run") + 3 }, view);
    await waitFor(() => expect(view.dispatch).toHaveBeenCalled());
    expect(screen.queryByText(/Looking for/)).toBeNull();

    resolveScan([]);
    await waitFor(() => expect(screen.queryByText(/Looking for/)).toBeNull());
  });

  it("says the search could not narrow down, rather than that nothing declares it", async () => {
    // A saturated substring scan is "too many matches", not "no such symbol";
    // reporting the second would be a claim the search never made.
    searchWorkspaceTextMock.mockResolvedValue(
      Array.from({ length: 500 }, (_, i) => ({
        file: `src/f${i}.ts`,
        line: 1,
        col: 1,
        preview: "  rerun(parse);",
      })),
    );
    const onRequest = definitionHandler();
    onRequest(at("parse(input)"), navView());
    await waitFor(() =>
      expect(pushToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Too many matches to narrow" }),
      ),
    );
  });

  it("lets a second request supersede the first, whichever resolves last", async () => {
    // Without a generation guard a slow first scan still opens its answer, on
    // top of the second one's — and its `finally` clears the "Looking for …"
    // chip while the second search is still running.
    let resolveFirst: (hits: unknown[]) => void = () => {};
    searchWorkspaceTextMock
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r as typeof resolveFirst; }))
      .mockResolvedValueOnce([
        { file: "src/second.ts", line: 5, col: 1, preview: "function parse(x) {" },
      ]);

    const onRequest = definitionHandler();
    onRequest(at("parse(input)"), navView());
    onRequest(at("parse(input)"), navView());

    await waitFor(() =>
      expect(mockOpenFile).toHaveBeenCalledWith("ws-active", "/repo/src/second.ts", undefined, 5),
    );

    // The stale first scan lands afterwards and must change nothing.
    resolveFirst([{ file: "src/first.ts", line: 99, col: 1, preview: "function parse(x) {" }]);
    await waitFor(() => expect(searchWorkspaceTextMock).toHaveBeenCalledTimes(2));
    expect(mockOpenFile).toHaveBeenCalledTimes(1);
  });
});
