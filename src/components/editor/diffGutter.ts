/**
 * CodeMirror 6 gutter extension for diff markers.
 *
 * Renders a narrow colored bar on the left edge of lines that were
 * added or had deletions immediately after them, matching the Atelier palette.
 */

import { EditorView, gutter, GutterMarker, type Command } from "@codemirror/view";
import { Facet, type Extension } from "@codemirror/state";
import type { DiffLineMarker } from "../../lib/diffParser";

/** The markers the gutter draws, so the next/previous-change commands step
 *  through exactly what the reader sees. */
const diffMarkers = Facet.define<DiffLineMarker[], DiffLineMarker[]>({
  combine: (values) => values[0] ?? [],
});

/** First line of each change: a run of consecutive marked lines is one stop. */
export function changeStarts(markers: readonly DiffLineMarker[]): number[] {
  const lines = new Set(markers.map((m) => m.line));
  return [...lines].filter((l) => !lines.has(l - 1)).sort((a, b) => a - b);
}

/** The change to land on from `current` (1-based), wrapping at either end. */
export function nextChangeLine(
  starts: readonly number[],
  current: number,
  dir: 1 | -1,
): number | null {
  if (starts.length === 0) return null;
  if (dir === 1) return starts.find((l) => l > current) ?? starts[0];
  for (let i = starts.length - 1; i >= 0; i--) if (starts[i] < current) return starts[i];
  return starts[starts.length - 1];
}

function stepChange(dir: 1 | -1): Command {
  return (view) => {
    const { doc } = view.state;
    const current = doc.lineAt(view.state.selection.main.head).number;
    const target = nextChangeLine(changeStarts(view.state.facet(diffMarkers)), current, dir);
    // No changes in this file: let the key fall through.
    if (target == null) return false;
    const pos = doc.line(Math.min(target, doc.lines)).from;
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
      userEvent: "select",
    });
    return true;
  };
}

export const gotoNextChange = stepChange(1);
export const gotoPrevChange = stepChange(-1);

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

  return [diffMarkers.of(markers), gutter({
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
  })];
}
