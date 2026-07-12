//! Shared xterm.js appearance for every terminal surface (RUN mode's
//! TerminalPane and TALK's live-process TerminalView). xterm.js needs
//! literal color values — it can't read CSS custom properties — so
//! `getXtermTheme()` resolves the live `--color-octo-*` tokens off
//! `:root` (the same tokens `themeStore.applyThemeToDom` writes on every
//! theme switch) and builds a fresh ITheme. Callers re-invoke it on the
//! `octo:theme` event and assign the result to `terminal.options.theme`.
//!
//! Previously this exported one hardcoded dark palette, so switching to a
//! light theme (vellum) left near-white foreground/ANSI-white text on a
//! cream background — illegible. Deriving every color from the active
//! theme's own tokens keeps foreground/background contrast correct
//! regardless of theme direction.

import type { ITheme } from "@xterm/xterm";

export const XTERM_FONT_FAMILY =
  '"JetBrains Mono", "Fira Code", "SF Mono", Menlo, Consolas, monospace';

// Static fallbacks (canonical Onyx & Brass / atelier) — used before the
// theme store has applied its tokens to :root (first paint) and in
// non-DOM test environments. Mirrors components/editor/atelierTheme.ts's
// FALLBACK, which resolves the same class of problem for CodeMirror.
const FALLBACK = {
  terminalBg: "#0c0a08",
  panel2: "#1a160f",
  brass: "#d4a574",
  ivory: "#f4ecdb",
  sage: "#95897a",
  mute: "#6d6354",
  verdigris: "#8fc9a8",
  rouge: "#d18b8b",
  warning: "#dfae4a",
  stateBlue: "#7a9cb8",
  statePurple: "#a888b8",
} as const;

/** Read one CSS custom property off :root, falling back when it's empty
 *  (no document, or the token hasn't been written yet). */
function readVar(name: string, fallback: string): string {
  if (typeof document === "undefined" || !document.documentElement) return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Build the live xterm.js theme from the active Octopush theme tokens.
 *  Call again — and reassign `terminal.options.theme` — whenever the
 *  `octo:theme` event fires. */
export function getXtermTheme(): ITheme {
  const terminalBg = readVar("--color-octo-terminal-bg", FALLBACK.terminalBg);
  const text = readVar("--color-octo-ivory", FALLBACK.ivory);
  const textDim = readVar("--color-octo-sage", FALLBACK.sage);
  const textMuted = readVar("--color-octo-mute", FALLBACK.mute);
  const accent = readVar("--color-octo-brass", FALLBACK.brass);
  const success = readVar("--color-octo-verdigris", FALLBACK.verdigris);
  const danger = readVar("--color-octo-rouge", FALLBACK.rouge);
  const warning = readVar("--color-octo-warning", FALLBACK.warning);
  const panel2 = readVar("--color-octo-panel-2", FALLBACK.panel2);
  // Blue/purple have no per-theme token — Onyx & Brass's semantic palette
  // only covers accent/success/warning/danger. Reuse the static state-blue /
  // state-purple tokens that already stand in for "info" hues elsewhere
  // (Direct's API/CLI substrate pills, issue-type chips) — they're
  // constant across themes but still sourced from the design system, not
  // invented here. Cyan reuses state-blue: there's no dedicated cyan
  // token and it's rare enough in terminal output not to warrant one.
  const stateBlue = readVar("--color-octo-state-blue", FALLBACK.stateBlue);
  const statePurple = readVar("--color-octo-state-purple", FALLBACK.statePurple);

  return {
    background: terminalBg,
    foreground: text,
    cursor: accent,
    cursorAccent: terminalBg,
    selectionBackground: panel2,
    black: terminalBg,
    red: danger,
    green: success,
    yellow: warning,
    blue: stateBlue,
    magenta: statePurple,
    cyan: stateBlue,
    white: textDim,
    brightBlack: textMuted,
    brightRed: danger,
    brightGreen: success,
    brightYellow: warning,
    brightBlue: stateBlue,
    brightMagenta: statePurple,
    brightCyan: stateBlue,
    brightWhite: text,
  };
}
