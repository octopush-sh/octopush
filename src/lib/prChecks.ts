import type { Pr, PrChecks } from "./types";

/** The most of the failed-step logs a "Fix failing checks…" brief carries
 *  (the backend caps too; this keeps the brief honest whatever it returns). */
export const FAILED_LOG_MAX_CHARS = 8_000;

/** The chip glyph's tooltip: the state, and the failing checks by name. */
export function checksTitle(checks: PrChecks): string {
  if (checks.state === "passing") return "Checks passing";
  if (checks.state === "pending") return "Checks running";
  const names = checks.failing.map((c) => c.name);
  return `Checks failing: ${names.join(", ")}`;
}

/** The distinct Actions runs behind the failing checks, in order. */
export function failedRunIds(checks: PrChecks): number[] {
  const ids: number[] = [];
  for (const c of checks.failing) {
    if (c.runId != null && !ids.includes(c.runId)) ids.push(c.runId);
  }
  return ids;
}

/** The brief "Fix failing checks…" seeds the Direct launcher with: the PR,
 *  the failed checks by name, and the tail of their failed-step logs. */
export function fixChecksBrief(pr: Pr, log: string): string {
  const names = (pr.checks?.failing ?? []).map((c) => `- ${c.name}`).join("\n");
  const lines = [
    `CI checks are failing on pull request #${pr.number} (${pr.title}).`,
    "",
    "Failing checks:",
    names,
    "",
    "Find the cause of each failure, fix it in this workspace, and run the same checks locally to confirm they pass.",
  ];
  const tail = log.trim();
  if (tail) {
    const capped = tail.length > FAILED_LOG_MAX_CHARS ? tail.slice(tail.length - FAILED_LOG_MAX_CHARS) : tail;
    lines.push("", "Tail of the failed steps' logs (gh run view --log-failed):", "```", capped, "```");
  }
  return lines.join("\n");
}
