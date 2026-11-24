import type { ColorMode } from "@xyflow/react";
import { isDarkBackground } from "../../lib/contrast";

/** The crew builder canvas follows the app's theme, never the OS. @xyflow v13
 *  resolves its stylesheet's `light-dark()` defaults against `color-scheme`,
 *  which it sets to `light dark` (the macOS appearance) unless the flow gets a
 *  forced mode. Unknown theme (not loaded yet) → dark, the default Onyx. The
 *  `--xy-*` variables the canvas relies on are also set from tokens under
 *  `.octo-flow` in styles.css, so neither mode ever shows the library palette. */
export function flowColorMode(bg: string | null | undefined): ColorMode {
  return bg && !isDarkBackground(bg) ? "light" : "dark";
}

/** Pointer travel, in px, before a press on a stage becomes a drag. Short of
 *  it the press stays a click: it selects, moves nothing and adds no undo
 *  entry (`onNodeDragStart` records one). v13 dropped `nodeClickDistance`,
 *  and its own threshold of 1px turns a trackpad click's jitter into a drag. */
export const NODE_DRAG_THRESHOLD = 4;

/** Margin `fitView` leaves around the stages, on load and after Tidy, so the
 *  outer ones clear the palette, the toolbar, the controls and the minimap.
 *  v13 reads a bare number as pixels (and floors it), so v12's `0.25` would
 *  be 0px; v12 turned that fraction into 10% of the canvas per side, which
 *  is what this string asks v13 for. */
export const FIT_PADDING = "10%";
