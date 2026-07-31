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
 * the native panel IS open — `searchKeymap` can still open it (⌘G/F3/⌘D fall
 * through to `openSearchPanel` when there's no valid query), and running both
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

/** How far past a visible range to search, so a match straddling the boundary
 *  isn't lost. Mirrors `RegExpQuery.highlight`'s own margin; it also sets the
 *  gap at which two visible ranges are merged, which is what keeps the widened
 *  windows from overlapping and reporting a match twice. */
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
  // `unquoted` isn't public, and unquoting only ever shortens the needle, so
  // `search.length` is a safe over-estimate. Capped at the margin so the
  // widened windows can't overlap and double-report a match.
  const pad = query.regexp
    ? HIGHLIGHT_MARGIN
    : Math.min(query.search.length, HIGHLIGHT_MARGIN);

  const matches: Match[] = [];
  const ranges = view.visibleRanges;
  let lastFrom = -1;
  let lastTo = -1;

  try {
    for (let i = 0; i < ranges.length; i++) {
      let { from, to } = ranges[i];
      // Merge ranges closer than twice the margin: scanning the gap costs less
      // than restarting the cursor, and it guarantees non-overlapping windows.
      while (i < ranges.length - 1 && to > ranges[i + 1].from - 2 * HIGHLIGHT_MARGIN) {
        to = ranges[++i].to;
      }
      const cursor = query.getCursor(
        view.state,
        Math.max(0, from - pad),
        Math.min(docLength, to + pad),
      );
      for (let res = cursor.next(); !res.done; res = cursor.next()) {
        const { from: mFrom, to: mTo } = res.value;
        // A mark decoration may not be empty and RangeSetBuilder throws on one,
        // so an all-optional regex match is skipped.
        if (mFrom >= mTo) continue;
        // RangeSetBuilder requires a non-decreasing `from`. Ranges are ascending
        // and the windows can't overlap, so this shouldn't trigger — it's here
        // so a surprise from the cursor degrades into a missing highlight
        // instead of an exception in the render path.
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
