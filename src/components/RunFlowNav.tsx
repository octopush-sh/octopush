import { useEffect, useState, type RefObject } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { IconButton } from "./controls/IconButton";
import { prefersReducedMotion } from "../lib/motion";

interface Props {
  containerRef: RefObject<HTMLDivElement | null>;
  /** Re-measure overflow when the stage count changes mid-run — a scroll
   *  container's own box doesn't resize when its content grows, so
   *  ResizeObserver alone would miss a stage being appended. */
  stageCount: number;
}

/** Prev/next chevrons for the Direct run rail. Renders only once the rail
 *  actually overflows, and disables at each scroll edge — the rail itself
 *  is always scrollable by trackpad/keyboard regardless. */
export function RunFlowNav({ containerRef, stageCount }: Props) {
  const [overflowing, setOverflowing] = useState(false);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const measure = () => {
      setOverflowing(el.scrollWidth > el.clientWidth + 1);
      setAtStart(el.scrollLeft <= 0);
      setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 1);
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

  if (!overflowing) return null;

  const scrollByGroup = (dir: 1 | -1) => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollBy({
      left: dir * el.clientWidth * 0.8,
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  };

  return (
    <div className="flex shrink-0 items-center gap-1">
      <IconButton label="Earlier stages" onClick={() => scrollByGroup(-1)} disabled={atStart}>
        <ChevronLeft size={14} />
      </IconButton>
      <IconButton label="Later stages" onClick={() => scrollByGroup(1)} disabled={atEnd}>
        <ChevronRight size={14} />
      </IconButton>
    </div>
  );
}
