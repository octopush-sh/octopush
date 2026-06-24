import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EditorWithPreview } from "./EditorWithPreview";
import { useEditorStore } from "../../stores/editorStore";
import { useReviewPrefs } from "../../stores/reviewPrefsStore";
import type { OpenFile } from "../../stores/editorStore";

// Stub the heavy panes — this test is about gating + divider, not CodeMirror.
vi.mock("../EditorPane", () => ({ EditorPane: () => <div data-testid="editor-pane" /> }));
vi.mock("./MarkdownPreview", () => ({
  MarkdownPreview: ({ source }: { source: string }) => <div data-testid="md-preview">{source}</div>,
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

describe("EditorWithPreview", () => {
  beforeEach(() => {
    useEditorStore.setState({ filesByWs: {}, activeByWs: {} });
    useReviewPrefs.setState({ mdPreview: true, mdPreviewSplit: 50 });
  });

  it("always renders the editor pane", () => {
    seedFile({ path: "/r/App.tsx", lang: "javascript", kind: "text" });
    renderIt();
    expect(screen.getByTestId("editor-pane")).toBeInTheDocument();
  });

  it("shows the preview for a markdown file when mdPreview is on", () => {
    seedFile({ path: "/r/README.md", lang: "markdown", kind: "text", content: "# Hi" });
    renderIt();
    expect(screen.getByTestId("md-preview")).toHaveTextContent("# Hi");
    expect(screen.getByRole("separator")).toBeInTheDocument();
  });

  it("hides the preview for a non-markdown file but keeps the editor mounted", () => {
    seedFile({ path: "/r/App.tsx", lang: "javascript", kind: "text" });
    renderIt();
    expect(screen.queryByRole("separator")).toBeNull();
    expect(screen.getByTestId("editor-pane")).toBeInTheDocument();
  });

  it("hides the preview when mdPreview is off but keeps the editor mounted", () => {
    seedFile({ path: "/r/README.md", lang: "markdown", kind: "text" });
    useReviewPrefs.setState({ mdPreview: false });
    renderIt();
    expect(screen.queryByRole("separator")).toBeNull();
    expect(screen.getByTestId("editor-pane")).toBeInTheDocument();
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

  it("double-click on the divider resets the split to 50", () => {
    seedFile({ path: "/r/README.md", lang: "markdown", kind: "text" });
    useReviewPrefs.setState({ mdPreviewSplit: 30 });
    renderIt();
    fireEvent.doubleClick(screen.getByRole("separator"));
    expect(useReviewPrefs.getState().mdPreviewSplit).toBe(50);
  });
});
