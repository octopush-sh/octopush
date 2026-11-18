// Which change Review shows (#851): the working tree (what the agent left
// uncommitted, hunk by hunk) or what the workspace committed since its base
// (merge base → HEAD, read-only). Direct crews commit their work, so after a
// run the working tree is often clean while the branch holds the change.
// Pure, so the default and the copy stay unit-testable.

export type ReviewSource = "working" | "committed";

/** The view Review shows. With no commits ahead there is only the working
 *  tree. Otherwise the user's pick wins; without one, the working tree when
 *  it has changes (today's behaviour), else the commits. */
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

/** Files in a unified diff (one `diff --git` header each). */
export function diffFileCount(diff: string): number {
  let n = 0;
  for (const line of diff.split("\n")) if (line.startsWith("diff --git ")) n++;
  return n;
}

/** The base as copy: "main", or "the base branch" when unknown. */
export function baseName(base: string | null | undefined): string {
  return base && base.trim() ? base : "the base branch";
}
