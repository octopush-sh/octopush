/** True when an open editor file is a Markdown document we can render a
 *  preview for. Detection is by language first (the editor store classifies
 *  `.md`/`.markdown` as "markdown") with an extension fallback that also
 *  catches `.mdx`. Binary files never qualify. */
export function isMarkdownFile(
  file: { path: string; lang: string; kind: "text" | "binary" } | null | undefined,
): boolean {
  if (!file || file.kind !== "text") return false;
  return file.lang === "markdown" || /\.(md|markdown|mdx)$/i.test(file.path);
}
