import { CheckCircle } from "lucide-react";
import { baseName, commitCount, type ReviewSource } from "../../lib/reviewSource";
import type { TurnReadState } from "../../lib/turnChanges";

/** Which view is empty and what the other one holds (#851). */
export interface EmptyDiffContext {
  source: ReviewSource;
  /** Commits since the base. */
  commitsAhead: number;
  base: string | null;
  /** Changed files in the working tree. */
  workingCount: number;
  /** ±WS is on: whitespace-only changes are hidden, so commits that only
   *  re-indent leave an empty committed diff (#903). */
  ignoreWhitespace?: boolean;
  /** This turn's diff is still being read, or couldn't be (#1152). */
  turnRead?: TurnReadState;
}

/** The empty state's title and line, by case. Exported for tests. A `quiet`
 *  copy is a wait, not an outcome: one muted line, no mark. */
export function emptyDiffCopy(
  stagedCount: number,
  ctx: EmptyDiffContext | undefined,
): { title: string; body: string; showCommitted: boolean; quiet?: boolean } {
  const commits = ctx?.commitsAhead ?? 0;
  const base = baseName(ctx?.base);
  if (ctx?.source === "turn" && ctx.turnRead === "loading") {
    return { title: "", body: "Reading this turn's changes…", showCommitted: false, quiet: true };
  }
  if (ctx?.source === "turn" && typeof ctx.turnRead === "object" && ctx.turnRead) {
    return { title: "This turn's changes couldn't be read.", body: ctx.turnRead.error, showCommitted: false };
  }
  if (ctx?.source === "turn") {
    return {
      title: "Nothing to review.",
      body: ctx.ignoreWhitespace
        ? "With whitespace ignored, this turn changes nothing."
        : "This turn left the files as they were.",
      showCommitted: false,
    };
  }
  if (ctx?.source === "committed") {
    return {
      title: "Nothing to review.",
      body: ctx.ignoreWhitespace
        ? `With whitespace ignored, the ${commitCount(commits)} since ${base} change nothing.`
        : `The ${commitCount(commits)} since ${base} leave the code as it was.`,
      showCommitted: false,
    };
  }
  if (stagedCount > 0) {
    return {
      title: `${stagedCount} file${stagedCount !== 1 ? "s" : ""} staged.`,
      body: "Write a commit message in the Changes rail and commit when you're ready.",
      showCommitted: false,
    };
  }
  if (commits > 0) {
    return {
      title: "The working tree is clean.",
      body: `This workspace's work is committed: ${commitCount(commits)} since ${base}.`,
      showCommitted: true,
    };
  }
  return {
    title: "Nothing to review.",
    body: ctx
      ? `No uncommitted changes, and no commits since ${base}. When the agent edits or commits in this workspace, the diff appears here.`
      : "When the agent edits files in this workspace, the diff will appear here for hunk-by-hunk approval.",
    showCommitted: false,
  };
}

export function EmptyDiffState({
  stagedCount,
  context,
  onShowCommitted,
}: {
  stagedCount: number;
  context?: EmptyDiffContext;
  onShowCommitted?: () => void;
}) {
  const copy = emptyDiffCopy(stagedCount, context);
  if (copy.quiet) {
    return (
      <div className="octo-fade-in flex h-full items-center justify-center font-mono text-[11px] text-octo-mute" role="status">
        {copy.body}
      </div>
    );
  }
  return (
    <div className="octo-fade-in flex h-full flex-col items-center justify-center gap-4 text-center">
      <CheckCircle size={24} className="text-octo-brass opacity-60" />
      <div className="font-serif text-[20px] leading-tight tracking-[-0.005em] text-octo-ivory">{copy.title}</div>
      <p className="max-w-xs text-[12px] leading-[1.6] text-octo-sage">{copy.body}</p>
      {copy.showCommitted && onShowCommitted && (
        <button
          type="button"
          onClick={onShowCommitted}
          title="Show the committed changes since the base, read-only"
          className="font-serif text-[14px] text-octo-brass transition-colors hover:text-octo-ivory focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-octo-brass"
        >
          Read what was committed
        </button>
      )}
      <div className="h-px w-7 bg-octo-brass/60" aria-hidden />
    </div>
  );
}
