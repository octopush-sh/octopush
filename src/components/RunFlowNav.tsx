import { useEffect, useState, type RefObject } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { IconButton } from "./controls/IconButton";
import { prefersReducedMotion } from "../lib/motion";

export interface RailEdges {
  overflowing: boolean;
  atStart: boolean;
  atEnd: boolean;
}

/** Whether the Direct run rail overflows and which of its edges hide stages.
 *  `stageCount` re-measures when the stage count changes mid-run — a scroll
 *  container's own box doesn't resize when its content grows, so
 *  ResizeObserver alone would miss a stage being appended. */
export function useRailEdges(containerRef: RefObject<HTMLDivElement | null>, stageCount: number): RailEdges {
  const [edges, setEdges] = useState<RailEdges>({ overflowing: false, atStart: true, atEnd: true });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const measure = () => {
      const next = {
        overflowing: el.scrollWidth > el.clientWidth + 1,
        atStart: el.scrollLeft <= 0,
        atEnd: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1,
      };
      setEdges((prev) =>
        prev.overflowing === next.overflowing && prev.atStart === next.atStart && prev.atEnd === next.atEnd
          ? prev
          : next,
      );
    };
    measure();

    const ro = new ResizeObserver(measure);
    ro.observe(el);
    el.addEventListener("scroll", measure, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", measure);
    };
  }, [containerRef, stageCount]);

  return edges;
}

/** The rail's edge-fade: each edge that hides stages fades out, so a
 *  connector whose stage is scrolled away never reads as a broken line. */
export function railEdgeFade({ overflowing, atStart, atEnd }: RailEdges): string {
  if (!overflowing || (atStart && atEnd)) return "";
  if (!atStart && !atEnd) {
    return "[mask-image:linear-gradient(to_right,transparent,black_32px,black_calc(100%_-_32px),transparent)]";
  }
  return atStart
    ? "[mask-image:linear-gradient(to_left,transparent,black_32px)]"
    : "[mask-image:linear-gradient(to_right,transparent,black_32px)]";
}

interface Props {
  containerRef: RefObject<HTMLDivElement | null>;
  /** "earlier" sits at the rail's left edge, "later" at its right. */
  side: "earlier" | "later";
  disabled: boolean;
}

/** One chevron of the Direct run rail, beside the edge it scrolls toward.
 *  The rail renders them only once it actually overflows; each disables at
 *  its scroll edge — the rail itself is always scrollable by
 *  trackpad/keyboard regardless. */
export function RunFlowNav({ containerRef, side, disabled }: Props) {
  const dir = side === "earlier" ? -1 : 1;
  const scrollByGroup = () => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollBy({
      left: dir * el.clientWidth * 0.8,
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  };

  return (
    <div className="octo-fade-in flex shrink-0 items-center">
      <IconButton label={side === "earlier" ? "Earlier stages" : "Later stages"} onClick={scrollByGroup} disabled={disabled}>
        {side === "earlier" ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
      </IconButton>
    </div>
  );
}
