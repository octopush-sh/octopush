import { Wand2, Server } from "lucide-react";
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
  /** Active skill for the conversation, if any (capabilities section). */
  activeSkill?: string | null;
  /** Connected MCP servers for the workspace (capabilities section). */
  mcpServers?: string[];
  /** Jump to Review mode (e.g. clicking the unstaged-changes row). */
  onReviewClick?: () => void;
  /** Open Settings (e.g. clicking a spending row to manage budgets). */
  onSettingsClick?: () => void;
}

export function CompanionContext({
  tokensUsed,
  tokensLimit,
  unstaged,
  toolCalls,
  workspaceId,
  budgets = [],
  spend = {},
  activeSkill,
  mcpServers = [],
  onReviewClick,
  onSettingsClick,
}: Props) {
  const pct = tokensLimit > 0 ? Math.min(100, (tokensUsed / tokensLimit) * 100) : 0;
  // Warn as the context window fills — amber past 80%, rouge past 95%.
  const tokenColor =
    pct >= 95
      ? "var(--color-octo-rouge)"
      : pct >= 80
        ? "var(--color-octo-warning)"
        : "var(--color-octo-brass)";

  // Build spending rows: workspace > global, for each period that has a budget.
  const spendingRows = buildSpendingRows(budgets, spend, workspaceId ?? "");
  const hasCapabilities = !!activeSkill || mcpServers.length > 0;

  return (
    <section className="border-t border-octo-hairline">
      {/* Canonical eyebrow bar — full-bleed, converges on the
          CompanionFileTree/CompanionHistory chrome. */}
      <div className="flex h-11 shrink-0 items-center border-b border-octo-hairline px-4">
        <h3 className="font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass">
          Context
        </h3>
      </div>
      <div className="px-4 py-3">
        <div className="space-y-1.5 text-[11px] text-octo-sage">
          <Row
            label="tokens"
            value={`${formatThousands(tokensUsed)} / ${formatThousands(tokensLimit)}`}
            valueColor={tokenColor}
            title={
              pct >= 80
                ? `${Math.round(pct)}% of the context window used — consider a new conversation`
                : undefined
            }
          />
          <div
            className="h-[3px] rounded-sm"
            style={{ background: "var(--color-octo-hairline)" }}
          >
            <div
              className="h-full rounded-sm transition-[width] duration-[220ms]"
              style={{ width: `${pct}%`, background: tokenColor }}
            />
          </div>
          <Row
            label="unstaged"
            value={String(unstaged)}
            onClick={unstaged > 0 ? onReviewClick : undefined}
            title={unstaged > 0 && onReviewClick ? "Review changes" : undefined}
          />
          <Row label="tool calls" value={String(toolCalls)} />
        </div>

        {/* Capabilities — the skill + MCP tools this conversation can use. Only
            rendered when there's something to show (minimalism). */}
        {hasCapabilities && (
          <div className="octo-rise-in mt-4">
            <h4 className="font-mono text-[9px] uppercase tracking-[0.3em] text-octo-mute">
              Capabilities
            </h4>
            <div className="mt-2 flex flex-col gap-1.5">
              {activeSkill && (
                <span className="flex items-center gap-1.5 text-[10px] text-octo-sage">
                  <Wand2 size={11} className="shrink-0 text-octo-brass" />
                  <span className="font-mono text-octo-ivory">{activeSkill}</span>
                  <span className="text-octo-mute">skill</span>
                </span>
              )}
              {mcpServers.map((s) => (
                <span key={s} className="flex items-center gap-1.5 text-[10px] text-octo-sage">
                  <Server size={11} className="shrink-0 text-octo-brass" />
                  <span className="font-mono text-octo-ivory">{s}</span>
                  <span className="text-octo-mute">MCP</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Spending block — rendered only when a budget exists (an empty section
            earns no space); `octo-rise-in` makes it appear smoothly rather than
            popping in. Budget setup lives in Settings. */}
        {spendingRows.length > 0 && (
          <div className="octo-rise-in mt-4">
            <h4 className="font-mono text-[9px] uppercase tracking-[0.3em] text-octo-mute">
              Spending
            </h4>
            <div className="mt-2 space-y-2.5">
              {spendingRows.map((row) => (
                <SpendRow key={row.key} row={row} onClick={onSettingsClick} />
              ))}
            </div>
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

function SpendRow({ row, onClick }: { row: SpendRowData; onClick?: () => void }) {
  const pct = row.limitUsd > 0 ? Math.min(100, (row.costUsd / row.limitUsd) * 100) : 0;
  const barColor = pct >= 100
    ? "var(--color-octo-rouge)"
    : pct >= 80
    ? "var(--color-octo-warning)"
    : "var(--color-octo-brass)";

  const body = (
    <>
      <div className="flex items-baseline justify-between text-[10px]">
        <span className="text-octo-sage">{row.label}</span>
        <span className="font-mono text-octo-ivory">
          ${row.costUsd.toFixed(2)} / ${row.limitUsd.toFixed(2)}
        </span>
      </div>
      <div
        className="mt-1 h-[3px] rounded-sm"
        style={{ background: "var(--color-octo-hairline)" }}
      >
        <div
          className="h-full rounded-sm transition-[width] duration-[220ms]"
          style={{ width: `${pct}%`, background: barColor }}
        />
      </div>
    </>
  );

  if (!onClick) return <div>{body}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      title="Manage budgets in Settings"
      className="w-full rounded text-left transition-colors hover:bg-[var(--brass-ghost)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
    >
      {body}
    </button>
  );
}

function Row({
  label,
  value,
  valueColor,
  onClick,
  title,
}: {
  label: string;
  value: string;
  valueColor?: string;
  onClick?: () => void;
  title?: string;
}) {
  const content = (
    <>
      <span>{label}</span>
      <span
        className="font-mono text-[10px]"
        style={{ color: valueColor ?? "var(--color-octo-ivory)" }}
      >
        {value}
      </span>
    </>
  );
  if (!onClick) {
    return (
      <div className="flex items-baseline justify-between" title={title}>
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="flex w-full items-baseline justify-between rounded px-1 -mx-1 text-left transition-colors hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
    >
      {content}
    </button>
  );
}

function formatThousands(n: number): string {
  // Millions branch matters: the target model has a 1M context window, which
  // must read "1M", not "1000k".
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}
