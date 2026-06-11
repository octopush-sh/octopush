/**
 * Shared class strings for context-menu rows (rendered inside `<MenuSurface>`).
 * One source of truth — Project/Workspace/FileTree menus previously carried
 * three diverging copies of these.
 */

/** Standard single-line menu row. */
export const MENU_ITEM =
  "flex w-full items-center gap-2 px-3 py-2 font-mono text-[11px] text-octo-sage transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass";

/** Two-line menu row (label + muted hint) — icon aligns to the first line. */
export const MENU_ITEM_MULTILINE =
  "flex w-full items-start gap-2 px-3 py-2 font-mono text-[11px] text-octo-sage transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass";

/** Destructive single-line row — rouge text, rouge-ghost hover. */
export const MENU_DANGER =
  "flex w-full items-center gap-2 px-3 py-2 font-mono text-[11px] text-octo-rouge transition hover:bg-[var(--rouge-ghost)] hover:text-octo-rouge";

/** Destructive two-line row (label + muted hint). */
export const MENU_DANGER_MULTILINE =
  "flex w-full items-start gap-2 px-3 py-2 font-mono text-[11px] text-octo-rouge transition hover:bg-[var(--rouge-ghost)] hover:text-octo-rouge";

/** Hairline separator between menu sections. */
export const MENU_SEP = "h-px bg-octo-hairline";

/** Muted eyebrow header naming the menu's subject (first row of the menu). */
export const MENU_HEADER =
  "truncate px-3 pb-1 pt-1 font-mono text-[9px] uppercase tracking-[0.18em] text-octo-mute";
