import { useEffect } from "react";
import type { WorkspaceMode } from "../lib/modes";

/**
 * Every app-wide keyboard shortcut (FEATURES.md Appendix C), as a table.
 *
 * One `window` keydown listener walks `GLOBAL_SHORTCUTS` in order and the
 * FIRST entry whose chord matches claims the key — later entries never see
 * it, even when the claimer then does nothing. Order therefore matters: ⌘1..9
 * sits before ⌘⌥1..9 only because its `alt: false` keeps them apart.
 */

/** What a shortcut can read and do. Getters are read at key time, so values
 *  that change without re-registering the listener (the mode, the open file,
 *  the terminal list) are always live. */
export interface ShortcutContext {
  mode: () => WorkspaceMode;
  workspaceIds: readonly string[];
  activeWorkspaceId: string | null;
  hasProject: boolean;
  selectWorkspace: (id: string) => void;
  setMode: (mode: WorkspaceMode) => void;
  toggleMissionControl: () => void;
  toggleLogbook: () => void;
  activeEditorPath: () => string | null;
  revealInTree: (path: string) => void;
  openCreator: () => void;
  togglePalette: () => void;
  /** ⌘⇧P: the "Open a pull request" composer for the active workspace. */
  openPrComposer: () => void;
  /** The active workspace's checked-out branch (`"HEAD"` when detached), or null. */
  activeBranch: () => string | null;
  openSearch: (mode: "files" | "text") => void;
  bumpLayout: () => void;
  openSettings: (tab: "general" | "usage") => void;
  toggleSessionSwitcher: () => void;
  terminalIds: () => readonly string[];
  activeTerminalId: () => string | null;
  setActiveTerminal: (id: string) => void;
}

export interface Shortcut {
  id: string;
  /** Key caps as written in Appendix C (each one is checked against it). */
  chords: readonly string[];
  /** A mode: outside it the chord is still claimed, but nothing runs. */
  scope: "global" | WorkspaceMode;
  /** Required modifier state; omitted = either. ⌘ (or Ctrl) is always required. */
  shift?: boolean;
  alt?: boolean;
  /** Matches when `e.key` is one of `keys` or `e.code` one of `codes`. */
  keys?: readonly string[];
  codes?: readonly string[];
  /** Returns true when the key was used, which calls `preventDefault`. */
  run: (e: KeyboardEvent, ctx: ShortcutContext) => boolean;
}

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

/** The 1–9 a digit chord names. `e.code` first: on macOS Option rewrites the
 *  printed character even with Cmd held (⌥1 → "¡"). */
function digitOf(e: KeyboardEvent): number | null {
  const d = /^Digit([1-9])$/.exec(e.code ?? "")?.[1] ?? (/^[1-9]$/.test(e.key) ? e.key : null);
  return d ? parseInt(d, 10) : null;
}

/** Whether the key went to a CodeMirror editor or an xterm terminal. */
function inEditorOrTerminal(target: EventTarget | null | undefined): boolean {
  return target instanceof Element && !!target.closest(".cm-editor, .xterm");
}

export const GLOBAL_SHORTCUTS: readonly Shortcut[] = [
  {
    // `alt: false` so ⌘⌥N (jump to the Nth terminal session, below) is never
    // eaten here on a layout where Option leaves `e.key` as the digit.
    id: "workspace-n",
    chords: ["⌘1", "⌘9"],
    scope: "global",
    shift: false,
    alt: false,
    keys: DIGITS,
    run: (e, c) => {
      const id = c.workspaceIds[parseInt(e.key, 10) - 1];
      if (!id) return false;
      c.selectWorkspace(id);
      return true;
    },
  },
  {
    // Shift turns the digit into its symbol on US layouts.
    id: "mode-talk-run-review",
    chords: ["⌘⇧1", "⌘⇧2", "⌘⇧3"],
    scope: "global",
    shift: true,
    keys: ["1", "2", "3", "!", "@", "#"],
    run: (e, c) => {
      const modes: Record<string, WorkspaceMode> = {
        "1": "talk", "!": "talk", "2": "run", "@": "run", "3": "review", "#": "review",
      };
      c.setMode(modes[e.key]);
      return true;
    },
  },
  {
    id: "mode-direct",
    chords: ["⌘⇧D"],
    scope: "global",
    shift: true,
    keys: ["D", "d"],
    run: (_e, c) => (c.setMode("direct"), true),
  },
  {
    id: "mission-control",
    chords: ["⌘⇧M"],
    scope: "global",
    shift: true,
    keys: ["M", "m"],
    run: (_e, c) => (c.toggleMissionControl(), true),
  },
  {
    id: "logbook",
    chords: ["⌘⇧L"],
    scope: "global",
    shift: true,
    keys: ["L", "l"],
    run: (_e, c) => (c.toggleLogbook(), true),
  },
  {
    // Acts in Review only (outside it no tree is listening), but claims the
    // chord everywhere.
    id: "reveal-in-tree",
    chords: ["⌘⇧E"],
    scope: "global",
    shift: true,
    keys: ["E", "e"],
    run: (_e, c) => {
      if (c.mode() === "review" && c.activeWorkspaceId) {
        const path = c.activeEditorPath();
        if (path) c.revealInTree(path);
      }
      return true;
    },
  },
  {
    id: "new-workspace",
    chords: ["⌘N"],
    scope: "global",
    shift: false,
    keys: ["n"],
    run: (_e, c) => {
      if (c.hasProject) c.openCreator();
      return true;
    },
  },
  {
    // `alt: false` keeps ⌘⌥K (session switcher) out.
    id: "palette",
    chords: ["⌘K"],
    scope: "global",
    shift: false,
    alt: false,
    keys: ["k"],
    run: (_e, c) => (c.togglePalette(), true),
  },
  {
    // Leaves the key to a focused code editor or terminal, and needs the
    // active workspace on a named branch — there's nothing to open from else.
    id: "open-pull-request",
    chords: ["⌘⇧P"],
    scope: "global",
    shift: true,
    alt: false,
    keys: ["p", "P"],
    run: (e, c) => {
      if (inEditorOrTerminal(e.target) || !c.activeWorkspaceId) return false;
      const branch = c.activeBranch();
      if (!branch || branch === "HEAD") return false;
      c.openPrComposer();
      return true;
    },
  },
  {
    id: "file-finder",
    chords: ["⌘P"],
    scope: "global",
    shift: false,
    keys: ["p"],
    run: (_e, c) => (c.openSearch("files"), true),
  },
  {
    id: "text-search",
    chords: ["⌘⇧F"],
    scope: "global",
    shift: true,
    keys: ["f", "F"],
    run: (_e, c) => (c.openSearch("text"), true),
  },
  {
    id: "companion",
    chords: ["⌘\\"],
    scope: "global",
    keys: ["\\"],
    run: (_e, c) => (c.bumpLayout(), true),
  },
  {
    id: "settings",
    chords: ["⌘,"],
    scope: "global",
    keys: [","],
    run: (_e, c) => (c.openSettings("general"), true),
  },
  {
    id: "settings-usage",
    chords: ["⌘⇧T"],
    scope: "global",
    shift: true,
    keys: ["T", "t"],
    run: (_e, c) => (c.openSettings("usage"), true),
  },
  {
    // Run mode only: the switcher lists terminals and nothing else — in Talk
    // it would silently switch a surface the user isn't looking at. `codes`
    // so the shortcut follows the physical key when Option remaps the
    // printed character.
    id: "session-switcher",
    chords: ["⌘⌥K"],
    scope: "run",
    shift: false,
    alt: true,
    keys: ["k", "K"],
    codes: ["KeyK"],
    run: (_e, c) => {
      if (!c.activeWorkspaceId) return false;
      c.toggleSessionSwitcher();
      return true;
    },
  },
  {
    // Previous / next session, wrapping.
    id: "session-step",
    chords: ["⌘⌥←", "⌘⌥→"],
    scope: "run",
    shift: false,
    alt: true,
    keys: ["ArrowLeft", "ArrowRight"],
    run: (e, c) => {
      if (!c.activeWorkspaceId) return false;
      const ids = c.terminalIds();
      if (ids.length < 2) return false;
      const at = ids.indexOf(c.activeTerminalId() ?? "");
      const step = e.key === "ArrowRight" ? 1 : -1;
      const next = ids[(at + step + ids.length) % ids.length];
      if (next) c.setActiveTerminal(next);
      return true;
    },
  },
  {
    id: "session-n",
    chords: ["⌘⌥1", "⌘⌥9"],
    scope: "run",
    shift: false,
    alt: true,
    keys: DIGITS,
    codes: DIGITS.map((d) => `Digit${d}`),
    run: (e, c) => {
      const n = digitOf(e);
      if (c.activeWorkspaceId && n) {
        const id = c.terminalIds()[n - 1];
        if (id) c.setActiveTerminal(id);
      }
      return true;
    },
  },
];

/** The first shortcut whose chord `e` presses, or null. Pure. */
export function matchShortcut(e: KeyboardEvent, table: readonly Shortcut[] = GLOBAL_SHORTCUTS): Shortcut | null {
  if (!(e.metaKey || e.ctrlKey)) return null;
  for (const s of table) {
    if (s.shift !== undefined && e.shiftKey !== s.shift) continue;
    if (s.alt !== undefined && e.altKey !== s.alt) continue;
    if (s.keys?.includes(e.key) || s.codes?.includes(e.code ?? "")) return s;
  }
  return null;
}

/** Runs the shortcut `e` presses, if any. */
export function handleShortcut(
  e: KeyboardEvent,
  ctx: ShortcutContext,
  table: readonly Shortcut[] = GLOBAL_SHORTCUTS,
): void {
  // Something closer to the event already handled this key. CodeMirror calls
  // preventDefault on a key its keymap consumed but never stopPropagation,
  // so without this an editor binding and an app-level shortcut both fire:
  // ⌘⇧L in a code editor multiplied the selection AND opened the Logbook.
  if (e.defaultPrevented) return;
  const s = matchShortcut(e, table);
  if (!s) return;
  if (s.scope !== "global" && ctx.mode() !== s.scope) return;
  if (s.run(e, ctx)) e.preventDefault();
}

/** Owns the single `window` keydown listener for every global shortcut.
 *  Pass a memoised `ctx`: the listener re-registers whenever it changes. */
export function useGlobalShortcuts(ctx: ShortcutContext): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => handleShortcut(e, ctx);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ctx]);
}
