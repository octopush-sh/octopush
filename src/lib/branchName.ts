// A short branch name from a task — the one rule for the mission wizard and
// (mirrored in Rust, `workspace::branch_from_task`) the MCP's create_workspace.
// `branchName.fixtures.json` holds the cases both must satisfy.
//
// Why short: the worktree directory is named after the branch, and Claude
// Code names its transcript directory after the worktree path, capped at 200
// characters. A branch that carries a whole ticket summary blows past that,
// and the session's spend disappears from the ledger. A name is the ticket
// key, when there is one, and up to four significant words of the task.
import { pickWords } from "./genesis";
import { detectIssueKeyForProject } from "./detectIssueKey";

/** The longest branch the wizard derives or lets you type. */
export const BRANCH_NAME_MAX = 60;
/** How many words of the task make it into the name. */
export const BRANCH_WORDS = 4;
/** The longest branch-derived part of a worktree directory name (the backend
 *  appends `-<id8>`). Mirrors `workspace::DIR_SLUG_MAX`. */
export const DIR_SLUG_MAX = 60;
/** The least the backend keeps of it under a deep project path. */
export const DIR_SLUG_MIN = 8;
/** Claude Code caps a transcript directory name (the sanitized worktree path)
 *  at this many characters. Mirrors `workspace::CLAUDE_DIR_NAME_CAP`. */
export const CLAUDE_DIR_NAME_CAP = 200;

/** Cut a `-`-joined slug to at most `max` characters on a word boundary —
 *  never mid-word, never leaving a trailing dash. A slug with no boundary
 *  before the limit is cut hard. */
export function shortenSlug(slug: string, max: number): string {
  if (slug.length <= max) return slug;
  const head = slug.slice(0, max);
  const cut = head.lastIndexOf("-");
  return (cut > 0 ? head.slice(0, cut) : head).replace(/-+$/, "");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `<KEY>-<up to four significant words>`, at most {@link BRANCH_NAME_MAX}
 * characters, cut on a word boundary and never inside the key. The key is
 * the one given (a ticket the workspace is created from) or, only when the
 * project has a Jira key, that project's first key found in the task — a
 * bare `UTF-8` or `SHA-256` is never a ticket. The key's text is removed
 * from the task before its words are picked, so it never repeats, glued to
 * punctuation or not. "" when nothing is left — the caller picks its fallback.
 */
export function branchFromTask(task: string, issueKey?: string | null, projectKey?: string | null): string {
  const key = (issueKey ?? detectIssueKeyForProject(task, projectKey ?? null) ?? "").trim();
  const text = key ? task.replace(new RegExp(escapeRegExp(key), "gi"), " ") : task;
  const body = pickWords(text, BRANCH_WORDS).join("-");
  if (!key) return shortenSlug(body, BRANCH_NAME_MAX);
  if (!body) return key;
  const room = BRANCH_NAME_MAX - key.length - 1;
  const tail = room > 0 ? shortenSlug(body, room) : "";
  return tail ? `${key}-${tail}` : key;
}

/** `base`, or `base-2`, `base-3`, … — the first not taken. Two tasks that
 *  share their first four words must not share a branch, or the second
 *  mission would silently reuse the first one's workspace. */
export function uniqueBranch(base: string, isTaken: (branch: string) => boolean): string {
  if (!isTaken(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!isTaken(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/** The name Claude Code gives a transcript directory for a path: every
 *  character outside `[A-Za-z0-9]` becomes `-`. Mirrors
 *  `transcripts::project_dir_name`. */
export function claudeProjectDirName(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, "-");
}

/** How much of the branch slug the backend keeps in a worktree directory
 *  under `worktreesDir` — [`DIR_SLUG_MAX`] unless the path is so deep that
 *  the sanitized worktree path would pass Claude Code's cap, then less,
 *  never under [`DIR_SLUG_MIN`]. Mirrors `workspace::worktree_dir_name_under`. */
export function worktreeSlugMax(worktreesDir: string): number {
  const base = claudeProjectDirName(`${worktreesDir}/`).length;
  const room = Math.max(0, CLAUDE_DIR_NAME_CAP - base - 1 - 8);
  return Math.max(DIR_SLUG_MIN, Math.min(DIR_SLUG_MAX, room));
}
