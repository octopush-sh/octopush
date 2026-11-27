/** An issue key: a Jira key (`PROJ-123`) or an Epiku story id, which adds
 *  dotted numbers (`ST-2.3`, `HU-1.1`). A dot extends a key only when a digit
 *  follows it, so `PROJ-123.fix` still gives `PROJ-123`. Kept in sync with the
 *  Rust `detect_issue_key` in `src-tauri/src/issue_tracker/mod.rs`. Both
 *  require a ≥2-char project prefix (e.g. "A-1" → null; "AB-1" → "AB-1"). */
const KEY_SOURCE = String.raw`[A-Z][A-Z0-9]+-\d+(?:\.\d+)*`;
const KEY_IN_TEXT = new RegExp(String.raw`(?<![A-Za-z0-9])${KEY_SOURCE}`);
const KEYS_IN_TEXT = new RegExp(KEY_IN_TEXT.source, "g");
const KEY_EXACT = new RegExp(`^${KEY_SOURCE}$`);

/** First issue key in a branch name, or null. */
export function detectIssueKey(branch: string): string | null {
  const m = branch.match(KEY_IN_TEXT);
  return m ? m[0] : null;
}

/** Every issue key in a branch name, in order. */
export function detectIssueKeys(branch: string): string[] {
  return branch.match(KEYS_IN_TEXT) ?? [];
}

/** A Jira key never has dotted numbers: `PROJ-12.5` names `PROJ-12`. */
export function jiraKeyOf(key: string): string {
  return key.split(".")[0];
}

/** True when `text` is exactly one issue key (`OCT-12`, `ST-1.1`). */
export function isIssueKey(text: string): boolean {
  return KEY_EXACT.test(text);
}

/** The ticket a branch names for a project's tracker (#1127). Under Epiku,
 *  the first dotted story id (`ST-2.3`) that `isKnownStory` confirms: one of
 *  the project's loaded stories, or one `getIssue` read. A dotted token that
 *  isn't a story (`UTF-8.1`, `NODE-20.11`) links nothing and fetches nothing.
 *  Otherwise a key of the project's Jira key ({@link detectIssueKeyForProject}). */
export function detectTrackerKey(
  branch: string,
  tracker: "jira" | "epiku" | null,
  jiraProjectKey: string | null,
  isKnownStory: (key: string) => boolean = () => false,
): string | null {
  if (tracker !== "epiku") return detectIssueKeyForProject(branch, jiraProjectKey);
  return detectIssueKeys(branch).find((key) => key.includes(".") && isKnownStory(key)) ?? null;
}

/** Like {@link detectIssueKey} but only returns a key that belongs to the
 *  project's configured Jira key (e.g. "OCT" → accepts "OCT-12", rejects
 *  "UTF-8"), without dotted numbers (`OCT-12.5` → `OCT-12`). Returns null when
 *  the project has no configured key, so we never surface a guessed ticket we
 *  can't validate (C5). */
export function detectIssueKeyForProject(
  branch: string,
  projectKey: string | null,
): string | null {
  if (!projectKey) return null;
  const key = detectIssueKey(branch);
  return key && key.startsWith(projectKey + "-") ? jiraKeyOf(key) : null;
}
