import { useEffect, useState } from "react";
import type { RunStage } from "../lib/ipc";
import { labelForRole } from "./RunTrack";
import { FadeSwap } from "./primitives/FadeSwap";

interface LoopState {
  iteration: number;
  max: number;
}

interface Props {
  blockedStage: RunStage;
  onApprove: () => void;
  onReject: (feedback: string) => void;
  onAbort: () => void;
  /** Human-readable label for the loop target stage, or null when no loop applies. */
  loopTargetRole: string | null;
  /** Current loop iteration state, or null when no loop applies. */
  loopState: LoopState | null;
  onSendBack: (feedback: string) => void;
}

/** First non-empty line of a stage error, for the one-line decision strip. */
function firstLine(error: string | null): string {
  const line = (error ?? "").split("\n")[0].trim();
  return line || "stage halted";
}

export function CheckpointBar({ blockedStage, onApprove, onReject, onAbort, loopTargetRole, loopState, onSendBack }: Props) {
  const [mode, setMode] = useState<"decide" | "reject" | "sendback">("decide");
  const [feedback, setFeedback] = useState("");
  const failed = blockedStage.status === "failed";

  // The bar stays mounted inside the Reveal dock across pauses — a new
  // checkpoint must never inherit the previous one's editor mode or text.
  useEffect(() => {
    setMode("decide");
    setFeedback("");
  }, [blockedStage.id]);

  const atCap = loopState !== null && loopState.iteration >= loopState.max;
  const canSendBack = loopTargetRole !== null && !atCap;

  function submitFeedback() {
    (mode === "reject" ? onReject : onSendBack)(feedback);
    setMode("decide");
    setFeedback("");
  }

  return (
    <div className={`border-t px-4 py-3 ${failed ? "border-octo-rouge bg-[var(--rouge-ghost)]" : "border-[var(--brass-dim)] bg-[var(--brass-faint)]"}`}>
      {loopState !== null && (
        <div className="mb-2 h-4 font-mono text-[10px] uppercase tracking-[0.25em]">
          {atCap ? (
            <span className="text-octo-brass">
              loop exhausted · <span className="octo-tabular">{loopState.iteration}/{loopState.max}</span> — approve or abort
            </span>
          ) : (
            <span className="text-octo-mute">
              review loop · <span className="octo-tabular">{loopState.iteration} of {loopState.max}</span> used
            </span>
          )}
        </div>
      )}

      <FadeSwap swapKey={mode}>
        {mode === "decide" ? (
          <div className="flex items-center gap-3">
            <span className={`font-mono text-[10px] uppercase tracking-[0.25em] ${failed ? "text-octo-rouge" : "text-octo-brass"}`}>
              {failed ? "✕ stage halted" : "⟜ checkpoint"}
            </span>
            <span
              className="min-w-0 flex-1 truncate text-sm text-octo-sage"
              title={failed ? blockedStage.error ?? undefined : undefined}
            >
              {failed ? (
                <><b className="text-octo-ivory">{labelForRole(blockedStage.role)}</b> halted: {firstLine(blockedStage.error)}</>
              ) : (
                <>Review <b className="text-octo-ivory">{labelForRole(blockedStage.role)}</b> and choose how to proceed.</>
              )}
            </span>
            {failed ? (
              // Accept the partial work and let the pipeline's next review
              // catch the gaps. Outlined — the bar keeps at most one solid brass.
              <button type="button" onClick={onApprove}
                className="rounded-md border border-octo-brass px-3 py-1.5 font-serif text-sm text-octo-brass transition-colors duration-[180ms] hover:bg-[var(--brass-ghost)]">
                Accept &amp; continue
              </button>
            ) : (
              <button type="button" onClick={onApprove}
                className="rounded-md bg-octo-brass px-3 py-1.5 font-serif text-sm text-octo-onyx transition-colors duration-[180ms] hover:bg-octo-brass-hi">
                Approve &amp; continue
              </button>
            )}
            {canSendBack && (
              <button type="button" onClick={() => setMode("sendback")}
                className="rounded-md border border-octo-brass px-3 py-1.5 font-serif text-sm text-octo-brass transition-colors duration-[180ms] hover:bg-[var(--brass-ghost)]">
                Send back to {loopTargetRole}
              </button>
            )}
            <button type="button" onClick={() => setMode("reject")}
              className="rounded-md border border-octo-hairline px-3 py-1.5 font-mono text-xs text-octo-sage transition-colors duration-[180ms] hover:text-octo-ivory">
              {failed ? "Re-run" : "Reject"}
            </button>
            <button type="button" onClick={onAbort}
              className="rounded-md border border-octo-hairline px-3 py-1.5 font-mono text-xs text-octo-mute transition-colors duration-[180ms] hover:text-octo-rouge">
              Abort
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <textarea
              autoFocus
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder={mode === "reject" ? "Optional feedback for the re-run…" : "Optional feedback for the send-back…"}
              className="h-20 resize-none rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-mono text-xs text-octo-ivory placeholder:font-serif placeholder:text-octo-mute"
            />
            <div className="flex gap-2">
              <button type="button" onClick={submitFeedback}
                className="rounded-md bg-octo-brass px-3 py-1.5 font-serif text-sm text-octo-onyx transition-colors duration-[180ms] hover:bg-octo-brass-hi">
                {mode === "reject" ? "Re-run the stage" : "Send back"}
              </button>
              <button type="button"
                onClick={() => { setMode("decide"); setFeedback(""); }}
                className="rounded-md border border-octo-hairline px-3 py-1.5 font-mono text-xs text-octo-mute">
                Cancel
              </button>
            </div>
          </div>
        )}
      </FadeSwap>
    </div>
  );
}
