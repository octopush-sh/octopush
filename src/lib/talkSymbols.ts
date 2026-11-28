/**
 * Definitions for Talk's `@` popover (#1162): `@` followed by an identifier
 * also offers where the workspace defines it, and choosing one inserts the
 * definition as a line range, `@path#Lx-y`.
 *
 * The search is the one go-to-definition uses (`lib/definitionSearch.ts`):
 * a case-sensitive, whole-word scan of the worktree, kept to the lines that
 * read as a definition (`fn`, `struct`, `enum`, `trait`, `class`, `def`,
 * `const`, `function`, `type` and the other declaring forms) and ranked.
 * Each definition's end is read from the file: where its braces close, where
 * its indented body ends, or the line itself for a one-line statement.
 */

import { ipc } from "./ipc";
import { rankDefinitionHits } from "./definitionSearch";
import { CONTEXT_CAP, rangeToken } from "./talkContext";

/** Most definitions the popover lists. */
export const SYMBOL_ROWS = 5;
/** Most lines one definition's range spans. */
export const SYMBOL_MAX_LINES = 400;
/** Shortest identifier the popover looks up (shorter ones match too much). */
export const SYMBOL_MIN_CHARS = 3;
/** Lines a signature may run on before its body opens. */
const SIGNATURE_MAX_LINES = 20;

export interface SymbolRow {
  name: string;
  file: string;
  start: number;
  end: number;
  /** What is inserted after `@`: `path#Lx-y` (`#Lx` for one line). */
  token: string;
}

/** True when the `@query` reads as an identifier worth looking up. */
export function isSymbolQuery(query: string): boolean {
  return query.length >= SYMBOL_MIN_CHARS && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(query);
}

/** The line without its strings and `//` comment, so braces in them don't count. */
function codeOf(line: string): string {
  return line
    .replace(/"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""')
    .replace(/\/\/.*$/, "");
}

const indentOf = (line: string) => line.length - line.trimStart().length;

/** A line that says the statement goes on: an open bracket or operator. */
const CONTINUES = /(?:[([{,=<|&+\\:]|->)$/;

/**
 * How many lines the definition starting at `lines[0]` spans (at least 1).
 * Brace languages: up to the line where its first `{` closes. A body opened
 * by a trailing `:` (Python): up to its last line indented past the
 * definition. A one-line statement (`type A = B;`, `X = 5`): that line. A
 * definition still open at the end of `lines` spans all of them.
 */
export function definitionLength(lines: string[]): number {
  let depth = 0;
  let opened = false;
  for (let i = 0; i < lines.length; i++) {
    const code = codeOf(lines[i]);
    for (const ch of code) {
      if (ch === "{") {
        depth++;
        opened = true;
      } else if (ch === "}") {
        depth--;
      }
    }
    if (opened) {
      if (depth <= 0) return i + 1;
      continue;
    }
    const t = code.trim();
    if (t.endsWith(":")) return i + indentedBody(lines, i + 1, indentOf(lines[0]));
    // A signature that goes on, or a body that opens on the next line.
    const next = lines.slice(i + 1).find((l) => l.trim() !== "");
    if (i + 1 >= SIGNATURE_MAX_LINES) return 1;
    if (CONTINUES.test(t) || next?.trim().startsWith("{")) continue;
    return i + 1;
  }
  return opened ? lines.length : 1;
}

/** Lines of the indented body starting at `from`, plus the head line: up to
 *  the last non-blank line indented past `base`. */
function indentedBody(lines: string[], from: number, base: number): number {
  let last = from - 1;
  for (let j = from; j < lines.length; j++) {
    if (lines[j].trim() === "") continue;
    if (indentOf(lines[j]) <= base) break;
    last = j;
  }
  return last + 1 - (from - 1);
}

/** The ranked definitions of `name` in the workspace, each with its range.
 *  Only files `@` can name (the catalog's `files`) are offered, so every row
 *  inserts a token that resolves. */
export async function findSymbolRows(
  workspacePath: string,
  name: string,
  files: Set<string>,
  limit = SYMBOL_ROWS,
): Promise<SymbolRow[]> {
  if (!isSymbolQuery(name)) return [];
  const hits = await ipc.searchWorkspaceText(workspacePath, name, true, true);
  const ranked = rankDefinitionHits(hits.filter((h) => files.has(h.file)), name, { limit });
  return Promise.all(
    ranked.map(async (c) => {
      let end = c.line;
      try {
        const res = await ipc.readFileLines(
          `${workspacePath}/${c.file}`,
          c.line,
          c.line + SYMBOL_MAX_LINES - 1,
          CONTEXT_CAP,
        );
        if (res.kind === "text" && res.start === c.line) {
          end = c.line + definitionLength(res.content.split("\n")) - 1;
        }
      } catch {
        // Unreadable now: the definition's own line still names it.
      }
      return { name, file: c.file, start: c.line, end, token: rangeToken(c.file, c.line, end) };
    }),
  );
}
