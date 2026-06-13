// Workspace monogram resolution — glyph + tint preset.
// See docs/superpowers/specs/2026-05-16-octopus-ux-redesign-design.md §3.5
// for the design rationale and color choices.

import type { Workspace, TintName } from "./types";

export interface MonogramConfig {
  /** Single character to render (Spectral upright serif). */
  glyph: string;
  /** Tint preset name — controls the icon's accent + background only. */
  tint: TintName;
  /** True iff the user has overridden glyph or tint (vs. defaults). */
  isCustom: boolean;
}

export const TINT_NAMES: TintName[] = [
  "brass",
  "verdigris",
  "rouge",
  "indigo",
  "lavender",
  "smoke",
  "bone",
];

export const TINTS: Record<TintName, { accent: string; bg: string }> = {
  brass:     { accent: "#d4a574", bg: "rgba(212, 165, 116, 0.08)" },
  verdigris: { accent: "#8fc9a8", bg: "rgba(143, 201, 168, 0.08)" },
  rouge:     { accent: "#d18b8b", bg: "rgba(209, 139, 139, 0.08)" },
  indigo:    { accent: "#8a93c9", bg: "rgba(138, 147, 201, 0.08)" },
  lavender:  { accent: "#b59ac9", bg: "rgba(181, 154, 201, 0.08)" },
  smoke:     { accent: "#a8a8a8", bg: "rgba(168, 168, 168, 0.06)" },
  bone:      { accent: "#d8c9a8", bg: "rgba(216, 201, 168, 0.07)" },
};

export function resolveMonogram(ws: Workspace): MonogramConfig {
  const glyph = ws.glyph ?? deriveFirstLetter(ws.name);
  const tint: TintName = ws.tint ?? "brass";
  const isCustom = ws.glyph !== null || ws.tint !== null;
  return { glyph, tint, isCustom };
}

function deriveFirstLetter(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "?";
  return trimmed.charAt(0).toUpperCase();
}
