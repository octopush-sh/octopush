import { describe, it, expect, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  changeStarts, nextChangeLine, diffGutter, gotoNextChange, gotoPrevChange,
} from "./diffGutter";
import type { DiffLineMarker } from "../../lib/diffParser";

const added = (line: number): DiffLineMarker => ({ line, kind: "added" });

describe("changeStarts", () => {
  it("collapses a run of marked lines into one stop at its first line", () => {
    expect(changeStarts([added(3), added(4), added(5), added(9), added(12), added(13)]))
      .toEqual([3, 9, 12]);
  });

  it("sorts and ignores duplicate lines", () => {
    expect(changeStarts([added(9), added(2), added(2)])).toEqual([2, 9]);
  });
});

describe("nextChangeLine", () => {
  const starts = [3, 9, 12];

  it("steps forward and back from the caret's line", () => {
    expect(nextChangeLine(starts, 1, 1)).toBe(3);
    expect(nextChangeLine(starts, 3, 1)).toBe(9);
    expect(nextChangeLine(starts, 10, -1)).toBe(9);
    expect(nextChangeLine(starts, 9, -1)).toBe(3);
  });

  it("wraps at either end", () => {
    expect(nextChangeLine(starts, 12, 1)).toBe(3);
    expect(nextChangeLine(starts, 3, -1)).toBe(12);
  });

  it("has nowhere to go in a file without changes", () => {
    expect(nextChangeLine([], 5, 1)).toBeNull();
  });
});

describe("gotoNextChange / gotoPrevChange", () => {
  let view: EditorView | null = null;
  afterEach(() => { view?.destroy(); view = null; });

  const make = (markers: DiffLineMarker[]) => {
    const doc = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    view = new EditorView({
      state: EditorState.create({ doc, extensions: [diffGutter(markers)] }),
      parent: document.body,
    });
    return view;
  };
  const caretLine = (v: EditorView) => v.state.doc.lineAt(v.state.selection.main.head).number;

  it("moves the caret through the gutter's changes, wrapping", () => {
    const v = make([added(4), added(5), { line: 10, kind: "removed-after", count: 2 }]);
    expect(gotoNextChange(v)).toBe(true);
    expect(caretLine(v)).toBe(4);
    gotoNextChange(v);
    expect(caretLine(v)).toBe(10);
    gotoNextChange(v);
    expect(caretLine(v)).toBe(4);
    gotoPrevChange(v);
    expect(caretLine(v)).toBe(10);
  });

  it("lets the key fall through when the file has no changes", () => {
    const v = make([]);
    expect(gotoNextChange(v)).toBe(false);
    expect(gotoPrevChange(v)).toBe(false);
  });
});
