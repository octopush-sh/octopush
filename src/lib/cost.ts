import type { ChatMessage, ModelInfo } from "./types";

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
