import { useLayoutEffect, useRef } from "react";
import { MenuSurface } from "./MenuSurface";
import { MoveToGroupChoices, type MoveToGroupChoicesProps } from "./MoveToGroupItem";
import { MENU_HEADER } from "../lib/menuStyles";

interface Props extends MoveToGroupChoicesProps {
  x: number;
  y: number;
  /** What moves, as the header's tooltip: a mission's or a project's name. */
  subject: string;
  /** How many missions move, when it is a selection of several: the header
   *  then says so ("Move 3 missions to group"). */
  count?: number;
  onDismiss: () => void;
}

/** How long typed letters keep adding to one type-ahead search. */
const TYPEAHEAD_MS = 600;

/**
 * "Move to group…" from the keyboard (`⌘⌥G` on a focused rail row): the
 * choices of the context menu's **Move to group ›** submenu, as a menu of
 * their own opened at the row. The focus starts on the current group (else
 * on the first row), and typing a group's first letters moves to it.
 */
export function MoveToGroupMenu({ x, y, subject, count, onDismiss, ...choices }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });

  // MenuSurface focuses its first row; the current group is the better start,
  // as it is in the submenu. (A child's layout effect runs before this one.)
  useLayoutEffect(() => {
    rootRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, []);

  const run = (fn: () => void) => () => {
    fn();
    onDismiss();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey || e.key === " ") return;
    const now = Date.now();
    const text = (now - typed.current.at < TYPEAHEAD_MS ? typed.current.text : "") + e.key.toLowerCase();
    typed.current = { text, at: now };
    const menu = e.currentTarget.closest<HTMLElement>('[role="menu"]');
    const rows = Array.from(menu?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);
    const from = rows.indexOf(document.activeElement as HTMLElement);
    // A repeated single letter walks the rows that start with it.
    const start = text.length === 1 ? from + 1 : Math.max(from, 0);
    const label = (el: HTMLElement) => (el.textContent ?? "").trim().toLowerCase();
    const hit = [...rows.slice(start), ...rows.slice(0, start)].find((el) => label(el).startsWith(text));
    if (hit) {
      e.preventDefault();
      hit.focus();
    }
  };

  return (
    <MenuSurface x={x} y={y} ariaLabel="Move to group" onDismiss={onDismiss} widthClass="w-[220px]">
      <div ref={rootRef} onKeyDown={onKeyDown}>
        {/* The row it moves is the focused one, in sight beside the menu; the
            header says what the menu does (a long name would only truncate). */}
        <div className={MENU_HEADER} title={subject}>
          {count && count > 1 ? `Move ${count} missions to group` : "Move to group"}
        </div>
        <MoveToGroupChoices
          {...choices}
          onMove={(id) => run(() => choices.onMove(id))()}
          onNewGroup={run(choices.onNewGroup)}
          onRemoveFromGroup={choices.onRemoveFromGroup ? run(choices.onRemoveFromGroup) : undefined}
        />
      </div>
    </MenuSurface>
  );
}
