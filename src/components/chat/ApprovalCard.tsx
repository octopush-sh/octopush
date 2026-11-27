import type { KeyboardEvent } from "react";
import { ShieldAlert } from "lucide-react";
import type { PendingApproval } from "../../stores/chatStore";
import { tourId } from "../../lib/tour/ids";

interface Props {
  approval: PendingApproval;
  onRespond: (decision: "approve" | "always" | "deny") => void;
  /** Talk is the mode on screen. A card the user focused can keep the focus
   *  after a mode switch hides Talk (WebKit may leave it on a hidden
   *  element), so its keys answer only while Talk shows. */
  talkActive?: boolean;
}

const QUICK = "transition-colors duration-[var(--dur-quick)] ease-[var(--ease-octo)]";

/** Each kind of card's words: eyebrow, title, and its two answers (the lead
 *  first) as `[label, title]`. */
const COPY = {
  command: { eyebrow: "Approval needed", title: "⌘↵ approves · Esc denies", lead: ["Approve", "Approve (⌘↵ with the card focused)"], other: ["Deny", "Deny (Esc with the card focused)"] },
  outside: { eyebrow: "Outside the workspace", title: "⌘↵ allows once · Esc denies", lead: ["Allow once", "Allow once (⌘↵ with the card focused)"], other: ["Deny", "Deny (Esc with the card focused)"] },
  sensitive: { eyebrow: "Possible credentials", title: "⌘↵, Enter or Esc denies", lead: ["Deny", "Deny (⌘↵, Enter or Esc with the card focused)"], other: ["Allow once", "Allow this one access; the next one asks again"] },
  secret: { eyebrow: "Possible secret", title: "⌘↵, Enter or Esc leaves it out", lead: ["Leave it out", "Leave it out (⌘↵, Enter or Esc with the card focused)"], other: ["Run regardless", "Run it as it is, once, for exactly these findings"] },
  ask: { eyebrow: "Ask first", title: "⌘↵ approves · Esc denies", lead: ["Approve", "Approve this one change (⌘↵ with the card focused)"], other: ["Deny", "Deny (Esc with the card focused)"] },
} as const;

/** The chord that focuses the oldest card waiting in the conversation on
 *  screen (`focusOldestCard`, the `focus-approval` global shortcut). A card
 *  only ever takes the focus from the user: this, a click or Tab. */
export const FOCUS_CARD_CHORD = "⌘⌥A";

/** Every card carries this attribute, so the chord can find the oldest one
 *  and Talk's Esc can leave a card's focus alone (`talkEscape`). */
export const APPROVAL_CARD_SELECTOR = "[data-approval-card]";

/** What a command's path card can't promise (#1201), on its tooltip. */
export const RUN_CHECK_LIMITS =
  "Octopush reads the paths a command names. A shell can build a path it can't see, so this is a net, not a sandbox.";

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
 * the secret card, keys included. Since #1201 a command that names a path
 * outside the workspace or in a credentials location (`kind: "run"`) asks
 * the same way, showing the command, and its tooltip says the check is a
 * net, not a sandbox. A read outside that isn't a credentials location also
 * offers "Allow reading <folder> for this conversation" (`rememberDir`,
 * answered as "always").
 * Since #1231 a conversation in Ask first parks each write here: a file
 * change (`kind: "ask"`) with its diff when it can be shown, or a command
 * that may write (`kind: "ask-run"`), and when the change can't be shown
 * the card says why (`previewNote`). No card offers "don't ask again" while
 * the conversation is in Ask first (`askFirst`): no grant answers one there.
 *
 * At the keyboard, only while the card itself has focus: ⌘↵ takes the card's
 * lead answer (Approve; on the secret card the safe "Leave it out") and Esc
 * denies. Plain Enter does nothing, so a stray Return can never approve a
 * destructive command; the secret card is the one exception, where Enter
 * also takes the safe answer. Held keys (auto-repeat) are ignored. A focused
 * button answers its own keys, as any button does, and the composer's ⌘↵
 * never reaches the card: the card answers only its own focus.
 *
 * A card never takes the focus when it appears: a keystroke meant for
 * something else (a habitual ⌘↵ from the composer) must never answer a
 * command the user hasn't read. It takes the focus only from the user: a
 * click, Tab, or ⌘⌥A (`FOCUS_CARD_CHORD`), which focuses the oldest card in
 * the conversation on screen.
 */
export function ApprovalCard({ approval, onRespond, talkActive = true }: Props) {
  const secret = approval.secret === true;
  const run = approval.kind === "run";
  const outside = approval.kind === "read" || approval.kind === "write" || run;
  const sensitive = outside && approval.sensitive === true;
  const askFirst = approval.kind === "ask" || approval.kind === "ask-run";
  const copy = COPY[secret ? "secret" : sensitive ? "sensitive" : outside ? "outside" : askFirst ? "ask" : "command"];
  // Where the safe answer leads, it is the first button and Enter takes it.
  const safeLead = secret || sensitive;
  const lead = safeLead ? "deny" : "approve";
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const answer = cardKeyAnswer(e, safeLead, talkActive);
    if (!answer) return;
    e.preventDefault();
    e.stopPropagation();
    onRespond(answer);
  };
  return (
    <div
      role="group"
      data-approval-card=""
      tabIndex={0}
      aria-label={`${copy.eyebrow}: ${approval.command}`}
      aria-keyshortcuts={safeLead ? "Meta+Enter Enter Escape" : "Meta+Enter Escape"}
      title={`${copy.title} · ${FOCUS_CARD_CHORD} focuses the oldest waiting card${run ? `. ${RUN_CHECK_LIMITS}` : ""}`}
      onKeyDown={onKeyDown}
      data-tour={secret ? tourId("talk-secret-approval") : askFirst ? tourId("talk-ask-first-approval") : tourId("talk-approval")}
      className="octo-rise-in my-2 rounded-md border border-[var(--rouge-border)] bg-[var(--rouge-ghost)] px-3 py-2.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
    >
      {/* Tells a screen reader the turn waits, as the card appears; the
          group's label names what it waits on. */}
      <span role="alert" className="sr-only">
        The turn is waiting on your answer.
      </span>
      <div className="flex items-center gap-2">
        <ShieldAlert size={14} aria-hidden className="shrink-0 text-octo-rouge" />
        <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-octo-rouge">{copy.eyebrow}</span>
        <span className="ml-auto truncate font-mono text-[10px] text-octo-mute" title={approval.reason}>
          {approval.reason}
        </span>
      </div>
      <pre className="mt-2 overflow-x-auto rounded bg-octo-onyx px-2.5 py-1.5 font-mono text-[12px] text-octo-ivory">
        {/* Only a shell command reads as one. */}
        {(approval.kind === undefined || run || approval.kind === "ask-run") && <span className="text-octo-brass">$ </span>}
        {approval.command}
      </pre>
      {approval.diff && <AskDiff diff={approval.diff} />}
      {approval.previewNote && (
        <p className="mt-2 text-[12px] leading-relaxed text-octo-sage">{approval.previewNote}</p>
      )}
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
            : run
              ? "Allowing runs it once, and its output goes to your AI provider. "
              : "Allowing lets the agent write it once. "}
          {run ? "A credentials location always asks." : "Every access outside the workspace asks again."}
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
        {!secret && !outside && !askFirst && !approval.askFirst && (
          <button
            type="button"
            onClick={() => onRespond("always")}
            title="Approve this, and stop asking about flagged commands and MCP tool calls for the rest of this conversation (a possible secret, or a file or command reaching outside the workspace, still asks)"
            className={`ml-auto font-mono text-[10px] text-octo-mute hover:text-octo-sage ${QUICK}`}
          >
            Approve &amp; don't ask again
          </button>
        )}
        {run && !sensitive && approval.rememberDir && (
          <button
            type="button"
            onClick={() => onRespond("always")}
            title={`Run this, and let commands read ${approval.rememberDir} without asking for the rest of this conversation (a credentials location still asks)`}
            className={`ml-auto truncate font-mono text-[10px] text-octo-mute hover:text-octo-sage ${QUICK}`}
          >
            Allow reading {approval.rememberDir} for this conversation
          </button>
        )}
      </div>
    </div>
  );
}

/** How a line of an Ask first card's diff reads, by its first character
 *  only: a removed line whose text starts `--` is still a removed line.
 *  Review's diff tints (`--diff-add-bg` / `--diff-del-bg`). Pure. */
export function askLineStyle(line: string): { className: string; background: string } {
  if (line.startsWith("+")) return { className: "text-octo-verdigris", background: "var(--diff-add-bg)" };
  if (line.startsWith("-")) return { className: "text-octo-rouge", background: "var(--diff-del-bg)" };
  return { className: "text-octo-sage", background: "" };
}

/** An Ask first card's change: the hunks the call would write, then any
 *  marker or note the engine added (a cut line, the lines not shown, a
 *  line-ending change). */
function AskDiff({ diff }: { diff: string }) {
  const lines = diff.endsWith("\n") ? diff.slice(0, -1).split("\n") : diff.split("\n");
  return (
    <pre
      aria-label="The change"
      className="mt-1 max-h-64 overflow-auto rounded bg-octo-onyx py-1.5 font-mono text-[12px] leading-[1.45]"
    >
      {lines.map((line, i) => {
        const style = askLineStyle(line);
        return (
          <div key={i} className={`px-2.5 ${style.className}`} style={style.background ? { background: style.background } : undefined}>
            {line || " "}
          </div>
        );
      })}
    </pre>
  );
}

/** Focus the oldest card waiting under `root` (cards render in the order
 *  they arrived, so the first is the oldest) and bring it into view. False
 *  when none waits. Only the user's own ⌘⌥A or ⌘K command calls this. */
export function focusOldestCard(root: ParentNode = document): boolean {
  const card = root.querySelector<HTMLElement>(APPROVAL_CARD_SELECTOR);
  if (!card) return false;
  card.focus();
  return true;
}

/** The answer a key gives a focused card, or null for a key it leaves alone.
 *  Only the card's own focus counts (a key on a button inside it is the
 *  button's), only while Talk is the mode on screen (`talkActive`), and
 *  never a held key, an IME composition, or a chord other than ⌘↵.
 *  `safeLead`: the safe answer leads (the secret card, a credentials
 *  location). Pure. */
export function cardKeyAnswer(
  e: Pick<KeyboardEvent<HTMLElement>, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "repeat" | "target" | "currentTarget"> & {
    nativeEvent?: { isComposing?: boolean };
  },
  safeLead: boolean,
  talkActive = true,
): "approve" | "deny" | null {
  if (!talkActive) return null;
  if (e.target !== e.currentTarget || e.repeat || e.nativeEvent?.isComposing) return null;
  if (e.ctrlKey || e.altKey || e.shiftKey) return null;
  const lead = safeLead ? "deny" : "approve";
  if (e.key === "Escape" && !e.metaKey) return "deny";
  if (e.key === "Enter" && e.metaKey) return lead;
  // Where the lead answer is the safe one, plain Enter may take it.
  if (e.key === "Enter" && safeLead) return lead;
  return null;
}
