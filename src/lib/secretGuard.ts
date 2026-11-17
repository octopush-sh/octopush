/** The secret guard (#730). The Rust core refuses a commit, push or pull
 *  request whose change holds a possible credential with a structured error
 *  `{ kind: "SecretsFound", message, findings }`. A finding names the file,
 *  the line and the kind — never any part of the value. */
export interface SecretFinding {
  file: string;
  /** 1-based line in the new file; null for a whole-file finding. */
  line: number | null;
  /** Stable rule id (`anthropic-key`, `your-credential`, …). */
  rule: string;
  /** For people: "Anthropic API key", "your OpenAI API key". */
  kind: string;
  /** Matched a credential configured in Octopush itself. */
  yours: boolean;
}

/** The action the guard held: it names the confirm CTA and the copy. */
export type GuardedAction = "commit" | "push" | "pr";

/** The findings when a thrown value is the guard's refusal, else `null`. */
export function secretFindings(err: unknown): SecretFinding[] | null {
  let obj: unknown = err;
  if (typeof err === "string") {
    try {
      obj = JSON.parse(err);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object") return null;
  const e = obj as Record<string, unknown>;
  if (e.kind !== "SecretsFound" || !Array.isArray(e.findings)) return null;
  return e.findings.filter(
    (f): f is SecretFinding =>
      !!f && typeof f === "object" && typeof (f as SecretFinding).file === "string" && typeof (f as SecretFinding).kind === "string",
  );
}

/** `tests/fixtures.ts:12`, or the file alone for a whole-file finding. */
export function findingLocation(f: SecretFinding): string {
  return f.line == null ? f.file : `${f.file}:${f.line}`;
}

/** "an Anthropic API key", "a GitHub token", "your OpenAI API key". */
function withArticle(kind: string): string {
  if (kind.startsWith("your ")) return kind;
  return /^[aeiouAEIOU]/.test(kind) ? `an ${kind}` : `a ${kind}`;
}

const NOUN: Record<GuardedAction, string> = { commit: "change", push: "push", pr: "pull request" };

/** The dialog's lead sentence: "This change adds what looks like an Anthropic
 *  API key in tests/fixtures.ts:12." */
export function guardHeadline(action: GuardedAction, findings: SecretFinding[]): string {
  const noun = NOUN[action];
  if (findings.length === 1) {
    const f = findings[0];
    return `This ${noun} adds what looks like ${withArticle(f.kind)} in ${findingLocation(f)}.`;
  }
  return `This ${noun} adds ${findings.length} things that look like secrets.`;
}

/** The explicit-override CTA, one per action. */
export function overrideLabel(action: GuardedAction): string {
  return action === "commit" ? "Commit regardless" : action === "push" ? "Push regardless" : "Open it regardless";
}

/** "possible secret · GitHub token in tests/fixtures.ts:12" (+ "and N more"). */
export function secretSummary(findings: SecretFinding[]): string {
  if (findings.length === 0) return "possible secret";
  const f = findings[0];
  const lead = `${findings.length === 1 ? "possible secret" : "possible secrets"} · ${f.kind} in ${findingLocation(f)}`;
  return findings.length > 1 ? `${lead} and ${findings.length - 1} more` : lead;
}
