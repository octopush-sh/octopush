/**
 * CodeMirror 6 gutter extension for per-line git blame (G7 slice III).
 *
 * Shows `shaShort author` in mute mono per line, collapsing runs of the
 * same commit (only the first line of each contiguous run is labelled).
 * The native `title` tooltip carries the commit summary + date.
 */

import { gutter, GutterMarker } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import type { BlameLine } from "../../lib/ipc";

/** Collapse contiguous same-commit runs: keep only the first line of each
 *  run. Exported for tests. */
export function firstOfRuns(lines: BlameLine[]): Map<number, BlameLine> {
  const sorted = [...lines].sort((a, b) => a.line - b.line);
  const map = new Map<number, BlameLine>();
  let prevSha: string | null = null;
  let prevLine = 0;
  for (const l of sorted) {
    if (l.shaShort !== prevSha || l.line !== prevLine + 1) map.set(l.line, l);
    prevSha = l.shaShort;
    prevLine = l.line;
  }
  return map;
}

class BlameMarker extends GutterMarker {
  constructor(
    readonly text: string,
    readonly tooltip: string,
  ) {
    super();
  }
  eq(other: GutterMarker) {
    return (
      other instanceof BlameMarker &&
      other.text === this.text &&
      other.tooltip === this.tooltip
    );
  }
  toDOM() {
    const el = document.createElement("span");
    // Mute mono meta — tokens via CSS variables (no literals).
    el.style.cssText = `
      color: var(--color-octo-mute);
      font-size: 9.5px;
      line-height: inherit;
      padding: 0 8px 0 2px;
      white-space: nowrap;
    `;
    el.textContent = this.text;
    el.title = this.tooltip;
    return el;
  }
}

export function blameGutter(lines: BlameLine[]): Extension {
  const byLine = firstOfRuns(lines);
  return gutter({
    class: "cm-blame-gutter",
    lineMarker(view, line) {
      const n = view.state.doc.lineAt(line.from).number;
      const bl = byLine.get(n);
      if (!bl) return null;
      const date = new Date(bl.timestampMs).toLocaleDateString();
      return new BlameMarker(
        `${bl.shaShort} ${bl.authorName}`,
        `${bl.summary} · ${date}`,
      );
    },
  });
}
