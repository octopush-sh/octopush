import { ShieldAlert } from "lucide-react";
import type { PendingApproval } from "../../stores/chatStore";
import { tourId } from "../../lib/tour/ids";

interface Props {
  approval: PendingApproval;
  onRespond: (decision: "approve" | "always" | "deny") => void;
}

/**
 * Inline approval card for a command the agent wants to run. The turn is
 * paused until the user chooses. Two kinds: a destructive command (with
 * "don't ask again" for the thread), and a commit/push/PR the secret guard
 * stopped (#819) — that one names what was found (kind and file:line, never
 * the value), says when the scan read uncommitted changes, and has no
 * "don't ask again": every such command asks again, and the approval
 * covers exactly what the card showed. User-typed `$` commands get the
 * secret guard's dialog instead, never this card.
 */
export function ApprovalCard({ approval, onRespond }: Props) {
  const secret = approval.secret === true;
  return (
    <div
      data-tour={secret ? tourId("talk-secret-approval") : undefined}
      className="octo-rise-in my-2 rounded-md border border-[var(--rouge-border)] bg-[var(--rouge-ghost)] px-3 py-2.5"
    >
      <div className="flex items-center gap-2">
        <ShieldAlert size={14} className="shrink-0 text-octo-rouge" />
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
          onClick={() => onRespond(secret ? "deny" : "approve")}
          className="rounded-md border border-[var(--brass-dim)] bg-[var(--brass-ghost)] px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-brass transition-colors"
        >
          {secret ? "Leave it out" : "Approve"}
        </button>
        <button
          type="button"
          onClick={() => onRespond(secret ? "approve" : "deny")}
          className="rounded-md border border-octo-hairline px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-rouge transition-colors hover:border-[var(--rouge-border)]"
        >
          {secret ? "Run regardless" : "Deny"}
        </button>
        {!secret && (
          <button
            type="button"
            onClick={() => onRespond("always")}
            title="Run this and stop asking for the rest of this conversation"
            className="ml-auto font-mono text-[10px] text-octo-mute transition-colors hover:text-octo-sage"
          >
            Approve &amp; don't ask again
          </button>
        )}
      </div>
    </div>
  );
}
