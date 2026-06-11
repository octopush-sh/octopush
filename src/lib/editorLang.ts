import { getExtension } from "./getExtension";

/**
 * Maps a file path's extension to a CodeMirror language identifier.
 * Used by EditorPane to pick the correct language support extension.
 *
 * Extension table 3 of 3 — see getExtension.ts for the cross-reference
 * (fileIcons.ts and languageDetection.ts hold the other two).
 */

export type LangId =
  | "javascript"
  | "rust"
  | "python"
  | "java"
  | "json"
  | "markdown"
  | "html"
  | "css"
  | "xml"
  | "yaml"
  | "plaintext";

export function langForExtension(path: string): LangId {
  const ext = getExtension(path);
  if (ext === "") return "plaintext";

  switch (ext) {
    case "js":
    case "jsx":
    case "ts":
    case "tsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "rs":
      return "rust";
    case "py":
      return "python";
    case "java":
      return "java";
    case "json":
      return "json";
    case "md":
    case "markdown":
      return "markdown";
    case "html":
    case "htm":
      return "html";
    case "css":
    case "scss":
      return "css";
    case "xml":
    case "svg":
      return "xml";
    case "yaml":
    case "yml":
      return "yaml";
    default:
      return "plaintext";
  }
}
