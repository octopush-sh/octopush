// Settings → Usage → Gateway — what the gateway billed the key against what
// the ledger recorded, for the page's period. Rendered only when a provider's
// base URL turned out to be an LLM gateway (LiteLLM today); a provider's own
// API has no such section. The gap is the point: Claude Code's service calls
// and prompt-cache upkeep are billed by the gateway but never written to its
// transcripts, so RUN can only account for the turns — and a gateway-side key
// budget is the one a 429 "budget exceeded" refers to.
import type { GatewayReconciliation } from "../../lib/types";
import { SectionLabel, Stat, formatTokens } from "./shared";

function usd(n: number): string {
  return `$${n.toFixed(n >= 100 ? 0 : 2)}`;
}

/** A budget reset instant as a short calendar date; the raw value when
 *  it does not parse. */
function resetDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  return `${Math.round((part / whole) * 100)}%`;
}

/** The one-line reading of the gap, for the eyebrow's right side. Pure so
 *  the wording is tested. */
export function gapSummary(r: GatewayReconciliation): string {
  if (r.basis === "key") return "running total only";
  if (r.unaccountedCostUsd < 0.005 && r.unaccountedRequests === 0) return "in step with the ledger";
  return `${usd(r.unaccountedCostUsd)} · ${pct(r.unaccountedCostUsd, r.gatewayCostUsd)} not in the ledger`;
}

/** The key budget line, when the gateway enforces one. Pure so the
 *  wording is tested. */
export function budgetLine(r: GatewayReconciliation): string | null {
  const g = r.gateway;
  if (g.keyMaxBudgetUsd == null) return null;
  const spent = g.keySpendUsd ?? 0;
  const over = spent >= g.keyMaxBudgetUsd;
  const reset = g.budgetResetAt ? ` · resets ${resetDate(g.budgetResetAt)}` : "";
  return `${over ? "Key budget exhausted" : "Key budget"} · ${usd(spent)} of ${usd(g.keyMaxBudgetUsd)}${reset}`;
}

export function GatewaySection({ report }: { report: GatewayReconciliation }) {
  const g = report.gateway;
  const budget = budgetLine(report);
  const over = g.keyMaxBudgetUsd != null && (g.keySpendUsd ?? 0) >= g.keyMaxBudgetUsd;
  const keyBasis = report.basis === "key";
  return (
    <div className="octo-fade-in mt-8 max-w-[860px]" data-testid="usage-gateway">
      <div className="flex items-baseline justify-between gap-3">
        <SectionLabel>
          Gateway · {g.label} · <span className="normal-case tracking-normal">{g.host}</span>
        </SectionLabel>
        <span
          className="octo-tabular mb-3 font-mono text-[9px] uppercase tracking-[0.2em]"
          style={{ color: report.unaccountedCostUsd >= 0.005 ? "var(--color-octo-brass)" : "var(--color-octo-mute)" }}
          data-testid="usage-gateway-gap"
        >
          {gapSummary(report)}
        </span>
      </div>

      {keyBasis ? (
        <div className="rounded-md border border-octo-hairline bg-octo-panel px-4 py-3">
          <div className="flex items-baseline justify-between text-[12px]">
            <span className="font-sans text-octo-sage">Key spend since its last reset</span>
            <span className="octo-tabular font-mono text-octo-ivory">{usd(report.gatewayCostUsd)}</span>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-3">
          <Stat
            label="Gateway billed"
            value={usd(report.gatewayCostUsd)}
            note={`${report.gatewayRequests.toLocaleString()} requests · ${formatTokens(report.gatewayTokens)} tokens`}
            title="Every successful request the gateway charged this key in the period, cache tokens included."
            testId="usage-gateway-billed"
          />
          <Stat
            label="In the ledger"
            value={usd(report.ledgerCostUsd)}
            note={`${report.ledgerCalls.toLocaleString()} calls · ${formatTokens(report.ledgerTokens)} tokens`}
            title="Octopush's rows for the models the gateway served: API calls it made itself, and the turns Claude Code wrote to its transcripts."
            testId="usage-gateway-ledger"
          />
          <Stat
            label="Not in the ledger"
            value={usd(report.unaccountedCostUsd)}
            note={`${report.unaccountedRequests.toLocaleString()} requests · ${pct(report.unaccountedCostUsd, report.gatewayCostUsd)} of billed`}
            title="Gateway minus ledger. Claude Code's service calls (titles, summaries) and its prompt-cache upkeep are billed here but never written to its transcripts."
            testId="usage-gateway-unaccounted"
          />
        </div>
      )}

      {budget && (
        <div
          className="mt-3 rounded-md border px-3 py-2 font-mono text-[10px] tracking-[0.02em]"
          style={{
            borderColor: over ? "var(--color-octo-rouge)" : "var(--color-octo-hairline)",
            background: "var(--color-octo-panel)",
            color: over ? "var(--color-octo-rouge)" : "var(--color-octo-sage)",
          }}
          data-testid="usage-gateway-budget"
          title="The budget the gateway enforces on this key. A 429 “budget exceeded” from the provider refers to this figure, not to an Octopush budget."
        >
          {budget}
          {g.keyAlias && <span className="text-octo-mute"> · {g.keyAlias}</span>}
        </div>
      )}

      {!keyBasis && report.byModel.length > 0 && (
        <ul className="mt-3 space-y-1.5" data-testid="usage-gateway-models">
          {report.byModel.map((m) => {
            const gap = Math.max(0, m.gatewayCostUsd - m.ledgerCostUsd);
            return (
              <li key={m.model} className="octo-rise-in rounded-md border border-octo-hairline bg-octo-panel px-3 py-2">
                <div className="flex items-baseline gap-3">
                  <span className="min-w-0 flex-1 truncate font-serif text-[13px] text-octo-ivory" title={m.model}>{m.model}</span>
                  <span className="octo-tabular shrink-0 font-mono text-[10px] text-octo-mute">
                    gateway {m.gatewayRequests.toLocaleString()} · ledger {m.ledgerCalls.toLocaleString()}
                  </span>
                  <span className="octo-tabular w-16 shrink-0 text-right font-mono text-[11px] text-octo-ivory">{usd(m.gatewayCostUsd)}</span>
                  <span
                    className="octo-tabular w-16 shrink-0 text-right font-mono text-[11px]"
                    style={{ color: gap >= 0.005 ? "var(--color-octo-brass)" : "var(--color-octo-mute)" }}
                    title="Gateway cost for this model minus the ledger's"
                  >
                    {gap >= 0.005 ? `+${usd(gap)}` : "—"}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {report.unmatchedRequests != null && report.unmatchedByModel.length > 0 && (
        <p className="mt-2 text-[11px] leading-[1.55] text-octo-mute" data-testid="usage-gateway-unmatched">
          {report.unmatchedRequests.toLocaleString()} gateway requests match no ledger row
          {report.unmatchedCostUsd != null ? ` (${usd(report.unmatchedCostUsd)})` : ""}:{" "}
          {report.unmatchedByModel
            .map((m) => `${m.requests.toLocaleString()} × ${m.model} ${usd(m.costUsd)}`)
            .join(" · ")}
          .
        </p>
      )}

      <p className="mt-2 text-[11px] leading-[1.55] text-octo-mute">
        RUN counts the turns Claude Code writes to its transcripts. The gateway also bills its service calls and prompt-cache upkeep, which leave no transcript.
        {report.ledgerOnlyModels.length > 0 && ` Not compared: ${report.ledgerOnlyModels.join(", ")}.`}
        {report.note && ` ${report.note}`}
      </p>
    </div>
  );
}
