/**
 * Colour maths shared by the surfaces that can't use `var(--…)`.
 *
 * Two consumers need real numbers rather than CSS variables: `stores/themeStore.ts`,
 * which derives alpha tokens from the active theme, and
 * `components/editor/atelierTheme.ts`, which feeds CodeMirror's `theme()` API.
 *
 * The search-match helpers live here because a highlight that works on onyx
 * does not automatically work on cream — contrast is a ratio of luminances, so
 * the same alpha reads very differently per palette and has to be solved.
 */

/** Parse `#rgb` or `#rrggbb` (with or without leading #) into an [r,g,b] tuple.
 *  Returns null for anything else, so callers can fall back to a static value
 *  rather than emit `rgba(NaN, NaN, NaN, …)`.
 *
 *  The 3-digit form matters because a hand-written ~/.octopush/theme.json is
 *  not validated anywhere: `"bg": "#fff"` is perfectly valid CSS, so the editor
 *  really would be white. Rejecting it would make `isDarkBackground` fall back
 *  to its `true` default and hand a white background CodeMirror's dark
 *  defaults — reinstating the exact bug that function exists to fix. */
export function hexToRgb(hex: string): [number, number, number] | null {
  const s = hex.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(s)) {
    // Each digit doubles: #abc === #aabbcc.
    return [
      parseInt(s[0] + s[0], 16),
      parseInt(s[1] + s[1], 16),
      parseInt(s[2] + s[2], 16),
    ];
  }
  if (/^[0-9a-f]{6}$/i.test(s)) {
    const n = parseInt(s, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  return null;
}

/** `#rrggbb` → `rgba(r, g, b, alpha)`. Passes the input through unchanged when
 *  it isn't a hex triplet, so a malformed token degrades to itself. */
export function rgba(hex: string, alpha: number): string {
  const c = hexToRgb(hex);
  if (!c) return hex;
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;
}

/** Linearise one sRGB channel, per WCAG 2.1. */
function channelLuminance(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** Relative luminance of an opaque colour, in [0, 1]. */
export function luminance(rgb: [number, number, number]): number {
  return (
    0.2126 * channelLuminance(rgb[0]) +
    0.7152 * channelLuminance(rgb[1]) +
    0.0722 * channelLuminance(rgb[2])
  );
}

/** WCAG contrast ratio between two opaque colours, in [1, 21]. */
export function contrastRatio(
  a: [number, number, number],
  b: [number, number, number],
): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Composite `fg` at `alpha` over the opaque `bg`. */
export function composite(
  fg: [number, number, number],
  alpha: number,
  bg: [number, number, number],
): [number, number, number] {
  return [
    Math.round(fg[0] * alpha + bg[0] * (1 - alpha)),
    Math.round(fg[1] * alpha + bg[1] * (1 - alpha)),
    Math.round(fg[2] * alpha + bg[2] * (1 - alpha)),
  ];
}

/** Contrast step a search-match wash must clear against the editor background
 *  to register as a highlight at all. 1.50 is the smallest step that stays
 *  legible in practice while costing the text on top of it the least — every
 *  wash compresses its foreground's contrast by ~34% at this target, and that
 *  penalty grows fast above it (~38% at a 1.60 step). */
export const MATCH_WASH_TARGET = 1.5;

/** Alpha the atelier accent needs to clear MATCH_WASH_TARGET on atelier onyx.
 *  Used as the fallback when a colour can't be parsed. */
const ATELIER_WASH_ALPHA = 0.235;

/**
 * Smallest alpha in [0.04, 0.60] at which `accent` over `bg` reaches
 * MATCH_WASH_TARGET contrast against `bg`.
 *
 * This is the whole reason the match tokens are computed rather than
 * hardcoded: one fixed alpha reads very differently per palette. The same
 * 23.5% is a 1.50 step against atelier's near-black onyx but only 1.35
 * against vellum's cream. Solving per theme lands on 23.5% for atelier
 * through 31% for vellum, so every theme gets an equally present highlight.
 */
export function solveMatchWashAlpha(accent: string, bg: string): number {
  const a = hexToRgb(accent);
  const b = hexToRgb(bg);
  if (!a || !b) return ATELIER_WASH_ALPHA;
  for (let alpha = 0.04; alpha <= 0.601; alpha += 0.005) {
    if (contrastRatio(composite(a, alpha, b), b) >= MATCH_WASH_TARGET) {
      return Math.round(alpha * 1000) / 1000;
    }
  }
  // Accent too close to the background to ever reach the target (no built-in
  // theme does this). Take the ceiling — the most visible wash available.
  return 0.6;
}

/** True when `bg` is dark enough that CodeMirror should apply its dark-mode
 *  defaults. Feeds `EditorView.theme`'s `dark` flag, which used to be
 *  hardcoded to true — wrong for the vellum light theme.
 *
 *  Decided by which extreme the colour contrasts with better, not by a
 *  luminance midpoint: `luminance < 0.5` sounds right but sits far too high,
 *  because luminance is not perceptually linear. It calls `#b0b0b0` — a light
 *  grey — dark, which would put a white caret on it. */
export function isDarkBackground(bg: string): boolean {
  const c = hexToRgb(bg);
  if (!c) return true;
  return contrastRatio(c, [255, 255, 255]) > contrastRatio(c, [0, 0, 0]);
}

/** Whether a string is a `#rrggbb` triplet this module can actually work with.
 *  Callers deriving an OPAQUE colour must check first: `rgba` passes malformed
 *  input straight through, which is harmless at 0.04–0.12 alpha but would turn
 *  a match wash into a solid slab over the code. */
export function isHexColor(value: string): boolean {
  return hexToRgb(value) !== null;
}
