import type { KeyboardEvent } from "react";
import { ShieldAlert } from "lucide-react";
import type { PendingApproval } from "../../stores/chatStore";
import type { ApprovalAnswer } from "../../lib/types";
import { tourId } from "../../lib/tour/ids";

interface Props {
  approval: PendingApproval;
  onRespond: (decision: ApprovalAnswer) => void;
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
  config: { eyebrow: "Runs commands", title: "⌘↵, Enter or Esc denies", lead: ["Deny", "Deny (⌘↵, Enter or Esc with the card focused)"], other: ["Allow once", "Allow this one change; the next one asks again"] },
  server: { eyebrow: "Project MCP server", title: "⌘↵, Enter or Esc denies", lead: ["Deny", "Deny (⌘↵, Enter or Esc with the card focused)"], other: ["Allow", "Start it, now and while its entry stays the same"] },
} as const;

/** What a `config` or `server` card adds under what it shows (#1245). */
export const CODE_CARD_BODY = {
  config:
    "This file can make Octopush or Claude Code run commands, so a change to it always asks. Allowing lets this one call go ahead.",
  server:
    "This project's .claude/mcp.json defines this server. Allowing starts it now and in later turns while its entry stays the same; any change asks again. Revoke it in Settings › Integrations or in the Companion.",
} as const;

/** The chord that focuses the oldest card waiting in the conversation on
 *  screen (`focusOldestCard`, the `focus-approval` global shortcut). A card
 *  only ever takes the focus from the user: this, a click or Tab. */
export const FOCUS_CARD_CHORD = "⌘⌥A";

/** Every card carries this attribute, so the chord can find the oldest one
 *  and Talk's Esc can leave a card's focus alone (`talkEscape`). */
export const APPROVAL_CARD_SELECTOR = "[data-approval-card]";

/** Why a card offers no conversation grant in Plan only (#1229). */
export const PLAN_ONLY_COPY = "In Plan only, nothing is allowed for the conversation: this asks every time.";

/** The per-command grant's tooltip (#1229). */
export const COMMAND_GRANT_TITLE =
  "Run this, and run exactly this command again from this folder without asking for the rest of this conversation: the same words, quotes, operators and redirections. A credentials location, or a place that runs code, still asks. Revoke it in the Companion.";

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
 * offers "Allow reading <folder> for this conversation" (`rememberDir`). Since
 * #1229 a write outside offers "Allow writing <folder>…", a command card with
 * no folder "Allow this command…" (`rememberCommand`), each answered "grant";
 * in Plan only the card says it offers none (`planOnly`). Since #1243 an MCP
 * card in Edit freely (`trustServer`/`trustTool`) instead offers two lasting
 * answers, app-wide and revocable in Settings › Integrations: "Always allow
 * this tool" ("tool") and "Trust <server>" ("server"); an MCP card never
 * offers a conversation grant. The reason line wraps, never cut.
 * Since #1231 a conversation in Ask first parks each write here: a file
 * change (`kind: "edit"`) with its diff when it can be shown, or a command
 * that doesn't only read (`kind: "exec"`); when the change can't be shown,
 * its reason says why. No card offers "don't ask again" or a lasting trust
 * while the conversation is in Ask first (`askFirst`); a conversation grant
 * still can.
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
  // A file that runs commands, or a project's MCP server (#1245).
  const code = approval.kind === "config" || approval.kind === "server" ? approval.kind : null;
  const askFirst = approval.kind === "edit" || approval.kind === "exec";
  const copy = COPY[secret ? "secret" : (code ?? (sensitive ? "sensitive" : outside ? "outside" : askFirst ? "ask" : "command"))];
  // An MCP card in Edit freely offers to stop asking for good (#1243); never
  // in Ask first, where no answer lasts (#1231).
  const trust =
    approval.kind === "mcp" && !approval.askFirst && approval.trustServer && approval.trustTool
      ? { server: approval.trustServer, tool: approval.trustTool }
      : null;
  // Where the safe answer leads, it is the first button and Enter takes it.
  const safeLead = secret || sensitive || code !== null;
  const lead = safeLead ? "deny" : "approve";
  // The grant the card offers for the conversation (#1229): a folder, or the command itself.
  const dir = !secret && !sensitive && (run || approval.kind === "write") ? approval.rememberDir : undefined;
  const grant = dir
    ? run
      ? { label: `Allow reading ${dir} for this conversation`, title: `Run this, and let commands read ${dir} without asking for the rest of this conversation (a credentials location still asks). Revoke it in the Companion.` }
      : { label: `Allow writing ${dir} for this conversation`, title: `Allow this, and let the agent's file tools write in ${dir} without asking for the rest of this conversation (reads there still ask). Revoke it in the Companion.` }
    : !secret && !sensitive && !code && approval.rememberCommand && approval.kind !== "mcp" && (run || !outside)
      ? { label: "Allow this command for this conversation", title: COMMAND_GRANT_TITLE }
      : null;
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
      <div className="flex items-baseline gap-2">
        <ShieldAlert size={14} aria-hidden className="shrink-0 self-center text-octo-rouge" />
        <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.25em] text-octo-rouge">{copy.eyebrow}</span>
        <span data-testid="approval-reason" className="ml-auto min-w-0 break-words text-right font-mono text-[10px] text-octo-mute">
          {approval.reason}
        </span>
      </div>
      {/* Wrapped, never scrolled: nothing it shows sits out of view (#1245). */}
      <pre
        data-testid="approval-shown"
        className="mt-2 whitespace-pre-wrap break-all rounded bg-octo-onyx px-2.5 py-1.5 font-mono text-[12px] text-octo-ivory"
      >
        {/* Only a shell command reads as one. */}
        {(approval.kind === undefined || run || approval.kind === "exec") && <span className="text-octo-brass">$ </span>}
        {approval.command}
      </pre>
      {approval.diff && <AskDiff diff={approval.diff} />}
      {approval.planOnly && !secret && <p className="mt-2 text-[12px] leading-relaxed text-octo-sage">{PLAN_ONLY_COPY}</p>}
      {secret && (
        <p className="mt-2 text-[12px] leading-relaxed text-octo-sage">
          {approval.coversUncommitted
            ? "This command also stages files, so the check covered every uncommitted change, not only what is staged. "
            : ""}
          Approving runs it once, for exactly these findings.
        </p>
      )}
      {code && <p className="mt-2 text-[12px] leading-relaxed text-octo-sage">{CODE_CARD_BODY[code]}</p>}
      {outside && (
        <p className="mt-2 text-[12px] leading-relaxed text-octo-sage">
          {sensitive ? "This may hold credentials. " : ""}
          {approval.kind === "read"
            ? "Allowing lets the agent read it once, and what it reads goes to your AI provider. "
            : run
              ? "Allowing runs it once, and its output goes to your AI provider. "
              : "Allowing lets the agent write it once. "}
          {run || dir ? "A credentials location always asks." : "Every access outside the workspace asks again."}
        </p>
      )}
      <div className={`mt-2 flex items-center gap-2 ${trust ? "flex-wrap" : ""}`}>
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
        {grant && (
          <button
            type="button"
            onClick={() => onRespond("grant")}
            title={grant.title}
            className={`ml-auto truncate font-mono text-[10px] text-octo-mute hover:text-octo-sage ${QUICK}`}
          >
            {grant.label}
          </button>
        )}
        {!secret && !outside && !code && !askFirst && !approval.askFirst && (
          <button
            type="button"
            onClick={() => onRespond("always")}
            title="Approve this, and stop asking about flagged commands and MCP tool calls for the rest of this conversation (a possible secret, or a file or command reaching outside the workspace, still asks)"
            className={`${grant ? "shrink-0" : "ml-auto"} font-mono text-[10px] text-octo-mute hover:text-octo-sage ${QUICK}`}
          >
            Approve &amp; don't ask again
          </button>
        )}
        {trust && (
          <span className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 pt-0.5" data-tour={tourId("talk-approval-trust")}>
            <button
              type="button"
              onClick={() => onRespond("tool")}
              title={`Run this, and let ${trust.tool} run without asking in Edit freely, in every conversation, until you revoke it in Settings › Integrations`}
              className={`font-serif text-[12px] text-octo-sage hover:text-octo-ivory ${QUICK}`}
            >
              Always allow this tool
            </button>
            <button
              type="button"
              onClick={() => onRespond("server")}
              title={`Run this, and let every ${trust.server} tool run without asking in Edit freely, in every conversation, until you revoke it in Settings › Integrations (a tool it marks destructive still asks)`}
              className={`font-serif text-[12px] text-octo-sage hover:text-octo-ivory ${QUICK}`}
            >
              Trust {trust.server}
            </button>
          </span>
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

/** An Ask first card's change: the hunks the call would write, then the
 *  engine's count of the lines it leaves out. */
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
