import { describe, it, expect, vi, beforeEach } from "vitest";
import { Profiler } from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { Text } from "@codemirror/state";

// jsdom has no layout; CodeMirror's measure pass asks ranges for rects.
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

// The real editor, store and tab bar: only the edges are stubbed.
vi.mock("../lib/ipc", () => ({
  ipc: {
    searchWorkspaceText: vi.fn().mockResolvedValue([]),
    fileMeta: vi.fn().mockResolvedValue(null),
    writeFile: vi.fn().mockResolvedValue({ mtime: 2 }),
  },
}));
vi.mock("./Toasts", () => ({ pushToast: vi.fn() }));

import { useEditorStore } from "../stores/editorStore";
import { EditorPane } from "./EditorPane";
import { EditorTabs } from "./EditorTabs";

const PATH = "/repo/big.ts";
const BIG =
  Array.from({ length: 9_999 }, (_, i) => `const line${i} = ${i};`).join("\n") + "\n";

beforeEach(() => {
  useEditorStore.setState({
    filesByWs: {
      ws: [{
        path: PATH, content: BIG, savedContent: BIG, lang: "javascript", kind: "text",
        mtime: 1, size: BIG.length, version: 0, diskStale: false,
      }],
    },
    activeByWs: { ws: PATH },
    pendingRevealByWs: {},
    navByWs: {},
    saveConflict: null,
  });
});

describe("EditorPane — typing in a 10k-line file", () => {
  it("doesn't re-render the tab bar per keystroke, and syncs the text once typing pauses", async () => {
    let tabRenders = 0;
    const { container } = render(
      <>
        <Profiler id="tabs" onRender={() => { tabRenders++; }}>
          <EditorTabs workspaceId="ws" />
        </Profiler>
        <EditorPane workspaceId="ws" workspacePath="/repo" diffText="" />
      </>,
    );
    const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
    expect(view.state.doc.lines).toBe(10_000);

    const before = tabRenders;
    // Every document CodeMirror makes is a `Text`: this sees any full copy.
    // Typing spaces on a blank last line keeps the caret off identifiers, so
    // symbolHighlight's own (size-capped) definition scan stays out of it.
    const toString = vi.spyOn(Text.prototype, "toString");
    act(() => {
      for (let i = 0; i < 100; i++) {
        const end = view.state.doc.length;
        view.dispatch({
          changes: { from: end, insert: " " },
          selection: { anchor: end + 1 },
          userEvent: "input.type",
        });
      }
    });

    // One render for the dirty dot, not one per key — and no copy of the text.
    expect(tabRenders - before).toBeLessThanOrEqual(1);
    expect(screen.getByTestId(`dirty-dot-${PATH}`)).toBeInTheDocument();
    expect(toString).not.toHaveBeenCalled();
    toString.mockRestore();
    expect(useEditorStore.getState().getFiles("ws")[0].content).toBe(BIG);

    // After the pause the store holds the typed text.
    await waitFor(() =>
      expect(useEditorStore.getState().getFiles("ws")[0].content).toBe(BIG + " ".repeat(100)),
    );
    expect(tabRenders - before).toBeLessThanOrEqual(2);
    expect(useEditorStore.getState().isDirty("ws", PATH)).toBe(true);
  });

  it("syncs unsynced keys immediately when the pane unmounts", () => {
    const { container, unmount } = render(
      <EditorPane workspaceId="ws" workspacePath="/repo" diffText="" />,
    );
    const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
    act(() => { view.dispatch({ changes: { from: 0, insert: "y" } }); });
    unmount();
    expect(useEditorStore.getState().getFiles("ws")[0].content).toBe("y" + BIG);
  });
});
