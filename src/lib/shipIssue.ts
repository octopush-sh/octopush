import type { GhIssue } from "./types";

/** How much of an issue body rides into the run task. Stage prompts cap
 *  sections anyway (~16K chars); bounding here keeps the brief readable and
 *  makes the truncation explicit instead of silent. */
const BODY_CAP = 4_000;

/** Fold a GitHub issue into a crew task. The issue reference lives in the
 *  TASK text (not `linked_issue_key`, which is Jira-semantic everywhere) —
 *  the task reaches every stage's prompt, so the `pull_request` stage can
 *  honor the closing instruction. */
export function composeIssueTask(issue: GhIssue): string {
  let body = issue.body.trim();
  if (body.length > BODY_CAP) {
    body = `${body.slice(0, BODY_CAP)}\n… [issue body truncated — read the full issue at ${issue.url}]`;
  }
  const bodyBlock = body.length > 0 ? `\n\n${body}` : "";
  return (
    `Ship GitHub issue #${issue.number} — ${issue.title}${bodyBlock}\n\n` +
    `When you open the pull request, include "Closes #${issue.number}" in its body.`
  );
}
