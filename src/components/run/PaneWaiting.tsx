import { useAttentionStore } from "../../stores/attentionStore";
import { claudeWaitingCopy } from "../../lib/claudeWaiting";
import { FadeSwap } from "../primitives/FadeSwap";

/**
 * A pane caption's quiet "· waiting on permission" for a session on screen
 * that Claude Code's hooks say is blocked on the user (`waitingByTerminal`).
 * Mute mono with one static brass dot — the caption's only brass, no pulse.
 * Fades in and out with the mark.
 */
export function PaneWaiting({ terminalId, tour }: { terminalId: string | null; tour?: string }) {
  const reason = useAttentionStore((s) => (terminalId ? s.waitingByTerminal[terminalId] : undefined));
  return (
    <FadeSwap swapKey={reason ?? ""} className="flex shrink-0 items-center">
      {reason && (
        <span
          data-testid="pane-waiting"
          data-tour={tour}
          title="Claude Code is waiting on you in this session"
          className="flex items-center gap-1.5 whitespace-nowrap pl-2 font-mono text-[11px] tracking-[0.04em] text-octo-mute"
        >
          <span aria-hidden>·</span>
          <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-octo-brass" />
          {claudeWaitingCopy(reason)}
        </span>
      )}
    </FadeSwap>
  );
}
