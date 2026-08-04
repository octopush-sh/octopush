import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { EditorWithPreview } from "./EditorWithPreview";
import { useEditorStore } from "../../stores/editorStore";
import { useReviewPrefs } from "../../stores/reviewPrefsStore";
import type { OpenFile } from "../../stores/editorStore";

// Stub the heavy panes — this test is about layout gating, the divider and the
// jump wiring, not CodeMirror or the Markdown renderer. The preview stub
// exposes its jump callback as a button so the wiring stays observable.
vi.mock("../EditorPane", () => ({ EditorPane: () => <div data-testid="editor-pane" /> }));
vi.mock("./MarkdownPreview", () => ({
  MarkdownPreview: ({
    source,
    onJumpToLine,
  }: {
    source: string;
    onJumpToLine?: (line: number) => void;
  }) => (
    <div data-testid="md-preview">
      {source}
      <button data-testid="md-jump" onClick={() => onJumpToLine?.(7)}>
        jump
      </button>
    </div>
  ),
}));

const WS = "ws1";
function seedFile(partial: Partial<OpenFile> & Pick<OpenFile, "path" | "lang" | "kind">) {
  const file = {
    content: "# Doc", savedContent: "# Doc", mtime: 0, size: 1, version: 0, diskStale: false,
    ...partial,
  } as OpenFile;
  useEditorStore.setState({ filesByWs: { [WS]: [file] }, activeByWs: { [WS]: file.path } });
}

function renderIt() {
  return render(<EditorWithPreview workspaceId={WS} workspacePath="/r" diffText="" />);
}

/** The editor column is the root's first child; the preview column its last. */
function columns() {
  const root = screen.getByTestId("editor-with-preview");
  return {
    editor: root.firstElementChild as HTMLElement,
    preview: root.lastElementChild as HTMLElement,
  };
}

describe("EditorWithPreview", () => {
  beforeEach(() => {
    useEditorStore.setState({ filesByWs: {}, activeByWs: {}, pendingRevealByWs: {} });
    useReviewPrefs.setState({ mdView: "split", mdPreviewSplit: 50 });
  });

  it("always renders the editor pane", () => {
    seedFile({ path: "/r/App.tsx", lang: "javascript", kind: "text" });
    renderIt();
    expect(screen.getByTestId("editor-pane")).toBeInTheDocument();
  });

  it("split shows both columns and the divider", () => {
    seedFile({ path: "/r/README.md", lang: "markdown", kind: "text", content: "# Hi" });
    renderIt();
    expect(screen.getByTestId("md-preview")).toHaveTextContent("# Hi");
    expect(screen.getByRole("separator")).toBeInTheDocument();
    const { editor, preview } = columns();
    expect(editor.style.width).toBe("50%");
    expect(preview.style.width).toBe("50%");
  });

  it("source hides the preview and gives the editor the full width", () => {
    seedFile({ path: "/r/README.md", lang: "markdown", kind: "text" });
    useReviewPrefs.setState({ mdView: "source" });
    renderIt();
    expect(screen.queryByTestId("md-preview")).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
    const { editor, preview } = columns();
    expect(editor.style.width).toBe("100%");
    expect(preview.style.width).toBe("0%");
  });

  // The editor must survive every mode switch: CodeMirror's undo history and
  // scroll position live in the view, so a collapse must never be an unmount.
  it("reading collapses the editor to zero width but keeps it mounted", () => {
    seedFile({ path: "/r/README.md", lang: "markdown", kind: "text" });
    useReviewPrefs.setState({ mdView: "reading" });
    renderIt();
    expect(screen.getByTestId("editor-pane")).toBeInTheDocument();
    expect(screen.getByTestId("md-preview")).toBeInTheDocument();
    expect(screen.queryByRole("separator")).toBeNull();
    const { editor, preview } = columns();
    expect(editor.style.width).toBe("0%");
    expect(editor.style.visibility).toBe("hidden");
    expect(preview.style.width).toBe("100%");
  });

  it("a non-markdown tab ignores the markdown view and stays editor-only", () => {
    seedFile({ path: "/r/App.tsx", lang: "javascript", kind: "text" });
    useReviewPrefs.setState({ mdView: "reading" });
    renderIt();
    expect(screen.queryByTestId("md-preview")).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
    expect(columns().editor.style.width).toBe("100%");
  });

  it("drag updates the split ratio, clamped to 25..75", () => {
    seedFile({ path: "/r/README.md", lang: "markdown", kind: "text" });
    renderIt();
    const container = screen.getByTestId("editor-with-preview");
    container.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 1000, bottom: 100, width: 1000, height: 100, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const divider = screen.getByRole("separator");

    fireEvent.mouseDown(divider);
    fireEvent.mouseMove(document, { clientX: 300 });
    fireEvent.mouseUp(document);
    expect(useReviewPrefs.getState().mdPreviewSplit).toBe(30);

    fireEvent.mouseDown(divider);
    fireEvent.mouseMove(document, { clientX: 100 }); // 10% -> clamp 25
    fireEvent.mouseUp(document);
    expect(useReviewPrefs.getState().mdPreviewSplit).toBe(25);
  });

  // Layout-regression guard: jsdom can't compute flexbox, so assert the class
  // contract that keeps the editor from collapsing to zero height — the root
  // must grow into the slot below the tabs (flex-1, not h-full) and the editor
  // column must be a flex-col so EditorPane's own flex-1 can fill it.
  it("uses fill-height layout classes (root flex-1, editor column flex-col)", () => {
    seedFile({ path: "/r/README.md", lang: "markdown", kind: "text" });
    const { container } = renderIt();
    const root = container.querySelector('[data-testid="editor-with-preview"]') as HTMLElement;
    expect(root.className).toContain("flex-1");
    expect(root.className).not.toContain("h-full");
    const editorColumn = root.firstElementChild as HTMLElement;
    expect(editorColumn.className).toContain("flex");
    expect(editorColumn.className).toContain("flex-col");
  });

  it("does not write the split to the store until the drag is released", () => {
    seedFile({ path: "/r/README.md", lang: "markdown", kind: "text" });
    renderIt();
    const container = screen.getByTestId("editor-with-preview");
    container.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 1000, bottom: 100, width: 1000, height: 100, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const divider = screen.getByRole("separator");

    fireEvent.mouseDown(divider);
    fireEvent.mouseMove(document, { clientX: 300 });
    // Mid-drag: the persisted store is untouched (no per-pixel localStorage writes).
    expect(useReviewPrefs.getState().mdPreviewSplit).toBe(50);
    fireEvent.mouseUp(document);
    // Committed once, on release.
    expect(useReviewPrefs.getState().mdPreviewSplit).toBe(30);
  });

  it("double-click on the divider resets the split to 50", () => {
    seedFile({ path: "/r/README.md", lang: "markdown", kind: "text" });
    useReviewPrefs.setState({ mdPreviewSplit: 30 });
    renderIt();
    fireEvent.doubleClick(screen.getByRole("separator"));
    expect(useReviewPrefs.getState().mdPreviewSplit).toBe(50);
  });
});

describe("EditorWithPreview — jump to source", () => {
  beforeEach(() => {
    useEditorStore.setState({ filesByWs: {}, activeByWs: {}, pendingRevealByWs: {} });
    useReviewPrefs.setState({ mdView: "split", mdPreviewSplit: 50 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("from split, a jump reveals the line immediately", () => {
    seedFile({ path: "/r/README.md", lang: "markdown", kind: "text" });
    renderIt();
    fireEvent.click(screen.getByTestId("md-jump"));
    expect(useEditorStore.getState().getPendingReveal(WS)).toEqual({
      path: "/r/README.md",
      line: 7,
    });
  });

  // From reading the editor column is still zero-width; revealing before the
  // width transition lands would scroll CodeMirror against no viewport.
  it("from reading, a jump opens split first and defers the reveal", () => {
    vi.useFakeTimers();
    seedFile({ path: "/r/README.md", lang: "markdown", kind: "text" });
    useReviewPrefs.setState({ mdView: "reading" });
    renderIt();

    fireEvent.click(screen.getByTestId("md-jump"));
    expect(useReviewPrefs.getState().mdView).toBe("split");
    expect(useEditorStore.getState().getPendingReveal(WS)).toBeNull();

    act(() => { vi.advanceTimersByTime(400); });
    expect(useEditorStore.getState().getPendingReveal(WS)).toEqual({
      path: "/r/README.md",
      line: 7,
    });
  });

  it("drops a deferred reveal when the component unmounts first", () => {
    vi.useFakeTimers();
    seedFile({ path: "/r/README.md", lang: "markdown", kind: "text" });
    useReviewPrefs.setState({ mdView: "reading" });
    const { unmount } = renderIt();

    fireEvent.click(screen.getByTestId("md-jump"));
    unmount();
    act(() => { vi.advanceTimersByTime(400); });
    expect(useEditorStore.getState().getPendingReveal(WS)).toBeNull();
  });
});
