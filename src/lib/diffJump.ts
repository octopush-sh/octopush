/**
 * Locate the rendered diff row for a new-file line number inside a
 * `review-file-*` section. The diff rows (FileDiffSection → DiffLines) don't
 * carry line-level ids, so we match the rendered line-number gutter text:
 * unified mode rows have [oldLine, newLine, marker] spans (newLine is the
 * 2nd); side-by-side renders the new file in the 2nd `[data-sbs-col]` column
 * whose rows have a single line-number span. Returns null when the line
 * isn't part of any visible hunk — callers fall back to the file header.
 */
export function findDiffRowByNewLine(fileEl: HTMLElement, line: number): HTMLElement | null {
  const target = String(line);
  const cols = fileEl.querySelectorAll("[data-sbs-col]");
  if (cols.length >= 2) {
    for (const row of cols[1].querySelectorAll<HTMLElement>("[data-diff-row]")) {
      if (row.querySelector("span")?.textContent?.trim() === target) return row;
    }
    return null;
  }
  for (const row of fileEl.querySelectorAll<HTMLElement>("[data-diff-row]")) {
    const spans = row.querySelectorAll(":scope > span");
    if (spans.length >= 2 && spans[1].textContent?.trim() === target) return row;
  }
  return null;
}
