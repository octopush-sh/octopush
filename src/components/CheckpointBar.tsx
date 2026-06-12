import { useEffect, useState } from "react";
import type { RunStage } from "../lib/ipc";
import { isTransientHalt } from "../lib/runStatus";
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
  /** Re-run a transient halt as-is (no feedback, spend kept) — see CheckpointAction::Resume. */
  onResume: () => void;
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

export function CheckpointBar({ blockedStage, onApprove, onReject, onAbort, onResume, loopTargetRole, loopState, onSendBack }: Props) {
  const [mode, setMode] = useState<"decide" | "reject" | "sendback">("decide");
  const [feedback, setFeedback] = useState("");
  const failed = blockedStage.status === "failed";
  // A transient halt (rate limit, overload, 5xx, dropped connection) isn't a
  // wrong result — the substrate was briefly unavailable. It gets its own calmer
  // amber treatment and a Resume affordance, not the rouge accept/re-run choice.
  const transient = failed && isTransientHalt(blockedStage.error);

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

  const tone = transient
    ? "border-[var(--warning-border)] bg-[var(--warning-ghost)]"
    : failed
      ? "border-octo-rouge bg-[var(--rouge-ghost)]"
      : "border-[var(--brass-dim)] bg-[var(--brass-faint)]";

  return (
    <div className={`border-t px-4 py-3 ${tone}`}>
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
            <span className={`font-mono text-[10px] uppercase tracking-[0.25em] ${transient ? "text-octo-warning" : failed ? "text-octo-rouge" : "text-octo-brass"}`}>
              {transient ? "⟳ awaiting retry" : failed ? "✕ stage halted" : "⟜ checkpoint"}
            </span>
            <span
              className="min-w-0 flex-1 truncate text-sm text-octo-sage"
              title={failed ? blockedStage.error ?? undefined : undefined}
            >
              {transient ? (
                <><b className="text-octo-ivory">{labelForRole(blockedStage.role)}</b> paused on a transient fault: {firstLine(blockedStage.error)}</>
              ) : failed ? (
                <><b className="text-octo-ivory">{labelForRole(blockedStage.role)}</b> halted: {firstLine(blockedStage.error)}</>
              ) : (
                <>Review <b className="text-octo-ivory">{labelForRole(blockedStage.role)}</b> and choose how to proceed.</>
              )}
            </span>
            {transient ? (
              // The work isn't wrong — the substrate hiccuped. Resume re-runs the
              // stage as-is (worktree intact, spend kept). Amber, never brass.
              <button type="button" onClick={onResume}
                className="rounded-md border border-octo-warning px-3 py-1.5 font-serif text-sm text-octo-warning transition-colors duration-[180ms] hover:bg-[var(--warning-ghost)]">
                Resume the stage
              </button>
            ) : failed ? (
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
