/** Talk's permission modes (#1146, #1231): what the agent may do without
 *  asking in one conversation. The backend decides every call
 *  (`permissions.rs`); this is how the Composer names and cycles them. */

export type PermissionMode = "plan" | "ask" | "edit";

/** A conversation's mode as stored, as its turns run it, and whether a
 *  read-only mission forces Plan only (then the control can't change it). */
export interface ThreadMode {
  stored: PermissionMode;
  effective: PermissionMode;
  forced: boolean;
}

/** The modes in the order the chord cycles them. */
export const PERMISSION_MODES: readonly PermissionMode[] = ["plan", "ask", "edit"];

export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  plan: "Plan only",
  ask: "Ask first",
  edit: "Edit freely",
};

/** One line on what each mode does, for the menu and the tooltip. */
export const PERMISSION_MODE_HINTS: Record<PermissionMode, string> = {
  plan: "Reads and plans. Nothing is written, and commands run read-only.",
  ask: "Each change waits for your OK: file edits, commands that may write, MCP writes. Nothing is approved for later.",
  edit: "Changes run without asking. Flagged commands, MCP writes and anything outside the workspace still have their cards.",
};

/** The chord that cycles the mode, only while the focus is in the Composer. */
export const MODE_CHORD = "⌘⌥P";

/** What the control says while a read-only mission forces Plan only. */
export const FORCED_HINT = "This workspace's mission is read-only, so Talk works in Plan only here.";

/** The mode after `mode` in the cycle. Pure. */
export function nextPermissionMode(mode: PermissionMode): PermissionMode {
  return PERMISSION_MODES[(PERMISSION_MODES.indexOf(mode) + 1) % PERMISSION_MODES.length];
}

/** Whether a key is the mode chord: ⌘⌥P and nothing else (not ⌃⌥P), by
 *  the physical key, since Option turns `p` into `π` on macOS. A held key
 *  never cycles. Pure. */
export function isModeChord(
  e: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "repeat" | "key" | "code">,
): boolean {
  if (!e.metaKey || e.ctrlKey || !e.altKey || e.shiftKey || e.repeat) return false;
  return e.code === "KeyP" || e.key === "p" || e.key === "P";
}

/** Whether a quiet note row is the one a turn writes when its mode changes
 *  between rounds ("Ask first from this round on: …",
 *  `permissions::mode_note`), not a stop. Pure. */
export function isModeNote(content: string): boolean {
  return PERMISSION_MODES.some((m) => content.startsWith(`${PERMISSION_MODE_LABELS[m]} from this round on`));
}
