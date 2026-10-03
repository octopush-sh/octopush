import { getExtension } from "../lib/getExtension";

/** How Quick View presents a file. Everything is editable as source; kinds
 *  with a rendered form (`hasPreview`) also get a Preview layout. */
export type QuickViewKind = "markdown" | "json" | "csv" | "tsv" | "svg" | "html" | "code";

export function quickViewKind(path: string): QuickViewKind {
  switch (getExtension(path)) {
    case "md":
    case "markdown":
    case "mdx":
      return "markdown";
    case "json":
    case "jsonc":
    case "json5":
      return "json";
    case "csv":
      return "csv";
    case "tsv":
      return "tsv";
    case "svg":
      return "svg";
    case "html":
    case "htm":
      return "html";
    default:
      return "code";
  }
}

/** Kinds with a rendered Preview layout beside Source. */
export function hasPreview(kind: QuickViewKind): boolean {
  return kind === "markdown" || kind === "csv" || kind === "tsv" || kind === "svg" || kind === "html";
}

/** The layout a kind opens in: rendered when it has one, else source. */
export function defaultLayout(kind: QuickViewKind): "preview" | "source" {
  return hasPreview(kind) ? "preview" : "source";
}

export type JsonFormatResult = { ok: true; text: string } | { ok: false; error: string };

/** Pretty-print JSON with `indent` spaces, preserving a trailing newline if
 *  the source had one. Comments (JSONC) are not valid JSON — they fail with
 *  the parser's message rather than being silently dropped. */
export function formatJson(source: string, indent = 2): JsonFormatResult {
  try {
    const parsed: unknown = JSON.parse(source);
    const text = JSON.stringify(parsed, null, indent);
    return { ok: true, text: source.endsWith("\n") ? `${text}\n` : text };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** RFC 4180-style delimited-text parser: quoted fields, `""` escapes, and
 *  delimiters/newlines inside quotes. Handles `\r\n`. A trailing newline does
 *  not produce an empty final row. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
      } else {
        field += ch;
      }
      i += 1;
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
    i += 1;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** `path` relative to `root` when inside it, else the path unchanged. */
export function relativeTo(root: string, path: string): string {
  const base = root.endsWith("/") ? root : `${root}/`;
  return path.startsWith(base) ? path.slice(base.length) : path;
}

/** The final path segment. */
export function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
