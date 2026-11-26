// Which change Review shows (#851): the working tree (what the agent left
// uncommitted, hunk by hunk) or what the workspace committed since its base
// (merge base → HEAD, read-only). Direct crews commit their work, so after a
// run the working tree is often clean while the branch holds the change.
// Pure, so the default and the copy stay unit-testable.

export type ReviewSource = "working" | "committed";

/** The view Review shows. With no commits ahead there is only the working
 *  tree. Otherwise the user's pick wins; without one, the working tree when
 *  it has changes (today's behaviour), else the commits. App passes the
 *  pinned default as the pick once a default has been shown (#903), so a
 *  crew touching a file never flips the view mid-read. */
export function resolveReviewSource(
  pick: ReviewSource | null | undefined,
  hasWorkingChanges: boolean,
  commitsAhead: number,
): ReviewSource {
  if (commitsAhead <= 0) return "working";
  if (pick) return pick;
  return hasWorkingChanges ? "working" : "committed";
}

/** "1 commit" / "3 commits". */
export function commitCount(n: number): string {
  return n === 1 ? "1 commit" : `${n} commits`;
}

/** The committed segment's label: "Since base · 3 commits". */
export function sinceBaseLabel(commitsAhead: number): string {
  return `Since base · ${commitCount(commitsAhead)}`;
}

/** The line `git_ops::diff_to_text` appends when the 1 MiB cap cut a diff. */
export const DIFF_TRUNCATED_MARKER = "... diff truncated (too large to display fully) ...";

/** Files in a unified diff (one `diff --git` header each). A diff the 1 MiB
 *  cap truncated holds only the files before the cut, so the count is a
 *  floor: `truncated` says so, and the copy reads "N+ files" (#903). */
export function diffFileCount(diff: string): number {
  let n = 0;
  for (const line of diff.split("\n")) if (line.startsWith("diff --git ")) n++;
  return n;
}

/** True when the backend's 1 MiB cap cut this diff short. */
export function isDiffTruncated(diff: string): boolean {
  return diff.trimEnd().endsWith(DIFF_TRUNCATED_MARKER);
}

/** The base as copy: "main", or "the base branch" when unknown. */
export function baseName(base: string | null | undefined): string {
  return base && base.trim() ? base : "the base branch";
}
