/** The secret guard (#730). The Rust core refuses a commit, push or pull
 *  request whose change holds a possible credential — or that it couldn't
 *  scan to the end — with a structured error
 *  `{ kind: "SecretsFound", message, findings, total, partial, fingerprint }`.
 *  A finding names the file, the line and the kind — never any part of the
 *  value. `findings` is capped; `total` counts all of them. The override
 *  echoes `fingerprint` back, so it covers exactly what the dialog showed:
 *  the core rescans and refuses again if anything changed. */
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

/** One refusal: what to show, and the fingerprint an override must echo. */
export interface SecretRefusal {
  findings: SecretFinding[];
  /** Every finding, including those past the cap. */
  total: number;
  /** The 16 MB budget ran out: the rest of the change wasn't checked. */
  partial: boolean;
  fingerprint: string;
}

/** The refusal when a thrown value is the guard's, else `null`. */
export function secretRefusal(err: unknown): SecretRefusal | null {
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
  if (e.kind !== "SecretsFound" || !Array.isArray(e.findings) || typeof e.fingerprint !== "string") return null;
  const findings = e.findings.filter(
    (f): f is SecretFinding =>
      !!f && typeof f === "object" && typeof (f as SecretFinding).file === "string" && typeof (f as SecretFinding).kind === "string",
  );
  const total = typeof e.total === "number" ? Math.max(e.total, findings.length) : findings.length;
  return { findings, total, partial: e.partial === true, fingerprint: e.fingerprint };
}

/** Shown whenever a scan didn't reach the end of the change. */
export const PARTIAL_NOTE = "Scanned the first 16 MB; the rest wasn't checked.";

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
 *  API key in tests/fixtures.ts:12." `total` defaults to the list's length. */
export function guardHeadline(action: GuardedAction, findings: SecretFinding[], total = findings.length): string {
  const noun = NOUN[action];
  if (total === 0) return `This ${noun} is too large to check in full.`;
  if (total === 1 && findings.length === 1) {
    const f = findings[0];
    return `This ${noun} adds what looks like ${withArticle(f.kind)} in ${findingLocation(f)}.`;
  }
  return `This ${noun} adds ${total} things that look like secrets.`;
}

/** The explicit-override CTA, one per action. */
export function overrideLabel(action: GuardedAction): string {
  return action === "commit" ? "Commit regardless" : action === "push" ? "Push regardless" : "Open it regardless";
}

/** "possible secret · GitHub token in tests/fixtures.ts:12" (+ "and N more"),
 *  counted against `total` when it's larger than the capped list. */
export function secretSummary(findings: SecretFinding[], total = findings.length): string {
  const n = Math.max(total, findings.length);
  if (findings.length === 0) return "possible secret";
  const f = findings[0];
  const lead = `${n === 1 ? "possible secret" : "possible secrets"} · ${f.kind} in ${findingLocation(f)}`;
  return n > 1 ? `${lead} and ${n - 1} more` : lead;
}

/** A Direct stage's persisted hold (`run_stages.secret_hold`). */
export interface SecretHold {
  acknowledged: boolean;
  fingerprint: string;
  findings: SecretFinding[];
  total?: number;
  partial?: boolean;
  /** The worktree couldn't be read: nothing was checked. */
  unreadable?: boolean;
}

/** The held stage's one-liner, including why nothing (or not all) was checked. */
export function holdSummary(hold: SecretHold): string {
  if (hold.unreadable) return "couldn't read the worktree's changes, so nothing was checked";
  const total = Math.max(hold.total ?? 0, hold.findings.length);
  const note = hold.partial ? "scanned the first 16 MB; the rest wasn't checked" : "";
  if (total === 0) return note || "possible secret";
  return note ? `${secretSummary(hold.findings, total)} · ${note}` : secretSummary(hold.findings, total);
}
