// src/components/controls/Listbox.tsx
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface ListboxOption {
  value: string;
  label: string;
  description?: string;
}

interface Props {
  value: string | null;
  options: ListboxOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel: string;
  /** Extra classes on the trigger — sizing/layout (e.g. "w-full"). */
  className?: string;
  /** Surface classes (border/bg/hover/focus) on the trigger. REPLACES the
   *  default onyx surface so a form can match its sibling inputs. The
   *  structural classes (flex, radius, padding, transition) are always kept. */
  triggerClassName?: string;
}

const PANEL_MAX_H = 280;

/** Structural classes always applied to the trigger (never overridable). */
const TRIGGER_STRUCTURE =
  "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors duration-[180ms]";

/** Default trigger surface — the ModelPicker's onyx look. */
const DEFAULT_TRIGGER_SURFACE = "border border-octo-hairline bg-octo-onyx hover:border-[var(--brass-dim)]";

/** Anchored popover listbox in the ModelPicker's visual language.
 *  Portal + position:fixed so overflow containers never clip it (PR #8 lesson).
 *
 *  Keyboard-navigable native-select replacement (ARIA combobox pattern):
 *  focus stays on the trigger; the visual highlight roves via
 *  `aria-activedescendant`. On open the trigger is focused *programmatically*
 *  — WebKit (macOS WKWebView) does NOT focus a `<button>` on click, so without
 *  this, keydown never reaches the trigger. Escape is handled on the trigger
 *  and `stopPropagation`'d so an enclosing ModalShell (bubble-phase window
 *  Escape listener) is not closed with it. */
export function Listbox({
  value,
  options,
  onChange,
  placeholder = "—",
  ariaLabel,
  className = "",
  triggerClassName = DEFAULT_TRIGGER_SURFACE,
}: Props) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const baseId = useId();
  const panelId = `${baseId}-panel`;
  const optionId = (i: number) => `${baseId}-opt-${i}`;

  // Typeahead buffer (jump to option whose label starts with typed chars).
  const typeBuffer = useRef("");
  const typeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const current = options.find((o) => o.value === value) ?? null;

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;
    const r = anchorRef.current.getBoundingClientRect();
    const estimated = Math.min(PANEL_MAX_H, Math.max(options.length, 1) * 34 + 8);
    const fitsBelow = window.innerHeight - r.bottom >= estimated + 8;
    setPos({ top: fitsBelow ? r.bottom + 4 : Math.max(8, r.top - 4 - estimated), left: r.left, width: Math.max(r.width, 200) });
  }, [open, options.length]);

  // On open: focus the trigger (WebKit click-focus workaround) and highlight
  // the current selection (or the first option). Empty list → no highlight.
  useEffect(() => {
    if (!open) return;
    anchorRef.current?.focus();
    if (options.length === 0) {
      setHighlighted(-1);
      return;
    }
    const idx = options.findIndex((o) => o.value === value);
    setHighlighted(idx >= 0 ? idx : 0);
    // Only re-run when the panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep the highlighted option scrolled into view (portaled → query by id).
  useEffect(() => {
    if (!open || highlighted < 0) return;
    document.getElementById(optionId(highlighted))?.scrollIntoView?.({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlighted, open]);

  // Click-outside closes. Escape is handled on the trigger (so it can be
  // shielded from a surrounding ModalShell) — no window keydown listener here.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !anchorRef.current?.contains(t)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => () => clearTimeout(typeTimer.current), []);

  const clamp = (i: number) => Math.max(0, Math.min(options.length - 1, i));

  const commit = (i: number) => {
    const o = options[i];
    if (o) onChange(o.value);
    setOpen(false);
  };

  const typeahead = (ch: string) => {
    typeBuffer.current += ch.toLowerCase();
    clearTimeout(typeTimer.current);
    typeTimer.current = setTimeout(() => (typeBuffer.current = ""), 500);
    const buf = typeBuffer.current;
    const n = options.length;
    if (n === 0) return;
    // A repeated single char cycles through matches (start after the current
    // index); a multi-char buffer refines in place (start at the current index).
    const allSame = [...buf].every((c) => c === buf[0]);
    const query = allSame ? buf[0] : buf;
    const offset = allSame ? 1 : 0;
    const from = highlighted < 0 ? 0 : highlighted;
    for (let k = 0; k < n; k++) {
      const i = (from + offset + k) % n;
      if (options[i].label.toLowerCase().startsWith(query)) {
        setHighlighted(i);
        return;
      }
    }
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    const key = e.key;
    if (!open) {
      if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " " || key === "Spacebar") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    switch (key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlighted((h) => clamp(h + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlighted((h) => clamp(h - 1));
        break;
      case "Home":
        e.preventDefault();
        setHighlighted(0);
        break;
      case "End":
        e.preventDefault();
        setHighlighted(options.length - 1);
        break;
      case "Enter":
      case " ":
      case "Spacebar":
        e.preventDefault();
        commit(highlighted);
        break;
      case "Escape":
        // Shield an enclosing ModalShell (bubble-phase window Escape) from
        // also closing on this Escape.
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        if (key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          typeahead(key);
        }
    }
  };

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={ariaLabel}
        aria-activedescendant={open && highlighted >= 0 ? optionId(highlighted) : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onTriggerKeyDown}
        className={`${TRIGGER_STRUCTURE} ${triggerClassName} ${className}`}
      >
        <span className={`truncate font-serif text-sm ${current ? "text-octo-ivory" : "text-octo-mute"}`}>
          {current?.label ?? placeholder}
        </span>
        <span className="ml-auto font-mono text-[9px] text-octo-mute">▾</span>
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            id={panelId}
            role="listbox"
            aria-label={ariaLabel}
            className="octo-menu-enter fixed z-50 overflow-auto rounded-md border border-octo-hairline bg-octo-panel py-1 shadow-xl"
            style={{ top: pos.top, left: pos.left, minWidth: pos.width, maxHeight: PANEL_MAX_H }}
          >
            {options.length === 0 ? (
              <div className="px-3 py-1.5 font-serif text-sm text-octo-mute">No options</div>
            ) : (
              options.map((o, i) => {
                const active = o.value === value;
                const isHi = i === highlighted;
                return (
                  <button
                    key={o.value}
                    id={optionId(i)}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onMouseEnter={() => setHighlighted(i)}
                    onClick={() => {
                      onChange(o.value);
                      setOpen(false);
                    }}
                    // Keyboard-roving highlight uses --brass-glow (inline so it
                    // wins over the mouse hover:bg-octo-panel-2 class).
                    style={isHi ? { background: "var(--brass-glow)" } : undefined}
                    className={`flex w-full flex-col gap-0.5 px-3 py-1.5 text-left transition-colors duration-[120ms] hover:bg-octo-panel-2 ${
                      !isHi && active ? "bg-[var(--brass-ghost)]" : ""
                    }`}
                  >
                    <span className="flex w-full items-center gap-2">
                      <span className={`font-serif text-sm ${active ? "text-octo-brass" : "text-octo-ivory"}`}>{o.label}</span>
                      {active && <span className="ml-auto font-mono text-[10px] text-octo-brass">✓</span>}
                    </span>
                    {o.description && <span className="font-mono text-[10px] text-octo-mute">{o.description}</span>}
                  </button>
                );
              })
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
