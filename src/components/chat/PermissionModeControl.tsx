import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { clsx } from "clsx";
import { Eye, Hand, Lock, PencilLine, type LucideIcon } from "lucide-react";
import { usePermissionModeStore } from "../../stores/permissionModeStore";
import {
  FORCED_HINT,
  MODE_CHORD,
  PERMISSION_MODES,
  PERMISSION_MODE_HINTS,
  PERMISSION_MODE_LABELS,
  nextPermissionMode,
  type PermissionMode,
} from "../../lib/permissionModes";

const ICONS: Record<PermissionMode, LucideIcon> = { plan: Eye, ask: Hand, edit: PencilLine };

const CHIP =
  "flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 py-1 font-mono text-[11px] transition-colors duration-[var(--dur-quick)] ease-[var(--ease-octo)]";

interface Props {
  threadId: string;
  /** A turn is running: the mode is read again when it ends. */
  streaming: boolean;
}

/**
 * The Composer's permission-mode control (#1231): Plan only, Ask first or
 * Edit freely for this conversation. It shows the mode the turns run in,
 * so a read-only mission that forces Plan only shows as such, with a lock,
 * and can't be changed. A click opens the three modes; ⌘⌥P (the Composer's
 * chord) moves to the next. A change during a turn applies from its next
 * round.
 */
export function PermissionModeControl({ threadId, streaming }: Props) {
  const mode = usePermissionModeStore((s) => s.byThread[threadId]);
  const load = usePermissionModeStore((s) => s.load);
  const setMode = usePermissionModeStore((s) => s.set);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Read for each conversation, and again when a turn ends: a mission may
  // have started or settled meanwhile.
  useEffect(() => {
    void load(threadId);
  }, [threadId, streaming, load]);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !triggerRef.current?.contains(t)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!mode) return null;
  const current = mode.effective;
  const label = PERMISSION_MODE_LABELS[current];

  if (mode.forced) {
    return (
      <button
        type="button"
        aria-disabled="true"
        aria-label={`Permission mode: ${label}. ${FORCED_HINT}`}
        title={`${label}. ${FORCED_HINT} The mode can't be changed while it is.`}
        data-tour="talk-permission-mode"
        className={clsx(CHIP, "cursor-default border-octo-hairline text-octo-mute")}
      >
        <Lock size={12} aria-hidden />
        <span>{label}</span>
      </button>
    );
  }

  const Icon = ICONS[current];
  const next = PERMISSION_MODE_LABELS[nextPermissionMode(current)];
  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  const choose = (m: PermissionMode) => {
    void setMode(threadId, m);
    close();
  };
  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      setOpen(false);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? []);
      const at = items.indexOf(document.activeElement as HTMLElement);
      items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    }
  };

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Permission mode: ${label}`}
        aria-keyshortcuts="Meta+Alt+P"
        title={`Permission mode: ${label}. ${PERMISSION_MODE_HINTS[current]} ${MODE_CHORD} switches to ${next} (with the focus in the composer).`}
        data-tour="talk-permission-mode"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={clsx(
          CHIP,
          open
            ? "border-octo-brass/40 bg-octo-brass/8 text-octo-brass"
            : "border-octo-hairline text-octo-sage hover:border-octo-brass/30 hover:text-octo-brass",
        )}
      >
        <Icon size={12} aria-hidden />
        <span>{label}</span>
        <span aria-hidden className="ml-0.5 text-[9px] opacity-60">
          ▾
        </span>
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="Permission mode"
          onKeyDown={onMenuKey}
          className="octo-menu-enter absolute bottom-full left-0 z-30 mb-1.5 w-[min(20rem,80vw)] rounded-md border border-octo-hairline bg-octo-panel py-1 shadow-xl"
        >
          {PERMISSION_MODES.map((m) => {
            const ItemIcon = ICONS[m];
            const on = m === current;
            return (
              <button
                key={m}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                title={`${PERMISSION_MODE_LABELS[m]}: ${PERMISSION_MODE_HINTS[m]}`}
                onClick={() => choose(m)}
                className="flex w-full items-start gap-2.5 px-3 py-1.5 text-left transition-colors duration-[var(--dur-quick)] ease-[var(--ease-octo)] hover:bg-octo-panel-2 focus-visible:bg-octo-panel-2 focus-visible:outline-none"
              >
                <ItemIcon size={13} aria-hidden className={clsx("mt-0.5 shrink-0", on ? "text-octo-brass" : "text-octo-mute")} />
                <span className="flex flex-col gap-0.5">
                  <span className={clsx("font-serif text-sm", on ? "text-octo-brass" : "text-octo-ivory")}>
                    {PERMISSION_MODE_LABELS[m]}
                  </span>
                  <span className="font-mono text-[10px] leading-snug text-octo-mute">{PERMISSION_MODE_HINTS[m]}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
