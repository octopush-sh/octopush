/** An issue key: a Jira key (`PROJ-123`) or an Epiku story id, which adds
 *  dotted numbers (`ST-2.3`, `HU-1.1`). A dot extends a key only when a digit
 *  follows it, so `PROJ-123.fix` still gives `PROJ-123`. Kept in sync with the
 *  Rust `detect_issue_key` in `src-tauri/src/issue_tracker/mod.rs`. Both
 *  require a ≥2-char project prefix (e.g. "A-1" → null; "AB-1" → "AB-1"). */
const KEY_SOURCE = String.raw`[A-Z][A-Z0-9]+-\d+(?:\.\d+)*`;
const KEY_IN_TEXT = new RegExp(String.raw`(?<![A-Za-z0-9])${KEY_SOURCE}`);
const KEY_EXACT = new RegExp(`^${KEY_SOURCE}$`);

/** First issue key in a branch name, or null. */
export function detectIssueKey(branch: string): string | null {
  const m = branch.match(KEY_IN_TEXT);
  return m ? m[0] : null;
}

/** True when `text` is exactly one issue key (`OCT-12`, `ST-1.1`). */
export function isIssueKey(text: string): boolean {
  return KEY_EXACT.test(text);
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
