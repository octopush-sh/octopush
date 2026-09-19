import { useEffect, useMemo, useState } from "react";
import { useChatStore, type ToolExecution } from "../../stores/chatStore";
import { isAgentToolName } from "../../lib/agentTools";
import { ipc } from "../../lib/ipc";
import type { ChatMessage, ModelInfo, ProviderConfig } from "../../lib/types";

interface Props {
  workspaceId: string;
}

/** Cost of `tokens` against a model's per-million rates (input + output). */
function turnCost(model: ModelInfo, inTok: number, outTok: number): number {
  return (inTok / 1_000_000) * model.inputCostPerM + (outTok / 1_000_000) * model.outputCostPerM;
}

/** One billed unit of the conversation: an assistant turn or a sub-agent. */
export interface BilledUnit {
  kind: "turn" | "agent";
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Every billed unit in a thread: assistant rows plus resolved `Agent` rows
 *  (their spend is real and would otherwise be invisible to the ledger). */
export function billedUnits(messages: ChatMessage[]): BilledUnit[] {
  const out: BilledUnit[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.costUsd != null) {
      out.push({ kind: "turn", model: msg.model, inputTokens: msg.inputTokens ?? 0, outputTokens: msg.outputTokens ?? 0, costUsd: msg.costUsd });
      continue;
    }
    if (msg.role !== "tool") continue;
    try {
      const tool = JSON.parse(msg.content) as ToolExecution;
      if (isAgentToolName(tool.toolName) && tool.agent && tool.agent.costUsd > 0) {
        out.push({ kind: "agent", model: tool.agent.model, inputTokens: tool.agent.inputTokens, outputTokens: tool.agent.outputTokens, costUsd: tool.agent.costUsd });
      }
    } catch {
      /* not a tool row */
    }
  }
  return out;
}

/** What the same tokens would have cost on `baseline` (the all-strong or
 *  all-premium counterfactual) versus what was spent. */
export function ledgerFor(units: BilledUnit[], baseline: ModelInfo | null) {
  let spent = 0;
  let base = 0;
  let agentSpent = 0;
  for (const u of units) {
    spent += u.costUsd;
    if (u.kind === "agent") agentSpent += u.costUsd;
    if (baseline) base += turnCost(baseline, u.inputTokens, u.outputTokens);
  }
  const saved = Math.max(0, base - spent);
  const pct = base > 0 ? Math.round((saved / base) * 100) : 0;
  return { spent, baseline: base, saved, pct, agentSpent };
}

/**
 * Savings-first cost ledger for the active conversation (differentiator D2).
 *
 * Octopush lets you pick a model per turn and delegates legwork to tiered
 * sub-agents; this rewards thrift by showing what the conversation WOULD have
 * cost had every token run on the strong tier ("all-strong" — the model the
 * economy director itself runs on; the priciest configured model when no
 * strong tier is mapped) versus what it actually cost, sub-agents included.
 * Savings lead; spend is secondary — the same ethos as Direct mode's ledger,
 * adapted to chat. Renders nothing until there's at least one billed unit.
 */
export function SavingsLedger({ workspaceId }: Props) {
  const messages = useChatStore((s) => s.getMessages(workspaceId));
  const [catalog, setCatalog] = useState<ProviderConfig[]>([]);
  const [tiers, setTiers] = useState<Record<string, string>>({});
  useEffect(() => {
    ipc.listProviders().then(setCatalog).catch(() => {});
    ipc.getSettings().then((s) => setTiers(s.modelTiers ?? {})).catch(() => {});
  }, []);

  const ledger = useMemo(() => {
    // The strong tier defines "all-strong"; without one, the priciest
    // configured model defines "all-premium".
    let strong: ModelInfo | null = null;
    let priciest: ModelInfo | null = null;
    for (const p of catalog) {
      for (const m of p.models) {
        if (tiers.strong && m.id === tiers.strong) strong = m;
        const rate = m.inputCostPerM + m.outputCostPerM;
        if (!priciest || rate > priciest.inputCostPerM + priciest.outputCostPerM) {
          priciest = m;
        }
      }
    }
    const baseline = strong ?? priciest;
    const units = billedUnits(messages);
    return {
      ...ledgerFor(units, baseline),
      label: strong
        ? `saved vs all-strong · ${strong.displayName || strong.id}`
        : baseline
          ? `saved vs ${baseline.displayName || baseline.id}`
          : null,
    };
  }, [messages, catalog, tiers]);

  if (ledger.spent <= 0) return null;

  return (
    <section className="border-t border-octo-hairline">
      <div className="flex h-11 shrink-0 items-center border-b border-octo-hairline px-4">
        <h3 className="font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass">
          Conversation cost
        </h3>
      </div>
      <div className="space-y-1.5 px-4 py-3 text-[11px] text-octo-sage">
        {ledger.saved > 0 && ledger.label ? (
          <div className="flex items-baseline justify-between">
            <span>{ledger.label}</span>
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
        {ledger.agentSpent > 0 && (
          <div className="flex items-baseline justify-between">
            <span>of which sub-agents</span>
            <span className="octo-tabular font-mono text-octo-sage">${ledger.agentSpent.toFixed(3)}</span>
          </div>
        )}
      </div>
    </section>
  );
}
