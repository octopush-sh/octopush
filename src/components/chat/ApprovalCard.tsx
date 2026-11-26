import type { KeyboardEvent } from "react";
import { ShieldAlert } from "lucide-react";
import type { PendingApproval } from "../../stores/chatStore";
import { tourId } from "../../lib/tour/ids";

interface Props {
  approval: PendingApproval;
  onRespond: (decision: "approve" | "always" | "deny") => void;
}

const QUICK = "transition-colors duration-[var(--dur-quick)] ease-[var(--ease-octo)]";

/**
 * Inline approval card for a command the agent wants to run. The turn is
 * paused until the user chooses: the card waits as long as it takes (no
 * timeout), and while it waits the workspace reads as needing you. Two
 * kinds: a destructive command (with "don't ask again" for the thread), and
 * a commit/push/PR the secret guard stopped (#819) — that one names what was
 * found (kind and file:line, never the value), says when the scan read
 * uncommitted changes, and has no "don't ask again": every such command asks
 * again, and the approval covers exactly what the card showed. User-typed
 * `$` commands get the secret guard's dialog instead, never this card.
 *
 * At the keyboard, with the card focused: Enter takes the card's lead answer
 * (Approve; on the secret card the safe "Leave it out") and Esc denies. A
 * focused button answers Enter itself, as any button does.
 */
export function ApprovalCard({ approval, onRespond }: Props) {
  const secret = approval.secret === true;
  const lead = secret ? "deny" : "approve";
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onRespond("deny");
    } else if (e.key === "Enter" && e.target === e.currentTarget) {
      e.preventDefault();
      onRespond(lead);
    }
  };
  return (
    <div
      role="group"
      tabIndex={0}
      aria-label={`${secret ? "Possible secret" : "Approval needed"}: ${approval.command}`}
      aria-keyshortcuts="Enter Escape"
      title={secret ? "Enter or Esc leaves it out" : "Enter approves · Esc denies"}
      onKeyDown={onKeyDown}
      data-tour={secret ? tourId("talk-secret-approval") : tourId("talk-approval")}
      className="octo-rise-in my-2 rounded-md border border-[var(--rouge-border)] bg-[var(--rouge-ghost)] px-3 py-2.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
    >
      <div className="flex items-center gap-2">
        <ShieldAlert size={14} aria-hidden className="shrink-0 text-octo-rouge" />
        <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-octo-rouge">
          {secret ? "Possible secret" : "Approval needed"}
        </span>
        <span className="ml-auto truncate font-mono text-[10px] text-octo-mute" title={approval.reason}>
          {approval.reason}
        </span>
      </div>
      <pre className="mt-2 overflow-x-auto rounded bg-octo-onyx px-2.5 py-1.5 font-mono text-[12px] text-octo-ivory">
        <span className="text-octo-brass">$ </span>
        {approval.command}
      </pre>
      {secret && (
        <p className="mt-2 text-[12px] leading-relaxed text-octo-sage">
          {approval.coversUncommitted
            ? "This command also stages files, so the check covered every uncommitted change, not only what is staged. "
            : ""}
          Approving runs it once, for exactly these findings.
        </p>
      )}
      <div className="mt-2 flex items-center gap-2">
        {/* On the secret card the safe answer leads, as in the guard's dialog. */}
        <button
          type="button"
          onClick={() => onRespond(lead)}
          title={secret ? "Leave it out (Enter or Esc)" : "Approve (Enter)"}
          aria-keyshortcuts={secret ? "Enter Escape" : "Enter"}
          className={`rounded-md border border-[var(--brass-dim)] bg-[var(--brass-ghost)] px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-brass ${QUICK}`}
        >
          {secret ? "Leave it out" : "Approve"}
        </button>
        <button
          type="button"
          onClick={() => onRespond(secret ? "approve" : "deny")}
          title={secret ? "Run it as it is, once, for exactly these findings" : "Deny (Esc)"}
          aria-keyshortcuts={secret ? undefined : "Escape"}
          className={`rounded-md border border-octo-hairline px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-rouge hover:border-[var(--rouge-border)] ${QUICK}`}
        >
          {secret ? "Run regardless" : "Deny"}
        </button>
        {!secret && (
          <button
            type="button"
            onClick={() => onRespond("always")}
            title="Run this and stop asking for the rest of this conversation"
            className={`ml-auto font-mono text-[10px] text-octo-mute hover:text-octo-sage ${QUICK}`}
          >
            Approve &amp; don't ask again
          </button>
        )}
      </div>
    </div>
  );
}
