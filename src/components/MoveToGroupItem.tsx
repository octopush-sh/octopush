import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronRight, Group as GroupIcon, Plus } from "lucide-react";
import { MENU_ITEM, MENU_SEP, SUBMENU_CHROME } from "../lib/menuStyles";
import { TINTS } from "../lib/monogram";
import type { TintName } from "../lib/types";

/** A group as the submenu lists it. */
export interface MoveTargetGroup {
  id: string;
  name: string;
  tint: TintName | null;
}

interface Props {
  /** The groups the item may join, in rail order. */
  groups: MoveTargetGroup[];
  /** The group the item is in now (shown checked), or null. */
  currentGroupId: string | null;
  onMove: (groupId: string) => void;
  onNewGroup: () => void;
  /** Present only while the item is in a group. */
  onRemoveFromGroup?: () => void;
}

/** How long the pointer may be off the row and its submenu before it closes. */
const CLOSE_GRACE_MS = 160;

/**
 * "Move to group ›": a row of a `<MenuSurface>` menu that opens a submenu
 * beside it, listing the groups of the item's own scope (the current one
 * checked), then "New group…" and, for an item already in a group, "Remove
 * from group".
 *
 * The submenu is rendered inside the menu's panel, not portalled: the menu's
 * outside-click test and its ↑/↓ walk (`useMenuChrome`, which walks the menu
 * holding the focus) then treat it as part of the menu. It opens on hover,
 * click, Enter or →; ← returns to the row; Escape closes the whole menu.
 */
export function MoveToGroupItem({ groups, currentGroupId, onMove, onNewGroup, onRemoveFromGroup }: Props) {
  const [open, setOpen] = useState(false);
  // Which way the submenu opens, and how far it is pulled up, decided after
  // measuring it against the window.
  const [place, setPlace] = useState<{ side: "right" | "left"; lift: number }>({ side: "right", lift: 0 });
  const rowRef = useRef<HTMLButtonElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const focusOnOpen = useRef(false);

  const cancelClose = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = undefined;
  }, []);
  useEffect(() => cancelClose, [cancelClose]);

  const openNow = (withFocus: boolean) => {
    cancelClose();
    focusOnOpen.current = withFocus;
    setOpen(true);
  };

  useLayoutEffect(() => {
    if (!open) return;
    const sub = subRef.current;
    const row = rowRef.current;
    if (!sub || !row) return;
    const margin = 8;
    const rowRect = row.getBoundingClientRect();
    const { width, height } = sub.getBoundingClientRect();
    const side = rowRect.right + width + margin > window.innerWidth && rowRect.left - width > margin ? "left" : "right";
    const lift = Math.max(0, rowRect.top + height + margin - window.innerHeight);
    setPlace((prev) => (prev.side === side && prev.lift === lift ? prev : { side, lift }));
    if (focusOnOpen.current) {
      focusOnOpen.current = false;
      const rows = sub.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]');
      (sub.querySelector<HTMLElement>('[aria-checked="true"]') ?? rows[0])?.focus();
    }
  }, [open]);

  const closeToRow = () => {
    setOpen(false);
    rowRef.current?.focus();
  };

  return (
    <div
      className="relative"
      // Keyboard focus that moves on to another row of the menu closes it.
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
      onMouseEnter={() => openNow(false)}
      onMouseLeave={() => {
        cancelClose();
        closeTimer.current = setTimeout(() => setOpen(false), CLOSE_GRACE_MS);
      }}
    >
      <button
        ref={rowRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        className={MENU_ITEM}
        onClick={() => openNow(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") {
            e.preventDefault();
            openNow(true);
          }
        }}
      >
        <GroupIcon size={12} className="shrink-0" />
        <span className="flex-1 text-left">Move to group</span>
        <ChevronRight size={12} className="shrink-0 text-octo-mute" aria-hidden />
      </button>

      {open && (
        // The 4px gap between the two panels is padding on this wrapper, so
        // the pointer never leaves the row's hover area while crossing it.
        <div
          className={`absolute top-0 z-[61] ${place.side === "right" ? "left-full pl-1" : "right-full pr-1"}`}
          style={{ marginTop: -4 - place.lift }}
        >
          <div
            ref={subRef}
            role="menu"
            aria-label="Move to group"
            className={`${SUBMENU_CHROME} w-[220px] py-1`}
            style={{ transformOrigin: place.side === "right" ? "top left" : "top right" }}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") {
                e.preventDefault();
                e.stopPropagation();
                closeToRow();
              }
            }}
          >
            {groups.map((group) => {
              const current = group.id === currentGroupId;
              return (
                <button
                  key={group.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={current}
                  data-menu-item=""
                  className={MENU_ITEM}
                  title={group.name}
                  onClick={() => onMove(group.id)}
                >
                  <span className="flex w-3 shrink-0 items-center justify-center" aria-hidden>
                    {current ? (
                      <Check size={12} />
                    ) : (
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${group.tint ? "" : "bg-octo-mute"}`}
                        style={group.tint ? { background: TINTS[group.tint].accent } : undefined}
                      />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-left">{group.name}</span>
                </button>
              );
            })}
            {groups.length > 0 && <div className={MENU_SEP} />}
            <button type="button" role="menuitem" className={MENU_ITEM} onClick={onNewGroup}>
              <Plus size={12} className="shrink-0" /> New group…
            </button>
            {onRemoveFromGroup && (
              <button type="button" role="menuitem" className={MENU_ITEM} onClick={onRemoveFromGroup}>
                <span className="w-3 shrink-0" aria-hidden /> Remove from group
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
