// src/components/primitives/MidTruncate.tsx

import { useLayoutEffect, useRef, type ReactNode } from "react";

interface Props {
  /** The full string. The caller is responsible for the `title` that carries
   *  it — verbatim: the rendered text folds line breaks and tabs to a space,
   *  the title should not. */
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
 *  elision point tracks the container's width. A layout pass then seats the
 *  `…` flush against the tail (`seatEllipsis`, #750), re-run whenever the
 *  nearest ancestor with a definite width resizes (`widthAnchor`).
 *  The parent should still give it a DEFINITE width — a `flex-1 min-w-0`
 *  item, as in the rail and the ContextHeader. Inside a shrink-to-fit parent
 *  the box is sized from its own text and WebKit hard-cuts it instead of
 *  eliding. */
export function MidTruncate({ text, tail = 12, lead, className = "" }: Props) {
  const boxRef = useRef<HTMLSpanElement>(null);
  const headRef = useRef<HTMLSpanElement>(null);
  const shown = flatten(text);
  const split = shown.length > tail + 4;
  useLayoutEffect(() => {
    const box = boxRef.current;
    const head = headRef.current;
    if (!split || !box || !head) return;
    return track(box, head);
  }, [split, shown, tail, lead, className]);

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
        {shown}
      </span>
    );
  }
  const [headText, tailText] = splitAt(shown, shown.length - tail);
  return (
    <span ref={boxRef} className={`octo-midtrunc ${className}`.trim()}>
      {leadEl}
      <span ref={headRef} className="octo-midtrunc-head">
        {headText}
      </span>
      {/* A real glyph, not CSS `content`: hidden from the accessibility tree
          (the accessible name stays the clean full string) and from a copy,
          and shown only once `seatEllipsis` has cut the head (`data-elided`). */}
      <span className="octo-midtrunc-ell" aria-hidden="true">
        …
      </span>
      <span className="octo-midtrunc-tail">{tailText}</span>
    </span>
  );
}

/** One line, always: a line break or a tab in an identifier renders as a
 *  space (the box is `white-space: nowrap`, which would otherwise collapse a
 *  break into nothing visible at all, or wrap it under `pre`). */
export function flatten(text: string): string {
  return text.replace(/\r\n|[\r\n\t]/g, " ");
}

/** Splits at `at`. Under `nowrap` a space at the very end of the head is a
 *  line-edge space and collapses away — the two halves are separate flex
 *  items — so `deploy (api)` would read `deploy(api)`. Whitespace at the end
 *  of the head moves to the start of the tail instead, and the tail alone is
 *  `white-space: pre` (`.octo-midtrunc-tail`), which keeps it. The text stays
 *  plain spaces, so a copy and the accessible name are the string itself. */
export function splitAt(text: string, at: number): [string, string] {
  let cut = at;
  while (cut > 0 && text[cut - 1] === " ") cut--;
  return [text.slice(0, cut), text.slice(cut)];
}

// ── One observer, batched layout ────────────────────────────────────────
//
// Every MidTruncate on screen (a rail can hold hundreds) shares ONE
// ResizeObserver and ONE animation frame. A frame resets every dirty box,
// then reads them all, then writes them all — one forced layout per frame,
// however many rows changed, instead of one per row.

interface Tracked {
  box: HTMLElement;
  head: HTMLElement;
  ell: HTMLElement | null;
  anchor: Element;
}

const tracked = new Set<Tracked>();
const byAnchor = new Map<Element, Set<Tracked>>();
const lastWidth = new Map<Element, number>();
const dirty = new Set<Tracked>();
let observer: ResizeObserver | null = null;
let frame: (() => void) | null = null; // cancels the pending frame

function track(box: HTMLElement, head: HTMLElement): () => void {
  const anchor = widthAnchor(box);
  const t: Tracked = { box, head, ell: ellOf(box), anchor };
  tracked.add(t);
  let peers = byAnchor.get(anchor);
  if (!peers) {
    byAnchor.set(anchor, (peers = new Set()));
    if (!observer && typeof ResizeObserver !== "undefined") observer = new ResizeObserver(onResize);
    observer?.observe(anchor);
  }
  peers.add(t);
  schedule(t);
  // Widths change once the web fonts land.
  document.fonts?.ready.then(() => tracked.has(t) && schedule(t)).catch(() => {});
  return () => {
    tracked.delete(t);
    dirty.delete(t);
    peers.delete(t);
    if (peers.size === 0) {
      byAnchor.delete(anchor);
      lastWidth.delete(anchor);
      observer?.unobserve(anchor);
    }
    if (tracked.size === 0) {
      observer?.disconnect();
      observer = null;
      frame?.();
      frame = null;
    }
  };
}

function onResize(records: ResizeObserverEntry[]) {
  for (const r of records) {
    const width = r.contentRect.width;
    const before = lastWidth.get(r.target);
    // Under a pixel of slack can't move the cut by a glyph: skip the re-cut.
    // The recorded width only moves when a re-cut is scheduled, so many small
    // steps still add up to one.
    if (before !== undefined && Math.abs(width - before) < 1) continue;
    lastWidth.set(r.target, width);
    for (const t of byAnchor.get(r.target) ?? []) schedule(t);
  }
}

function schedule(t: Tracked) {
  dirty.add(t);
  if (frame !== null) return;
  if (typeof requestAnimationFrame === "function") {
    const id = requestAnimationFrame(flush);
    frame = () => typeof cancelAnimationFrame === "function" && cancelAnimationFrame(id);
  } else {
    const id = setTimeout(flush, 16);
    frame = () => clearTimeout(id);
  }
}

function flush() {
  frame = null;
  const batch = [...dirty].filter((t) => t.box.isConnected);
  dirty.clear();
  for (const t of batch) reset(t.box, t.head); // writes
  const cuts = batch.map((t) => measureCut(t.box, t.head, t.ell)); // reads
  batch.forEach((t, i) => applyCut(t.box, t.head, cuts[i])); // writes
}

/** The element whose width actually bounds the box: the nearest ancestor
 *  whose width does NOT come from its own content. A shrink-to-fit parent
 *  (`FileDiffSection`'s `flex min-w-0` path cell, an inline wrapper) shrinks
 *  when the head is cut and never grows back when the row widens, so
 *  observing it leaves a stale cut; the row it sits in does resize. */
export function widthAnchor(box: HTMLElement): Element {
  let el = box.parentElement;
  while (el && el !== document.body && el !== document.documentElement) {
    if (!sizedByContent(el)) return el;
    el = el.parentElement;
  }
  return el ?? box;
}

function sizedByContent(el: HTMLElement): boolean {
  const cs = getComputedStyle(el);
  if (cs.display === "contents" || cs.display.startsWith("inline") || cs.display.startsWith("table-cell")) return true;
  if (cs.position === "absolute" || cs.position === "fixed") return true;
  if (cs.float && cs.float !== "none") return true;
  const parent = el.parentElement;
  if (!parent) return false;
  const p = getComputedStyle(parent);
  if (!p.display.endsWith("flex")) return false;
  if (p.flexDirection.startsWith("column")) {
    const align = cs.alignSelf && cs.alignSelf !== "auto" ? cs.alignSelf : p.alignItems;
    return !(align === "" || align === "normal" || align === "stretch");
  }
  // A row flex item takes the room its content asks for unless it grows.
  return !(parseFloat(cs.flexGrow) > 0);
}

/** Seats the ellipsis flush against the pinned tail (#750).
 *
 *  `text-overflow: ellipsis` drops every glyph that doesn't fit and draws the
 *  `…` after the last one that does, so the head's box keeps up to a glyph of
 *  empty room AFTER the ellipsis — a gap between `…` and the tail that changes
 *  from row to row, and a visible space when the cut lands after a word. CSS
 *  can't shrink a box to its ellipsized text, so once the head overflows we
 *  cut it ourselves: `data-elided` swaps the head to `text-overflow: clip` and
 *  shows the real, `aria-hidden` `…` span before the tail, and the head's
 *  `max-width` is set to the last grapheme boundary that fits beside the
 *  `…` (its width is reserved; trailing whitespace dropped). Any slack then falls after the tail, where it is just
 *  row space. The full string stays in the DOM, so it is still selectable and
 *  copyable. Right-to-left text keeps the plain CSS ellipsis: the range maths
 *  below measures from the left edge. Without layout (tests, SSR) the CSS
 *  ellipsis is also the fallback. Synchronous; the component batches the
 *  same three steps across every instance (`flush`). */
export function seatEllipsis(box: HTMLElement, head: HTMLElement) {
  reset(box, head);
  applyCut(box, head, measureCut(box, head, ellOf(box)));
}

function ellOf(box: HTMLElement): HTMLElement | null {
  return box.querySelector<HTMLElement>(":scope > .octo-midtrunc-ell");
}

/** Float noise in range maths, not a rounding allowance: the cut must fit. */
const EPS = 0.01;

function reset(box: HTMLElement, head: HTMLElement) {
  box.removeAttribute("data-elided");
  head.style.maxWidth = "";
}

/** The head's new `max-width` in px, or `null` to keep the CSS ellipsis
 *  (nothing to cut, RTL, or no layout). Reads only.
 *
 *  `room` is the head's own width, read while the `…` span takes no room
 *  (`.octo-midtrunc-ell` is zero-width until `data-elided`); the span's
 *  glyph is laid out all the same, so its width is measured in the same
 *  layout and subtracted — head + `…` + tail never exceed the box. */
function measureCut(box: HTMLElement, head: HTMLElement, ell: HTMLElement | null): number | null {
  if (getComputedStyle(box).direction === "rtl") return null;
  const node = head.firstChild;
  if (!(node instanceof Text) || node.length === 0) return null;
  const range = document.createRange();
  if (typeof range.getBoundingClientRect !== "function") return null;
  const rect = head.getBoundingClientRect();
  const left = rect.left;
  const full = rect.width;
  const widthTo = (i: number) => {
    if (i === 0) return 0;
    range.setStart(node, 0);
    range.setEnd(node, i);
    return range.getBoundingClientRect().right - left;
  };
  // The whole head fits: nothing is cut, so no `…` either.
  if (widthTo(node.length) <= full + EPS) return null;
  const room = full - ellipsisWidth(ell, range);
  const fit = lastFitting(graphemeBoundaries(node.data), widthTo, room);
  if (fit >= node.length) return null;
  return widthTo(trimTrailingSpace(node.data, fit));
}

function ellipsisWidth(ell: HTMLElement | null, range: Range): number {
  const glyph = ell?.firstChild;
  if (!(glyph instanceof Text)) return 0;
  range.setStart(glyph, 0);
  range.setEnd(glyph, glyph.length);
  return range.getBoundingClientRect().width;
}

function applyCut(box: HTMLElement, head: HTMLElement, px: number | null) {
  if (px === null) return;
  box.setAttribute("data-elided", "");
  head.style.maxWidth = `${px}px`;
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

/** The largest boundary whose prefix fits in `room` px. `widthTo` must be monotonic, so this is a binary search. */
export function lastFitting(bounds: number[], widthTo: (i: number) => number, room: number): number {
  let lo = 0;
  let hi = bounds.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (widthTo(bounds[mid]) <= room + EPS) lo = mid;
    else hi = mid - 1;
  }
  return bounds[lo];
}

/** Moves a cut back past whitespace, so `Production …` never happens. */
export function trimTrailingSpace(text: string, cut: number): number {
  while (cut > 0 && /\s/.test(text[cut - 1])) cut--;
  return cut;
}
