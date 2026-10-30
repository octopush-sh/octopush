// The guided tour on screen: a scrim with a cut-out + hairline brass outline
// around the step's target, and a caption bubble anchored to it (auto-flips at
// the viewport edges). Driven by `useTourStore` / `lib/tour/runner.ts`.
// Pattern: docs/design-system.md §4 "Tour spotlight".
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useTourStore } from "../stores/tourStore";
import { stopTour, tourBack, tourNext } from "../lib/tour/runner";

export interface Box { top: number; left: number; width: number; height: number }

const PAD = 4;
const GAP = 10;
const EDGE = 12;
export const BUBBLE_WIDTH = 300;

/** Where the caption bubble goes: below the spot when it fits, else above,
 *  else wherever it overflows least; horizontally centred on the spot and
 *  clamped inside the viewport. */
export function placeBubble(
  spot: Box,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): { top: number; left: number; side: "below" | "above" } {
  const below = spot.top + spot.height + GAP;
  const above = spot.top - GAP - size.height;
  const fitsBelow = below + size.height <= viewport.height - EDGE;
  const fitsAbove = above >= EDGE;
  const side: "below" | "above" =
    fitsBelow || (!fitsAbove && viewport.height - (spot.top + spot.height) >= spot.top) ? "below" : "above";
  const rawTop = side === "below" ? below : above;
  const top = Math.max(EDGE, Math.min(rawTop, viewport.height - size.height - EDGE));
  const maxLeft = Math.max(EDGE, viewport.width - size.width - EDGE);
  const left = Math.max(EDGE, Math.min(spot.left + spot.width / 2 - size.width / 2, maxLeft));
  return { top, left, side };
}

function spotOf(el: HTMLElement): Box {
  const r = el.getBoundingClientRect();
  return { top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 };
}

const sameBox = (a: Box | null, b: Box) =>
  !!a && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;

const FOCUSABLE = "button:not([disabled])";

export function TourOverlay() {
  const active = useTourStore((s) => s.active);
  const mode = useTourStore((s) => s.mode);
  const steps = useTourStore((s) => s.steps);
  const index = useTourStore((s) => s.index);
  const target = useTourStore((s) => s.target);

  const [spot, setSpot] = useState<Box | null>(null);
  const [bubbleSize, setBubbleSize] = useState({ width: BUBBLE_WIDTH, height: 120 });
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const nextRef = useRef<HTMLButtonElement | null>(null);

  // Remember what had focus when the tour began; give it back when it ends.
  useEffect(() => {
    if (!active) return;
    const opener = document.activeElement;
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [active]);

  // Follow the target every frame (layout shifts, entrance animations, scroll).
  useEffect(() => {
    if (!target) return;
    let raf = 0;
    const tick = () => {
      const next = spotOf(target);
      setSpot((prev) => (sameBox(prev, next) ? prev : next));
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [target]);

  useEffect(() => {
    if (!active) setSpot(null);
  }, [active]);

  useLayoutEffect(() => {
    const el = bubbleRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && (r.width !== bubbleSize.width || r.height !== bubbleSize.height)) {
      setBubbleSize({ width: r.width, height: r.height });
    }
  });

  // Focus the primary control on each step (once the bubble is placed).
  const placed = spot !== null;
  useEffect(() => {
    if (target && placed && mode === "interactive") nextRef.current?.focus({ preventScroll: true });
  }, [target, index, mode, placed]);

  // Escape closes; ←/→ page. Capture phase + stopPropagation so the surface
  // underneath (Settings, the palette) doesn't also react.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        stopTour();
      } else if (mode === "interactive" && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "ArrowRight") tourNext();
        else tourBack();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, mode]);

  if (!active) return null;

  const step = index >= 0 ? steps[index] : undefined;
  const last = index >= steps.length - 1;
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const place = spot ? placeBubble(spot, bubbleSize, viewport) : null;

  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const items = Array.from(bubbleRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0];
    const lastItem = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      lastItem.focus();
    } else if (!e.shiftKey && document.activeElement === lastItem) {
      e.preventDefault();
      first.focus();
    } else if (!items.includes(document.activeElement as HTMLElement)) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[60] octo-overlay-enter" data-testid="tour-overlay">
      {/* Click-catcher: the app underneath is look-don't-touch during a tour. */}
      <div className="absolute inset-0" aria-hidden onMouseDown={(e) => e.preventDefault()} />
      {spot && (
        <div
          className="octo-tour-spot"
          data-testid="tour-spot"
          style={{ top: spot.top, left: spot.left, width: spot.width, height: spot.height }}
        />
      )}
      {step && target && place && (
        <div
          ref={bubbleRef}
          role="dialog"
          aria-modal="true"
          aria-label="Guided tour"
          onKeyDown={trapTab}
          className="absolute rounded-lg border border-octo-hairline bg-octo-panel px-4 pb-3 pt-3"
          style={{ top: place.top, left: place.left, width: Math.min(BUBBLE_WIDTH, viewport.width - EDGE * 2) }}
        >
          <div key={index} className="octo-fade-in">
            <div className="flex items-start gap-3">
              <p className="m-0 flex-1 text-[13px] leading-[1.55] text-octo-ivory">{step.caption}</p>
              {mode === "interactive" && (
                <button
                  type="button"
                  onClick={() => stopTour()}
                  title="Close tour"
                  aria-label="Close tour"
                  className="flex shrink-0 items-center justify-center rounded p-1 text-octo-mute transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
                >
                  <X size={12} />
                </button>
              )}
            </div>
            <div className="mt-3 flex items-center gap-2">
              <span className="octo-tabular font-mono text-[10px] tracking-[0.15em] text-octo-mute">
                {index + 1} / {steps.length}
              </span>
              {mode === "interactive" && (
                <>
                  <button
                    type="button"
                    onClick={() => tourBack()}
                    disabled={index === 0}
                    className="ml-auto rounded-md border border-octo-hairline px-3 py-1 font-serif text-[13px] text-octo-sage transition-colors hover:text-octo-ivory disabled:opacity-40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
                  >
                    Back
                  </button>
                  <button
                    ref={nextRef}
                    type="button"
                    onClick={() => tourNext()}
                    className="rounded-md border border-[var(--brass-dim)] bg-[var(--brass-ghost)] px-3 py-1 font-serif text-[13px] text-octo-brass transition-colors hover:text-octo-brass-hi focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
                  >
                    {last ? "Done" : "Next"}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
