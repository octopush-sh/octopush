// Fixtures shared by several scenarios.
import type { ThemeConfig } from "../../../src/lib/types";

// The built-in themes exactly as the IPC returns them: `builtin_themes()` in
// src-tauri/src/theme.rs, in the same order, camelCased by serde. Values are
// copied from there; this is backend data, not UI styling. The names are
// checked against theme.rs by scripts/visual-audit/visual-audit.test.mjs, so a
// theme added or removed there fails CI until it is mirrored here (#1055).

/** The brand default, and what `get_theme` returns. */
export const ATELIER: ThemeConfig = {
  name: "atelier",
  bg: "#0c0a08",
  panel: "#14110d",
  panel2: "#1a160f",
  border: "#2a2419",
  borderStrong: "#786747",
  accent: "#d4a574",
  accentDim: "#e8c39a",
  success: "#8fc9a8",
  warning: "#dfae4a",
  danger: "#d18b8b",
  text: "#f4ecdb",
  textDim: "#95897a",
  textMuted: "#8c7f6c",
  terminalBg: "#0c0a08",
};

export const VELLUM: ThemeConfig = {
  name: "vellum",
  bg: "#f2ece0",
  panel: "#faf6ec",
  panel2: "#ece4d4",
  border: "#c9ba95",
  borderStrong: "#8a7a5f",
  accent: "#91522c",
  accentDim: "#6d3710",
  success: "#246f47",
  warning: "#7f5300",
  danger: "#b33024",
  text: "#2a201a",
  textDim: "#6d5e4b",
  textMuted: "#6f5f4a",
  terminalBg: "#f2ece0",
};

export const MOSSBANK: ThemeConfig = {
  name: "mossbank",
  bg: "#0a120c",
  panel: "#121b14",
  panel2: "#1a261c",
  border: "#233028",
  borderStrong: "#597a66",
  accent: "#c89669",
  accentDim: "#dbac82",
  success: "#8fc9a8",
  warning: "#c89669",
  danger: "#d18b8b",
  text: "#e8e5da",
  textDim: "#95a098",
  textMuted: "#7f8f84",
  terminalBg: "#0a120c",
};

export const PORCELAIN_INDIGO: ThemeConfig = {
  name: "porcelain-indigo",
  bg: "#0a0e1c",
  panel: "#121830",
  panel2: "#1a223d",
  border: "#2a3252",
  borderStrong: "#606fad",
  accent: "#d4a5b8",
  accentDim: "#e6c3d2",
  success: "#8fc8b4",
  warning: "#d4b074",
  danger: "#d18888",
  text: "#e8e8ee",
  textDim: "#999fb5",
  textMuted: "#858a9f",
  terminalBg: "#0a0e1c",
};

export const EMBER: ThemeConfig = {
  name: "ember",
  bg: "#100806",
  panel: "#1a0e0a",
  panel2: "#251510",
  border: "#2d1d15",
  borderStrong: "#915e44",
  accent: "#d4805c",
  accentDim: "#e09975",
  success: "#9bc89d",
  warning: "#d4805c",
  danger: "#c86060",
  text: "#f0e0d0",
  textDim: "#a09080",
  textMuted: "#937f6c",
  terminalBg: "#100806",
};

export const DARK: ThemeConfig = {
  name: "dark",
  bg: "#0a0a0b",
  panel: "#101013",
  panel2: "#16161c",
  border: "#1f1f25",
  borderStrong: "#67677a",
  accent: "#a78bfa",
  accentDim: "#7c6dd8",
  success: "#34d399",
  warning: "#fbbf24",
  danger: "#f87171",
  text: "#e4e4e7",
  textDim: "#a1a1aa",
  textMuted: "#7f7f8c",
  terminalBg: "#0a0a0b",
};

export const MIDNIGHT: ThemeConfig = {
  name: "midnight",
  bg: "#0d1117",
  panel: "#161b22",
  panel2: "#1a212a",
  border: "#21262d",
  borderStrong: "#627185",
  accent: "#58a6ff",
  accentDim: "#388bfd",
  success: "#3fb950",
  warning: "#d29922",
  danger: "#f85149",
  text: "#c9d1d9",
  textDim: "#8b949e",
  textMuted: "#7e8996",
  terminalBg: "#0d1117",
};

export const SOLARIZED_DARK: ThemeConfig = {
  name: "solarized-dark",
  bg: "#002b36",
  panel: "#073642",
  panel2: "#0a4351",
  border: "#586e75",
  borderStrong: "#779199",
  accent: "#268bd2",
  accentDim: "#2176b8",
  success: "#859900",
  warning: "#b58900",
  danger: "#dc322f",
  text: "#839496",
  textDim: "#657b83",
  textMuted: "#586e75",
  terminalBg: "#002b36",
};

/** Every built-in theme, as `list_themes` returns it. A picker with one card
 *  in a screenshot means a scenario stopped returning this. */
export const BUILTIN_THEMES: ThemeConfig[] = [
  ATELIER, VELLUM, MOSSBANK, PORCELAIN_INDIGO, EMBER, DARK, MIDNIGHT, SOLARIZED_DARK,
];

/** A fixed clock so recordings are reproducible. */
export const NOW = "2026-10-28T15:00:00Z";
