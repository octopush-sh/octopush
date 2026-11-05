import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject, type TransitionEvent } from "react";
import { useTerminalLayoutStore } from "../stores/terminalLayoutStore";
import { useTerminalSlotsStore } from "../stores/terminalSlotsStore";

/** Longest the hold waits for the Companion's width glide to report its end. */
export const FOLD_SETTLE_FALLBACK_MS = 400;
/** Frames in a row with no slot moving before the hold lets go. */
export const SETTLED_FRAMES = 3;
/** Most frames the release waits for the slots to keep still. */
const MAX_SETTLE_FRAMES = 30;

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
 * timer releases the hold if that end never arrives. Reduced motion holds
 * the same way: its 0.01ms transition still lands the Companion's new width
 * a frame or more after the switch and still reports its end, and without
 * the hold the stale canvas size would reach the PTY ahead of the settled one.
 *
 * `glide` is the gliding element and the width it is headed for. The hold
 * counts still frames only once that width has landed: with reduced motion
 * the end (or the timer) can come before the Companion's new width publishes
 * the slots' new rects, and a release on stillness alone sent the stale size
 * first. A width that never lands still lets go after MAX_SETTLE_FRAMES.
 */
export function useFoldSettle(
  mode: string,
  strip: boolean,
  glide?: { ref: RefObject<HTMLElement | null>; width: number },
) {
  const prev = useRef({ mode, strip });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const gen = useRef(0);
  const glideRef = useRef(glide);
  glideRef.current = glide;

  const release = useCallback(() => {
    if (timer.current === undefined) return;
    clearTimeout(timer.current);
    timer.current = undefined;
    const g = gen.current;
    // The canvas has its final width, but the slots publish it over the next
    // frames (a slot's observer, the host's re-render). Let go once the width
    // has landed and every slot has kept its rect for SETTLED_FRAMES frames in
    // a row since, so the panes fit the settled size, never a stale one.
    const slots = () => useTerminalSlotsStore.getState();
    const landed = () => {
      const el = glideRef.current?.ref.current;
      if (!el) return true;
      return Math.abs(el.getBoundingClientRect().width - glideRef.current!.width) < 1;
    };
    let last = slots();
    let still = 0;
    let left = MAX_SETTLE_FRAMES;
    const tick = () => {
      if (gen.current !== g) return;
      const now = slots();
      still = now.slots === last.slots && now.origin === last.origin && landed() ? still + 1 : 0;
      last = now;
      if (still >= SETTLED_FRAMES || --left <= 0) useTerminalLayoutStore.getState().setSettling(false);
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, []);

  // A layout effect: the hold is on before any pane's observer reports the
  // first step of the glide.
  useLayoutEffect(() => {
    const was = prev.current;
    prev.current = { mode, strip };
    if (was.mode === mode || was.strip === strip) return;
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
