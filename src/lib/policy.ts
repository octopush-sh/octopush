// The Auto policy (economy director) as the frontend sees it, plus the tier
// arithmetic the crew card and the savings ledger share. Store-free so leaf
// components and tests import it without pulling Tauri listeners in.

/** The model id the composer sends to mean "the economy director decides":
 *  the backend runs the turn on the strong tier under the lean-context
 *  doctrine and sub-agents take their tier by role. */
export const AUTO_MODEL = "auto";

export const TIER_ORDER = ["fast", "balanced", "strong"] as const;
export type ModelTier = (typeof TIER_ORDER)[number];

/** The tier a configured model id is mapped to in Settings › Models, if any
 *  (the reverse of the tier map). */
export function tierOfModel(model: string | null | undefined, tiers: Record<string, string> | null | undefined): ModelTier | null {
  if (!model || !tiers) return null;
  for (const t of TIER_ORDER) if (tiers[t] === model) return t;
  return null;
}

/** Share of a crew's work per tier, by tokens: `[["fast", 72], ["strong", 28]]`
 *  in tier order, only the tiers present. Agents whose model maps to no tier
 *  count as "other". Empty when nothing has been billed yet. */
export function tierMix(
  agents: ReadonlyArray<{ tier: string | null; tokens: number }>,
): Array<[string, number]> {
  const totals = new Map<string, number>();
  let all = 0;
  for (const a of agents) {
    if (a.tokens <= 0) continue;
    const key = a.tier ?? "other";
    totals.set(key, (totals.get(key) ?? 0) + a.tokens);
    all += a.tokens;
  }
  if (all === 0) return [];
  // Largest-remainder rounding so the shares always sum to 100.
  const order: string[] = [...TIER_ORDER, "other"];
  const present = order.filter((t) => totals.has(t));
  const exact = present.map((t) => ((totals.get(t) ?? 0) / all) * 100);
  const floors = exact.map((x) => Math.floor(x));
  let left = 100 - floors.reduce((a, b) => a + b, 0);
  const byRemainder = exact
    .map((x, i) => [x - floors[i], i] as [number, number])
    .sort((a, b) => b[0] - a[0]);
  for (const [, i] of byRemainder) {
    if (left <= 0) break;
    floors[i] += 1;
    left -= 1;
  }
  return present.map((t, i) => [t, floors[i]] as [string, number]);
}

/** `72% fast · 28% strong` */
export function formatTierMix(mix: Array<[string, number]>): string {
  return mix.map(([t, pct]) => `${pct}% ${t}`).join(" · ");
}
