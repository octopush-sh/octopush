import { CheckCircle } from "lucide-react";

export function EmptyDiffState({ stagedCount }: { stagedCount: number }) {
  const hasStaged = stagedCount > 0;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
      <CheckCircle size={24} className="text-octo-brass opacity-60" />
      <div className="font-serif text-[20px] leading-tight tracking-[-0.005em] text-octo-ivory">
        {hasStaged ? `${stagedCount} file${stagedCount !== 1 ? "s" : ""} staged.` : "Nothing to review."}
      </div>
      <p className="max-w-xs text-[12px] leading-[1.6] text-octo-sage">
        {hasStaged
          ? "Write a commit message in the Changes rail and commit when you're ready."
          : "When the agent edits files in this workspace, the diff will appear here for hunk-by-hunk approval."}
      </p>
      <div className="h-px w-7 bg-octo-brass/60" aria-hidden />
    </div>
  );
}
