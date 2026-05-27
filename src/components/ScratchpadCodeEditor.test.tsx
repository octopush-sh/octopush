import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

// ─── Mock CodeMirror (JSDOM can't construct a real EditorView) ────────
vi.mock("@codemirror/view", () => {
  class EditorViewMock {
    dom = document.createElement("div");
    destroy = vi.fn();
    dispatch = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(config: any) {
      // Mirror the real EditorView: attach our DOM to the parent host so the
      // editor surface is present in the rendered tree.
      config?.parent?.appendChild?.(this.dom);
    }
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
    placeholder: vi.fn(() => ({})),
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
}));

const langMock = () => ({ javascript: vi.fn(() => ({})) });
vi.mock("@codemirror/lang-javascript", () => ({ javascript: vi.fn(() => ({})) }));
vi.mock("@codemirror/lang-rust", () => ({ rust: vi.fn(() => ({})) }));
vi.mock("@codemirror/lang-python", () => ({ python: vi.fn(() => ({})) }));
vi.mock("@codemirror/lang-java", () => ({ java: vi.fn(() => ({})) }));
vi.mock("@codemirror/lang-json", () => ({ json: vi.fn(() => ({})) }));
vi.mock("@codemirror/lang-markdown", () => ({ markdown: vi.fn(() => ({})) }));
vi.mock("@codemirror/lang-html", () => ({ html: vi.fn(() => ({})) }));
vi.mock("@codemirror/lang-css", () => ({ css: vi.fn(() => ({})) }));
vi.mock("@codemirror/lang-xml", () => ({ xml: vi.fn(() => ({})) }));
vi.mock("@codemirror/lang-yaml", () => ({ yaml: vi.fn(() => ({})) }));
void langMock;

vi.mock("./editor/atelierTheme", () => ({ atelierTheme: [] }));

import { ScratchpadCodeEditor } from "./ScratchpadCodeEditor";
import { useScratchpadStore } from "../stores/scratchpadStore";

describe("ScratchpadCodeEditor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useScratchpadStore.getState().reset();
  });

  it("shows the empty state when no tab is active", () => {
    const { getByText } = render(<ScratchpadCodeEditor />);
    expect(getByText("No tab selected")).toBeInTheDocument();
  });

  it("renders the CodeMirror host when a tab is active", () => {
    useScratchpadStore.getState().createTab();
    const { getByTestId } = render(<ScratchpadCodeEditor />);
    expect(getByTestId("scratchpad-host")).toBeInTheDocument();
  });

  it("REGRESSION: renders a single editor layer — no textarea/pre overlay", () => {
    // The old hand-rolled editor stacked an invisible <textarea> over a
    // highlighted <pre>, which caused the double-text / shadow bug. The
    // CodeMirror rewrite must render exactly one editing surface and neither
    // of the old overlay elements.
    useScratchpadStore.getState().createTab();
    const { container } = render(<ScratchpadCodeEditor />);

    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector("pre")).toBeNull();
    expect(container.querySelectorAll("[data-testid='scratchpad-host']")).toHaveLength(1);
  });

  it("creates the editor with the active tab's content as the document", async () => {
    const { EditorState } = await import("@codemirror/state");
    const store = useScratchpadStore.getState();
    store.createTab();
    const tabId = useScratchpadStore.getState().tabs[0].id;
    store.setContent(tabId, "const x = 1;");

    render(<ScratchpadCodeEditor />);

    expect(EditorState.create).toHaveBeenCalledWith(
      expect.objectContaining({ doc: "const x = 1;" }),
    );
  });
});
