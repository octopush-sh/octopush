import { ShieldAlert } from "lucide-react";
import type { PendingApproval } from "../../stores/chatStore";

interface Props {
  approval: PendingApproval;
  onRespond: (decision: "approve" | "always" | "deny") => void;
}

/**
 * Inline approval card for a destructive command the agent wants to run. The
 * turn is paused until the user chooses. User-typed `$` commands are never
 * gated, so this only ever appears for agent-issued run_command.
 */
export function ApprovalCard({ approval, onRespond }: Props) {
  return (
    <div className="octo-rise-in my-2 rounded-md border border-[var(--rouge-border)] bg-[var(--rouge-ghost)] px-3 py-2.5">
      <div className="flex items-center gap-2">
        <ShieldAlert size={14} className="shrink-0 text-octo-rouge" />
        <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-octo-rouge">
          Approval needed
        </span>
        <span className="ml-auto truncate font-mono text-[10px] text-octo-mute" title={approval.reason}>
          {approval.reason}
        </span>
      </div>
      <pre className="mt-2 overflow-x-auto rounded bg-octo-onyx px-2.5 py-1.5 font-mono text-[12px] text-octo-ivory">
        <span className="text-octo-brass">$ </span>
        {approval.command}
      </pre>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => onRespond("approve")}
          className="rounded-md border border-[var(--brass-dim)] bg-[var(--brass-ghost)] px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-brass transition-colors"
        >
          Approve
        </button>
        <button
          type="button"
          onClick={() => onRespond("deny")}
          className="rounded-md border border-octo-hairline px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-rouge transition-colors hover:border-[var(--rouge-border)]"
        >
          Deny
        </button>
        <button
          type="button"
          onClick={() => onRespond("always")}
          title="Run this and stop asking for the rest of this conversation"
          className="ml-auto font-mono text-[10px] text-octo-mute transition-colors hover:text-octo-sage"
        >
          Approve &amp; don't ask again
        </button>
      </div>
    </div>
  );
}
