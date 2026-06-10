import { useEffect, useRef, useState, type ReactNode } from "react";
import { prefersReducedMotion } from "../../lib/motion";

const EXIT_MS = 120;

interface Props {
  swapKey: string;
  className?: string;
  children: ReactNode;
}

/** Stability rule S3 — no abrupt subtree swaps. Crossfades mutually exclusive
 *  views keyed by `swapKey`: the outgoing subtree fades out (120ms), then the
 *  incoming one mounts with .octo-fade-in. Same-key renders pass children
 *  straight through, so live content inside a view never re-animates. */
export function FadeSwap({ swapKey, className = "", children }: Props) {
  const [view, setView] = useState({ key: swapKey, exiting: false });
  const snapshot = useRef<ReactNode>(children);
  if (swapKey === view.key && !view.exiting) snapshot.current = children;

  useEffect(() => {
    if (swapKey === view.key) {
      setView((v) => (v.exiting ? { ...v, exiting: false } : v));
      return;
    }
    if (prefersReducedMotion()) {
      setView({ key: swapKey, exiting: false });
      return;
    }
    setView((v) => (v.exiting ? v : { ...v, exiting: true }));
    const id = setTimeout(() => setView({ key: swapKey, exiting: false }), EXIT_MS);
    return () => clearTimeout(id);
  }, [swapKey, view.key]);

  const stale = swapKey !== view.key || view.exiting;
  return (
    <div key={view.key} className={`${view.exiting ? "octo-fade-out" : "octo-fade-in"} ${className}`}>
      {stale ? snapshot.current : children}
    </div>
  );
}
