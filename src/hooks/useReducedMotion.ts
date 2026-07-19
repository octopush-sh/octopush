import { useEffect, useState } from "react";
import { prefersReducedMotion } from "../lib/motion";

/** Live version of `prefersReducedMotion()` — re-renders when the OS setting
 *  changes, so JS-driven motion engines (mascot gaze, gesture schedulers,
 *  crossfade timers) can stop mid-flight, matching what the global CSS
 *  neutralizer already does for CSS animation. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq?.addEventListener) return;
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}
