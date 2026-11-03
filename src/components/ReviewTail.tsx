import { useLayoutEffect, useRef, useState } from "react";
import type { ReviewTailParts } from "../lib/modeMeta";

/** The flex gap between atoms — the `margin-right: -8px` a shed
 *  `.octo-demote` rung uses to eat its gap assumes exactly this. */
const GAP_PX = 8;

/** How many rungs to shed so the tail fits in `available` px. `rungs` are the
 *  natural widths of the sheddable atoms in shed order (first shed first);
 *  the floor never sheds — when even it doesn't fit, it is the one elastic
 *  atom and truncates. Exported for tests: jsdom has no layout. */
export function rungsToShed(available: number, floor: number, rungs: readonly number[]): number {
  for (let shed = 0; shed < rungs.length; shed++) {
    const kept = rungs.slice(shed);
    const width = floor + kept.reduce((sum, w) => sum + GAP_PX + w, 0);
    if (width <= available) return shed;
  }
  return rungs.length;
}

interface Props {
  parts: ReviewTailParts;
  /** The full reading ("2 files changed · +2 −1"), kept in the tooltip so a
   *  shed atom is never lost (E2 rule 2). */
  label: string;
}

/** The Review status tail on the E2 demotion ladder. Truncating the whole
 *  line kept the fixed prefix and cut the part that varies, so the band
 *  read "2 FILES CHANGED · …". Instead every rung is `flex: none` and sheds
 *  whole, in a stated order:
 *
 *    1st    "changed"          — implied by the Review mode itself
 *    2nd    "· +2 −1"          — the tooltip, and the diff below
 *    floor  "2 files"          — never sheds; the one elastic atom
 *
 *  The rungs are shed by state (`.octo-demote-shed`), not by a container
 *  query: their widths vary with the counts, so a fixed breakpoint would
 *  either shed a short "+2 −1" too early or leave a long one to clip. The
 *  natural widths are measured against the track's, which is set by the band's
 *  grid and never by this content, so shedding can't feed back into the
 *  measurement. */
export function ReviewTail({ parts, label }: Props) {
  const boxRef = useRef<HTMLSpanElement>(null);
  const floorRef = useRef<HTMLSpanElement>(null);
  const verbRef = useRef<HTMLSpanElement>(null);
  const statRef = useRef<HTMLSpanElement>(null);
  const [shed, setShed] = useState(0);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const measure = () => {
      const available = box.clientWidth;
      // jsdom, or a hidden canvas (ModeOverlay): no layout, nothing to decide.
      if (available <= 0) return;
      const rungs = [verbRef.current, statRef.current]
        .filter((el): el is HTMLSpanElement => el !== null)
        .map((el) => el.scrollWidth);
      setShed(rungsToShed(available, floorRef.current?.scrollWidth ?? 0, rungs));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, [parts.files, parts.verb, parts.stat]);

  const rung = (shedAt: number) => `octo-demote${shed >= shedAt ? " octo-demote-shed" : ""}`;

  return (
    <span
      ref={boxRef}
      title={label}
      data-tour="review-mode-tail"
      className="flex min-w-0 flex-1 items-center justify-end gap-2 font-mono text-[10px] uppercase tracking-[0.15em] text-octo-mute"
    >
      <span ref={floorRef} className="block min-w-0 truncate octo-tabular">
        {parts.files}
      </span>
      <span className={rung(1)} data-rung="verb">
        <span ref={verbRef}>{parts.verb}</span>
      </span>
      {parts.stat && (
        <span className={rung(2)} data-rung="stat">
          <span ref={statRef} className="octo-tabular">
            · {parts.stat}
          </span>
        </span>
      )}
    </span>
  );
}
