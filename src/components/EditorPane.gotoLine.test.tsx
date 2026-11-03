import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";

// jsdom has no layout; CodeMirror's measure pass asks ranges for rects.
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

// The real editor, the real `gotoLine` dialog and the real store.
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

const PATH = "/repo/lines.ts";
const DOC = Array.from({ length: 1_000 }, (_, i) => `// ${i + 1}`).join("\n");

beforeEach(() => {
  useEditorStore.setState({
    filesByWs: {
      ws: [{
        path: PATH, content: DOC, savedContent: DOC, lang: "javascript", kind: "text",
        mtime: 1, size: DOC.length, version: 0, diskStale: false,
      }],
    },
    activeByWs: { ws: PATH },
    pendingRevealByWs: {},
    navByWs: {},
    saveConflict: null,
  });
});

/** The pane with its caret on line 10, and ⌘⌥G pressed (Ctrl+Alt+G here:
 *  jsdom is not a Mac, so `Mod` resolves to Ctrl). */
function openGotoLine() {
  const { container } = render(<EditorPane workspaceId="ws" workspacePath="/repo" diffText="" />);
  const view = EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement)!;
  const start = view.state.doc.line(10).from;
  act(() => { view.dispatch({ selection: { anchor: start } }); });
  act(() => {
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", {
      key: "g", code: "KeyG", ctrlKey: true, altKey: true, bubbles: true, cancelable: true,
    }));
  });
  const form = container.querySelector(".cm-goto-line form") as HTMLFormElement;
  expect(form).not.toBeNull();
  return { view, start, form };
}

const trail = () => useEditorStore.getState().navByWs.ws?.back ?? [];

/** The dialog closes and jumps in microtasks; a cancel settles after the task. */
const nextTask = () => new Promise<void>((r) => window.setTimeout(r, 0));
const settle = () => act(async () => { await nextTask(); await nextTask(); });

describe("EditorPane · ⌘⌥G and Back, with the real dialog and keymap", () => {
  it("records where the reader stood once the dialog jumps", async () => {
    const { view, start, form } = openGotoLine();
    (form.elements.namedItem("line") as HTMLInputElement).value = "500";
    act(() => { form.dispatchEvent(new Event("submit", { cancelable: true })); });
    await settle();

    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(500);
    expect(trail()).toEqual([
      expect.objectContaining({ path: PATH, anchor: start, head: start }),
    ]);
  });

  it("records nothing when the dialog is dismissed with Escape", async () => {
    const { view, start, form } = openGotoLine();
    act(() => {
      form.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
    });
    await settle();

    expect(view.dom.querySelector(".cm-goto-line")).toBeNull();
    expect(view.state.selection.main.head).toBe(start);
    expect(trail()).toEqual([]);

    // …and the abandoned origin doesn't attach itself to a later caret move.
    act(() => { view.dispatch({ selection: { anchor: view.state.doc.line(20).from } }); });
    expect(trail()).toEqual([]);
  });

  it("comes back with Ctrl+Alt+− off macOS, where Ctrl+− stays the font-size chord", async () => {
    const { view, start, form } = openGotoLine();
    (form.elements.namedItem("line") as HTMLInputElement).value = "500";
    act(() => { form.dispatchEvent(new Event("submit", { cancelable: true })); });
    await settle();
    const press = (init: KeyboardEventInit) =>
      act(() => {
        view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", {
          key: "-", code: "Minus", ctrlKey: true, bubbles: true, cancelable: true, ...init,
        }));
      });

    press({});
    await settle();
    expect(view.state.doc.lineAt(view.state.selection.main.head).number).toBe(500);

    press({ altKey: true });
    await waitFor(() => expect(view.state.selection.main.head).toBe(start));
  });

  it("doesn't take a click in the text, with the dialog still open, for the jump", async () => {
    const { view, start, form } = openGotoLine();
    act(() => { view.dispatch({ selection: { anchor: view.state.doc.line(30).from } }); });
    expect(trail()).toEqual([]);

    // The real jump still records the origin from when ⌘⌥G was pressed.
    (form.elements.namedItem("line") as HTMLInputElement).value = "700";
    act(() => { form.dispatchEvent(new Event("submit", { cancelable: true })); });
    await settle();
    expect(trail()).toEqual([expect.objectContaining({ anchor: start })]);
  });
});
