/**
 * The one extension extractor for the three extension tables in src/lib:
 *
 *  - `fileIcons.ts`        — extension → lucide icon category
 *  - `languageDetection.ts`— extension → language id (chat code blocks)
 *  - `editorLang.ts`       — extension → CodeMirror LangId
 *
 * The tables map to different output domains so they stay separate, but they
 * must agree on what "the extension" is. When adding a new extension, check
 * whether the other two tables want it too.
 *
 * Returns the lowercased extension after the final dot, without the dot,
 * or "" when the name has none. Dotfiles (".gitignore") count as an
 * extension — historical behavior all three tables relied on.
 */
export function getExtension(nameOrPath: string): string {
  const dot = nameOrPath.lastIndexOf(".");
  if (dot === -1) return "";
  return nameOrPath.slice(dot + 1).toLowerCase();
}
