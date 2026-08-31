import { describe, it, expect } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { search, setSearchQuery, SearchQuery } from "@codemirror/search";
import { javascript } from "@codemirror/lang-javascript";
import { symbolUnderCursor } from "./symbolHighlight";

const DOC = [
  "const total = 1;",
  "function add(a) {",
  "  return total + a;",
  "}",
].join("\n");

/**
 * A real state — not a mock — so the search-field integration is exercised.
 *
 * The selection is applied as an UPDATE rather than passed to `create`, which
 * matters: `@codemirror/search` seeds its default query from whatever is
 * selected at creation time, so a state built with a selection already in place
 * would look to `symbolUnderCursor` like a find is in progress. A live editor
 * never gets its selection that way.
 */
function stateWith(sel: { anchor: number; head?: number }, doc = DOC) {
  const state = EditorState.create({
    doc,
    extensions: [
      search({ top: true }),
      javascript({ typescript: true }),
      EditorState.allowMultipleSelections.of(true),
    ],
  });
  return state.update({ selection: sel }).state;
}

const stateAt = (cursor: number, doc = DOC) => stateWith({ anchor: cursor }, doc);

describe("symbolUnderCursor", () => {
  it("reports the identifier the caret rests on", () => {
    expect(symbolUnderCursor(stateAt(DOC.indexOf("total") + 2))).toBe("total");
  });

  it("reports an exact single-identifier selection", () => {
    const from = DOC.indexOf("add");
    expect(symbolUnderCursor(stateWith({ anchor: from, head: from + 3 }))).toBe("add");
  });

  it("ignores a selection that is only part of an identifier", () => {
    const from = DOC.indexOf("total");
    // "tot" — dragging across part of a word must not start matching.
    expect(symbolUnderCursor(stateWith({ anchor: from, head: from + 3 }))).toBeNull();
  });

  it("ignores language keywords", () => {
    expect(symbolUnderCursor(stateAt(DOC.indexOf("return") + 1))).toBeNull();
    expect(symbolUnderCursor(stateAt(DOC.indexOf("const") + 1))).toBeNull();
  });

  it("ignores punctuation and whitespace", () => {
    expect(symbolUnderCursor(stateAt(DOC.indexOf("+")))).toBeNull();
  });

  it("stands down while a find query is live", () => {
    // Two ambient washes over the same text read as one broken one — the find
    // layer owns the screen while it has a query.
    const state = stateAt(DOC.indexOf("total") + 2);
    const withQuery = state.update({
      effects: setSearchQuery.of(new SearchQuery({ search: "total" })),
    }).state;
    expect(symbolUnderCursor(withQuery)).toBeNull();

    const cleared = withQuery.update({
      effects: setSearchQuery.of(new SearchQuery({ search: "" })),
    }).state;
    expect(symbolUnderCursor(cleared)).toBe("total");
  });

  it("stands down on a multi-caret selection", () => {
    const state = stateWith({ anchor: 0 }).update({
      selection: EditorSelection.create([
        EditorSelection.cursor(DOC.indexOf("total") + 2),
        EditorSelection.cursor(DOC.indexOf("add") + 1),
      ]),
    }).state;
    expect(symbolUnderCursor(state)).toBeNull();
  });

  it("works without the search extension installed", () => {
    // getSearchQuery falls back to a default query when the field is absent;
    // the scratchpad and any future host must not need to install search first.
    const state = EditorState.create({ doc: DOC, selection: { anchor: 8 } });
    expect(symbolUnderCursor(state)).toBe("total");
  });
});
