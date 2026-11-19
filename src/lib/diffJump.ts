/**
 * Locate the rendered diff row for a new-file line number inside a
 * `review-file-*` section. The diff rows (FileDiffSection → DiffLines) don't
 * carry line-level ids, so we match the rendered line-number gutter text:
 * unified mode rows have [oldLine, newLine, marker] spans (newLine is the
 * 2nd); side-by-side renders the new file in the 2nd `[data-sbs-col]` column
 * whose rows have a single line-number span. Returns null when the line
 * isn't part of any visible hunk — callers fall back to the file header.
 */
/**
 * Scroll the rendered diff to a file (and line, when given) and optionally
 * flash-highlight the target. AI-review findings sometimes echo git's `a/`/`b/`
 * path prefixes, so both the raw and de-prefixed paths are tried. Returns true
 * when a `review-file-*` section was found; callers surface a "not in the
 * current diff" message on false.
 */
export function revealDiffTarget(
  file: string,
  line: number | null,
  opts?: { flash?: boolean },
): boolean {
  const candidates = [file, file.replace(/^[ab]\//, "")];
  let fileEl: HTMLElement | null = null;
  for (const candidate of candidates) {
    fileEl = document.getElementById(`review-file-${encodeURIComponent(candidate)}`);
    if (fileEl) break;
  }
  if (!fileEl) return false;

  const row = line != null ? findDiffRowByNewLine(fileEl, line) : null;
  const target = (row ?? fileEl) as HTMLElement;
  target.scrollIntoView({ behavior: "smooth", block: row ? "center" : "start" });

  if (opts?.flash) {
    // Restart the flash even if this target was just highlighted.
    target.classList.remove("octo-flash");
    void target.offsetWidth;
    target.classList.add("octo-flash");
    window.setTimeout(() => target.classList.remove("octo-flash"), 1400);
  }
  return true;
}

/** How long a jump made from another mode waits for Review's diff to land
 *  (the working diff is only read while Review is on screen). */
export const DIFF_ARRIVAL_WAIT_MS = 2000;

/**
 * `revealDiffTarget`, tried on animation frames until the file's section
 * is rendered or `waitMs` has passed. The first try is one frame out, so the
 * canvas has switched modes; with `waitMs` 0 that is the only try. Resolves
 * with whether the section was found.
 */
export function revealDiffTargetWhenReady(
  file: string,
  line: number | null,
  waitMs: number,
  opts?: { flash?: boolean },
): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = performance.now() + waitMs;
    const attempt = () => {
      if (revealDiffTarget(file, line, opts)) resolve(true);
      else if (performance.now() >= deadline) resolve(false);
      else requestAnimationFrame(attempt);
    };
    requestAnimationFrame(attempt);
  });
}

/** Strip git's `a/`/`b/` diff prefix from a (relative) path. Absolute paths
 *  are returned untouched. AI findings occasionally carry these prefixes. */
export function stripDiffPrefix(path: string): string {
  return path.startsWith("/") ? path : path.replace(/^[ab]\//, "");
}

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
