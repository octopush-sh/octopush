import { useCallback, useEffect, useLayoutEffect, useRef, type TransitionEvent } from "react";
import { useTerminalLayoutStore } from "../stores/terminalLayoutStore";
import { prefersReducedMotion } from "../lib/motion";

/** Longest the hold waits for the Companion's width glide to report its end. */
export const FOLD_SETTLE_FALLBACK_MS = 400;

/**
 * A mode switch that flips the Companion between its strip and its width
 * (`strip`, e.g. Run with one pane ↔ Talk with its seat open) glides the
 * canvas wider or narrower. Without a hold, every visible PTY would hear each
 * step of that glide. This holds every PTY's size (`terminalLayoutStore`
 * `settling`, the same suspension as a divider drag: panes refit on frames,
 * `TerminalPane` sends the size on release) from the switch until the glide
 * ends, so each visible PTY gets exactly one `resize_session`.
 *
 * Returns the `onTransitionEnd` for the element whose `width` glides. A
 * timer releases the hold if that end never arrives. Reduced motion has no
 * glide and no hold.
 */
export function useFoldSettle(mode: string, strip: boolean) {
  const prev = useRef({ mode, strip });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const gen = useRef(0);

  const release = useCallback(() => {
    if (timer.current === undefined) return;
    clearTimeout(timer.current);
    timer.current = undefined;
    const g = gen.current;
    // Two frames: the slots publish the settled rects before the panes fit.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (gen.current === g) useTerminalLayoutStore.getState().setSettling(false);
      }),
    );
  }, []);

  // A layout effect: the hold is on before any pane's observer reports the
  // first step of the glide.
  useLayoutEffect(() => {
    const was = prev.current;
    prev.current = { mode, strip };
    if (was.mode === mode || was.strip === strip || prefersReducedMotion()) return;
    gen.current += 1;
    useTerminalLayoutStore.getState().setSettling(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(release, FOLD_SETTLE_FALLBACK_MS);
  }, [mode, strip, release]);

  useEffect(
    () => () => {
      clearTimeout(timer.current);
      gen.current += 1;
      useTerminalLayoutStore.getState().setSettling(false);
    },
    [],
  );

  return useCallback(
    (e: TransitionEvent<HTMLElement>) => {
      if (e.target === e.currentTarget && e.propertyName === "width") release();
    },
    [release],
  );
}
