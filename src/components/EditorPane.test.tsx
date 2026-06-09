import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

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

// ─── Mock editorStore ─────────────────────────────────────────────

const mockSaveActive = vi.fn();

vi.mock("../stores/editorStore", () => ({
  useEditorStore: vi.fn((selector: (s: unknown) => unknown) => {
    const state = {
      getActivePath: (wsId: string) =>
        wsId === "ws-active" ? "/repo/file.ts" : null,
      getFiles: (wsId: string) =>
        wsId === "ws-active"
          ? [{ path: "/repo/file.ts", content: "hello", savedContent: "hello", lang: "javascript" }]
          : [],
      setContent: vi.fn(),
      saveActive: mockSaveActive,
    };
    return selector(state);
  }),
}));

import { EditorPane } from "./EditorPane";

beforeEach(() => {
  vi.clearAllMocks();
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
