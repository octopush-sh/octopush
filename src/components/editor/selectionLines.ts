import type { EditorState } from "@codemirror/state";

/** The main selection's first and last line, or null when it is empty. A
 *  selection ending at a line's start (a whole-line drag) ends on the line
 *  above it — "Ask Talk about this" names the lines the user sees selected. */
export function selectionLines(state: EditorState): { from: number; to: number } | null {
  const main = state.selection.main;
  if (main.empty) return null;
  const from = state.doc.lineAt(main.from).number;
  const end = state.doc.lineAt(main.to);
  return { from, to: end.from === main.to && end.number > from ? end.number - 1 : end.number };
}
