//! Shared xterm.js appearance for every terminal surface (RUN mode's
//! TerminalPane and TALK's live-process TerminalView). xterm needs literal
//! color values (it can't read CSS variables), so this is the one place these
//! hexes live — keep RUN and TALK terminals visually identical.

import type { ITheme } from "@xterm/xterm";

export const XTERM_FONT_FAMILY =
  '"JetBrains Mono", "Fira Code", "SF Mono", Menlo, Consolas, monospace';

export const XTERM_THEME: ITheme = {
  background: "#0a0a0b",
  foreground: "#e4e4e7",
  cursor: "#a78bfa",
  cursorAccent: "#0a0a0b",
  selectionBackground: "#3f3f46",
  black: "#18181b",
  red: "#f87171",
  green: "#34d399",
  yellow: "#fbbf24",
  blue: "#60a5fa",
  magenta: "#a78bfa",
  cyan: "#22d3ee",
  white: "#d4d4d8",
  brightBlack: "#3f3f46",
  brightRed: "#fca5a5",
  brightGreen: "#6ee7b7",
  brightYellow: "#fcd34d",
  brightBlue: "#93c5fd",
  brightMagenta: "#c4b5fd",
  brightCyan: "#67e8f9",
  brightWhite: "#fafafa",
};
