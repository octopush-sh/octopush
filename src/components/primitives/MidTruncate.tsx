// src/components/primitives/MidTruncate.tsx

import { useLayoutEffect, useRef, type ReactNode } from "react";

interface Props {
  /** The full string. The caller is responsible for the `title` that carries it. */
  text: string;
  /** How many trailing characters stay pinned. Below `tail + 4` the string
   *  renders whole — eliding two characters out of the middle of a short name
   *  costs more legibility than it buys. */
  tail?: number;
  /** Optional glyph drawn INSIDE the box, before the text, and never shrunk
   *  (the ContextHeader's `GitBranch`). Inside, so a wash or a ring drawn on
   *  the box covers glyph and text as one chip. */
  lead?: ReactNode;
  className?: string;
}

/** Middle truncation for identifiers whose head AND tail disambiguate —
 *  branch names above all. `truncate` keeps the head and discards exactly the
 *  part that tells `…-per-shard-copy` from `…-per-shard-guard` apart; this
 *  keeps both ends and elides the middle instead.
 *
 *  CSS does the layout (design-system §6, `.octo-midtrunc`): the head
 *  ellipsizes into whatever space is left over and the tail is pinned, so the
 *  elision point tracks the container's width. One layout pass then seats
 *  the `…` flush against the tail (`seatEllipsis`, #750).
 *  The parent must give it a DEFINITE width — a `flex-1 min-w-0` item, as in
 *  the rail and the ContextHeader. Inside a shrink-to-fit parent the box is
 *  sized from its own text and WebKit hard-cuts it instead of eliding. */
export function MidTruncate({ text, tail = 12, lead, className = "" }: Props) {
  const boxRef = useRef<HTMLSpanElement>(null);
  const headRef = useRef<HTMLSpanElement>(null);
  const split = text.length > tail + 4;
  useLayoutEffect(() => {
    const box = boxRef.current;
    const head = headRef.current;
    if (!split || !box || !head) return;
    let alive = true;
    const fit = () => alive && seatEllipsis(box, head);
    fit();
    // The parent, not the box: the box shrinks when the head is cut, and
    // observing it would feed the cut back into the measurement.
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    ro?.observe(box.parentElement ?? box);
    // Widths change once the web fonts land.
    document.fonts?.ready.then(fit).catch(() => {});
    return () => {
      alive = false;
      ro?.disconnect();
    };
  }, [split, text, tail]);

  const leadEl =
    lead != null ? (
      <span className="octo-midtrunc-lead" aria-hidden>
        {lead}
      </span>
    ) : null;
  // The short path is a plain truncating line, NOT the flex box — a bare
  // string inside a flex container is an anonymous flex item that wraps at
  // every hyphen and slash. See `.octo-midtrunc-whole` in styles.css.
  if (!split) {
    return (
      <span className={`octo-midtrunc-whole ${className}`.trim()}>
        {leadEl}
        {text}
      </span>
    );
  }
  return (
    <span ref={boxRef} className={`octo-midtrunc ${className}`.trim()}>
      {leadEl}
      <span ref={headRef} className="octo-midtrunc-head">
        {text.slice(0, text.length - tail)}
      </span>
      <span className="octo-midtrunc-tail">{text.slice(text.length - tail)}</span>
    </span>
  );
}

/** Seats the ellipsis flush against the pinned tail (#750).
 *
 *  `text-overflow: ellipsis` drops every glyph that doesn't fit and draws the
 *  `…` after the last one that does, so the head's box keeps up to a glyph of
 *  empty room AFTER the ellipsis — a gap between `…` and the tail that changes
 *  from row to row, and a visible space when the cut lands after a word. CSS
 *  can't shrink a box to its ellipsized text, so once the head overflows we
 *  cut it ourselves: `data-elided` swaps the head to `text-overflow: clip` and
 *  draws the `…` as the tail's `::before`, and the head's `max-width` is set to
 *  the last grapheme boundary that fits (trailing whitespace dropped). Any
 *  slack then falls after the tail, where it is just row space. The full
 *  string stays in the DOM, so it is still selectable and copyable; without
 *  layout (tests, SSR) the plain CSS ellipsis remains the fallback. */
export function seatEllipsis(box: HTMLElement, head: HTMLElement) {
  box.removeAttribute("data-elided");
  head.style.maxWidth = "";
  if (head.scrollWidth <= head.clientWidth) return;
  const node = head.firstChild;
  if (!(node instanceof Text)) return;
  box.setAttribute("data-elided", "");
  const left = head.getBoundingClientRect().left;
  const room = head.clientWidth;
  const range = document.createRange();
  const widthTo = (i: number) => {
    if (i === 0) return 0;
    range.setStart(node, 0);
    range.setEnd(node, i);
    return range.getBoundingClientRect().right - left;
  };
  const cut = trimTrailingSpace(node.data, lastFitting(graphemeBoundaries(node.data), widthTo, room));
  head.style.maxWidth = `${widthTo(cut)}px`;
}

/** Offsets (UTF-16) at which `text` may be cut without splitting a grapheme:
 *  an emoji or a combining accent is never halved. Ascending, starts at 0. */
export function graphemeBoundaries(text: string): number[] {
  const out = [0];
  const Seg = (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (Seg) {
    for (const { index, segment } of new Seg(undefined, { granularity: "grapheme" }).segment(text)) {
      out.push(index + segment.length);
    }
  } else {
    let i = 0;
    for (const ch of text) out.push((i += ch.length));
  }
  return out;
}

/** The largest boundary whose prefix fits in `room` px (half a pixel of
 *  rounding forgiven). `widthTo` must be monotonic, so this is a binary search. */
export function lastFitting(bounds: number[], widthTo: (i: number) => number, room: number): number {
  let lo = 0;
  let hi = bounds.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (widthTo(bounds[mid]) <= room + 0.5) lo = mid;
    else hi = mid - 1;
  }
  return bounds[lo];
}

/** Moves a cut back past whitespace, so `Production …` never happens. */
export function trimTrailingSpace(text: string, cut: number): number {
  while (cut > 0 && /\s/.test(text[cut - 1])) cut--;
  return cut;
}
