export interface DiffLineStyle {
  /** Tailwind text-color class for this line. */
  className: string;
  /** Inline background tint (empty string for context lines). */
  background: string;
}

/** Classify a raw unified-diff line into its text color + background tint.
 *  Shared by the read-only DiffViewer and the interactive ReviewCanvas so the
 *  two diff surfaces never drift.
 *
 *  The tints are theme tokens rather than literals. They used to be the
 *  atelier verdigris and rouge at a flat 8% — the dark palette's hues at an
 *  alpha tuned against near-black — so under the vellum light theme a diff row
 *  was tinted with colours from a theme the user wasn't running. `themeStore`
 *  now solves both per theme against that theme's own background — the surface
 *  DiffViewer's rows actually sit on — holding one
 *  constant perceptual step (see `DIFF_TINT_TARGET`), and publishes them as
 *  `--diff-add-bg` / `--diff-del-bg`. */
export function diffLineStyle(line: string): DiffLineStyle {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return { className: "text-octo-verdigris", background: "var(--diff-add-bg)" };
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return { className: "text-octo-rouge", background: "var(--diff-del-bg)" };
  }
  return { className: "text-octo-sage", background: "" };
}
