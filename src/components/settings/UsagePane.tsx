// Settings → Usage — budgets, spend stats, trend charts, and CSV export. Charts
// read their colors from live theme tokens (useChartColors) so they follow the
// active theme instead of hardcoding the Atelier hexes.
import { useEffect, useState } from "react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell,
} from "recharts";
import { Plus, X } from "lucide-react";
import { ipc } from "../../lib/ipc";
import { useTokenStore } from "../../stores/tokenStore";
import { useBudgetsStore } from "../../stores/budgetsStore";
import type { Budget, BudgetPeriod, BudgetScope, UsageBreakdown } from "../../lib/types";
import { ModalShell } from "../ModalShell";
import { Listbox } from "../controls/Listbox";
import { IconButton } from "../controls/IconButton";
import { pushToast } from "../Toasts";
import {
  PaneHeader, SectionLabel, Stat, Row, formatTokens, useChartColors, type ChartColors,
} from "./shared";

const POLL_MS = 10_000;

export function UsagePane() {
  const { report, refresh } = useTokenStore();
  const { budgets, spend, loadAll: loadBudgets, refreshAllSpend } = useBudgetsStore();
  const [breakdown, setBreakdown] = useState<UsageBreakdown | null>(null);
  const chart = useChartColors();

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    loadBudgets();
  }, [loadBudgets]);

  // Fetch cloud/local breakdown for the rolling 30-day window.
  useEffect(() => {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 30);
    const startIso = start.toISOString();
    const endIso = end.toISOString();
    ipc.getUsageBreakdown(startIso, endIso)
      .then(setBreakdown)
      .catch(() => {}); // non-fatal: breakdown cards stay hidden
    const id = setInterval(() => {
      ipc.getUsageBreakdown(startIso, endIso).then(setBreakdown).catch(() => {});
    }, POLL_MS);
    return () => clearInterval(id);
  }, []);

  // CSV export state
  const [exportStart, setExportStart] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  });
  const [exportEnd, setExportEnd] = useState(() => new Date().toISOString().slice(0, 10));
  const [exporting, setExporting] = useState(false);

  async function handleExport() {
    setExporting(true);
    try {
      const startIso = `${exportStart}T00:00:00Z`;
      const endIso = `${exportEnd}T23:59:59Z`;
      const csv = await ipc.exportTokenEventsCsv(startIso, endIso);

      const { save } = await import("@tauri-apps/plugin-dialog");
      const dateStr = exportEnd.replace(/-/g, "");
      const pickedPath = await save({
        defaultPath: `octopush-usage-${dateStr}.csv`,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (pickedPath) {
        await ipc.writeFile(pickedPath as string, csv);
        pushToast({ level: "success", title: "Ledger exported", body: pickedPath as string });
      }
    } catch (e) {
      pushToast({ level: "error", title: "Export failed", body: String(e) });
    } finally {
      setExporting(false);
    }
  }

  if (!report) {
    return <PaneHeader eyebrow="Usage" title="Loading…" />;
  }

  const totalTokens = report.totalInput + report.totalOutput;
  const cacheHitPct = totalTokens > 0
    ? `${((report.totalCached / totalTokens) * 100).toFixed(0)}%`
    : "—";

  return (
    <>
      <PaneHeader
        eyebrow="Usage"
        title="Tokens and cost over time."
        subtitle="Live data refreshed every 10 seconds. Trend covers the last 24 hours."
      />

      {/* ── Budgets section ── */}
      <div className="mb-8 max-w-[800px]">
        <BudgetsSection budgets={budgets} spend={spend} onRefresh={refreshAllSpend} />
      </div>

      <div className="grid max-w-[800px] grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Cost" value={`$${report.totalCostUsd.toFixed(2)}`} />
        <Stat label="Tokens" value={formatTokens(totalTokens)} />
        <Stat label="Projected / day" value={`$${report.projectedDailyCost.toFixed(2)}`} />
        <Stat label="Cache hit" value={cacheHitPct} />
      </div>

      {breakdown && (
        <div className="mt-3 grid max-w-[800px] grid-cols-3 gap-3">
          <Stat label="Cloud spend · 30d" value={`$${breakdown.cloudCostUsd.toFixed(2)}`} />
          <Stat label="Local volume · 30d" value={formatTokens(breakdown.localTokens)} />
          <Stat label="Est. savings · 30d" value={`≈ $${breakdown.estimatedLocalSavingsUsd.toFixed(2)}`} />
        </div>
      )}

      {report.budgetRemaining != null && (
        <div className="mt-8 max-w-[800px]">
          <SectionLabel>Budget</SectionLabel>
          <BudgetGauge remaining={report.budgetRemaining} total={report.budgetRemaining + totalTokens} />
        </div>
      )}

      {report.hourlyTrend.length > 0 && (
        <div className="mt-8 max-w-[800px]">
          <SectionLabel>Burn rate · 24h</SectionLabel>
          <div className="h-40 rounded-md border border-octo-hairline bg-octo-panel p-3">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={report.hourlyTrend}>
                <defs>
                  <linearGradient id="grad-tokens-brass" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={chart.accent} stopOpacity={0.5} />
                    <stop offset="95%" stopColor={chart.accent} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="hour"
                  tickFormatter={(h: string) => h.slice(11, 16)}
                  tick={{ fill: chart.mute, fontSize: 9 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis hide />
                <Tooltip
                  contentStyle={tooltipStyle(chart)}
                  labelFormatter={(h) => String(h).slice(11, 16)}
                  formatter={(v) => [formatTokens(Number(v)), "Tokens"]}
                />
                <Area type="monotone" dataKey="tokens" stroke={chart.accent} fill="url(#grad-tokens-brass)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {report.costBySession.length > 0 && (
        <div className="mt-8 max-w-[800px]">
          <SectionLabel>Cost by session</SectionLabel>
          <div className="h-44 rounded-md border border-octo-hairline bg-octo-panel p-3">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={report.costBySession} layout="vertical" margin={{ left: 60 }}>
                <XAxis type="number" hide />
                <YAxis
                  type="category"
                  dataKey="label"
                  tick={{ fill: chart.sage, fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  width={56}
                />
                <Tooltip contentStyle={tooltipStyle(chart)} formatter={(v) => [`$${Number(v).toFixed(3)}`, "Cost"]} />
                <Bar dataKey="costUsd" radius={[0, 4, 4, 0]} barSize={14}>
                  {report.costBySession.map((_, i) => (
                    <Cell key={i} fill={chart.series[i % chart.series.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {report.costByModel.length > 0 && (
        <div className="mt-8 max-w-[800px]">
          <SectionLabel>Cost by model</SectionLabel>
          <ul className="space-y-2">
            {report.costByModel.map((m, i) => (
              <li
                key={m.label}
                className="flex items-center gap-3 rounded-md border border-octo-hairline bg-octo-panel px-3 py-2"
              >
                <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: chart.series[i % chart.series.length] }} />
                <span className="flex-1 truncate font-serif text-[13px] text-octo-ivory">{m.label}</span>
                <span className="octo-tabular font-mono text-[11px] text-octo-sage">${m.costUsd.toFixed(3)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-8 max-w-[800px]">
        <SectionLabel>Token breakdown</SectionLabel>
        <div className="space-y-1.5 rounded-md border border-octo-hairline bg-octo-panel px-4 py-3 text-[12px]">
          <Row label="Input" value={formatTokens(report.totalInput)} />
          <Row label="Output" value={formatTokens(report.totalOutput)} />
          <Row label="Cache read" value={formatTokens(report.totalCached)} />
        </div>
      </div>

      {/* ── CSV Export ── */}
      <div className="mt-8 max-w-[800px]">
        <SectionLabel>Export ledger</SectionLabel>
        <div className="flex items-center gap-3 rounded-md border border-octo-hairline bg-octo-panel px-4 py-3">
          <div className="flex items-center gap-2">
            <label htmlFor="usage-export-from" className="font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">From</label>
            <input
              id="usage-export-from"
              type="date"
              value={exportStart}
              onChange={(e) => setExportStart(e.target.value)}
              className="rounded border border-octo-hairline bg-octo-onyx px-2 py-1 font-mono text-[11px] text-octo-ivory outline-none focus:border-octo-brass"
            />
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="usage-export-to" className="font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">To</label>
            <input
              id="usage-export-to"
              type="date"
              value={exportEnd}
              onChange={(e) => setExportEnd(e.target.value)}
              className="rounded border border-octo-hairline bg-octo-onyx px-2 py-1 font-mono text-[11px] text-octo-ivory outline-none focus:border-octo-brass"
            />
          </div>
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting}
            className="ml-auto rounded-md px-4 py-1.5 font-serif text-[13px] text-octo-brass transition disabled:opacity-50"
            style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
          >
            {exporting ? "Exporting…" : "Export CSV"}
          </button>
        </div>
      </div>
    </>
  );
}

function tooltipStyle(chart: ChartColors): React.CSSProperties {
  return {
    background: chart.tooltipBg,
    border: `1px solid ${chart.hairline}`,
    borderRadius: 6,
    fontSize: 11,
    color: chart.ivory,
  };
}

// ─── Budgets section ──────────────────────────────────────────────────

type AddBudgetState = {
  scope: BudgetScope;
  scopeId: string;
  period: BudgetPeriod;
  limit: string;
};

function BudgetsSection({
  budgets,
  spend,
  onRefresh,
}: {
  budgets: Budget[];
  spend: Record<string, { costUsd: number; tokens: number }>;
  onRefresh: () => Promise<void>;
}) {
  const { setBudget, clearBudget } = useBudgetsStore();
  const [showAdd, setShowAdd] = useState(false);
  const [addState, setAddState] = useState<AddBudgetState>({
    scope: "global",
    scopeId: "",
    period: "daily",
    limit: "",
  });
  const [saving, setSaving] = useState(false);

  // Group budgets by scope
  const grouped = budgets.reduce<Record<string, Budget[]>>((acc, b) => {
    const key = `${b.scopeType}:${b.scopeId}`;
    if (!acc[key]) acc[key] = [];
    acc[key].push(b);
    return acc;
  }, {});

  async function handleSaveBudget() {
    const limitUsd = parseFloat(addState.limit);
    if (isNaN(limitUsd) || limitUsd <= 0) return;
    setSaving(true);
    try {
      await setBudget(addState.scope, addState.scopeId, addState.period, limitUsd);
      await onRefresh();
      setShowAdd(false);
      setAddState({ scope: "global", scopeId: "", period: "daily", limit: "" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div className="font-mono text-[9px] uppercase tracking-[0.3em] text-octo-mute">Budgets</div>
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-1.5 rounded-md px-2.5 py-1 font-serif text-[12px] text-octo-brass transition"
          style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
        >
          <Plus size={12} /> Add a budget
        </button>
      </div>

      {budgets.length === 0 ? (
        <div className="font-serif text-[12px] text-octo-mute">No budgets configured.</div>
      ) : (
        <div className="space-y-4">
          {Object.entries(grouped).map(([groupKey, groupBudgets]) => {
            const [scopeType, scopeId] = groupKey.split(":");
            const scopeLabel = scopeType === "global"
              ? "Global"
              : scopeType === "project"
              ? `Project · ${scopeId.slice(0, 8)}`
              : `Workspace · ${scopeId.slice(0, 8)}`;

            return (
              <div key={groupKey}>
                <div className="mb-1.5 font-serif text-[13px] text-octo-sage">{scopeLabel}</div>
                <div className="space-y-1.5 rounded-md border border-octo-hairline bg-octo-panel px-3 py-2">
                  {groupBudgets.map((b) => {
                    const key = `${b.scopeType}:${b.scopeId}:${b.period}`;
                    const snap = spend[key] ?? { costUsd: 0, tokens: 0 };
                    const pct = b.limitUsd > 0 ? Math.min(100, (snap.costUsd / b.limitUsd) * 100) : 0;
                    const barColor = pct >= 100
                      ? "var(--color-octo-rouge)"
                      : pct >= 80
                      ? "var(--color-octo-warning)"
                      : pct >= 50
                      ? "var(--brass-dim)"
                      : "var(--color-octo-brass)";

                    return (
                      <BudgetRow
                        key={key}
                        budget={b}
                        spentUsd={snap.costUsd}
                        pct={pct}
                        barColor={barColor}
                        onClear={async () => {
                          await clearBudget(b.scopeType as BudgetScope, b.scopeId, b.period as BudgetPeriod);
                          await onRefresh();
                        }}
                        onLimitChange={async (newLimit) => {
                          await setBudget(b.scopeType as BudgetScope, b.scopeId, b.period as BudgetPeriod, newLimit);
                          await onRefresh();
                        }}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add budget modal */}
      {showAdd && (
        <ModalShell onClose={() => setShowAdd(false)} ariaLabel="Add budget">
          <div className="w-[360px] rounded-xl border border-octo-hairline bg-octo-panel p-6 shadow-2xl">
            <div className="mb-4 font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass">Add Budget</div>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">Scope</label>
                <Listbox
                  ariaLabel="Budget scope"
                  className="w-full"
                  value={addState.scope}
                  onChange={(v) => setAddState((s) => ({ ...s, scope: v as BudgetScope, scopeId: "" }))}
                  options={[
                    { value: "global", label: "Global" },
                    { value: "workspace", label: "Workspace" },
                    { value: "project", label: "Project" },
                  ]}
                />
              </div>
              {addState.scope !== "global" && (
                <div>
                  <label className="mb-1 block font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">
                    {addState.scope === "workspace" ? "Workspace ID" : "Project ID"}
                  </label>
                  <input
                    type="text"
                    value={addState.scopeId}
                    onChange={(e) => setAddState((s) => ({ ...s, scopeId: e.target.value }))}
                    placeholder={`Enter ${addState.scope} id`}
                    className="w-full rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-mono text-[12px] text-octo-ivory outline-none placeholder:text-octo-mute focus:border-octo-brass"
                  />
                </div>
              )}
              <div>
                <label className="mb-1 block font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">Period</label>
                <Listbox
                  ariaLabel="Budget period"
                  className="w-full"
                  value={addState.period}
                  onChange={(v) => setAddState((s) => ({ ...s, period: v as BudgetPeriod }))}
                  options={[
                    { value: "daily", label: "Daily" },
                    { value: "monthly", label: "Monthly" },
                  ]}
                />
              </div>
              <div>
                <label className="mb-1 block font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">Limit (USD)</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={addState.limit}
                  onChange={(e) => setAddState((s) => ({ ...s, limit: e.target.value }))}
                  placeholder="5.00"
                  className="w-full rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-mono text-[12px] text-octo-ivory outline-none placeholder:text-octo-mute focus:border-octo-brass"
                />
              </div>
            </div>
            <div className="mt-5 flex items-center gap-3">
              <button
                type="button"
                onClick={handleSaveBudget}
                disabled={saving || !addState.limit}
                className="rounded-md px-4 py-2 font-serif text-[13px] text-octo-brass transition disabled:opacity-50"
                style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
              >
                {saving ? "Saving…" : "Save budget"}
              </button>
              <button
                type="button"
                onClick={() => setShowAdd(false)}
                className="text-[12px] text-octo-mute transition hover:text-octo-sage"
              >
                Cancel
              </button>
            </div>
          </div>
        </ModalShell>
      )}
    </div>
  );
}

function BudgetRow({
  budget,
  spentUsd,
  pct,
  barColor,
  onClear,
  onLimitChange,
}: {
  budget: Budget;
  spentUsd: number;
  pct: number;
  barColor: string;
  onClear: () => void;
  onLimitChange: (v: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(budget.limitUsd.toFixed(2));

  function commit() {
    const v = parseFloat(draft);
    if (!isNaN(v) && v > 0 && v !== budget.limitUsd) {
      onLimitChange(v);
    }
    setEditing(false);
  }

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="w-14 shrink-0 font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">
          {budget.period === "daily" ? "Daily" : "Monthly"}
        </span>
        {editing ? (
          <input
            type="number"
            min="0"
            step="0.01"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setEditing(false);
            }}
            autoFocus
            className="octo-tabular w-20 rounded border border-octo-brass bg-octo-onyx px-2 py-0.5 font-mono text-[11px] text-octo-ivory outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => { setDraft(budget.limitUsd.toFixed(2)); setEditing(true); }}
            className="octo-tabular w-20 rounded border border-octo-hairline px-2 py-0.5 text-left font-mono text-[11px] text-octo-ivory transition hover:border-octo-brass"
          >
            ${budget.limitUsd.toFixed(2)}
          </button>
        )}
        <span className="flex-1 text-octo-mute">
          Spent: <span className="octo-tabular text-octo-ivory">${spentUsd.toFixed(2)}</span>
          <span className="octo-tabular ml-1 text-octo-mute">{pct.toFixed(0)}%</span>
        </span>
        <IconButton label="Remove budget" danger onClick={onClear}>
          <X size={12} />
        </IconButton>
      </div>
      <div className="ml-16 h-[2px] rounded-sm" style={{ background: "var(--color-octo-hairline)" }}>
        <div className="h-full rounded-sm transition-[width]" style={{ width: `${pct}%`, background: barColor }} />
      </div>
    </div>
  );
}

function BudgetGauge({ remaining, total }: { remaining: number; total: number }) {
  const pct = total === 0 ? 0 : ((total - remaining) / total) * 100;
  const tint = pct > 90 ? "var(--color-octo-rouge)" : "var(--color-octo-brass)";
  return (
    <div className="rounded-md border border-octo-hairline bg-octo-panel px-4 py-3">
      <div className="mb-2 flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.25em] text-octo-mute">
        <span>Budget</span>
        <span className="octo-tabular">{pct.toFixed(0)}% used</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full" style={{ background: "var(--color-octo-hairline)" }}>
        <div className="h-full rounded-full transition-[width]" style={{ width: `${Math.min(pct, 100)}%`, background: tint }} />
      </div>
      <div className="octo-tabular mt-2 text-right font-mono text-[10px] text-octo-mute">
        {formatTokens(remaining)} remaining
      </div>
    </div>
  );
}
