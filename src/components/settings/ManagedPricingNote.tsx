// Settings → Usage: the one-line note shown while an organization's managed
// Claude Code settings carry a `modelPricing` table (#1111). Claude Code then
// reports its own figures (and trips `--max-budget-usd`) at those rates. A
// finished Claude Code Direct stage is booked at that figure; Talk, stopped,
// stalled or crashed stages and the savings baseline stay at list prices, so
// totals, budgets and savings can mix the two. Hidden otherwise.
import type { ManagedModelPricing } from "../../lib/ipc";

/** "0.85× every cost · own rates for claude-sonnet-4-6". */
export function managedPricingSummary(p: ManagedModelPricing): string {
  const ids = Object.keys(p.overrides);
  const parts: string[] = [];
  if (p.multiplier != null) parts.push(`${p.multiplier}× every cost`);
  if (ids.length === 1) parts.push(`own rates for ${ids[0]}`);
  else if (ids.length > 1) parts.push(`own rates for ${ids.length} models`);
  return parts.join(" · ");
}

/** The tooltip: each override row's rates, per million tokens. */
export function managedPricingRows(p: ManagedModelPricing): string {
  return Object.entries(p.overrides)
    .map(([id, r]) => `${id}: $${r.input} in · $${r.output} out · $${r.cacheRead} cache read · $${r.cacheWrite} cache write per MTok`)
    .join("\n");
}

export function ManagedPricingNote({ pricing }: { pricing: ManagedModelPricing | null }) {
  if (!pricing) return null;
  const rows = managedPricingRows(pricing);
  return (
    <p
      data-tour="usage-managed-pricing"
      data-testid="usage-managed-pricing"
      className="octo-fade-in mt-2 text-[11px] leading-[1.55] text-octo-mute"
      title={rows || undefined}
    >
      Your organization set Claude Code's rates on this Mac ({managedPricingSummary(pricing)}). Finished Claude Code
      stages are booked at Claude Code's own figure, which uses those rates, as does its --max-budget-usd cap; Talk,
      stopped or crashed stages and the savings baseline use list prices, so totals, budgets and savings can mix the
      two. Rates set from the admin console aren't visible to Octopush.
    </p>
  );
}
