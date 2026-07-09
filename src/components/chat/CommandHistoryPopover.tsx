interface Props {
  items: string[];
  activeIndex: number;
  onSelect: (command: string) => void;
  onHover: (index: number) => void;
}

/**
 * `$`-triggered recent-command menu, anchored above the composer. Lists the
 * workspace's most-recently-used `$`-direct commands (persisted). Purely
 * presentational — keyboard nav lives in the Composer (shared with the @file /
 * skill popovers). Selecting fills the composer with `$ <command>` to edit/run.
 */
export function CommandHistoryPopover({ items, activeIndex, onSelect, onHover }: Props) {
  if (items.length === 0) return null;
  return (
    <div
      className="octo-pop-in absolute bottom-full left-0 z-20 mb-1.5 max-h-64 w-[min(36rem,100%)] overflow-y-auto rounded-md border border-octo-hairline bg-octo-panel py-1 shadow-lg"
      role="listbox"
      id="cmdhist-popover"
      aria-label="Recent commands"
    >
      <div className="px-3 py-1 font-mono text-[8px] uppercase tracking-[0.3em] text-octo-brass">
        Recent commands
      </div>
      {items.map((command, i) => {
        const active = i === activeIndex;
        return (
          <button
            key={command}
            id={`cmdhist-opt-${i}`}
            type="button"
            role="option"
            aria-selected={active}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(command);
            }}
            onMouseMove={() => onHover(i)}
            className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left transition-colors ${
              active ? "bg-[var(--brass-ghost)]" : ""
            }`}
          >
            <span className="font-mono text-[11px] text-octo-brass">$</span>
            <span
              className={`truncate font-mono text-[11px] ${active ? "text-octo-brass" : "text-octo-ivory"}`}
            >
              {command}
            </span>
          </button>
        );
      })}
    </div>
  );
}
