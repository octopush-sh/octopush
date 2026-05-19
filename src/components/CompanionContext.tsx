import type { Budget, BudgetPeriod, BudgetScope, SpendSnapshot } from "../lib/types";

interface Props {
  tokensUsed: number;
  tokensLimit: number;
  unstaged: number;
  toolCalls: number;
  /** Active workspace id — for workspace-level spend lookups */
  workspaceId?: string;
  budgets?: Budget[];
  spend?: Record<string, SpendSnapshot>;
}

export function CompanionContext({
  tokensUsed,
  tokensLimit,
  unstaged,
  toolCalls,
  workspaceId,
  budgets = [],
  spend = {},
}: Props) {
  const pct = tokensLimit > 0 ? Math.min(100, (tokensUsed / tokensLimit) * 100) : 0;

  // Build spending rows: workspace > global, for each period that has a budget.
  const spendingRows = buildSpendingRows(budgets, spend, workspaceId ?? "");

  return (
    <section>
      <h3 className="border-b border-octo-hairline pb-2 font-mono text-[8px] uppercase tracking-[0.3em] text-octo-brass">
        Context
      </h3>
      <div className="mt-2 space-y-1.5 text-[11px] text-octo-sage">
        <Row label="tokens" value={`${formatThousands(tokensUsed)} / ${formatThousands(tokensLimit)}`} brass />
        <div
          className="h-[3px] rounded-sm"
          style={{ background: "var(--color-octo-hairline)" }}
        >
          <div
            className="h-full rounded-sm"
            style={{ width: `${pct}%`, background: "var(--color-octo-brass)" }}
          />
        </div>
        <Row label="unstaged" value={String(unstaged)} />
        <Row label="tool calls" value={String(toolCalls)} />
      </div>

      {/* Spending block */}
      <div className="mt-4">
        <h3 className="border-b border-octo-hairline pb-2 font-mono text-[8px] uppercase tracking-[0.3em] text-octo-brass">
          Spending
        </h3>
        {spendingRows.length === 0 ? (
          <div className="mt-2 text-[10px] text-octo-mute">
            <em className="font-serif">No budget configured · Configure in Settings · Usage</em>
          </div>
        ) : (
          <div className="mt-2 space-y-2.5">
            {spendingRows.map((row) => (
              <SpendRow key={row.key} row={row} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

interface SpendRowData {
  key: string;
  label: string;
  costUsd: number;
  limitUsd: number;
  period: string;
}

function buildSpendingRows(
  budgets: Budget[],
  spend: Record<string, SpendSnapshot>,
  workspaceId: string,
): SpendRowData[] {
  const rows: SpendRowData[] = [];
  const seen = new Set<string>();

  // Priority: workspace > global for each period
  const scopes: Array<{ scope: BudgetScope; scopeId: string }> = [];
  if (workspaceId) {
    scopes.push({ scope: "workspace", scopeId: workspaceId });
  }
  scopes.push({ scope: "global", scopeId: "" });

  for (const period of ["daily", "monthly"] as BudgetPeriod[]) {
    // Find the most specific budget for this period
    for (const { scope, scopeId } of scopes) {
      const budget = budgets.find(
        (b) => b.scopeType === scope && b.scopeId === scopeId && b.period === period,
      );
      if (!budget) continue; // try next scope

      const key = `${scope}:${scopeId}:${period}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const snap = spend[key];
      const periodLabel = period === "daily" ? "Today" : "Month";
      rows.push({
        key,
        label: `${periodLabel}`,
        costUsd: snap?.costUsd ?? 0,
        limitUsd: budget.limitUsd,
        period,
      });
      break; // only most specific for this period
    }
  }

  return rows;
}

function SpendRow({ row }: { row: SpendRowData }) {
  const pct = row.limitUsd > 0 ? Math.min(100, (row.costUsd / row.limitUsd) * 100) : 0;
  const barColor = pct >= 100
    ? "var(--color-octo-rouge)"
    : pct >= 80
    ? "var(--color-octo-warning, #d4a250)"
    : pct >= 50
    ? "var(--color-octo-warning, #d4a250)"
    : "var(--color-octo-brass)";

  return (
    <div>
      <div className="flex items-baseline justify-between text-[10px]">
        <span className="text-octo-sage">{row.label}</span>
        <span className="font-mono text-octo-ivory">
          ${row.costUsd.toFixed(2)} / ${row.limitUsd.toFixed(2)}
          <span className="ml-1 text-octo-mute">{pct.toFixed(0)}%</span>
        </span>
      </div>
      <div
        className="mt-1 h-[3px] rounded-sm"
        style={{ background: "var(--color-octo-hairline)" }}
      >
        <div
          className="h-full rounded-sm transition-all"
          style={{ width: `${pct}%`, background: barColor }}
        />
      </div>
    </div>
  );
}

function Row({ label, value, brass }: { label: string; value: string; brass?: boolean }) {
  return (
    <div className="flex items-baseline justify-between">
      <span>{label}</span>
      <span className={`font-mono text-[10px] ${brass ? "text-octo-brass" : "text-octo-ivory"}`}>
        {value}
      </span>
    </div>
  );
}

function formatThousands(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}
