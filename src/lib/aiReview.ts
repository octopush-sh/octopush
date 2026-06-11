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

export function buildReviewPrompt(gitDiff: string): string {
  return `Here is the unified diff to review:\n\n${gitDiff}`;
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
