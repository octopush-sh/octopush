import type { ChatMessage, ModelInfo } from "./types";
import type { RunEstimate, StageEstimate } from "./ipc";

/**
 * Heuristic ratio: assume the assistant's reply consumes ~30% of the input
 * token budget. Good enough for an inline cost hint; the user understands
 * it's an estimate (rendered with the "≈" prefix).
 */
const OUTPUT_RATIO = 0.3;

/** Cost in USD for a single chat turn against this model. */
export function estimatePerMessageCost(
  model: ModelInfo,
  inputTokens: number,
): number {
  if (inputTokens <= 0) return 0;
  const inputCost = (inputTokens / 1_000_000) * model.inputCostPerM;
  const outputCost =
    ((inputTokens * OUTPUT_RATIO) / 1_000_000) * model.outputCostPerM;
  return inputCost + outputCost;
}

/** "≈ $0.04" / "free" / "≈ <$0.01" — kept short so it fits inline. */
export function formatPerMessageCost(cost: number): string {
  if (cost === 0) return "free";
  if (cost < 0.01) return "≈ <$0.01";
  if (cost < 1) return `≈ $${cost.toFixed(2)}`;
  return `≈ $${cost.toFixed(1)}`;
}

/** Compact token count: "12k tokens" or "850 tokens". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tokens`;
  if (n >= 1000) return `${Math.round(n / 1000)}k tokens`;
  return `${n} tokens`;
}

/**
 * Estimate how many input tokens the NEXT chat turn will consume. Combines:
 *
 *   1. The most recent assistant message's `inputTokens` field — that's the
 *      authoritative size of the prompt that fed the previous reply and is
 *      our best proxy for the context that gets resent.
 *   2. Otherwise, a chars/4 estimate across every prior message.
 *   3. Plus chars/4 of whatever the user is currently typing.
 *
 * Returns 0 when there's nothing to estimate — callers should treat that as
 * "skip the cost preview, fall back to per-million rates".
 */
export function estimateNextTurnTokens(
  messages: ChatMessage[],
  pendingText: string,
): number {
  const pendingTokens =
    pendingText.trim().length === 0 ? 0 : Math.ceil(pendingText.length / 4);

  let historyTokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.inputTokens != null) {
      historyTokens = m.inputTokens;
      break;
    }
  }
  if (historyTokens === 0) {
    for (const m of messages) {
      historyTokens += Math.ceil((m.content?.length ?? 0) / 4);
    }
  }

  const total = historyTokens + pendingTokens;
  return total > 0 ? total : 0;
}

/**
 * Tooltip for spend whose model has no price: its real cost is unknown, so
 * it is left out of totals and savings rather than shown as free.
 */
export function unpricedTitle(models: string[]): string {
  const names = models.length > 0 ? models.join(", ") : "this model";
  return `No price for ${names} — its calls are not counted as spend or as savings. Add a price in Settings › Models, then re-price.`;
}

/**
 * The cost cell of one model in a usage table. A model whose calls are all
 * unpriced reads "unpriced", never "$0.00"; a model with some unpriced
 * calls keeps its priced figure and says so in the tooltip.
 */
export function modelCostCell(
  m: { model: string; costUsd: number; unpricedCalls?: number },
  fmt: (n: number) => string,
): { text: string; unpriced: boolean; title: string | undefined } {
  const unpricedCalls = m.unpricedCalls ?? 0;
  if (unpricedCalls <= 0) return { text: fmt(m.costUsd), unpriced: false, title: undefined };
  const calls = unpricedCalls === 1 ? "1 call" : `${unpricedCalls} calls`;
  if (m.costUsd === 0) return { text: "unpriced", unpriced: true, title: unpricedTitle([m.model]) };
  return { text: fmt(m.costUsd), unpriced: true, title: `${calls} unpriced — ${unpricedTitle([m.model])}` };
}

/**
 * A run's budget gate compares billed cost, and an unpriced stage bills $0 —
 * so a budget cannot stop spend it cannot see. "" when every stage is priced.
 */
export function budgetUnenforceableNote(unpricedStages: number): string {
  if (unpricedStages <= 0) return "";
  return `budget not enforceable: ${unpricedStages === 1 ? "1 stage" : `${unpricedStages} stages`} unpriced`;
}

/** "$0.40"; a positive amount under a cent reads "<$0.01", never "$0.00". */
export function formatEstimateUsd(n: number): string {
  if (n > 0 && n < 0.005) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

/** True when the estimate has stages and none of them is priced. */
function nothingPriced(e: RunEstimate): boolean {
  return (e.perStage?.length ?? 0) > 0 && e.perStage!.every((s) => s.lowUsd == null);
}

/** A low–high pair: "$0.40–$1.10", or one figure when both round alike. */
function rangeText(low: number, high: number): string {
  const lo = formatEstimateUsd(low);
  const hi = formatEstimateUsd(high);
  return lo === hi ? `~${lo}` : `${lo}–${hi}`;
}

/**
 * The launcher's estimate figure: "$0.40–$1.10" (p25–p75), "~$0.43" from a
 * single-figure estimate, or "unpriced" when no stage model has a price —
 * an unknown cost is never shown as $0.
 */
export function estimateRangeText(e: RunEstimate): string {
  if (nothingPriced(e)) return "unpriced";
  if (e.lowUsd == null || e.highUsd == null) return `~${formatEstimateUsd(e.estimateUsd)}`;
  return rangeText(e.lowUsd, e.highUsd);
}

/** "saves ~62% vs all-premium", or "" when there is nothing to save. */
export function estimateSavingsText(e: RunEstimate): string {
  if (e.baselineUsd <= 0) return "";
  const pct = Math.round((Math.max(0, e.baselineUsd - e.estimateUsd) / e.baselineUsd) * 100);
  return pct > 0 ? `saves ~${pct}% vs all-premium` : "";
}

function stageLine(s: StageEstimate): string {
  const head = [s.role, s.model, s.effort].filter(Boolean).join(" · ");
  if (s.lowUsd == null || s.highUsd == null) return `${head}  unpriced`;
  const basis = s.rough ? "rough" : `${s.samples} past run${s.samples === 1 ? "" : "s"}`;
  return `${head}  ${rangeText(s.lowUsd, s.highUsd)}  (${basis})`;
}

/**
 * The hover breakdown: one line per stage, then where the figures come
 * from. "" when the estimate carries no per-stage rows.
 */
export function estimateBreakdownTitle(e: RunEstimate): string {
  if (!e.perStage || e.perStage.length === 0) return "";
  const lines = e.perStage.map(stageLine);
  lines.push("");
  lines.push("Tokens from this Mac's recent completed runs of each role and effort, priced at the chosen model.");
  if (e.perStage.some((s) => s.rough && s.lowUsd != null)) {
    lines.push("Rough: fewer than 3 past runs, so a built-in guess for the role.");
  }
  if (e.perStage.some((s) => s.lowUsd == null)) {
    lines.push("Unpriced stages are not counted. Add a price in Settings › Models.");
  }
  return lines.join("\n");
}
