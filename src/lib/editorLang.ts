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
  | "shell"
  | "toml"
  | "go"
  | "sql"
  | "dockerfile"
  | "properties"
  | "ruby"
  | "swift"
  | "c"
  | "cpp"
  | "csharp"
  | "kotlin"
  | "lua"
  | "plaintext";

export function langForExtension(path: string): LangId {
  // Extension-less files known by name.
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";

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
    case "sh":
    case "bash":
    case "zsh":
      return "shell";
    case "toml":
      return "toml";
    case "go":
      return "go";
    case "sql":
      return "sql";
    case "dockerfile":
      return "dockerfile";
    case "ini":
    case "cfg":
    case "conf":
    case "env":
    case "properties":
      return "properties";
    case "rb":
      return "ruby";
    case "swift":
      return "swift";
    case "c":
    case "h":
      return "c";
    case "cpp":
    case "cc":
    case "cxx":
    case "hpp":
      return "cpp";
    case "cs":
      return "csharp";
    case "kt":
    case "kts":
      return "kotlin";
    case "lua":
      return "lua";
    default:
      return "plaintext";
  }
}
