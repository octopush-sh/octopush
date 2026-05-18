import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// ─── Mock CodeMirror (JSDOM can't run it) ─────────────────────────
vi.mock("@codemirror/view", () => {
  class EditorViewMock {
    dom = document.createElement("div");
    destroy = vi.fn();
    dispatch = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_config: any) {}
    static updateListener = { of: vi.fn(() => ({})) };
    static theme = vi.fn(() => ({}));
  }

  return {
    EditorView: EditorViewMock,
    lineNumbers: vi.fn(() => ({})),
    highlightActiveLineGutter: vi.fn(() => ({})),
    highlightActiveLine: vi.fn(() => ({})),
    drawSelection: vi.fn(() => ({})),
    keymap: { of: vi.fn(() => ({})) },
  };
});

vi.mock("@codemirror/state", () => ({
  EditorState: {
    create: vi.fn().mockReturnValue({ doc: { toString: () => "" } }),
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
});
