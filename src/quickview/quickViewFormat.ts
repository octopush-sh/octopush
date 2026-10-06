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

/** Re-indent JSON with `indent` spaces, preserving a trailing newline if the
 *  source had one. Only whitespace between tokens changes: numbers, strings
 *  and key order are copied verbatim, so big integer IDs, `1.0`, `1e3` and
 *  duplicate keys survive (a `JSON.parse`/`stringify` round-trip would
 *  silently rewrite them). Invalid JSON — including JSONC comments — fails
 *  with the parser's message and leaves the source alone. */
export function formatJson(source: string, indent = 2): JsonFormatResult {
  try {
    JSON.parse(source);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const pad = (depth: number) => "\n" + " ".repeat(depth * indent);
  let out = "";
  let depth = 0;
  let i = 0;
  const n = source.length;
  const nextSignificant = (from: number) => {
    let j = from;
    while (j < n && /\s/.test(source[j])) j += 1;
    return source[j];
  };
  while (i < n) {
    const ch = source[i];
    if (ch === '"') {
      // Copy the whole string literal, escapes included.
      let j = i + 1;
      while (j < n && source[j] !== '"') j += source[j] === "\\" ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "{" || ch === "[") {
      const close = ch === "{" ? "}" : "]";
      if (nextSignificant(i + 1) === close) {
        out += ch + close;
        i = source.indexOf(close, i + 1) + 1;
        continue;
      }
      depth += 1;
      out += ch + pad(depth);
    } else if (ch === "}" || ch === "]") {
      depth -= 1;
      out += pad(depth) + ch;
    } else if (ch === ",") {
      out += "," + pad(depth);
    } else if (ch === ":") {
      out += ": ";
    } else {
      out += ch;
    }
    i += 1;
  }
  return { ok: true, text: /\r?\n$/.test(source) ? `${out}\n` : out };
}

/** The line separator a file uses: CRLF when it has any, else LF. The editor
 *  is told, so a Windows file keeps its line endings through an edit+save. */
export function detectEol(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
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

/** `path` relative to `root` when inside it, else the path unchanged.
 *  Accepts either separator, so Windows paths relativize too; the result is
 *  `/`-separated. */
export function relativeTo(root: string, path: string): string {
  const norm = (p: string) => p.replace(/\\/g, "/");
  const r = norm(root);
  const base = r.endsWith("/") ? r : `${r}/`;
  const p = norm(path);
  return p.startsWith(base) ? p.slice(base.length) : path;
}

/** The final path segment. */
export function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
