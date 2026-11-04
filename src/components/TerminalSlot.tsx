import { useId, useLayoutEffect, useRef } from "react";
import { useTerminalSlotsStore, type SlotMode } from "../stores/terminalSlotsStore";

/** Longest a slot follows a moving ancestor: past `--dur-standard`'s 320ms. */
const FOLLOW_MS = 400;

interface Props {
  mode: SlotMode;
  /** The session this slot shows, or null for none. */
  terminalId: string | null;
  className?: string;
}

/**
 * An empty box that holds a terminal's place in a mode's layout. It measures
 * itself and publishes its rect to `terminalSlotsStore`; `TerminalHost` draws
 * the pane over it. It renders nothing of the terminal itself.
 */
export function TerminalSlot({ mode, terminalId, className }: Props) {
  const key = useId();
  const ref = useRef<HTMLDivElement>(null);

  // Layout effect: the rect lands in the store before paint, so switching the
  // session in a slot never paints a frame with the old pane in it.
  useLayoutEffect(() => {
    const el = ref.current;
    const { publish, withdraw } = useTerminalSlotsStore.getState();
    if (!el || terminalId === null) {
      withdraw(key);
      return;
    }
    const measure = () => {
      const r = el.getBoundingClientRect();
      publish(key, {
        mode,
        terminalId,
        rect: { left: r.left, top: r.top, width: r.width, height: r.height },
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    // A pane that only moves (Run's grid relaid out at the same size) never
    // trips the ResizeObserver: while an ancestor transitions, follow it on
    // frames for a bounded while, and once more when it ends.
    let frame = 0;
    let until = 0;
    const tick = () => {
      measure();
      frame = performance.now() < until ? requestAnimationFrame(tick) : 0;
    };
    const ancestor = (e: Event) => e.target instanceof Node && e.target !== el && e.target.contains(el);
    const onRun = (e: Event) => {
      if (!ancestor(e)) return;
      until = performance.now() + FOLLOW_MS;
      if (!frame) frame = requestAnimationFrame(tick);
    };
    const onEnd = (e: Event) => {
      if (ancestor(e)) measure();
    };
    document.addEventListener("transitionrun", onRun, true);
    document.addEventListener("transitionend", onEnd, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      document.removeEventListener("transitionrun", onRun, true);
      document.removeEventListener("transitionend", onEnd, true);
      cancelAnimationFrame(frame);
      withdraw(key);
    };
  }, [key, mode, terminalId]);

  return <div ref={ref} data-terminal-slot={mode} className={className ?? "h-full w-full"} />;
}
