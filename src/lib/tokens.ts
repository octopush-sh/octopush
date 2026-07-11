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
  mute: "#6d6354",

  // Status
  verdigris: "#8fc9a8",
  rouge: "#d18b8b",
  // Amber — distinct from brass: warning/caution, never the accent.
  warning: "#dfae4a",
} as const;

export const fonts = {
  serif: '"Spectral", "Iowan Old Style", "Times New Roman", serif',
  sans: '-apple-system, "Helvetica Neue", sans-serif',
  mono: '"JetBrains Mono", "SF Mono", monospace',
} as const;

export const ease = {
  octo: "cubic-bezier(0.2, 0.8, 0.3, 1)",
} as const;

export const dur = {
  quick: 220,
  standard: 280,
  slow: 320,
  reveal: 600,
} as const;

export type Token = keyof typeof tokens;
export type Font = keyof typeof fonts;
