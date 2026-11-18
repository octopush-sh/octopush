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
  // One resolution for every surface (rail, collapsed rail, ⌘K, customize):
  // a stored glyph is honoured only if it normalizes to a real capital-form
  // glyph; otherwise the name's initial stands in (#848).
  const glyph = normalizeGlyph(ws.glyph) ?? deriveFirstLetter(ws.name);
  const tint: TintName = ws.tint ?? "brass";
  const isCustom = ws.glyph != null || ws.tint != null;
  return { glyph, tint, isCustom };
}

/** The first user-perceived character of `s` (a grapheme, so an emoji or an
 *  accented letter built from combining marks stays whole). */
function firstGrapheme(s: string): string {
  const Seg = (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (Seg) {
    for (const { segment } of new Seg("en", { granularity: "grapheme" }).segment(s)) return segment;
    return "";
  }
  return Array.from(s)[0] ?? "";
}

/** Uppercases with a locale-independent mapping; `null` when the capital form
 *  isn't a single glyph (ß → "SS", ŉ → "ʼN", ﬁ → "FI"). */
function singleCapital(g: string): string | null {
  const up = g.toLocaleUpperCase("en-US");
  return firstGrapheme(up) === up ? up : null;
}

/**
 * Normalizes a stored or typed glyph to what the monogram renders: the first
 * grapheme, trimmed, in capital form. Returns `null` (use the name's initial)
 * for empty or whitespace input, control characters, and lowercase letters
 * with no single-glyph capital — notably `ß`, which macOS types for ⌥S and
 * which once stood in for a `main` workspace's "M" (#848). Symbols, digits
 * and emoji pass through unchanged.
 */
export function normalizeGlyph(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const g = firstGrapheme(raw.trim());
  if (g === "" || /^\p{C}/u.test(g)) return null;
  return singleCapital(g);
}

function deriveFirstLetter(name: string | null | undefined): string {
  const g = firstGrapheme((name ?? "").trim());
  if (g === "") return "?";
  // A name opening with ß keeps the first letter of its capital form ("S").
  return singleCapital(g) ?? firstGrapheme(g.toLocaleUpperCase("en-US"));
}
