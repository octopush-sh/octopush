import { useCallback, useLayoutEffect, useState } from "react";

/** Used before the first measurement lands (and under jsdom, where layout
 *  never produces a clientHeight) — roughly one Companion panel of rows. */
const FALLBACK_VIEWPORT = 600;

export interface VirtualWindow {
  /** First row index to mount (inclusive). */
  start: number;
  /** One past the last row index to mount (exclusive). */
  end: number;
  /** Height of the spacer standing in for the rows above the window. */
  topPad: number;
  /** Height of the spacer standing in for the rows below the window. */
  bottomPad: number;
  /** Nudge the container so row `index` is inside the viewport, syncing the
   *  window state in the same tick (scroll events are asynchronous — and
   *  never fire from scrollTop assignment under jsdom). */
  scrollToRow: (index: number) => void;
}

/**
 * Zero-dependency windowing for a flat list of fixed-height rows inside a
 * scrolling container: tracks scrollTop (quantized to row buckets, so a
 * smooth scroll re-renders at most once per row) and the container height
 * (ResizeObserver, when the environment has one), and returns the slice of
 * rows worth mounting plus the spacer heights that keep the scrollbar honest.
 */
export function useVirtualRows(
  containerRef: React.RefObject<HTMLElement | null>,
  rowCount: number,
  rowHeight: number,
  overscan = 10,
): VirtualWindow {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setViewport(el.clientHeight);
    const onScroll = () => {
      setScrollTop((prev) => {
        const next = el.scrollTop;
        return Math.floor(next / rowHeight) === Math.floor(prev / rowHeight) ? prev : next;
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => setViewport(el.clientHeight));
      ro.observe(el);
    }
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro?.disconnect();
    };
  }, [containerRef, rowHeight]);

  const height = viewport || FALLBACK_VIEWPORT;
  // Clamp into the list — the row count can shrink under a large scrollTop
  // (e.g. a filter applied while scrolled deep).
  const start = Math.min(
    Math.max(0, rowCount - 1),
    Math.max(0, Math.floor(scrollTop / rowHeight) - overscan),
  );
  const end = Math.min(rowCount, Math.ceil((scrollTop + height) / rowHeight) + overscan);

  const scrollToRow = useCallback(
    (index: number) => {
      const el = containerRef.current;
      if (!el) return;
      const h = el.clientHeight || FALLBACK_VIEWPORT;
      const top = index * rowHeight;
      const bottom = top + rowHeight;
      let next = el.scrollTop;
      if (top < next) next = top;
      else if (bottom > next + h) next = bottom - h;
      if (next !== el.scrollTop || next !== scrollTop) {
        el.scrollTop = next;
        setScrollTop(next);
      }
    },
    [containerRef, rowHeight, scrollTop],
  );

  return {
    start,
    end,
    topPad: start * rowHeight,
    bottomPad: Math.max(0, (rowCount - end) * rowHeight),
    scrollToRow,
  };
}
