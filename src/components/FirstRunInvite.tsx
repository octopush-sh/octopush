import { useEffect } from "react";
import { Users, X, XCircle } from "lucide-react";
import { useFirstRunStore } from "../stores/firstRunStore";
import { hasReadinessFailure, useReadinessStore } from "../stores/readinessStore";

/** The one-shot first-run invite — the differentiator's minute-one moment.
 *  Floats over the Talk canvas (where every new user lands) and hands off to
 *  the Direct launcher with the flagship crew preselected and the workspace's
 *  task as the brief: one click here, one "Begin the run" there, and a crew
 *  of five agents is shipping while they watch.
 *
 *  Beacon-legal: Talk has no brass live element, so the CTA may pulse
 *  (exactly one per attention scope). Rendered only while eligible — never
 *  ran a crew (all-time), not dismissed, not already used this session.
 *
 *  While shown it runs the readiness checks once; when one fails (no
 *  `claude`, no `git`) it links to the Settings › General readiness card. */
export function FirstRunInvite({ onSendCrew, onOpenReadiness }: {
  onSendCrew: () => void;
  onOpenReadiness: () => void;
}) {
  const dismissed = useFirstRunStore((s) => s.dismissed);
  const usedThisSession = useFirstRunStore((s) => s.usedThisSession);
  const everRan = useFirstRunStore((s) => s.everRan);
  const dismiss = useFirstRunStore((s) => s.dismiss);
  const checks = useReadinessStore((s) => s.checks);
  const checkReadiness = useReadinessStore((s) => s.check);

  const eligible = !dismissed && !usedThisSession && everRan === false;
  useEffect(() => {
    if (eligible && useReadinessStore.getState().checks === null) void checkReadiness();
  }, [eligible, checkReadiness]);

  if (!eligible) return null;
  const notReady = hasReadinessFailure(checks);

  return (
    <div className="octo-rise-in pointer-events-none absolute inset-x-0 bottom-36 z-30 flex justify-center px-6">
      <div className="pointer-events-auto w-full max-w-[520px] rounded-xl border border-octo-hairline bg-octo-panel p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">
              Direct · your first crew
            </span>
            <h2 className="mt-1.5 font-serif text-[19px] leading-tight text-octo-ivory">
              Put a crew on it.
            </h2>
          </div>
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss the crew invite"
            title="Not now"
            className="shrink-0 rounded p-1 text-octo-mute transition hover:bg-[var(--brass-ghost)] hover:text-octo-ivory"
          >
            <X size={14} />
          </button>
        </div>
        <p className="mt-2 text-[13px] leading-relaxed text-octo-sage">
          Five agents — plan, review, build, re-review, test — take on your task
          while you watch every move. You approve the gates; they do the work.
        </p>
        {notReady && (
          <div className="octo-pop-in mt-3 flex items-center gap-2 text-[12px] text-octo-sage">
            <span className="text-octo-rouge" title="A readiness check failed">
              <XCircle size={12} strokeWidth={1.75} aria-hidden />
            </span>
            <span className="min-w-0 flex-1">This Mac isn't ready for a crew yet.</span>
            <button
              type="button"
              onClick={onOpenReadiness}
              className="shrink-0 font-serif text-[13px] text-octo-brass transition-colors duration-[180ms] hover:text-octo-brass-hi"
            >
              See what's missing
            </button>
          </div>
        )}
        <div className="mt-4 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={dismiss}
            className="rounded-md px-3 py-1.5 font-mono text-xs text-octo-mute transition-colors duration-[180ms] hover:text-octo-sage"
          >
            Not now
          </button>
          <button
            type="button"
            onClick={onSendCrew}
            className="octo-stage-pulse flex items-center gap-1.5 rounded-lg border border-[var(--brass-dim)] bg-[var(--brass-ghost)] px-4 py-2 font-serif text-sm text-octo-brass transition-colors duration-[180ms] hover:text-octo-brass-hi"
          >
            <Users size={13} strokeWidth={1.75} />
            Send out the crew
          </button>
        </div>
      </div>
    </div>
  );
}
