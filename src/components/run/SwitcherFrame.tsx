import type { ReactNode, RefObject } from "react";
import { ModalShell } from "../ModalShell";

interface Props {
  onClose: () => void;
  ariaLabel: string;
  /** The brass key glyph before the query (`⌘⌥K`, `⌘D`). */
  glyph: string;
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  onQuery: (value: string) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  placeholder: string;
  inputLabel: string;
  inputTestId?: string;
  inputTour?: string;
  /** A line between the query and the list (pairing's "Replaces…"). */
  banner?: ReactNode;
  listLabel: string;
  /** The rows, then the "new" row. */
  children: ReactNode;
  /** The key hints in the foot, one `<span>` each. */
  hints: ReactNode;
}

/** A switcher row's border and wash, selected or not. */
export function switcherRowClass(selected: boolean, extra = ""): string {
  return `flex w-full items-center gap-3 border-l-2 px-4 py-2 text-left transition-colors duration-[180ms] ${extra} ${
    selected ? "border-l-octo-brass bg-[var(--brass-ghost)]" : "border-l-transparent hover:bg-octo-panel-2"
  }`;
}

/**
 * The chrome both ⌘⌥K switchers share: Run's sessions and Talk's
 * conversations. A top-anchored ModalShell (scrim, entrance motion, Escape),
 * the query line with its key glyph, the list, and the foot of key hints.
 * Each switcher owns its rows and its keys.
 */
export function SwitcherFrame({
  onClose,
  ariaLabel,
  glyph,
  inputRef,
  query,
  onQuery,
  onKeyDown,
  placeholder,
  inputLabel,
  inputTestId,
  inputTour,
  banner,
  listLabel,
  children,
  hints,
}: Props) {
  return (
    <ModalShell onClose={onClose} align="top" topOffset="pt-[16vh]" ariaLabel={ariaLabel} initialFocus={inputRef}>
      <div className="w-[470px] max-w-[92vw] overflow-hidden rounded-xl border border-octo-hairline bg-octo-panel">
        <div className="flex items-center gap-3 border-b border-octo-hairline px-4 py-3">
          <span className="font-mono text-[10px] tracking-[0.1em] text-octo-brass">{glyph}</span>
          <input
            ref={inputRef}
            autoFocus
            data-testid={inputTestId}
            data-tour={inputTour}
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            aria-label={inputLabel}
            className="flex-1 bg-transparent font-serif text-[14px] text-octo-ivory outline-none placeholder:font-serif placeholder:text-octo-mute"
          />
        </div>

        {banner}

        <div role="listbox" aria-label={listLabel} className="max-h-[52vh] overflow-y-auto py-1">
          {children}
        </div>

        {/* The app's canonical key-hint voice: mono caps, `ESC · CLOSE`. */}
        <div className="flex gap-4 border-t border-octo-hairline px-4 py-2 font-mono text-[9px] uppercase tracking-[0.18em] text-octo-mute">
          {hints}
          <span>Esc · Dismiss</span>
        </div>
      </div>
    </ModalShell>
  );
}
