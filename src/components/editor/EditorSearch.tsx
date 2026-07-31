/**
 * EditorSearch — Octopush-native find/replace for the CodeMirror editor.
 *
 * Replaces CodeMirror's built-in search panel (which docks at the top of the
 * viewport and wears the library's own chrome) with a calm floating card that
 * follows the Atelier design system. It drives the editor through the public
 * `@codemirror/search` command API, so regex, case- and whole-word matching,
 * and replace all behave exactly as CodeMirror's own.
 *
 * Match highlighting is the one thing that does NOT come for free: CodeMirror's
 * highlighter only runs while its own panel is open, which this overlay
 * deliberately prevents. `editor/searchHighlight.ts` supplies the marks.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Search,
  ArrowUp,
  ArrowDown,
  CaseSensitive,
  Regex,
  WholeWord,
  Replace,
  X,
} from "lucide-react";
import type { EditorView } from "@codemirror/view";
import {
  SearchQuery,
  setSearchQuery,
  findNext,
  findPrevious,
  replaceNext,
  replaceAll,
} from "@codemirror/search";

interface Props {
  view: EditorView;
  /** Bumped by the host each time the user presses ⌘F so an already-open
   *  overlay refocuses and selects its query rather than doing nothing. */
  focusSignal: number;
  /** What the host is searching, for the label and placeholder. A scratchpad
   *  tab isn't a file, and two mounted overlays need distinguishable landmarks
   *  (every mode stays mounted, so REVIEW and the scratchpad can both be up). */
  scope?: string;
  onClose: () => void;
}

const MAX_COUNT = 10_000;

/** Clears the editor's search query, and with it every match highlight. */
const EMPTY_QUERY = new SearchQuery({ search: "" });

/** Count matches for `query` and, when the current selection sits on one,
 *  which 1-based index it is — for the "n of m" readout. */
function countMatches(view: EditorView, query: SearchQuery): { count: number; current: number } {
  if (!query.search || !query.valid) return { count: 0, current: 0 };
  const sel = view.state.selection.main;
  let count = 0;
  let current = 0;
  try {
    const cursor = query.getCursor(view.state);
    let res = cursor.next();
    while (!res.done && count < MAX_COUNT) {
      count += 1;
      if (res.value.from === sel.from && res.value.to === sel.to) current = count;
      res = cursor.next();
    }
  } catch {
    return { count: 0, current: 0 };
  }
  return { count, current };
}

export function EditorSearch({ view, focusSignal, scope = "file", onClose }: Props) {
  const [search, setSearch] = useState("");
  const [replace, setReplace] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regexp, setRegexp] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [tally, setTally] = useState<{ count: number; current: number }>({ count: 0, current: 0 });

  const searchRef = useRef<HTMLInputElement>(null);

  const query = useMemo(
    () => new SearchQuery({ search, replace, caseSensitive, regexp, wholeWord }),
    [search, replace, caseSensitive, regexp, wholeWord],
  );

  const invalidRegex = regexp && search.length > 0 && !query.valid;

  // On each ⌘F (mount, and every focusSignal bump): seed the query from the
  // current selection like a native find, then focus + select the field so
  // typing replaces it.
  useEffect(() => {
    const sel = view.state.selection.main;
    if (!sel.empty) {
      const picked = view.state.sliceDoc(sel.from, sel.to);
      if (picked && !picked.includes("\n")) setSearch(picked);
    }
    const el = searchRef.current;
    if (el) {
      el.focus();
      el.select();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSignal]);

  // Push the query into the editor (drives highlighting) and refresh the tally.
  useEffect(() => {
    if (!query.valid) {
      // `valid` is false for an EMPTY search as well as a broken regex
      // (`!!this.search && (!this.regexp || validRegExp(…))`), so this branch
      // covers clearing the field. It has to clear the editor's query too:
      // returning early leaves the previous one in place, which used to be
      // invisible but now means the old matches stay lit while the field reads
      // empty or "bad pattern".
      view.dispatch({ effects: setSearchQuery.of(EMPTY_QUERY) });
      setTally({ count: 0, current: 0 });
      return;
    }
    view.dispatch({ effects: setSearchQuery.of(query) });
    setTally(countMatches(view, query));
  }, [query, view]);

  const refreshTally = () => setTally(countMatches(view, query));

  const goNext = () => { if (query.valid && query.search) { findNext(view); refreshTally(); } };
  const goPrev = () => { if (query.valid && query.search) { findPrevious(view); refreshTally(); } };

  const doReplace = () => { if (query.valid && query.search) { replaceNext(view); refreshTally(); } };
  const doReplaceAll = () => { if (query.valid && query.search) { replaceAll(view); refreshTally(); } };

  const close = () => {
    // Clear the query so match highlights vanish, then hand focus back.
    view.dispatch({ effects: setSearchQuery.of(EMPTY_QUERY) });
    view.focus();
    onClose();
  };

  const onSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.shiftKey ? goPrev() : goNext();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  const countLabel = invalidRegex
    ? "bad pattern"
    : !search
      ? ""
      : tally.count === 0
        ? "no results"
        : tally.current > 0
          ? `${tally.current} of ${tally.count}`
          : `${tally.count}${tally.count >= MAX_COUNT ? "+" : ""} found`;

  return (
    <div
      role="search"
      aria-label={`Find in ${scope}`}
      // max-w rather than a fixed width: the scratchpad's column can be squeezed
      // to 20% of the canvas, where a hard 320px is clipped by two nested
      // overflow-hidden ancestors and loses the left edge of the input.
      className="octo-modal-enter absolute right-3 top-3 z-20 w-full max-w-[320px] rounded-md border border-octo-hairline bg-octo-panel/95 p-2 shadow-2xl backdrop-blur-sm"
    >
      {/* ── Find row ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-1.5">
        <Search size={12} className="shrink-0 text-octo-mute" aria-hidden />
        <input
          ref={searchRef}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={onSearchKeyDown}
          aria-label="Find"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          placeholder={`Find in ${scope}`}
          className={`min-w-0 flex-1 bg-transparent font-mono text-[12px] text-octo-ivory outline-none placeholder:font-serif placeholder:not-italic placeholder:text-octo-mute ${
            invalidRegex ? "text-octo-rouge" : ""
          }`}
        />
        <span
          className={`shrink-0 font-mono text-[10px] tabular-nums ${
            invalidRegex ? "text-octo-rouge" : "text-octo-mute"
          }`}
          aria-live="polite"
        >
          {countLabel}
        </span>
        <div className="flex shrink-0 items-center">
          <ToggleIcon active={caseSensitive} onClick={() => setCaseSensitive((v) => !v)} title="Match case">
            <CaseSensitive size={13} />
          </ToggleIcon>
          <ToggleIcon active={wholeWord} onClick={() => setWholeWord((v) => !v)} title="Match whole word">
            <WholeWord size={13} />
          </ToggleIcon>
          <ToggleIcon active={regexp} onClick={() => setRegexp((v) => !v)} title="Use regular expression">
            <Regex size={13} />
          </ToggleIcon>
        </div>
        <div className="flex shrink-0 items-center">
          <IconBtn onClick={goPrev} title="Previous match (⇧⏎)" aria-label="Previous match">
            <ArrowUp size={13} />
          </IconBtn>
          <IconBtn onClick={goNext} title="Next match (⏎)" aria-label="Next match">
            <ArrowDown size={13} />
          </IconBtn>
          <IconBtn
            onClick={() => setShowReplace((v) => !v)}
            title={showReplace ? "Hide replace" : "Show replace"}
            aria-label="Toggle replace"
            active={showReplace}
          >
            <Replace size={13} />
          </IconBtn>
          <IconBtn onClick={close} title="Close (Esc)" aria-label="Close find">
            <X size={13} />
          </IconBtn>
        </div>
      </div>

      {/* ── Replace row — calm collapse via grid-rows 0fr↔1fr ─────── */}
      <div
        className="grid transition-[grid-template-rows] duration-[var(--dur-quick)] ease-[var(--ease-octo)]"
        style={{ gridTemplateRows: showReplace ? "1fr" : "0fr" }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="mt-1.5 flex items-center gap-1.5 border-t border-octo-hairline pt-1.5">
            <Replace size={12} className="shrink-0 text-octo-mute" aria-hidden />
            <input
              value={replace}
              onChange={(e) => setReplace(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
                if (e.key === "Enter") { e.preventDefault(); doReplace(); }
              }}
              aria-label="Replace with"
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              placeholder="Replace with"
              className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-octo-ivory outline-none placeholder:font-serif placeholder:not-italic placeholder:text-octo-mute"
            />
            <button
              type="button"
              onClick={doReplace}
              title="Replace this match"
              className="shrink-0 rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-octo-sage transition-colors hover:text-octo-ivory focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
            >
              Replace
            </button>
            <button
              type="button"
              onClick={doReplaceAll}
              title="Replace all matches"
              className="shrink-0 rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-octo-brass transition-colors hover:text-octo-brass-hi focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
              style={{ border: "1px solid var(--brass-dim)" }}
            >
              All
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Small controls ──────────────────────────────────────────────

function IconBtn({
  children,
  onClick,
  title,
  active,
  "aria-label": ariaLabel,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  active?: boolean;
  "aria-label"?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={ariaLabel ?? title}
      className={`flex h-6 w-6 items-center justify-center rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass ${
        active ? "text-octo-brass" : "text-octo-mute hover:text-octo-sage"
      }`}
    >
      {children}
    </button>
  );
}

/** A toggle that reads brass when on; used for the case/regex/word switches. */
function ToggleIcon({
  children,
  onClick,
  title,
  active,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
  active: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      className={`flex h-6 w-6 items-center justify-center rounded transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass ${
        active ? "text-octo-brass" : "text-octo-mute hover:text-octo-sage"
      }`}
      style={active ? { background: "var(--brass-ghost)" } : undefined}
    >
      {children}
    </button>
  );
}
