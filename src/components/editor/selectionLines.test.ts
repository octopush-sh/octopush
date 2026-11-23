import { describe, it, expect } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { selectionLines } from "./selectionLines";

const doc = "one\ntwo\nthree\nfour";
const at = (anchor: number, head = anchor) =>
  EditorState.create({ doc, selection: EditorSelection.single(anchor, head) });

describe("selectionLines", () => {
  it("is null for a bare caret", () => {
    expect(selectionLines(at(5))).toBeNull();
  });

  it("names the lines a selection touches, either direction", () => {
    expect(selectionLines(at(1, 10))).toEqual({ from: 1, to: 3 });
    expect(selectionLines(at(10, 1))).toEqual({ from: 1, to: 3 });
    expect(selectionLines(at(4, 6))).toEqual({ from: 2, to: 2 });
  });

  it("ends a whole-line drag on the line above the caret", () => {
    // "two\n" selected: from line 2's start to line 3's start.
    expect(selectionLines(at(4, 8))).toEqual({ from: 2, to: 2 });
  });
});
