// Typed mirror of the CSS theme tokens defined in src/styles.css.
//
// Prefer Tailwind utility classes (bg-octo-onyx, text-octo-brass, etc.) for
// component styling — they generate the same CSS variables. Reach for this
// module only when you need a value in JS (inline styles from runtime state,
// configuring a third-party lib like xterm or recharts).
//
// Source of truth: docs/design-system.md

export const tokens = {
  // Surfaces
  onyx: "#0c0a08",
  panel: "#14110d",
  panel2: "#1a160f",
  hairline: "#2a2419",

  // Brass — the single accent
  brass: "#d4a574",
  brassHi: "#e8c39a",
  brassDim: "rgba(212, 165, 116, 0.4)",
  brassGhost: "rgba(212, 165, 116, 0.08)",
  brassLine: "rgba(212, 165, 116, 0.55)",
  brassQuiet: "rgba(212, 165, 116, 0.22)",

  // Text
  ivory: "#f4ecdb",
  sage: "#95897a",
  mute: "#8c7f6c",

  // Status
  verdigris: "#8fc9a8",
  rouge: "#d18b8b",
  // Amber — distinct from brass: warning/caution, never the accent.
  warning: "#dfae4a",

  // State hues. The editor also inks types (blue) and constants (purple)
  // with them; see lib/syntaxPalette.ts.
  stateBlue: "#7a9cb8",
  statePurple: "#a888b8",
} as const;

/**
 * Vellum (light) values of the inks the editor's syntax palette uses beyond
 * the text ramp and brass. Each clears WCAG AA (4.5:1) on every Vellum surface.
 *
 * `stateBlue` / `statePurple` have no ThemeConfig field: themeStore picks
 * these on a light ground and the `tokens` values on a dark one. `verdigris`
 * and `warning` ARE ThemeConfig fields (`success` / `warning` in
 * src-tauri/src/theme.rs) and are mirrored here only for the contrast test;
 * a drift test keeps them equal to theme.rs.
 */
export const vellumInks = {
  stateBlue: "#2f5a7e",
  statePurple: "#6a4682",
  verdigris: "#246f47",
  warning: "#7f5300",
} as const;

/** The state hues for a theme, by whether its ground is dark. */
export function stateInks(dark: boolean): { stateBlue: string; statePurple: string } {
  const src = dark ? tokens : vellumInks;
  return { stateBlue: src.stateBlue, statePurple: src.statePurple };
}

export const fonts = {
  serif: '"Spectral", "Iowan Old Style", "Times New Roman", serif',
  sans: '-apple-system, "Helvetica Neue", sans-serif',
  mono: '"JetBrains Mono", "SF Mono", monospace',
} as const;

export const ease = {
  octo: "cubic-bezier(0.2, 0.8, 0.3, 1)",
} as const;

/** Talk's terminal seat (mirrors `--talk-*` in styles.css; see TalkSeat). */
export const talkSeat = {
  chatMin: "44rem",
  seatMin: "21rem",
  chatFloor: "18rem",
} as const;

export const dur = {
  quick: 220,
  standard: 280,
  slow: 320,
  reveal: 600,
} as const;

export type Token = keyof typeof tokens;
export type Font = keyof typeof fonts;
