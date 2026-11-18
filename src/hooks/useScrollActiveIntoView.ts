import { useEffect, useRef, type RefObject } from "react";
import { prefersReducedMotion } from "../lib/motion";

/** The rail marks its active row with `aria-current="location"`; this is the
 *  one hook that brings it into view (#846). */
export const ACTIVE_ROW_SELECTOR = '[aria-current="location"]';

/**
 * Scrolls the active row of a scroll container into view, once per newly
 * active id: switching workspaces, or opening a project whose new workspace
 * lands below the fold. `block: "nearest"` leaves a row that is already
 * visible exactly where it is, so the list never jumps under the cursor.
 * Smooth (calm, browser-paced) unless the user prefers reduced motion.
 *
 * `contentKey` is anything that changes when the rows do (the projects list):
 * an id that becomes active before its row has rendered is scrolled to as soon
 * as the row appears, then never again until another id becomes active.
 */
export function useScrollActiveIntoView(
  containerRef: RefObject<HTMLElement | null>,
  activeId: string | null,
  contentKey: unknown,
): void {
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!activeId) {
      scrolledFor.current = null;
      return;
    }
    if (scrolledFor.current === activeId) return;
    const el = containerRef.current?.querySelector<HTMLElement>(ACTIVE_ROW_SELECTOR);
    if (!el) return; // not rendered yet: retry when the content changes
    el.scrollIntoView?.({
      block: "nearest",
      inline: "nearest",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
    scrolledFor.current = activeId;
  }, [containerRef, activeId, contentKey]);
}
