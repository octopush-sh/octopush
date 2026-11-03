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
  | "jsx"
  | "typescript"
  | "tsx"
  | "rust"
  | "python"
  | "java"
  | "json"
  | "markdown"
  | "html"
  | "css"
  | "sass"
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
  | "scala"
  | "groovy"
  | "dart"
  | "protobuf"
  | "lua"
  | "plaintext";

/** The JavaScript/TypeScript dialects: one grammar, four configurations. */
export const JS_DIALECTS: ReadonlySet<string> = new Set<LangId>(["javascript", "jsx", "typescript", "tsx"]);

export function langForExtension(path: string): LangId {
  // Extension-less files known by name.
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";

  const ext = getExtension(path);
  if (ext === "") return "plaintext";

  switch (ext) {
    case "js":
    case "mjs":
    case "cjs":
      return "javascript";
    case "jsx":
      return "jsx";
    // Plain TypeScript has no JSX: `<T>(x) => x` and `<Foo>expr` are generics
    // and casts there, not tags.
    case "ts":
    case "mts":
    case "cts":
      return "typescript";
    case "tsx":
      return "tsx";
    case "rs":
      return "rust";
    case "py":
      return "python";
    case "java":
      return "java";
    case "json":
    case "jsonc":
      return "json";
    case "md":
    case "markdown":
    case "mdx":
      return "markdown";
    case "html":
    case "htm":
    // Single-file components: the HTML grammar nests their <script> and <style>.
    case "vue":
    case "svelte":
      return "html";
    case "css":
    case "scss":
      return "css";
    case "sass":
      return "sass";
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
    case "hh":
    case "hxx":
      return "cpp";
    case "cs":
      return "csharp";
    case "kt":
    case "kts":
      return "kotlin";
    case "scala":
      return "scala";
    case "gradle":
    case "groovy":
      return "groovy";
    case "dart":
      return "dart";
    case "proto":
      return "protobuf";
    case "lua":
      return "lua";
    default:
      return "plaintext";
  }
}
