import type { KeyboardEvent } from "react";
import { ShieldAlert } from "lucide-react";
import type { PendingApproval } from "../../stores/chatStore";
import { tourId } from "../../lib/tour/ids";

interface Props {
  approval: PendingApproval;
  onRespond: (decision: "approve" | "always" | "deny") => void;
}

const QUICK = "transition-colors duration-[var(--dur-quick)] ease-[var(--ease-octo)]";

/** Each kind of card's words: eyebrow, title, and its two answers (the lead
 *  first) as `[label, title]`. */
const COPY = {
  command: { eyebrow: "Approval needed", title: "⌘↵ approves · Esc denies", lead: ["Approve", "Approve (⌘↵ with the card focused)"], other: ["Deny", "Deny (Esc with the card focused)"] },
  outside: { eyebrow: "Outside the workspace", title: "⌘↵ allows once · Esc denies", lead: ["Allow once", "Allow once (⌘↵ with the card focused)"], other: ["Deny", "Deny (Esc with the card focused)"] },
  sensitive: { eyebrow: "Possible credentials", title: "⌘↵, Enter or Esc denies", lead: ["Deny", "Deny (⌘↵, Enter or Esc with the card focused)"], other: ["Allow once", "Allow this one access; the next one asks again"] },
  secret: { eyebrow: "Possible secret", title: "⌘↵, Enter or Esc leaves it out", lead: ["Leave it out", "Leave it out (⌘↵, Enter or Esc with the card focused)"], other: ["Run regardless", "Run it as it is, once, for exactly these findings"] },
} as const;

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
 * Since #1147 an MCP tool call (`kind: "mcp"`) asks like a command, and a
 * file tool reaching outside the workspace (`kind: "read" | "write"`) names
 * the path, never the file, and asks every time (no "don't ask again"); on a
 * likely credentials location (`sensitive`) its safe answer leads, as on
 * the secret card, keys included.
 *
 * At the keyboard, only while the card itself has focus: ⌘↵ takes the card's
 * lead answer (Approve; on the secret card the safe "Leave it out") and Esc
 * denies. Plain Enter does nothing, so a stray Return can never approve a
 * destructive command; the secret card is the one exception, where Enter
 * also takes the safe answer. Held keys (auto-repeat) are ignored. A focused
 * button answers its own keys, as any button does, and the composer's ⌘↵
 * never reaches the card: the card answers only its own focus.
 */
export function ApprovalCard({ approval, onRespond }: Props) {
  const secret = approval.secret === true;
  const outside = approval.kind === "read" || approval.kind === "write";
  const sensitive = outside && approval.sensitive === true;
  const copy = COPY[secret ? "secret" : sensitive ? "sensitive" : outside ? "outside" : "command"];
  // Where the safe answer leads, it is the first button and Enter takes it.
  const safeLead = secret || sensitive;
  const lead = safeLead ? "deny" : "approve";
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const answer = cardKeyAnswer(e, safeLead);
    if (!answer) return;
    e.preventDefault();
    e.stopPropagation();
    onRespond(answer);
  };
  return (
    <div
      role="group"
      tabIndex={0}
      aria-label={`${copy.eyebrow}: ${approval.command}`}
      aria-keyshortcuts={safeLead ? "Meta+Enter Enter Escape" : "Meta+Enter Escape"}
      title={copy.title}
      onKeyDown={onKeyDown}
      data-tour={secret ? tourId("talk-secret-approval") : tourId("talk-approval")}
      className="octo-rise-in my-2 rounded-md border border-[var(--rouge-border)] bg-[var(--rouge-ghost)] px-3 py-2.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
    >
      <div className="flex items-center gap-2">
        <ShieldAlert size={14} aria-hidden className="shrink-0 text-octo-rouge" />
        <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-octo-rouge">{copy.eyebrow}</span>
        <span className="ml-auto truncate font-mono text-[10px] text-octo-mute" title={approval.reason}>
          {approval.reason}
        </span>
      </div>
      <pre className="mt-2 overflow-x-auto rounded bg-octo-onyx px-2.5 py-1.5 font-mono text-[12px] text-octo-ivory">
        {/* Only a shell command reads as one. */}
        {approval.kind === undefined && <span className="text-octo-brass">$ </span>}
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
      {outside && (
        <p className="mt-2 text-[12px] leading-relaxed text-octo-sage">
          {sensitive ? "This may hold credentials. " : ""}
          {approval.kind === "read"
            ? "Allowing lets the agent read it once, and what it reads goes to your AI provider. "
            : "Allowing lets the agent write it once. "}
          Every access outside the workspace asks again.
        </p>
      )}
      <div className="mt-2 flex items-center gap-2">
        {/* Where the safe answer leads, it is the first button. */}
        <button
          type="button"
          onClick={() => onRespond(lead)}
          title={copy.lead[1]}
          aria-keyshortcuts={safeLead ? "Meta+Enter Enter Escape" : "Meta+Enter"}
          className={`rounded-md border border-[var(--brass-dim)] bg-[var(--brass-ghost)] px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-brass ${QUICK}`}
        >
          {copy.lead[0]}
        </button>
        <button
          type="button"
          onClick={() => onRespond(safeLead ? "approve" : "deny")}
          title={copy.other[1]}
          aria-keyshortcuts={safeLead ? undefined : "Escape"}
          className={`rounded-md border border-octo-hairline px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-rouge hover:border-[var(--rouge-border)] ${QUICK}`}
        >
          {copy.other[0]}
        </button>
        {!secret && !outside && (
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

/** The answer a key gives a focused card, or null for a key it leaves alone.
 *  Only the card's own focus counts (a key on a button inside it is the
 *  button's), and never a held key, an IME composition, or a chord other
 *  than ⌘↵. `safeLead`: the safe answer leads (the secret card, a
 *  credentials location). Pure. */
export function cardKeyAnswer(
  e: Pick<KeyboardEvent<HTMLElement>, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "repeat" | "target" | "currentTarget"> & {
    nativeEvent?: { isComposing?: boolean };
  },
  safeLead: boolean,
): "approve" | "deny" | null {
  if (e.target !== e.currentTarget || e.repeat || e.nativeEvent?.isComposing) return null;
  if (e.ctrlKey || e.altKey || e.shiftKey) return null;
  const lead = safeLead ? "deny" : "approve";
  if (e.key === "Escape" && !e.metaKey) return "deny";
  if (e.key === "Enter" && e.metaKey) return lead;
  // Where the lead answer is the safe one, plain Enter may take it.
  if (e.key === "Enter" && safeLead) return lead;
  return null;
}
