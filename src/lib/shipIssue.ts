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
    let head = body.slice(0, BODY_CAP);
    // Never split a surrogate pair — a lone high surrogate would make the
    // task unserializable at the IPC boundary (serde rejects it).
    if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
    // Deliberately NO "read the full issue at <url>" here: pointing the crew
    // at the uncapped remainder would let an attacker-authored issue body
    // smuggle unbounded instructions past the cap.
    body = `${head}\n… [issue body truncated]`;
  }
  const bodyBlock = body.length > 0 ? `\n\n${body}` : "";
  return (
    `Ship GitHub issue #${issue.number} — ${issue.title}${bodyBlock}\n\n` +
    `When you open the pull request, include "Closes #${issue.number}" in its body.`
  );
}
