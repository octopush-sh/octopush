/**
 * Occurrence highlighting — rest the caret on an identifier and every other
 * use of it in the file lights up, with its definition marked apart.
 *
 * This is the ambient half of symbol navigation (⌘-click is the deliberate
 * half, in `symbolNav.ts`). Because it fires on every cursor move, it is built
 * to be cheap and quiet:
 *
 *  - It scans only the visible ranges, so cost is bounded by the viewport, not
 *    by the file. The definition scan does read the whole document, but only
 *    when the symbol or the doc changes, and it is a plain string walk.
 *  - It stands down while a find query is live. `searchHighlight` is painting
 *    brass washes for that query at the same low precedence; two highlighters
 *    over the same text read as one broken one.
 *  - It ignores language keywords (`return`, `const`, …) via
 *    `NON_SYMBOL_WORDS`, and matches inside comments and strings, which the
 *    syntax tree can tell us about even without a language server.
 *
 * The decoration classes are Octopush's own (`cm-symbolOccurrence` /
 * `cm-symbolDefinition`), themed in `atelierTheme.ts`: a neutral wash for uses,
 * a brass-underlined one for the definition — the one place brass is spent
 * here, because there is at most one of them.
 */

import {
  Decoration,
  ViewPlugin,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from "@codemirror/view";
import { Prec, RangeSetBuilder, type EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { getSearchQuery } from "@codemirror/search";
import {
  findDefinitions,
  identifierNear,
  isIdentifier,
  isNavigableSymbol,
  wordOccurrences,
  type SymbolRange,
} from "./symbolIndex";

const OCCURRENCE = Decoration.mark({ class: "cm-symbolOccurrence" });
const DEFINITION = Decoration.mark({ class: "cm-symbolOccurrence cm-symbolDefinition" });

/** Ceiling per paint. The viewport already bounds this; the cap is insurance
 *  against a very tall viewport over minified source. */
const MAX_MARKS = 1000;

/**
 * Longest document we will walk for a definition at all.
 *
 * The walk is linear over the text — ~3 ms at 128 KB, ~6 ms here, but ~50 ms at
 * 1.8 MB, which is where an earlier 2 MB ceiling turned typing in a large file
 * into roughly 20 fps. It has to be a hard ceiling rather than an
 * "only re-scan small documents on edit" rule, because TYPING an identifier
 * changes the symbol on every keystroke, and a symbol change always re-scans:
 * the edit path and the symbol path are the same path in practice.
 *
 * Past the ceiling the definition simply isn't marked. Occurrence highlighting
 * still works, and ⌘-click still finds the definition — it scans on demand,
 * once, rather than on every keystroke.
 */
const MAX_DEF_SCAN_BYTES = 256 * 1024;

/**
 * Is a find query painting right now?
 *
 * Exactly the condition `searchMatchHighlight` paints under, so the two layers
 * are never on screen together. It has to be watched as its own signal: a
 * `setSearchQuery` transaction changes neither the doc, the selection nor the
 * viewport, so a plugin that only wakes for those three would keep painting
 * under a live query — and, worse, stay dark after the query is cleared.
 */
export function searchQueryLive(state: EditorState): boolean {
  const query = getSearchQuery(state);
  return !!query.search && query.valid;
}

/** The symbol the caret is resting on, or null when nothing should highlight. */
export function symbolUnderCursor(state: EditorState): string | null {
  // A live find query owns the highlight layer — see the header.
  if (searchQueryLive(state)) return null;

  const main = state.selection.main;
  if (state.selection.ranges.length > 1) return null; // multi-caret: no ambient layer

  let name: string | null = null;
  if (main.empty) {
    name =
      identifierNear(
        (from, to) => state.sliceDoc(from, to),
        state.doc.length,
        main.head,
      )?.name ?? null;
  } else {
    // An explicit selection highlights only when it IS exactly one identifier —
    // dragging across `foo(bar` should not start matching anything.
    if (main.to - main.from > 120) return null;
    const text = state.sliceDoc(main.from, main.to);
    if (isIdentifier(text)) {
      const before = state.sliceDoc(Math.max(0, main.from - 1), main.from);
      const after = state.sliceDoc(main.to, Math.min(state.doc.length, main.to + 1));
      if (!/[A-Za-z0-9_$]/.test(before) && !/[A-Za-z0-9_$]/.test(after)) name = text;
    }
  }

  return name && isNavigableSymbol(name) ? name : null;
}

/** Is `pos` in code, rather than inside a comment or a string literal?
 *  Falls back to "yes" whenever the tree can't say — a plain-text buffer has
 *  no nodes to ask, and a missing highlight is worse than a generous one. */
function inCode(state: EditorState, pos: number): boolean {
  try {
    let node = syntaxTree(state).resolveInner(pos, 1);
    for (let depth = 0; node && depth < 4; depth++) {
      if (/Comment|String/.test(node.name)) return false;
      if (!node.parent) break;
      node = node.parent;
    }
  } catch {
    // No parser, or a tree still being built: don't filter.
  }
  return true;
}

/** Whole-word occurrences of `name` inside the visible ranges. */
function scanVisible(view: EditorView, name: string): SymbolRange[] {
  const out: SymbolRange[] = [];
  for (const { from, to } of view.visibleRanges) {
    // Widen by the name's length so an occurrence straddling the boundary is
    // still seen whole; `wordOccurrences` then re-checks the word boundary.
    const start = Math.max(0, from - name.length);
    const end = Math.min(view.state.doc.length, to + name.length);
    const text = view.state.sliceDoc(start, end);
    for (const r of wordOccurrences(text, name, start)) {
      if (out.length && r.from <= out[out.length - 1].from) continue; // window overlap
      if (!inCode(view.state, r.from)) continue;
      out.push(r);
      if (out.length >= MAX_MARKS) return out;
    }
  }
  return out;
}

/** Offset of `symbol`'s best definition in the whole document, or null. */
function scanDefinition(state: EditorState, symbol: string): number | null {
  if (state.doc.length > MAX_DEF_SCAN_BYTES) return null;
  return findDefinitions(state.doc.toString(), symbol)[0]?.from ?? null;
}

function paint(ranges: readonly SymbolRange[], defFrom: number | null): DecorationSet {
  if (!ranges.length) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  for (const r of ranges) {
    builder.add(r.from, r.to, r.from === defFrom ? DEFINITION : OCCURRENCE);
  }
  return builder.finish();
}

/**
 * Registered at low precedence, below `searchMatchHighlight`, so that on the
 * rare overlap the find layer's marks nest outside these and keep their ring.
 */
export const symbolOccurrenceHighlight = Prec.lowest(
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private symbol: string | null = null;
      /** Offset of the symbol's best definition, cached per symbol + doc. */
      private defFrom: number | null = null;
      private queryLive: boolean;

      constructor(view: EditorView) {
        this.queryLive = searchQueryLive(view.state);
        this.decorations = this.compute(view, true);
      }

      update(update: ViewUpdate) {
        // `queryLive` is the fourth signal, and it is not optional: a find
        // query changes none of the other three.
        const queryLive = searchQueryLive(update.state);
        const wake =
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged ||
          queryLive !== this.queryLive;
        this.queryLive = queryLive;
        if (!wake) return;
        this.decorations = this.compute(update.view, update.docChanged);
      }

      private compute(view: EditorView, docChanged: boolean): DecorationSet {
        const symbol = symbolUnderCursor(view.state);
        if (!symbol) {
          this.symbol = null;
          this.defFrom = null;
          return Decoration.none;
        }
        // Re-scan when the symbol changes or the text under it did; a bare
        // caret move or a scroll repaints from the cached offset.
        if (symbol !== this.symbol || docChanged) {
          this.symbol = symbol;
          this.defFrom = scanDefinition(view.state, symbol);
        }
        return paint(scanVisible(view, symbol), this.defFrom);
      }
    },
    { decorations: (v) => v.decorations },
  ),
);
