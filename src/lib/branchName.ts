// A short branch name from a task — the one rule for the mission wizard and
// (mirrored in Rust, `workspace::branch_from_task`) the MCP's create_workspace.
//
// Why short: the worktree directory is named after the branch, and Claude
// Code names its transcript directory after the worktree path, capped at 200
// characters. A branch that carries a whole ticket summary blows past that,
// and the session's spend disappears from the ledger. A name is the ticket
// key, when there is one, and up to four significant words of the task.
import { GENESIS_STOPWORDS } from "./genesis";
import { detectIssueKey } from "./detectIssueKey";

/** The longest branch the wizard derives or lets you type. */
export const BRANCH_NAME_MAX = 60;
/** How many words of the task make it into the name. */
export const BRANCH_WORDS = 4;
/** The longest branch-derived part of a worktree directory name (the backend
 *  appends `-<id8>`). Mirrors `workspace::DIR_SLUG_MAX`. */
export const DIR_SLUG_MAX = 60;

/** Cut a `-`-joined slug to at most `max` characters on a word boundary —
 *  never mid-word, never leaving a trailing dash. A slug with no boundary
 *  before the limit is cut hard. */
export function shortenSlug(slug: string, max: number): string {
  if (slug.length <= max) return slug;
  const head = slug.slice(0, max);
  const cut = head.lastIndexOf("-");
  return (cut > 0 ? head.slice(0, cut) : head).replace(/-+$/, "");
}

function cleanToken(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 24);
}

/**
 * `<KEY>-<up to four significant words>`, at most {@link BRANCH_NAME_MAX}
 * characters, cut on a word boundary and never inside the key. The key is
 * the one given (a ticket the workspace is created from) or the first one
 * found in the task text; a token that is the key itself never repeats.
 * "" when nothing is left — the caller picks its fallback.
 */
export function branchFromTask(task: string, issueKey?: string | null): string {
  const key = (issueKey ?? detectIssueKey(task) ?? "").trim();
  const keyToken = key.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const tokens = task
    .split(/\s+/)
    .map(cleanToken)
    .filter((t) => t && t !== keyToken);
  const significant = tokens.filter((t) => !GENESIS_STOPWORDS.has(t));
  const body = (significant.length > 0 ? significant : tokens).slice(0, BRANCH_WORDS).join("-");
  if (!key) return shortenSlug(body, BRANCH_NAME_MAX);
  if (!body) return key;
  const room = BRANCH_NAME_MAX - key.length - 1;
  const tail = room > 0 ? shortenSlug(body, room) : "";
  return tail ? `${key}-${tail}` : key;
}
