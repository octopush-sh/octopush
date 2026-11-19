// Shared stage display helpers for the Direct mode surfaces (builder, launcher,
// run view). Kept framework-free so any component can import them without
// pulling in a heavy component module.

import { useRolesStore } from "../stores/rolesStore";

/** Compact token count — the single format across every Direct surface:
 *  1240 → "1.2k", 980 → "980". */
export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** Tighter still, for the 150px essence card: no decimal from 10k up
 *  (18 412 → "18k"), millions as "1.2M". Under 10k it reads as `fmtTokens`.
 *  Not `formatTokenCount` (lib/cost.ts): that one drops the decimal below 10k
 *  too, while the essence card keeps "3.1k" so it agrees with the focus pane. */
export function fmtTokensShort(n: number): string {
  if (n >= 999_500) return `${(n / 1_000_000).toFixed(1)}M`;
  // From 9 950 up, since `fmtTokens` would round those to "10.0k".
  if (n >= 9_950) return `${Math.round(n / 1000)}k`;
  return fmtTokens(n);
}

/** Characters of meta that fit on the essence card's one line: 150px less
 *  padding and border is 120px, 20ch of 10px mono, minus the row's two 8px gaps. */
export const ESSENCE_META_CH = 17;

/** The essence card's ladder (S1, E2): position and cost are the floor; the
 *  token pair is the one rung, shed whole when the line would overflow. */
export function essenceShedsTokens(position: string, cost: string, tokens: string): boolean {
  return position.length + cost.length + tokens.length > ESSENCE_META_CH;
}

/** The role's display label — read from the loaded roles store (falls back to
 *  the key itself when roles have not yet loaded or the key is unknown). */
export function labelForRole(role: string): string {
  return useRolesStore.getState().roles.find((r) => r.key === role)?.label ?? role;
}

/** A stage's display title: the author's custom name when set, else the
 *  archetype label — so every Direct surface shows the names chosen in the
 *  builder. */
export function stageTitle(s: { role: string; customName?: string | null }): string {
  const custom = s.customName?.trim();
  return custom && custom.length > 0 ? custom : labelForRole(s.role);
}
