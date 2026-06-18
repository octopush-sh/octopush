import { useEffect, useMemo, useState } from "react";
import { useChatStore } from "../../stores/chatStore";
import { ipc } from "../../lib/ipc";
import type { ModelInfo, ProviderConfig } from "../../lib/types";

interface Props {
  workspaceId: string;
}

/** Cost of `tokens` against a model's per-million rates (input + output). */
function turnCost(model: ModelInfo, inTok: number, outTok: number): number {
  return (inTok / 1_000_000) * model.inputCostPerM + (outTok / 1_000_000) * model.outputCostPerM;
}

/**
 * Savings-first cost ledger for the active conversation (differentiator D2).
 *
 * Octopush lets you pick a model per turn; this rewards thrift by showing what
 * the conversation WOULD have cost on the priciest available model ("all-
 * premium") versus what it actually cost. Savings lead; spend is secondary —
 * the same ethos as Direct mode's ledger, adapted to chat. Renders nothing
 * until there's at least one billed assistant turn.
 */
export function SavingsLedger({ workspaceId }: Props) {
  const messages = useChatStore((s) => s.getMessages(workspaceId));
  const [catalog, setCatalog] = useState<ProviderConfig[]>([]);
  useEffect(() => {
    ipc.listProviders().then(setCatalog).catch(() => {});
  }, []);

  const ledger = useMemo(() => {
    // The priciest configured model defines the "all-premium" baseline.
    let priciest: ModelInfo | null = null;
    for (const p of catalog) {
      for (const m of p.models) {
        const rate = m.inputCostPerM + m.outputCostPerM;
        if (!priciest || rate > priciest.inputCostPerM + priciest.outputCostPerM) {
          priciest = m;
        }
      }
    }
    let spent = 0;
    let baseline = 0;
    for (const msg of messages) {
      if (msg.role !== "assistant" || msg.costUsd == null) continue;
      spent += msg.costUsd;
      if (priciest && (msg.inputTokens != null || msg.outputTokens != null)) {
        baseline += turnCost(priciest, msg.inputTokens ?? 0, msg.outputTokens ?? 0);
      }
    }
    const saved = Math.max(0, baseline - spent);
    const pct = baseline > 0 ? Math.round((saved / baseline) * 100) : 0;
    return { spent, baseline, saved, pct, premium: priciest?.displayName ?? priciest?.id ?? null };
  }, [messages, catalog]);

  if (ledger.spent <= 0) return null;

  return (
    <section className="border-t border-octo-hairline">
      <div className="flex h-11 shrink-0 items-center border-b border-octo-hairline px-4">
        <h3 className="font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass">
          Conversation cost
        </h3>
      </div>
      <div className="space-y-1.5 px-4 py-3 text-[11px] text-octo-sage">
        {ledger.saved > 0 && ledger.premium ? (
          <div className="flex items-baseline justify-between">
            <span>saved vs {ledger.premium}</span>
            <span className="octo-tabular font-mono text-octo-verdigris">
              ${ledger.saved.toFixed(3)}
              <span className="px-1 text-octo-mute">·</span>
              {ledger.pct}%
            </span>
          </div>
        ) : null}
        <div className="flex items-baseline justify-between">
          <span>spent</span>
          <span className="octo-tabular font-mono text-octo-brass">
            ${ledger.spent.toFixed(3)}
          </span>
        </div>
      </div>
    </section>
  );
}
