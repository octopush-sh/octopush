/**
 * Match highlighting for Octopush's own find overlay.
 *
 * `@codemirror/search` only highlights matches while ITS OWN panel is open —
 * its `searchHighlighter` opens with `if (!panel || !query.spec.valid) return
 * Decoration.none`. `EditorSearch` replaces that panel with a React overlay and
 * drives the editor through `setSearchQuery`, so with the panel closed the
 * built-in highlighter emitted nothing at all and matches were invisible no
 * matter how `.cm-searchMatch` was styled; the only feedback was the current
 * match's text selection, painted in an 8%-alpha wash.
 *
 * This fills that gap, reusing CodeMirror's own class names so one set of theme
 * rules (see `atelierTheme.ts`) covers both. It deliberately stands down when
 * the native panel IS open — `searchKeymap` can still open it (`findNext` and
 * `findPrevious`, i.e. ⌘G/F3, are wrapped in `searchCommand`, which falls through
 * to `openSearchPanel` when there's no valid query), and running both
 * highlighters nests two `.cm-searchMatch` spans, doubling the wash and the
 * ring.
 */

import {
  Decoration,
  ViewPlugin,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from "@codemirror/view";
import { Prec, RangeSetBuilder, type EditorState } from "@codemirror/state";
import { getSearchQuery, searchPanelOpen, type SearchQuery } from "@codemirror/search";

/** The exact classes CodeMirror's own highlighter applies. */
const MATCH = Decoration.mark({ class: "cm-searchMatch" });
const CURRENT = Decoration.mark({ class: "cm-searchMatch cm-searchMatch-selected" });

/** How far past a visible range to search for a REGEX match, so one straddling
 *  the boundary isn't lost. Mirrors `RegExpQuery.highlight`'s own margin. */
const HIGHLIGHT_MARGIN = 250;

/** Ceiling on decorated matches per pass. The viewport already bounds this;
 *  this is insurance against a query like `x?` over a very tall viewport. */
const MAX_MATCHES = 2000;

interface Match {
  from: number;
  to: number;
}

/**
 * Do two queries match the same text?
 *
 * Not `SearchQuery.eq`, which is wrong in both directions here: it compares
 * `replace` (so every keystroke in the Replace field would force a rescan) and
 * it does NOT compare `literal` (which changes `unquoted`, and therefore what
 * matches, without changing anything `eq` looks at). The built-in sidesteps
 * this by comparing its whole state field by identity.
 */
function sameMatching(a: SearchQuery, b: SearchQuery): boolean {
  return (
    a.search === b.search &&
    a.caseSensitive === b.caseSensitive &&
    a.regexp === b.regexp &&
    a.wholeWord === b.wholeWord &&
    a.literal === b.literal &&
    a.test === b.test
  );
}

/** Find every match in (roughly) the visible ranges. */
function scan(view: EditorView): Match[] {
  const query = getSearchQuery(view.state);
  if (!query.search || !query.valid) return [];

  const docLength = view.state.doc.length;
  // Widen each scan window by `pad` so a match straddling a visible-range
  // boundary is still found — the built-in does the same. For a string query
  // that's the needle's length: `unquoted` isn't public, but unquoting only ever
  // shortens (`\n`/`\t`/`\\` collapse 2 chars to 1), so `search.length` is a
  // safe over-estimate. Deliberately uncapped, matching `StringQuery.highlight`;
  // the merge gap below is derived from `pad` so the windows still can't overlap.
  const pad = query.regexp ? HIGHLIGHT_MARGIN : query.search.length;

  const matches: Match[] = [];
  const ranges = view.visibleRanges;
  let lastFrom = -1;
  let lastTo = -1;

  try {
    for (let i = 0; i < ranges.length; i++) {
      let { from, to } = ranges[i];
      // Merge ranges closer than twice the pad: scanning the gap costs less than
      // restarting the cursor, and it's what guarantees the widened windows never
      // overlap. After merging, the gap to the next range is >= 2 * pad, so this
      // window ends at or before the next one begins — a match can't be reported
      // (and washed) twice.
      while (i < ranges.length - 1 && to > ranges[i + 1].from - 2 * pad) {
        to = ranges[++i].to;
      }
      const cursor = query.getCursor(
        view.state,
        Math.max(0, from - pad),
        Math.min(docLength, to + pad),
      );
      for (let res = cursor.next(); !res.done; res = cursor.next()) {
        const { from: mFrom, to: mTo } = res.value;
        // RegExpCursor really does yield empty matches; skipping them keeps a
        // zero-width span out of the DOM. (RangeSetBuilder.add tolerates an empty
        // range — the throw lives in MarkDecoration.range, which add never calls.)
        if (mFrom >= mTo) continue;
        // `mFrom < lastFrom` is the one case add() genuinely throws on, and the
        // duplicate case would silently spawn a second RangeSet layer, i.e. two
        // stacked washes. Neither should be reachable — ranges are ascending and
        // the windows can't overlap — so this degrades a surprise from the cursor
        // into a missing highlight rather than a broken render.
        if (mFrom < lastFrom || (mFrom === lastFrom && mTo === lastTo)) continue;
        matches.push({ from: mFrom, to: mTo });
        lastFrom = mFrom;
        lastTo = mTo;
        if (matches.length >= MAX_MATCHES) return matches;
      }
    }
  } catch {
    // A pattern that passes `valid` can still throw mid-scan. Keep what was
    // collected rather than dropping the highlight entirely.
  }

  return matches;
}

/** Turn cached match positions into decorations, tagging the one the selection
 *  sits on — that's what `findNext`/`findPrevious` move. */
function paint(matches: readonly Match[], state: EditorState): DecorationSet {
  if (!matches.length) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  const selection = state.selection;
  for (const m of matches) {
    const isCurrent = selection.ranges.some((r) => r.from === m.from && r.to === m.to);
    builder.add(m.from, m.to, isCurrent ? CURRENT : MATCH);
  }
  return builder.finish();
}

/** Registered at low precedence, matching the built-in, which puts the match
 *  mark OUTSIDE the syntax spans — see the `.cm-searchMatch span` rule. */
export const searchMatchHighlight = Prec.low(
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      /** Cached so moving the cursor doesn't re-run the search. */
      private matches: Match[];
      private query: SearchQuery;
      private panelOpen: boolean;

      constructor(view: EditorView) {
        this.query = getSearchQuery(view.state);
        this.panelOpen = searchPanelOpen(view.state);
        this.matches = this.panelOpen ? [] : scan(view);
        this.decorations = paint(this.matches, view.state);
      }

      update(update: ViewUpdate) {
        const panelOpen = searchPanelOpen(update.state);
        const query = getSearchQuery(update.state);
        const rescan =
          update.docChanged ||
          update.viewportChanged ||
          panelOpen !== this.panelOpen ||
          !sameMatching(query, this.query);

        if (rescan) {
          this.query = query;
          this.panelOpen = panelOpen;
          this.matches = panelOpen ? [] : scan(update.view);
        } else if (!update.selectionSet) {
          return;
        }
        // A bare cursor move lands here: it only moves which match is current,
        // so it repaints from the cache without searching again. That matters
        // because a pathological regex can take seconds per scan, and this
        // fires on every arrow key while a query is live.
        this.decorations = paint(this.matches, update.state);
      }
    },
    { decorations: (v) => v.decorations },
  ),
);
