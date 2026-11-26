/**
 * Shared class strings for context-menu rows (rendered inside `<MenuSurface>`).
 * One source of truth — Project/Workspace/FileTree menus previously carried
 * three diverging copies of these.
 */

/** The ground and lift of anything that floats above the app: the panel
 *  token, opaque in every theme, and the one lift shadow the menus use. A
 *  light theme has no brighter surface to raise a panel to (design-system
 *  §1.1, rule 5), so lift is the shadow and a line, never a darker ground:
 *  `panel_2` RECESSES in Vellum, and a lifted thing on it would read as a
 *  slab. Shared so a menu and a dragged rail block can never drift apart. */
export const LIFTED_GROUND = "bg-octo-panel shadow-2xl";

/** The menu panel itself — entrance, layering, the panel ground and its
 *  frame. `MenuSurface` is the one context-menu chrome; hover flyouts that
 *  are not menus (the rail's collapsed-cell flyout) share the look through
 *  this string so the two can never drift. Width and padding are the
 *  caller's. */
const MENU_FRAME = `rounded-md border border-octo-hairline ${LIFTED_GROUND}`;
export const MENU_CHROME = `octo-menu-enter fixed z-[60] ${MENU_FRAME}`;

/** A submenu's panel: the same entrance and frame, without the positioning.
 *  Its parent row places it (it is rendered inside the menu, so the menu's
 *  outside-click and ↑/↓ handling see it as part of the menu). */
export const SUBMENU_CHROME = `octo-menu-enter ${MENU_FRAME}`;

/** Standard single-line menu row. Keyboard focus (the ↑/↓ walk, the first
 *  row a menu focuses) wears the hover's wash, never the browser's ring. */
export const MENU_ITEM =
  "flex w-full items-center gap-2 px-3 py-2 font-mono text-[11px] text-octo-sage transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus-visible:bg-[var(--brass-ghost)] focus-visible:text-octo-brass focus-visible:outline-none";

/** Two-line menu row (label + muted hint) — icon aligns to the first line. */
export const MENU_ITEM_MULTILINE =
  "flex w-full items-start gap-2 px-3 py-2 font-mono text-[11px] text-octo-sage transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus-visible:bg-[var(--brass-ghost)] focus-visible:text-octo-brass focus-visible:outline-none";

/** Destructive single-line row — rouge text, rouge-ghost hover. */
export const MENU_DANGER =
  "flex w-full items-center gap-2 px-3 py-2 font-mono text-[11px] text-octo-rouge transition hover:bg-[var(--rouge-ghost)] hover:text-octo-rouge";

/** Destructive row that stays quiet until pointed at: sage at rest, rouge on
 *  hover and on keyboard focus alike (the arrow keys land on it too) — for a
 *  destructive item at the foot of an otherwise everyday menu. */
export const MENU_ITEM_ROUGE =
  "flex w-full items-center gap-2 px-3 py-2 font-mono text-[11px] text-octo-sage transition hover:bg-[var(--rouge-ghost)] hover:text-octo-rouge focus-visible:bg-[var(--rouge-ghost)] focus-visible:text-octo-rouge focus-visible:outline-none";

/** Destructive two-line row (label + muted hint). */
export const MENU_DANGER_MULTILINE =
  "flex w-full items-start gap-2 px-3 py-2 font-mono text-[11px] text-octo-rouge transition hover:bg-[var(--rouge-ghost)] hover:text-octo-rouge";

/** Hairline separator between menu sections. */
export const MENU_SEP = "h-px bg-octo-hairline";

/** Muted eyebrow header naming the menu's subject (first row of the menu). */
export const MENU_HEADER =
  "truncate px-3 pb-1 pt-1 font-mono text-[9px] uppercase tracking-[0.18em] text-octo-mute";
