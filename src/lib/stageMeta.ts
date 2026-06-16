// Shared stage display helpers for the Direct mode surfaces (builder, launcher,
// run view). Kept framework-free so any component can import them without
// pulling in a heavy component module.

import { useRolesStore } from "../stores/rolesStore";

export const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII"];

/** Compact token count — the single format across every Direct surface:
 *  1240 → "1.2k", 980 → "980". */
export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
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
