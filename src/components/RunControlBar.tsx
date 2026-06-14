import { useEffect, useState } from "react";
import { Pause, CircleStop, Ban, RotateCcw } from "lucide-react";
import type { Run, RunStage } from "../lib/ipc";
import { isTransientHalt } from "../lib/runStatus";
import { labelForRole } from "../lib/stageMeta";
import { FadeSwap } from "./primitives/FadeSwap";

interface LoopState {
  iteration: number;
  max: number;
}

interface Props {
  run: Run;
  /** The stage awaiting a decision (awaiting_checkpoint or failed), or null. */
  blockedStage: RunStage | null;
  /** Human label for a loop target when a gated send-back applies, else null. */
  loopTargetRole: string | null;
  loopState: LoopState | null;
  onPause: () => void;
  onStopStage: () => void;
  onAbort: () => void;
  onApprove: () => void;
  onReject: (feedback: string) => void;
  onResume: () => void;
  onSendBack: (feedback: string) => void;
  onRunAgain: () => void;
}

const TERMINAL = new Set(["completed", "aborted", "failed"]);

function firstLine(error: string | null): string {
  const line = (error ?? "").split("\n")[0].trim();
  return line || "stage halted";
}

/** A small icon control button with a tooltip — the run's quiet verbs. */
function IconCtl({
  label,
  onClick,
  children,
  danger = false,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`flex h-8 w-8 items-center justify-center rounded-md border border-octo-hairline text-octo-sage transition-colors duration-[180ms] hover:border-[var(--brass-dim)] ${
        danger ? "hover:text-octo-rouge" : "hover:text-octo-ivory"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * The single, state-adaptive command surface for a run. It subsumes the old
 * RunTrack controls and the CheckpointBar: while running it offers pause / stop
 * / abort; at a checkpoint it carries the full decision (approve · send-back ·
 * reject · resume · abort) with a feedback editor; when terminal it offers a
 * re-run. One bar, one place to steer.
 */
export function RunControlBar(props: Props) {
  const { run, blockedStage } = props;

  if (TERMINAL.has(run.status)) {
    return <TerminalBar run={run} onRunAgain={props.onRunAgain} />;
  }
  if (blockedStage) {
    return <DecisionBar {...props} blockedStage={blockedStage} />;
  }
  if (run.status === "running") {
    return <RunningBar onPause={props.onPause} onStopStage={props.onStopStage} onAbort={props.onAbort} />;
  }
  return null;
}

function RunningBar({ onPause, onStopStage, onAbort }: { onPause: () => void; onStopStage: () => void; onAbort: () => void }) {
  return (
    <div className="octo-fade-in flex items-center gap-3 border-t border-octo-hairline bg-octo-panel px-4 py-2.5">
      <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">
        <span className="octo-stage-pulse inline-block h-1.5 w-1.5 rounded-full bg-octo-brass" aria-hidden="true" />
        running
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-octo-mute">
        Pause parks the next stage for you · stop ends the current stage.
      </span>
      <IconCtl label="Pause at the next stage" onClick={onPause}><Pause size={14} strokeWidth={1.75} /></IconCtl>
      <IconCtl label="Stop the current stage" onClick={onStopStage}><CircleStop size={14} strokeWidth={1.75} /></IconCtl>
      <IconCtl label="Abort the run" onClick={onAbort} danger><Ban size={14} strokeWidth={1.75} /></IconCtl>
    </div>
  );
}

function TerminalBar({ run, onRunAgain }: { run: Run; onRunAgain: () => void }) {
  const word = run.status === "completed" ? "completed" : run.status === "aborted" ? "aborted" : "failed";
  const cls = run.status === "completed" ? "text-octo-verdigris" : run.status === "failed" ? "text-octo-rouge" : "text-octo-mute";
  return (
    <div className="octo-fade-in flex items-center gap-3 border-t border-octo-hairline bg-octo-panel px-4 py-2.5">
      <span className={`font-mono text-[10px] uppercase tracking-[0.25em] ${cls}`}>{word}</span>
      <span className="min-w-0 flex-1" />
      <button
        type="button"
        onClick={onRunAgain}
        className="flex items-center gap-1.5 rounded-md border border-octo-hairline px-3 py-1.5 font-serif text-[13px] text-octo-brass transition-colors duration-[180ms] hover:border-[var(--brass-dim)] hover:text-octo-brass-hi"
      >
        <RotateCcw size={13} strokeWidth={1.75} />
        Run it again
      </button>
    </div>
  );
}

function DecisionBar({
  blockedStage,
  loopTargetRole,
  loopState,
  onApprove,
  onReject,
  onResume,
  onSendBack,
  onAbort,
}: Props & { blockedStage: RunStage }) {
  const [mode, setMode] = useState<"decide" | "reject" | "sendback">("decide");
  const [feedback, setFeedback] = useState("");
  const failed = blockedStage.status === "failed";
  const transient = failed && isTransientHalt(blockedStage.error);

  // Reset the editor whenever a new checkpoint arrives (the bar stays mounted).
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
              <button type="button" onClick={onResume}
                className="rounded-md border border-octo-warning px-3 py-1.5 font-serif text-sm text-octo-warning transition-colors duration-[180ms] hover:bg-[var(--warning-ghost)]">
                Resume the stage
              </button>
            ) : failed ? (
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
