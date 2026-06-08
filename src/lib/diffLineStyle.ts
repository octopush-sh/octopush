export interface DiffLineStyle {
  /** Tailwind text-color class for this line. */
  className: string;
  /** Inline background tint (empty string for context lines). */
  background: string;
}

/** Classify a raw unified-diff line into its text color + background tint.
 *  Shared by the read-only DiffViewer and the interactive ReviewCanvas so the
 *  two diff surfaces never drift. */
export function diffLineStyle(line: string): DiffLineStyle {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return { className: "text-octo-verdigris", background: "rgba(143, 201, 168, 0.08)" };
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return { className: "text-octo-rouge", background: "rgba(209, 139, 139, 0.08)" };
  }
  return { className: "text-octo-sage", background: "" };
}
