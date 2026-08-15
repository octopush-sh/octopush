import { useTerminalsStore } from "../../stores/terminalsStore";
import { useAttentionStore } from "../../stores/attentionStore";
import { iconForSessionRole } from "../../lib/roleIcons";
import { ROLE_WORD } from "../../lib/sessionRole";

interface Props {
  workspaceId: string;
  /** Opens the ⌘⌥K switcher. */
  onOpen: () => void;
}

/**
 * The Run mode band's status tail, turned into a control.
 *
 * A keyboard-only switcher is a switcher nobody finds, so the tail — which
 * already reported "3 terminals" — becomes the affordance that names the
 * shortcut and opens the palette by mouse. With the rail on screen it stays
 * deliberately short: identity, whatever is running, and any session still
 * waiting. One glyph carries two facts (role by shape, state by colour).
 */
export function SessionAnchor({ workspaceId, onOpen }: Props) {
  const terminals = useTerminalsStore((s) => s.getTerminals(workspaceId));
  const activeId = useTerminalsStore((s) => s.getActiveId(workspaceId));
  const flag = useAttentionStore((s) => s.flagsByWs[workspaceId]);

  const active = terminals.find((t) => t.id === activeId) ?? null;
  if (!active) return null;

  const Icon = iconForSessionRole(active.role);
  // `attentionStore` holds ONE flag per workspace (a newer ping replaces the
  // older), so this is a boolean, not a count — printing "1 waiting" would
  // promise a counter the store cannot keep.
  const waiting =
    flag?.kind === "terminal" && !!flag.terminalId && flag.terminalId !== activeId;
  const doing = active.busy ? (active.command ?? "running") : ROLE_WORD[active.role];

  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="session-anchor"
      title={`${active.label} — ${doing}. Switch session (⌘⌥K)`}
      className="flex max-w-full items-center gap-2 whitespace-nowrap rounded-md border border-transparent px-2 py-1 font-mono text-[10px] tracking-[0.1em] text-octo-mute transition-colors duration-[180ms] hover:border-octo-hairline hover:bg-octo-panel hover:text-octo-ivory focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
    >
      <Icon
        size={13}
        strokeWidth={1.75}
        aria-hidden
        className={active.busy ? "text-octo-brass" : "text-octo-verdigris"}
      />
      <span className="min-w-0 truncate normal-case tracking-[0.04em] text-octo-ivory">
        {active.label}
      </span>
      {active.busy && active.command && (
        <span className="hidden min-w-0 truncate lg:inline">{active.command}</span>
      )}
      {waiting && <span className="text-octo-brass">· waiting</span>}
      <span className="rounded border border-octo-hairline px-1.5 py-px text-[9px] text-octo-mute">
        ⌘⌥K
      </span>
    </button>
  );
}
