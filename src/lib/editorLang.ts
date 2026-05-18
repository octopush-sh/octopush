/**
 * Maps a file path's extension to a CodeMirror language identifier.
 * Used by EditorPane to pick the correct language support extension.
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
  const dot = path.lastIndexOf(".");
  if (dot === -1) return "plaintext";
  const ext = path.slice(dot + 1).toLowerCase();

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
