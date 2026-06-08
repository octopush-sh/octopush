/**
 * CodeMirror 6 gutter extension for diff markers.
 *
 * Renders a narrow colored bar on the left edge of lines that were
 * added or had deletions immediately after them, matching the Atelier palette.
 */

import { gutter, GutterMarker } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import type { DiffLineMarker } from "../../lib/diffParser";

// ── Token hex mirrors ──────────────────────────────────────────────
// Matches tokens.ts values — no hardcoded literals beyond what the
// design system already canonically defines.
const ADDED_COLOR   = "#d4a574"; // octo-brass — inserted line
const REMOVED_COLOR = "#d18b8b"; // octo-rouge  — deletion marker

// ── GutterMarker subclasses ────────────────────────────────────────

class AddedMarker extends GutterMarker {
  toDOM() {
    const el = document.createElement("div");
    el.style.cssText = `
      width: 3px;
      height: 100%;
      background: ${ADDED_COLOR};
      border-radius: 1px;
      margin: 0 2px;
    `;
    return el;
  }
}

const addedMarker = new AddedMarker();

// Removed-after marker carries the deletion-run count. `eq()` lets CodeMirror
// reuse the same DOM node across view updates when the count is unchanged
// (instead of recreating a node on every keypress/scroll). Instances are
// cached per count so references are stable.
class RemovedMarker extends GutterMarker {
  constructor(readonly count: number) {
    super();
  }
  eq(other: GutterMarker) {
    return other instanceof RemovedMarker && other.count === this.count;
  }
  toDOM() {
    const el = document.createElement("div");
    el.style.cssText = `
      color: ${REMOVED_COLOR};
      font-size: 9px;
      line-height: 1;
      padding-top: 1px;
      text-align: center;
      width: 14px;
    `;
    el.textContent = "▾";
    const label = `${this.count} line${this.count === 1 ? "" : "s"} removed`;
    el.title = label;
    el.setAttribute("aria-label", label);
    return el;
  }
}

const removedMarkers = new Map<number, RemovedMarker>();
function removedMarker(count: number): RemovedMarker {
  let m = removedMarkers.get(count);
  if (!m) {
    m = new RemovedMarker(count);
    removedMarkers.set(count, m);
  }
  return m;
}

// ── Extension factory ──────────────────────────────────────────────

/**
 * Build a CodeMirror gutter `Extension` from a list of `DiffLineMarker`.
 *
 * @param markers  Output of `parseDiffForFile()` for the currently-open file.
 */
export function diffGutter(markers: DiffLineMarker[]): Extension {
  // Build a fast lookup: line number → full marker (to access count).
  const byLine = new Map<number, DiffLineMarker>();
  for (const m of markers) {
    byLine.set(m.line, m);
  }

  return gutter({
    class: "cm-diff-gutter",
    lineMarker(view, line) {
      const lineNo = view.state.doc.lineAt(line.from).number;
      const marker = byLine.get(lineNo);
      if (!marker) return null;
      if (marker.kind === "added") return addedMarker;
      if (marker.kind === "removed-after") return removedMarker(marker.count ?? 1);
      return null;
    },
    initialSpacer: () => addedMarker,
  });
}
