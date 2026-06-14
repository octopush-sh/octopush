import { useMemo } from "react";
import { ChevronDown, Loader2, X, Sparkles } from "lucide-react";
import { useAiReview, diffHash } from "../../stores/aiReviewStore";
import { AiFindingCard } from "./AiFindingCard";
import { FadeSwap } from "../primitives/FadeSwap";
import { ModelPicker } from "../ModelPicker";

export function AiReviewPanel({
  workspaceId,
  gitDiff,
  onJump,
  onEdit,
  embedded = false,
  onClose,
}: {
  workspaceId: string;
  gitDiff: string;
  onJump: (file: string, line: number | null) => void;
  /** Open a finding's file in the editor at its line, to fix it directly. */
  onEdit?: (file: string, line: number | null) => void;
  /** Embedded in the Diff canvas drawer: slim header, always-open body, model
   *  picker + run CTA in the body, optional close. Default (companion-style)
   *  keeps the collapse chevron. */
  embedded?: boolean;
  onClose?: () => void;
}) {
  // Collapse lives in the store (per workspace) so it survives the
  // mode-switch remount; a local useState would reopen/reclose on return.
  const collapsed = useAiReview((s) => s.collapsedFor(workspaceId));
  const setCollapsed = useAiReview((s) => s.setCollapsed);
  const model = useAiReview((s) => s.modelFor(workspaceId));
  const setModel = useAiReview((s) => s.setModel);
  const review = useAiReview((s) => s.reviewFor(workspaceId));
  const run = useAiReview((s) => s.run);

  const hasDiff = gitDiff.trim().length > 0;
  const dh = useMemo(() => diffHash(gitDiff), [gitDiff]);
  const stale = review.status === "done" && review.diffHash !== dh;

  const start = () => {
    if (!hasDiff) return;
    setCollapsed(workspaceId, false);
    void run(workspaceId, gitDiff);
  };

  // One discriminant per mutually-exclusive body view, so FadeSwap
  // crossfades between them instead of teleporting the subtree.
  const bodyKey = !hasDiff ? "no-diff" : review.status;

  const findings = review.result?.findings ?? [];
  const count = review.status === "done" ? findings.length : null;
  const countLabel =
    count != null ? `${count} finding${count !== 1 ? "s" : ""}` : null;

  // Findings + summary list, shared by both layouts. A function (not a const)
  // so `review.result` is only dereferenced when actually rendered — i.e. in
  // the "done" branch — never eagerly while idle/running (result is null then).
  const renderFindings = () => (
    <div className="space-y-1.5">
      {stale && (
        <button onClick={start} className="font-mono text-[10px] text-octo-brass focus-visible:ring-1 focus-visible:ring-octo-brass">
          diff changed — re-run ⟶
        </button>
      )}
      <p className="text-[11px] leading-[1.5] text-octo-sage">{review.result!.summary}</p>
      {findings.map((f, i) => (
        <AiFindingCard key={`${f.file ?? ""}:${f.line ?? ""}:${f.title}:${i}`} finding={f} onJump={onJump} onEdit={onEdit} />
      ))}
      {findings.length === 0 && (
        <p className="text-[11px] text-octo-verdigris">No issues found.</p>
      )}
    </div>
  );

  // ── Embedded (Diff drawer) — slim header, body owns the controls ──
  if (embedded) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-octo-hairline px-3">
          <span className="flex items-center gap-1.5 whitespace-nowrap font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass">
            <Sparkles size={11} aria-hidden /> AI Review
          </span>
          {countLabel && (
            <span className="font-mono text-[9px] text-octo-mute">{countLabel}</span>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close AI review"
              title="Close AI review"
              className="ml-auto flex h-6 w-6 items-center justify-center rounded text-octo-mute transition-colors hover:bg-octo-panel-2 hover:text-octo-sage focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
            >
              <X size={14} />
            </button>
          )}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {!hasDiff ? (
            <p className="text-[11px] text-octo-mute">Nothing to review.</p>
          ) : (
            <>
              {/* Control row — the picker gets the full drawer width here. */}
              <div className="mb-3 flex items-center justify-between gap-2">
                <ModelPicker activeModel={model} onSelectModel={(m) => setModel(workspaceId, m)} />
                {review.status === "done" && (
                  <button
                    type="button"
                    onClick={start}
                    className="shrink-0 whitespace-nowrap font-mono text-[10px] text-octo-brass transition hover:text-octo-ivory focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
                  >
                    re-review ⟶
                  </button>
                )}
              </div>

              <FadeSwap swapKey={bodyKey}>
                {review.status === "running" ? (
                  <div className="flex items-center gap-2 text-[11px] text-octo-sage">
                    <Loader2 size={12} className="animate-spin" /> Reading the change…
                  </div>
                ) : review.status === "error" ? (
                  <p className="text-[11px] text-octo-rouge">
                    {review.error}{" "}
                    <button onClick={start} className="text-octo-brass focus-visible:ring-1 focus-visible:ring-octo-brass">Retry</button>
                  </p>
                ) : review.status === "done" ? (
                  renderFindings()
                ) : (
                  // Idle — a prominent, ceremonial call to action.
                  <button
                    type="button"
                    onClick={start}
                    className="flex w-full items-center justify-center gap-2 rounded-md py-2 font-serif text-[13px] text-octo-brass transition-colors hover:bg-[var(--brass-ghost)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
                    style={{ border: "1px solid var(--brass-dim)" }}
                  >
                    Review this change ⟶
                  </button>
                )}
              </FadeSwap>
            </>
          )}
        </div>
      </div>
    );
  }

  // ── Default (companion-style) — collapse chevron header, grid body ──
  const body = (
    <FadeSwap swapKey={bodyKey} className="px-4 pb-3">
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
        renderFindings()
      ) : (
        <p className="text-[11px] text-octo-mute">Run an AI review of the current change.</p>
      )}
    </FadeSwap>
  );

  return (
    <div className="border-b border-octo-hairline">
      <div className="flex h-11 shrink-0 items-center gap-2 px-4">
        <button
          type="button"
          onClick={() => setCollapsed(workspaceId, !collapsed)}
          aria-expanded={!collapsed}
          title={collapsed ? "Expand AI review" : "Collapse AI review"}
          className="flex items-center gap-1.5 rounded font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass transition hover:bg-[var(--brass-ghost)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
        >
          <span>AI Review</span>
          <ChevronDown
            size={12}
            aria-hidden
            className={`text-octo-mute transition-transform duration-[280ms] ease-[cubic-bezier(0.2,0.8,0.3,1)] ${collapsed ? "-rotate-90" : ""}`}
          />
        </button>
        {countLabel && (
          <span className="font-mono text-[9px] text-octo-mute">{countLabel}</span>
        )}
        <span className="ml-auto flex items-center gap-2">
          <ModelPicker activeModel={model} onSelectModel={(m) => setModel(workspaceId, m)} />
          {hasDiff && review.status !== "running" && (
            <button
              type="button"
              onClick={start}
              className="rounded font-mono text-[10px] text-octo-brass transition hover:text-octo-ivory focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
            >
              {review.status === "done" ? "re-review ⟶" : "review this change ⟶"}
            </button>
          )}
        </span>
      </div>

      <div
        className="grid transition-[grid-template-rows] duration-[var(--dur-standard)]"
        style={{ gridTemplateRows: collapsed ? "0fr" : "1fr" }}
      >
        <div className="min-h-0 overflow-hidden">{body}</div>
      </div>
    </div>
  );
}
