interface Props {
  items: string[];
  activeIndex: number;
  onSelect: (path: string) => void;
  onHover: (index: number) => void;
}

/**
 * `@file` autocomplete list, anchored above the composer by the parent. Purely
 * presentational — keyboard navigation (Up/Down/Enter/Esc) lives in the
 * Composer so it can coexist with the textarea's own key handling. The active
 * row is brass-tinted; the basename is emphasized over its dimmed directory.
 */
export function MentionPopover({ items, activeIndex, onSelect, onHover }: Props) {
  if (items.length === 0) return null;
  return (
    <div
      className="octo-pop-in absolute bottom-full left-0 z-20 mb-1.5 max-h-64 w-[min(28rem,100%)] overflow-y-auto rounded-md border border-octo-hairline bg-octo-panel py-1 shadow-lg"
      role="listbox"
      id="mention-popover"
      aria-label="Worktree files"
    >
      <div className="px-3 py-1 font-mono text-[8px] uppercase tracking-[0.3em] text-octo-brass">
        Reference a file
      </div>
      {items.map((path, i) => {
        const slash = path.lastIndexOf("/");
        const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
        const base = slash >= 0 ? path.slice(slash + 1) : path;
        const active = i === activeIndex;
        return (
          <button
            key={path}
            id={`mention-opt-${i}`}
            type="button"
            role="option"
            aria-selected={active}
            // onMouseDown (not onClick) so the textarea doesn't blur first.
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(path);
            }}
            onMouseMove={() => onHover(i)}
            className={`flex w-full items-baseline gap-0 truncate px-3 py-1.5 text-left font-mono text-[11px] transition-colors ${
              active ? "bg-[var(--brass-ghost)]" : ""
            }`}
          >
            <span className="shrink-0 text-octo-mute">{dir}</span>
            <span className={active ? "text-octo-brass" : "text-octo-ivory"}>{base}</span>
          </button>
        );
      })}
    </div>
  );
}
