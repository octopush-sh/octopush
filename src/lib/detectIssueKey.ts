/** First Jira-style key (`[A-Z][A-Z0-9]+-<digits>`) in a branch name, or null.
 *  Kept in sync with the Rust `detect_issue_key` in
 *  `src-tauri/src/issue_tracker/mod.rs`. Both require a ≥2-char project prefix
 *  (e.g. "A-1" → null; "AB-1" → "AB-1"). */
export function detectIssueKey(branch: string): string | null {
  const m = branch.match(/(?<![A-Za-z0-9])[A-Z][A-Z0-9]+-\d+/);
  return m ? m[0] : null;
}

/** Like {@link detectIssueKey} but only returns a key that belongs to the
 *  project's configured Jira key (e.g. "OCT" → accepts "OCT-12", rejects
 *  "UTF-8"). Returns null when the project has no configured key, so we never
 *  surface a guessed ticket we can't validate (C5). */
export function detectIssueKeyForProject(
  branch: string,
  projectKey: string | null,
): string | null {
  if (!projectKey) return null;
  const key = detectIssueKey(branch);
  return key && key.startsWith(projectKey + "-") ? key : null;
}
