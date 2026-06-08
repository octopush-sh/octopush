import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { useAiReview, diffHash } from "../../stores/aiReviewStore";
import { AiFindingCard } from "./AiFindingCard";
import { ModelPicker } from "../ModelPicker";

export function AiReviewPanel({
  workspaceId,
  gitDiff,
  onJump,
}: {
  workspaceId: string;
  gitDiff: string;
  onJump: (file: string, line: number | null) => void;
}) {
  const [collapsed, setCollapsed] = useState(true);
  const model = useAiReview((s) => s.modelFor(workspaceId));
  const setModel = useAiReview((s) => s.setModel);
  const review = useAiReview((s) => s.reviewFor(workspaceId));
  const run = useAiReview((s) => s.run);

  const hasDiff = gitDiff.trim().length > 0;
  const dh = useMemo(() => diffHash(gitDiff), [gitDiff]);
  const stale = review.status === "done" && review.diffHash !== dh;

  const start = () => {
    if (!hasDiff) return;
    setCollapsed(false);
    void run(workspaceId, gitDiff);
  };

  return (
    <div className="border-b border-octo-hairline">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass focus-visible:ring-1 focus-visible:ring-octo-brass"
        >
          § AI Review
        </button>
        {review.status === "done" && (
          <span className="font-mono text-[9px] text-octo-mute">
            {review.result!.findings.length} finding{review.result!.findings.length !== 1 ? "s" : ""}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          <ModelPicker activeModel={model} onSelectModel={(m) => setModel(workspaceId, m)} />
          {hasDiff && review.status !== "running" && (
            <button
              onClick={start}
              className="rounded px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.15em] text-octo-brass focus-visible:ring-1 focus-visible:ring-octo-brass"
              style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
            >
              {review.status === "done" ? "Re-review" : "Review this change"}
            </button>
          )}
        </span>
      </div>

      <div
        className="grid transition-[grid-template-rows] duration-[var(--dur-standard)]"
        style={{ gridTemplateRows: collapsed ? "0fr" : "1fr" }}
      >
        <div className="min-h-0 overflow-hidden px-3 pb-3">
          {!hasDiff ? (
            <p className="text-[11px] text-octo-mute">Nothing to review.</p>
          ) : review.status === "running" ? (
            <div className="flex items-center gap-2 text-[11px] text-octo-sage">
              <Loader2 size={12} className="animate-spin" /> Reading the change…
            </div>
          ) : review.status === "error" ? (
            <p className="text-[11px] text-octo-rouge">
              {review.error}{" "}
              <button onClick={start} className="text-octo-brass focus-visible:ring-1 focus-visible:ring-octo-brass">Retry</button>
            </p>
          ) : review.status === "done" ? (
            <div className="space-y-1.5">
              {stale && (
                <button onClick={start} className="font-mono text-[10px] text-octo-brass focus-visible:ring-1 focus-visible:ring-octo-brass">
                  diff changed — re-run ⟶
                </button>
              )}
              <p className="text-[11px] leading-[1.5] text-octo-sage">{review.result!.summary}</p>
              {review.result!.findings.map((f, i) => (
                <AiFindingCard key={`${f.file ?? ""}:${f.line ?? ""}:${f.title}:${i}`} finding={f} onJump={onJump} />
              ))}
              {review.result!.findings.length === 0 && (
                <p className="text-[11px] text-octo-verdigris">No issues found.</p>
              )}
            </div>
          ) : (
            <p className="text-[11px] text-octo-mute">Run an AI review of the current change.</p>
          )}
        </div>
      </div>
    </div>
  );
}
