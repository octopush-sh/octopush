import type { PaneLayout } from "../../stores/terminalLayoutStore";

interface Props {
  layout: PaneLayout;
  /** For three panes: the large pane on the left (`side`) or on top. */
  orientation?: "side" | "stacked";
  size?: number;
  className?: string;
}

/** The lines that split the frame, per layout (24×24, lucide's grid). */
function splits(layout: PaneLayout, orientation: "side" | "stacked"): string | null {
  switch (layout) {
    case "one":
      return null;
    case "two-side":
      return "M12 3v18";
    case "two-stacked":
      return "M3 12h18";
    case "three":
      return orientation === "side" ? "M12 3v18M12 12h9" : "M3 12h18M12 12v9";
    case "four":
      return "M12 3v18M3 12h18";
  }
}

/**
 * One glyph per Run layout, drawn as the panes themselves: a frame and the
 * dividers inside it, in lucide's line style so it sits beside the role icons.
 * A single family rather than five unrelated icons, because the session
 * line's layout button shows whichever one is on screen. Decorative: the
 * button or menu row that holds it carries the name.
 */
export function PaneLayoutIcon({ layout, orientation = "side", size = 13, className }: Props) {
  const d = splits(layout, orientation);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-layout={layout}
      className={className}
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      {d && <path d={d} />}
    </svg>
  );
}
