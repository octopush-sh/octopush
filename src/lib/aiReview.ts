import { DIFF_TRUNCATED_MARKER, diffFileCount, isDiffTruncated } from "./reviewSource";

export type Severity = "high" | "medium" | "low";
export type Category = "bug" | "missing-test" | "security" | "style" | "perf" | "other";

export interface AiFinding {
  severity: Severity;
  category: Category;
  title: string;
  detail: string;
  file: string | null;
  line: number | null;
}
export interface AiReviewResult {
  summary: string;
  findings: AiFinding[];
}

export const AI_REVIEW_SYSTEM = `You are a meticulous senior code reviewer. You are given a unified git diff of a change a developer is about to commit. Review ONLY what the diff shows. Surface concrete, actionable issues: bugs, missing tests, security problems, performance regressions, and notable style problems. Do not praise; do not restate the diff.

Respond with ONLY a JSON object, no prose outside it, matching exactly:
{"summary":"<=160 chars: what the change does + the single biggest risk","findings":[{"severity":"high|medium|low","category":"bug|missing-test|security|style|perf|other","title":"<=80 chars","detail":"1-2 sentences","file":"path exactly as in the diff, or null","line":<new-file line number from the @@ header, or null>}]}
Use file/line when a finding maps to a specific changed line; use null for changeset-level findings. Order findings by severity (high first). If the change is clean, return an empty findings array with a summary saying so.`;

/** JSON schema for the review result — sent as `jsonSchema` to `ipc.aiComplete`
 *  so the backend forces a schema'd tool call and the response text is
 *  guaranteed-shape JSON. `parseAiReview` still runs on it (validation +
 *  enum coercion) and remains the fallback for prose responses. */
export const AI_REVIEW_SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description: "<=160 chars: what the change does + the single biggest risk",
    },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["high", "medium", "low"] },
          category: { type: "string", enum: ["bug", "missing-test", "security", "style", "perf", "other"] },
          title: { type: "string", description: "<=80 chars" },
          detail: { type: "string", description: "1-2 sentences" },
          file: { type: ["string", "null"], description: "path exactly as in the diff, or null" },
          line: { type: ["number", "null"], description: "new-file line number from the @@ header, or null" },
        },
        required: ["severity", "category", "title", "detail", "file", "line"],
      },
    },
  },
  required: ["summary", "findings"],
} as const;

/** What the review read when it couldn't read the whole change (#943): the
 *  backend's 1 MiB cap cut the diff, or it was cut at a file boundary to fit
 *  the model's context window. */
export interface ReviewPartial {
  /** Files the model was sent (the last one may be cut short). */
  readFiles: number;
  /** Files in the whole change; null when the 1 MiB cap cut it, so the
   *  count past the cut is unknown. */
  totalFiles: number | null;
  /** Paths left out to fit the window, in diff order; empty when only the
   *  1 MiB cap cut the diff. */
  omitted: string[];
}

export interface FittedDiff {
  diff: string;
  partial: ReviewPartial | null;
}

/** Conservative bytes-per-token for code and diffs (dense tokenisation), so
 *  the estimate errs high and the prompt fits. */
const BYTES_PER_TOKEN = 3;
/** Room kept for the answer: `ai_complete`'s default `max_tokens`. */
const OUTPUT_RESERVE_TOKENS = 8192;
/** Room for the prompt's own wording, the partial note and its file list. */
const PROMPT_SLACK_TOKENS = 4096;
/** Paths named in the prompt's partial note; the rest are counted. */
const MAX_OMITTED_NAMED = 30;

function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++; // the low surrogate
    } else n += 3;
  }
  return n;
}

/** Tokens a string costs, estimated from its UTF-8 bytes. */
export function estimateTokens(s: string): number {
  return Math.ceil(utf8Length(s) / BYTES_PER_TOKEN);
}

/** Split a unified diff into one chunk per `diff --git` header (any text
 *  before the first header rides with the first chunk). */
function splitFiles(diff: string): string[] {
  const chunks = diff.split(/(?=^diff --git )/m);
  if (chunks.length > 1 && !chunks[0].startsWith("diff --git ")) {
    chunks.splice(0, 2, chunks[0] + chunks[1]);
  }
  return chunks;
}

/** The file a chunk is about: the `b/` path of its `diff --git` header. */
function chunkPath(chunk: string): string {
  const header = chunk.slice(chunk.indexOf("diff --git ")).split("\n", 1)[0];
  const m = /^diff --git a\/.* b\/(.*)$/.exec(header);
  return m ? m[1] : header.replace(/^diff --git /, "");
}

/** Fit a review diff to the model (#943). Drops the backend's truncation
 *  marker (the prompt's note says so instead) and, when the prompt would
 *  overflow `maxContext` less room for the answer, keeps whole files from the
 *  start while they fit. A first file too big on its own is cut at a line.
 *  `maxContext` null/0 (model not in the catalog) skips the window fit. */
export function fitReviewDiff(gitDiff: string, maxContext: number | null | undefined): FittedDiff {
  const capped = isDiffTruncated(gitDiff);
  const body = capped
    ? gitDiff.slice(0, gitDiff.lastIndexOf(DIFF_TRUNCATED_MARKER)).replace(/\n+$/, "\n")
    : gitDiff;
  const total = diffFileCount(body);
  const budget =
    maxContext && maxContext > 0
      ? maxContext - OUTPUT_RESERVE_TOKENS - PROMPT_SLACK_TOKENS - estimateTokens(AI_REVIEW_SYSTEM)
      : Infinity;

  if (estimateTokens(body) <= budget) {
    return {
      diff: body,
      partial: capped ? { readFiles: total, totalFiles: null, omitted: [] } : null,
    };
  }

  const chunks = splitFiles(body);
  const kept: string[] = [];
  let used = 0;
  for (const c of chunks) {
    const t = estimateTokens(c);
    if (used + t > budget) break;
    kept.push(c);
    used += t;
  }
  if (kept.length === 0) {
    // Not even the first file fits: keep its head, cut at a line boundary.
    const room = Math.max(0, Math.floor(budget)) * BYTES_PER_TOKEN;
    let cut = chunks[0].slice(0, room);
    while (utf8Length(cut) > room) cut = cut.slice(0, Math.floor(cut.length * 0.9));
    const nl = cut.lastIndexOf("\n");
    kept.push(nl > 0 ? cut.slice(0, nl + 1) : cut);
  }
  return {
    diff: kept.join(""),
    partial: {
      readFiles: kept.length,
      totalFiles: capped ? null : total,
      omitted: chunks.slice(kept.length).map(chunkPath),
    },
  };
}

/** The mute line under the review summary saying what wasn't read. */
export function partialReviewLine(p: ReviewPartial): string {
  if (p.totalFiles != null) {
    return `Read the first ${p.readFiles} of ${p.totalFiles} files; the rest wasn't reviewed.`;
  }
  if (p.omitted.length > 0) {
    return `Read the first ${p.readFiles} ${p.readFiles === 1 ? "file" : "files"}; the rest wasn't reviewed.`;
  }
  return "Read the first 1 MB of the diff; the rest wasn't reviewed.";
}

export function buildReviewPrompt(gitDiff: string, partial: ReviewPartial | null = null): string {
  if (!partial) return `Here is the unified diff to review:\n\n${gitDiff}`;
  const why =
    partial.omitted.length > 0
      ? "it was cut at a file boundary to fit your context window"
      : "the change was too large to load in full, so it stops mid-way";
  let note = `This diff is PARTIAL: ${why}. Review only what it shows. Do not report code that is missing from it, a file that ends abruptly at the end, or the cut itself as a finding, and say in the summary that the review covers part of the change.`;
  if (partial.omitted.length > 0) {
    const named = partial.omitted.slice(0, MAX_OMITTED_NAMED).join(", ");
    const more = partial.omitted.length - MAX_OMITTED_NAMED;
    note += `\nFiles left out: ${named}${more > 0 ? ` (and ${more} more)` : ""}.`;
  }
  return `${note}\n\nHere is the unified diff to review:\n\n${gitDiff}`;
}

const SEVERITIES = new Set<string>(["high", "medium", "low"]);
const CATEGORIES = new Set<string>(["bug", "missing-test", "security", "style", "perf", "other"]);

/** String-aware balanced-brace scan: for each `{` in the text, walk forward
 *  tracking brace depth while skipping braces inside JSON string literals
 *  (respecting `\"` escapes). Returns the first balanced substring that parses
 *  to a non-null object with a `summary` or `findings` own-property, or null. */
function extractJsonObject(s: string): Record<string, unknown> | null {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (c === "\\") {
          escaped = true;
        } else if (c === '"') {
          inString = false;
        }
        continue;
      }
      if (c === '"') {
        inString = true;
      } else if (c === "{") {
        depth++;
      } else if (c === "}") {
        depth--;
        if (depth === 0) {
          const candidate = s.slice(i, j + 1);
          try {
            const parsed = JSON.parse(candidate) as unknown;
            if (
              parsed &&
              typeof parsed === "object" &&
              (Object.prototype.hasOwnProperty.call(parsed, "summary") ||
                Object.prototype.hasOwnProperty.call(parsed, "findings"))
            ) {
              return parsed as Record<string, unknown>;
            }
          } catch {
            // not valid JSON from this start; try the next `{`.
          }
          break;
        }
      }
    }
  }
  return null;
}

/** Tolerant: strips ```json fences + surrounding prose, parses the outermost
 *  object, validates shape. Out-of-enum severities coerce to "medium" and
 *  out-of-enum categories to "other" — a finding is only dropped when it has
 *  no usable title, so a slightly off-spec model response never collapses
 *  into a false "No issues found." Throws if no parseable object is present. */
export function parseAiReview(text: string): AiReviewResult {
  const obj = extractJsonObject(text.trim());
  if (!obj) {
    throw new Error("AI review returned no JSON object");
  }
  const summary = typeof obj.summary === "string" ? obj.summary : "";
  const rawFindings = Array.isArray(obj.findings) ? obj.findings : [];
  const findings: AiFinding[] = rawFindings
    .filter(
      (f): f is Record<string, unknown> =>
        !!f &&
        typeof f === "object" &&
        typeof (f as any).title === "string" &&
        ((f as any).title as string).length > 0,
    )
    .map((f) => ({
      severity: SEVERITIES.has(f.severity as string) ? (f.severity as Severity) : "medium",
      category: CATEGORIES.has(f.category as string) ? (f.category as Category) : "other",
      title: f.title as string,
      detail: typeof f.detail === "string" ? (f.detail as string) : "",
      file: typeof f.file === "string" && f.file ? (f.file as string) : null,
      line: typeof f.line === "number" ? (f.line as number) : null,
    }));
  return { summary, findings };
}
