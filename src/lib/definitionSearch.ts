/**
 * Workspace-wide "go to definition", built on the literal text search the
 * ⌘⇧F palette already uses.
 *
 * When a symbol isn't declared in the open file, the only index Octopush has
 * is `search_workspace_text` — a literal, case-insensitive line scan. That
 * returns every mention of the name, so the work here is turning mentions into
 * candidates: keep the lines that read as a *definition* (same heuristic the
 * in-file jump uses, so the two agree), then rank what survives by how likely
 * it is to be the one the reader meant.
 *
 * The ranking is honest about its own uncertainty. `chooseDefinition` only
 * jumps straight to a candidate when it beats the runner-up by a full
 * confidence tier; anything closer is handed back for the reader to pick from,
 * because silently landing in the wrong file is the failure mode that makes
 * people stop trusting the gesture.
 */

import { scoreDefinitionLine } from "../components/editor/symbolIndex";
import type { SearchHit } from "./types";

export interface DefinitionCandidate {
  /** Path relative to the workspace root. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** The source line, for the picker's preview. */
  preview: string;
  score: number;
}

/** Bonuses and penalties, in points on `scoreDefinitionAt`'s 0–100 scale. */
const SAME_EXTENSION_BONUS = 12;
const SAME_DIRECTORY_BONUS = 6;
const TEST_FILE_PENALTY = 30;
const VENDOR_PENALTY = 40;
const AMBIENT_DECL_PENALTY = 10;

/** The gap a winner needs over the runner-up to be taken without asking. One
 *  full tier — a declaration outranking an assignment, or a real source file
 *  outranking the same declaration in a test. */
const DECISIVE_GAP = 30;

const DEFAULT_LIMIT = 25;

export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function directoryOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(0, slash) : "";
}

export function isTestPath(path: string): boolean {
  return (
    /(^|\/)(tests?|__tests__|spec|e2e)\//i.test(path) ||
    /[._-](test|tests|spec)\.[A-Za-z0-9]+$/i.test(path) ||
    /(^|\/)test_[^/]*$/i.test(path)
  );
}

export function isVendorPath(path: string): boolean {
  return /(^|\/)(node_modules|vendor|third_party|dist|build|target|\.venv|site-packages)\//.test(
    path,
  );
}

/**
 * Keep the search hits that read as definitions of `name` and rank them.
 * `fromFile`/`fromLine` identify where the reader asked from: that exact line
 * is dropped (it is the use they clicked), and its file's language and folder
 * tilt the ranking toward a same-language neighbour.
 */
export function rankDefinitionHits(
  hits: readonly SearchHit[],
  name: string,
  opts: { fromFile?: string; fromLine?: number; limit?: number } = {},
): DefinitionCandidate[] {
  const { fromFile, fromLine, limit = DEFAULT_LIMIT } = opts;
  const fromExt = fromFile ? extensionOf(fromFile) : "";
  const fromDir = fromFile ? directoryOf(fromFile) : "";

  const out: DefinitionCandidate[] = [];
  for (const hit of hits) {
    if (fromFile && hit.file === fromFile && hit.line === fromLine) continue;
    const base = scoreDefinitionLine(hit.preview, name);
    if (base <= 0) continue;

    let score = base;
    if (fromExt && extensionOf(hit.file) === fromExt) score += SAME_EXTENSION_BONUS;
    if (fromDir && directoryOf(hit.file) === fromDir) score += SAME_DIRECTORY_BONUS;
    if (isTestPath(hit.file)) score -= TEST_FILE_PENALTY;
    if (isVendorPath(hit.file)) score -= VENDOR_PENALTY;
    if (hit.file.endsWith(".d.ts")) score -= AMBIENT_DECL_PENALTY;

    out.push({ file: hit.file, line: hit.line, preview: hit.preview.trim(), score });
  }

  out.sort(
    (a, b) =>
      b.score - a.score ||
      a.file.length - b.file.length ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );
  return out.slice(0, limit);
}

export type DefinitionChoice =
  | { kind: "none" }
  | { kind: "jump"; candidate: DefinitionCandidate }
  | { kind: "choose"; candidates: DefinitionCandidate[] };

/** Decide whether the ranking is confident enough to jump on its own. */
export function chooseDefinition(candidates: DefinitionCandidate[]): DefinitionChoice {
  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length === 1) return { kind: "jump", candidate: candidates[0] };
  if (candidates[0].score - candidates[1].score >= DECISIVE_GAP) {
    return { kind: "jump", candidate: candidates[0] };
  }
  return { kind: "choose", candidates };
}
