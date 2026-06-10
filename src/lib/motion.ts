/** Shared check for the user's reduced-motion preference. JS-driven motion
 *  (exit timers, crossfades) must short-circuit through this — CSS motion is
 *  already neutralized globally in styles.css. */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
}
