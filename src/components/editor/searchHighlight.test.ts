import { describe, it, expect, afterEach } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import {
  search,
  setSearchQuery,
  SearchQuery,
  findNext,
  openSearchPanel,
  closeSearchPanel,
} from "@codemirror/search";
import { codeFolding, foldEffect } from "@codemirror/language";
import { searchMatchHighlight } from "./searchHighlight";

/** Purpose-built: `theme` appears as a whole word, as a substring of
 *  `themeName`, and in upper case — so case- and word-sensitivity produce
 *  different, unambiguous results. */
const DOC = `const theme = "atelier";
const themeName = theme + "!";
// THEME in a comment
`;

let view: EditorView | null = null;

/** Attached to the document so the view measures and reports visible ranges —
 *  detached, `visibleRanges` is empty and nothing is decorated. */
function mount(doc = DOC) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [search(), codeFolding(), searchMatchHighlight],
    }),
  });
  return view;
}

function setQuery(v: EditorView, query: SearchQuery) {
  v.dispatch({ effects: setSearchQuery.of(query) });
}

const marks = (v: EditorView) => Array.from(v.contentDOM.querySelectorAll(".cm-searchMatch"));
const currentMark = (v: EditorView) =>
  v.contentDOM.querySelector(".cm-searchMatch-selected")?.textContent ?? null;

afterEach(() => {
  view?.destroy();
  document.body.innerHTML = "";
  view = null;
});

describe("searchMatchHighlight", () => {
  it("decorates matches that the built-in highlighter would not", () => {
    // The regression this exists for: with the native panel closed,
    // @codemirror/search emits nothing at all.
    const v = mount();
    expect(marks(v)).toHaveLength(0);
    setQuery(v, new SearchQuery({ search: "theme" }));
    // Case-insensitive by default: the whole word, the one inside `themeName`,
    // the second whole word, and the upper-case one in the comment.
    expect(marks(v).map((m) => m.textContent)).toEqual(["theme", "theme", "theme", "THEME"]);
  });

  it("honours case sensitivity and whole-word", () => {
    const v = mount();
    setQuery(v, new SearchQuery({ search: "theme", caseSensitive: true }));
    expect(marks(v).map((m) => m.textContent)).toEqual(["theme", "theme", "theme"]);
    setQuery(v, new SearchQuery({ search: "theme", wholeWord: true }));
    // Drops the substring inside `themeName`, keeps the upper-case word.
    expect(marks(v).map((m) => m.textContent)).toEqual(["theme", "theme", "THEME"]);
  });

  it("clears every highlight when the query is emptied", () => {
    const v = mount();
    setQuery(v, new SearchQuery({ search: "theme" }));
    expect(marks(v).length).toBeGreaterThan(0);
    // `SearchQuery.valid` is false for an empty search, so this is also the
    // path EditorSearch takes when the find field is cleared.
    setQuery(v, new SearchQuery({ search: "" }));
    expect(marks(v)).toHaveLength(0);
  });

  it("moves the current-match tag as findNext advances", () => {
    const v = mount();
    setQuery(v, new SearchQuery({ search: "theme" }));
    expect(currentMark(v)).toBeNull();
    findNext(v);
    expect(currentMark(v)).toBe("theme");
    expect(v.contentDOM.querySelectorAll(".cm-searchMatch-selected")).toHaveLength(1);
    const first = v.state.selection.main.from;
    findNext(v);
    expect(v.state.selection.main.from).not.toBe(first);
    // Still exactly one current match, and still the right count overall.
    expect(v.contentDOM.querySelectorAll(".cm-searchMatch-selected")).toHaveLength(1);
    expect(marks(v)).toHaveLength(4);
  });

  it("drops the current tag when the cursor leaves the match, without rescanning", () => {
    const v = mount();
    setQuery(v, new SearchQuery({ search: "theme" }));
    findNext(v);
    expect(currentMark(v)).toBe("theme");
    v.dispatch({ selection: { anchor: 0 } });
    expect(currentMark(v)).toBeNull();
    expect(marks(v)).toHaveLength(4);
  });

  it("stands down while the native search panel is open, so nothing double-paints", () => {
    // searchKeymap's ⌘G/F3 fall through to openSearchPanel when there's no
    // valid query, and two highlighters nest two .cm-searchMatch spans —
    // doubling the wash and drawing the ring twice.
    const v = mount();
    setQuery(v, new SearchQuery({ search: "theme" }));
    const before = marks(v).length;
    expect(before).toBe(4);

    openSearchPanel(v);
    expect(v.contentDOM.querySelectorAll(".cm-searchMatch .cm-searchMatch")).toHaveLength(0);
    // The built-in takes over here, so the count must not have doubled.
    expect(marks(v).length).toBeLessThanOrEqual(before);

    closeSearchPanel(v);
    expect(marks(v)).toHaveLength(4);
    expect(v.contentDOM.querySelectorAll(".cm-searchMatch .cm-searchMatch")).toHaveLength(0);
  });

  it("finds a match straddling a visible-range boundary", () => {
    // Visible ranges are split by folds and line gaps. Without widening the
    // scan window past each boundary, a match sitting across one is dropped.
    const v = mount();
    const needle = "themeName";
    const at = DOC.indexOf(needle);
    expect(at).toBeGreaterThan(0);
    // Cut the visible range through the middle of the needle.
    Object.defineProperty(v, "visibleRanges", {
      configurable: true,
      get: () => [{ from: at + 3, to: v.state.doc.length }],
    });
    setQuery(v, new SearchQuery({ search: needle }));
    expect(marks(v).map((m) => m.textContent)).toEqual([needle]);
  });

  it("keeps the document untouched", () => {
    const v = mount();
    setQuery(v, new SearchQuery({ search: "theme" }));
    findNext(v);
    expect(v.state.doc.toString()).toBe(DOC);
  });

  it("rebuilds when only `literal` changes, and fragments a multi-line match per line", () => {
    // Two facts in one: SearchQuery.eq ignores `literal` even though it changes
    // what matches (so the plugin compares the matching fields itself), and a
    // match spanning a line break becomes one element PER LINE, because lines
    // are separate DOM parents. The ring in atelierTheme.ts closes around each
    // fragment — the reason that rule's comment calls the multi-line case out.
    const v = mount(String.raw`a\nb` + "\na\nb\n");
    setQuery(v, new SearchQuery({ search: String.raw`a\nb`, literal: true }));
    expect(marks(v).map((m) => m.textContent)).toEqual([String.raw`a\nb`]);
    setQuery(v, new SearchQuery({ search: String.raw`a\nb`, literal: false }));
    // Unquoted to a real newline: matches lines 2-3, rendered as two fragments.
    expect(marks(v).map((m) => m.textContent)).toEqual(["a", "b"]);
  });

  it("survives every query shape without throwing", () => {
    // This runs inside the render path on every doc, selection and viewport
    // change, so a throw here would break typing itself.
    const v = mount();
    const queries: SearchQuery[] = [
      new SearchQuery({ search: "" }),
      new SearchQuery({ search: "theme" }),
      new SearchQuery({ search: "th[e]me", regexp: true }),
      // Unbalanced group — `valid` is false, so the plugin must bail early.
      new SearchQuery({ search: "th(eme", regexp: true }),
      // Match the empty string: skipped, so no zero-width span reaches the DOM.
      new SearchQuery({ search: "x*", regexp: true }),
      new SearchQuery({ search: "(?:)", regexp: true }),
      new SearchQuery({ search: "^", regexp: true }),
      new SearchQuery({ search: "$", regexp: true }),
      // Multi-line, and a needle longer than the whole doc.
      new SearchQuery({ search: "documentElement;\nconst" }),
      new SearchQuery({ search: DOC + DOC }),
    ];
    for (const query of queries) {
      expect(() => setQuery(v, query), `query ${JSON.stringify(query.search)}`).not.toThrow();
    }
  });

  it("survives doc edits and a wipe under a live query", () => {
    const v = mount();
    setQuery(v, new SearchQuery({ search: "theme" }));
    expect(() => findNext(v)).not.toThrow();
    expect(() => v.dispatch({ changes: { from: 0, insert: "theme theme\n" } })).not.toThrow();
    expect(marks(v)).toHaveLength(6);
    expect(() => v.dispatch({ selection: { anchor: 3, head: 8 } })).not.toThrow();
    expect(() =>
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "" } }),
    ).not.toThrow();
    expect(marks(v)).toHaveLength(0);
  });

  it("caps the number of decorated matches", () => {
    // Insurance against a query matching nearly every position. The doc has to
    // hold more than MAX_MATCHES matches inside one visible range for this to
    // assert anything, hence a single needle repeated well past the ceiling.
    const v = mount("a".repeat(6000));
    setQuery(v, new SearchQuery({ search: "a" }));
    expect(marks(v).length).toBe(2000);
  });

  it("rescans when the document changes", () => {
    // Guards the highest-risk line in the cache: a same-length edit sets
    // docChanged but NOT viewportChanged, so dropping docChanged from the
    // rescan condition leaves the stale match painted over the new text.
    const v = mount();
    setQuery(v, new SearchQuery({ search: "theme" }));
    const at = DOC.indexOf("theme");
    v.dispatch({ changes: { from: at, to: at + 5, insert: "XXXXX" } });
    expect(marks(v).map((m) => m.textContent)).toEqual(["theme", "theme", "THEME"]);
  });

  it("repaints from the cache on a bare cursor move, without re-scanning", () => {
    const v = mount();
    setQuery(v, new SearchQuery({ search: "theme" }));
    expect(marks(v)).toHaveLength(4);
    // Narrow the visible ranges behind the plugin's back. A rescan would now
    // find one match; a cached repaint must not notice the change.
    Object.defineProperty(v, "visibleRanges", {
      configurable: true,
      get: () => [{ from: 0, to: 10 }],
    });
    v.dispatch({ selection: { anchor: 2 } });
    expect(marks(v)).toHaveLength(4);
    // A doc change forces the rescan, and the narrowed range takes effect.
    v.dispatch({ changes: { from: v.state.doc.length, insert: " " } });
    expect(marks(v)).toHaveLength(1);
  });

  it("rescans when a viewport change alters the visible ranges", () => {
    // Folding is the only handle on `viewportChanged` available here, but it
    // also removes the folded lines from the DOM on its own — so folding a
    // region that CONTAINS matches would pass even with the flag dropped from
    // the rescan condition. The fold below covers matchless lines, leaving the
    // narrowed stub as the only thing that can change the mark count.
    const doc = [
      ...Array.from({ length: 5 }, (_, i) => `const theme${i} = ${i};`),
      ...Array.from({ length: 25 }, (_, i) => `const other${i} = ${i};`),
    ].join("\n");
    const v = mount(doc);
    setQuery(v, new SearchQuery({ search: "theme" }));
    expect(marks(v)).toHaveLength(5);

    Object.defineProperty(v, "visibleRanges", {
      configurable: true,
      get: () => [{ from: 0, to: v.state.doc.line(1).to }],
    });
    v.dispatch({
      effects: foldEffect.of({ from: v.state.doc.line(8).from, to: v.state.doc.line(12).to }),
    });
    expect(marks(v)).toHaveLength(1);
  });
});
