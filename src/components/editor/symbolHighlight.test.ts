import { describe, it, expect } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView, Decoration } from "@codemirror/view";
import { search, setSearchQuery, SearchQuery } from "@codemirror/search";
import { javascript } from "@codemirror/lang-javascript";
import { symbolOccurrenceHighlight, symbolUnderCursor } from "./symbolHighlight";

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

// ── The plugin itself, in a real (jsdom-mounted) EditorView ──────────
//
// `symbolUnderCursor` above is the decision; these cover the plugin's *gating*,
// which is a separate thing and is where the interesting bug was: the plugin
// only woke for doc/selection/viewport changes, and a find query is none of
// those, so it kept painting under a live query and stayed dark after one was
// cleared — while the unit tests above passed the whole time.

const VIEW_DOC = "const total = 1;\nconst other = total + total;\n";

function mountView(doc = VIEW_DOC) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({
    state: EditorState.create({
      doc,
      extensions: [search({ top: true }), symbolOccurrenceHighlight],
    }),
    parent,
  });
}

/** Every symbol mark currently on screen, as `from-to:classes`. */
function marks(view: EditorView): string[] {
  const out: string[] = [];
  for (const source of view.state.facet(EditorView.decorations)) {
    const set = typeof source === "function" ? source(view) : source;
    const iter = (set as ReturnType<typeof Decoration.set>).iter();
    while (iter.value) {
      const cls = String(iter.value.spec?.class ?? "");
      if (cls.includes("cm-symbol")) out.push(`${iter.from}-${iter.to}:${cls}`);
      iter.next();
    }
  }
  return out;
}

describe("symbolOccurrenceHighlight (mounted)", () => {
  it("marks every use, and the declaration apart from them", () => {
    const view = mountView();
    view.dispatch({ selection: { anchor: VIEW_DOC.indexOf("total") + 2 } });
    expect(marks(view)).toEqual([
      "6-11:cm-symbolOccurrence cm-symbolDefinition",
      "31-36:cm-symbolOccurrence",
      "39-44:cm-symbolOccurrence",
    ]);
    view.destroy();
  });

  it("clears under a live find query and comes back when it is cleared", () => {
    const view = mountView();
    view.dispatch({ selection: { anchor: VIEW_DOC.indexOf("total") + 2 } });
    expect(marks(view).length).toBe(3);

    // A setSearchQuery transaction changes no doc, selection or viewport — the
    // plugin has to watch the query as its own signal or it never notices.
    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "total" })) });
    expect(marks(view)).toEqual([]);

    view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: "" })) });
    expect(marks(view).length).toBe(3);
    view.destroy();
  });

  it("paints nothing for a keyword under the caret", () => {
    const view = mountView();
    view.dispatch({ selection: { anchor: VIEW_DOC.indexOf("const") + 1 } });
    expect(marks(view)).toEqual([]);
    view.destroy();
  });

  it("leaves the definition unmarked in a document too big to scan", () => {
    // Past MAX_DEF_SCAN_BYTES the underline is dropped rather than paid for on
    // every keystroke; the occurrences themselves still highlight.
    const filler = "// filler line to push the document past the scan ceiling\n";
    const big = `const total = 1;\n${filler.repeat(4600)}const other = total;\n`;
    expect(big.length).toBeGreaterThan(256 * 1024);

    const view = mountView(big);
    view.dispatch({ selection: { anchor: big.indexOf("total") + 2 } });
    const painted = marks(view);
    expect(painted.length).toBeGreaterThan(0);
    expect(painted.every((m) => !m.includes("cm-symbolDefinition"))).toBe(true);
    view.destroy();
  });

  it("keeps the definition mark on the declaration across an edit", () => {
    const view = mountView();
    view.dispatch({ selection: { anchor: VIEW_DOC.indexOf("total") + 2 } });
    // Insert a line above, shifting every offset by its length.
    view.dispatch({ changes: { from: 0, insert: "// lead\n" } });
    const shifted = marks(view);
    expect(shifted[0]).toBe("14-19:cm-symbolOccurrence cm-symbolDefinition");
    expect(shifted).toHaveLength(3);
    view.destroy();
  });
});
