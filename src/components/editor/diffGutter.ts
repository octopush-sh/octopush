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

class RemovedAfterMarker extends GutterMarker {
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
    return el;
  }
}

const addedMarker = new AddedMarker();
const removedAfterMarker = new RemovedAfterMarker();

// ── Extension factory ──────────────────────────────────────────────

/**
 * Build a CodeMirror gutter `Extension` from a list of `DiffLineMarker`.
 *
 * @param markers  Output of `parseDiffForFile()` for the currently-open file.
 */
export function diffGutter(markers: DiffLineMarker[]): Extension {
  // Build a fast lookup: line number → marker kind.
  const byLine = new Map<number, "added" | "removed-after">();
  for (const m of markers) {
    byLine.set(m.line, m.kind);
  }

  return gutter({
    class: "cm-diff-gutter",
    lineMarker(view, line) {
      const lineNo = view.state.doc.lineAt(line.from).number;
      const kind = byLine.get(lineNo);
      if (kind === "added") return addedMarker;
      if (kind === "removed-after") return removedAfterMarker;
      return null;
    },
    initialSpacer: () => addedMarker,
  });
}
