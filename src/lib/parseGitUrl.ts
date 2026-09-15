/**
 * Client-side mirror of the Rust `git_url::parse_git_url` parser.
 * Keeps name-auto-detect instant (no IPC round-trip per keystroke).
 *
 * Supported shapes:
 *   https://github.com/owner/repo.git
 *   https://github.com/owner/repo
 *   git@github.com:owner/repo.git          (SCP)
 *   ssh://git@github.com/owner/repo.git
 *   https://gitlab.com/group/sub/repo.git  (multi-level)
 *   https://bitbucket.org/owner/repo.git
 *   https://gitea.example.com/owner/repo   (custom host)
 *   https://org@dev.azure.com/org/project/_git/repo  (Azure DevOps)
 *   git@ssh.dev.azure.com:v3/org/project/repo        (Azure DevOps SSH)
 */

export interface ParsedGitUrl {
  host: string;
  /** The `user@` in front of the host, when the URL carries one (Azure DevOps
   *  and Bitbucket clone URLs do). Git then never asks for a username. */
  user?: string;
  owner: string;
  repo: string;
  isSsh: boolean;
}

/** Undo `%20`-style escapes so a repo called "My Repo" (Azure DevOps allows
 *  spaces and encodes them in its clone URLs) gets a readable folder name,
 *  `My Repo` (a terminal `git clone` would create `My%20Repo`). A segment
 *  that decodes to something that can't be a single directory name, or
 *  carries a malformed escape, is kept as written. */
function decodeSegment(segment: string): string {
  try {
    const decoded = decodeURIComponent(segment);
    // eslint-disable-next-line no-control-regex
    return /[/\\\u0000-\u001f\u007f-\u009f]/.test(decoded) ? segment : decoded;
  } catch {
    return segment;
  }
}

/** Strip trailing `.git` suffix and split `path` into [owner, repo]. */
function splitOwnerRepo(path: string): [string, string] | null {
  const stripped = path
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  const segments = stripped.split("/").filter(Boolean);
  // Azure DevOps (dev.azure.com, *.visualstudio.com, on-prem Server) puts a
  // literal `_git` between the project and the repository:
  //   https://dev.azure.com/org/project/_git/repo
  // Drop the marker so the owner is the project, not `_git`.
  if (segments.length >= 3 && segments[segments.length - 2] === "_git") {
    segments.splice(segments.length - 2, 1);
  }
  if (segments.length < 2) return null;
  const repo = decodeSegment(segments[segments.length - 1]);
  const owner = decodeSegment(segments[segments.length - 2]);
  // The repo becomes a directory name; `.`/`..` would point elsewhere.
  if ([owner, repo].some((s) => s === "" || s === "." || s === "..")) return null;
  return [owner, repo];
}

export function parseGitUrl(raw: string): ParsedGitUrl | null {
  // Same edges as Rust's `str::trim` (which also drops U+0085), plus the BOM.
  const url = raw.replace(/^[\s\u0085]+|[\s\u0085]+$/g, "");
  if (!url) return null;

  // ── SCP-style: git@github.com:owner/repo.git ──────────────────────
  if (!url.includes("://")) {
    const atIdx = url.indexOf("@");
    if (atIdx === -1) return null;
    const afterAt = url.slice(atIdx + 1);
    const colonIdx = afterAt.indexOf(":");
    if (colonIdx === -1) return null;
    const host = afterAt.slice(0, colonIdx);
    const path = afterAt.slice(colonIdx + 1);
    if (!host || !path) return null;
    const parts = splitOwnerRepo(path);
    if (!parts) return null;
    const user = url.slice(0, atIdx);
    return { host, ...(user ? { user } : {}), owner: parts[0], repo: parts[1], isSsh: true };
  }

  // ── URL-scheme forms ───────────────────────────────────────────────
  const schemeEnd = url.indexOf("://");
  const scheme = url.slice(0, schemeEnd).toLowerCase();
  if (!["https", "http", "ssh", "git"].includes(scheme)) return null;

  const isSsh = scheme === "ssh" || scheme === "git";

  let rest = url.slice(schemeEnd + 3);

  // Strip optional user@ (or user:password@) prefix (only if @ is before the first /)
  let user: string | undefined;
  const atIdx = rest.indexOf("@");
  const slashIdx = rest.indexOf("/");
  if (atIdx !== -1 && (slashIdx === -1 || atIdx < slashIdx)) {
    const name = decodeSegment(rest.slice(0, atIdx).split(":")[0]);
    if (name) user = name;
    rest = rest.slice(atIdx + 1);
  }

  // Split host from path
  const firstSlash = rest.indexOf("/");
  if (firstSlash === -1) return null;
  const host = rest.slice(0, firstSlash);
  const path = rest.slice(firstSlash + 1);
  if (!host || !path) return null;

  const parts = splitOwnerRepo(path);
  if (!parts) return null;

  return { host, ...(user ? { user } : {}), owner: parts[0], repo: parts[1], isSsh };
}
