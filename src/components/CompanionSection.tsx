import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Reveal } from "./primitives/Reveal";

/** Storage prefix for a section's remembered open/closed state. */
const STORAGE_PREFIX = "octo.companion.section.";

function readOpen(storageKey: string | undefined, fallback: boolean): boolean {
  if (!storageKey) return fallback;
  try {
    const v = localStorage.getItem(STORAGE_PREFIX + storageKey);
    return v == null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function writeOpen(storageKey: string | undefined, open: boolean) {
  if (!storageKey) return;
  try {
    localStorage.setItem(STORAGE_PREFIX + storageKey, open ? "1" : "0");
  } catch {
    /* private mode, blocked storage — the state just doesn't persist */
  }
}

interface Props {
  /** The eyebrow. One style for every Companion section: mono, small caps,
   *  mute — brass is reserved for the one section that needs attention. */
  title: string;
  /** A count or short figure after the title (`· 3`). */
  count?: number | string | null;
  /** Tooltip on the eyebrow. */
  hint?: string;
  /** A single control at the right of the eyebrow (a `+`, an open-room glyph). */
  action?: ReactNode;
  defaultOpen?: boolean;
  /** Remember the open/closed state across sessions under this key. */
  storageKey?: string;
  /** Brass eyebrow — for the section the user is looking at right now. */
  accent?: boolean;
  /** Fill the panel (the section becomes the whole Companion). */
  fill?: boolean;
  children: ReactNode;
  testId?: string;
  className?: string;
}

/**
 * The one section chrome of the Companion: a 36px eyebrow bar that folds
 * its body (grid-rows 0fr↔1fr), a hairline above, nothing nested inside.
 * Every Talk section — Chats, Conversation, a sub-agent's journal — hangs
 * on this, so the panel reads as one column with a few quiet rules instead
 * of a stack of framed cards.
 */
export function CompanionSection({
  title,
  count,
  hint,
  action,
  defaultOpen = true,
  storageKey,
  accent = false,
  fill = false,
  children,
  testId,
  className = "",
}: Props) {
  const [open, setOpen] = useState(() => readOpen(storageKey, defaultOpen));
  const toggle = () => {
    setOpen((v) => {
      writeOpen(storageKey, !v);
      return !v;
    });
  };

  return (
    <section
      data-testid={testId}
      className={`border-t border-octo-hairline first:border-t-0 ${fill ? "flex min-h-0 flex-1 flex-col" : ""} ${className}`}
    >
      <div className="flex h-9 shrink-0 items-center gap-1 pl-3 pr-2">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          title={hint}
          className={`flex min-w-0 flex-1 items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.3em] transition-colors duration-[220ms] hover:text-octo-sage focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass ${
            accent ? "text-octo-brass" : "text-octo-mute"
          }`}
        >
          <ChevronRight
            size={11}
            aria-hidden
            className={`shrink-0 transition-transform duration-[220ms] ${open ? "rotate-90" : ""}`}
          />
          <span className="truncate">{title}</span>
          {count != null && count !== "" && (
            <span className="octo-tabular tracking-normal text-octo-mute">· {count}</span>
          )}
        </button>
        {action}
      </div>
      <Reveal open={open} className={fill ? "min-h-0 flex-1" : ""}>
        {children}
      </Reveal>
    </section>
  );
}
