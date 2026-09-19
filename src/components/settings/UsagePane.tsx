// Settings → Usage — what the models cost, and where. One report over a
// chosen period (today / 7d / 30d / this month / custom), optionally one
// mode (Talk / Run / Review / Direct), read from the canonical spend ledger:
// headline figures, a per-mode split, a cost trend, where the spend went
// (workspaces and RUN sessions, by name, with a stacked per-mode bar), the
// models, and the prompt-token split behind the honest cache-hit ratio.
// Budgets and the CSV export live at the bottom. Charts read their colors
// from live theme tokens (useChartColors) so they follow the active theme.
import { useCallback, useEffect, useMemo, useState } from "react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { Plus, RefreshCw, X } from "lucide-react";
import { ipc } from "../../lib/ipc";
import { useBudgetsStore } from "../../stores/budgetsStore";
import type {
  Budget, BudgetPeriod, BudgetScope, SourceUsage, UsageBreakdown, UsageReport,
} from "../../lib/types";
import { ModalShell } from "../ModalShell";
import { Listbox } from "../controls/Listbox";
import { IconButton } from "../controls/IconButton";
import { pushToast } from "../Toasts";
import {
  PaneHeader, SectionLabel, Segments, Stat, Row, formatTokens, formatRelative, useChartColors,
  type ChartColors,
} from "./shared";

const POLL_MS = 10_000;
/** Pricing older than this gets the "refresh" nudge. */
const PRICING_STALE_DAYS = 14;

export type UsagePeriod = "today" | "7d" | "30d" | "month" | "custom";
export type UsageMode = "all" | "talk" | "run" | "review" | "direct";

const PERIODS: ReadonlyArray<{ value: UsagePeriod; label: string }> = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "month", label: "This month" },
  { value: "custom", label: "Custom" },
];

const MODES: ReadonlyArray<{ value: UsageMode; label: string }> = [
  { value: "all", label: "All" },
  { value: "talk", label: "Talk" },
  { value: "run", label: "Run" },
  { value: "review", label: "Review" },
  { value: "direct", label: "Direct" },
];

/** Display order and names for the ledger's surfaces. */
export const SURFACE_LABEL: Record<string, string> = {
  talk: "Talk",
  run: "Run",
  review: "Review",
  direct: "Direct",
  adhoc: "Ad hoc",
};
const SURFACE_ORDER = ["talk", "run", "review", "direct", "adhoc"];

function surfaceColor(surface: string, chart: ChartColors): string {
  // One stable hue per mode across every bar and legend on the page.
  const i = SURFACE_ORDER.indexOf(surface);
  return chart.series[(i < 0 ? SURFACE_ORDER.length : i) % chart.series.length];
}

function localMidnight(d: Date): Date {
  const m = new Date(d);
  m.setHours(0, 0, 0, 0);
  return m;
}

/** The [start, end] of a period as RFC3339 UTC strings, computed in the
 *  viewer's local calendar. Presets end now; a custom range spans whole
 *  local days. */
export function periodRange(
  period: UsagePeriod,
  custom: { from: string; to: string },
  now: Date = new Date(),
): { start: string; end: string } {
  if (period === "custom") {
    const from = new Date(`${custom.from}T00:00:00`);
    const to = new Date(`${custom.to}T23:59:59.999`);
    const ok = !Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime()) && from <= to;
    return ok
      ? { start: from.toISOString(), end: to.toISOString() }
      : periodRange("30d", custom, now);
  }
  const end = now.toISOString();
  const start = localMidnight(now);
  if (period === "7d") start.setDate(start.getDate() - 6);
  if (period === "30d") start.setDate(start.getDate() - 29);
  if (period === "month") start.setDate(1);
  return { start: start.toISOString(), end };
}

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function pricingAgeDays(refreshedAt: string | null, now: Date = new Date()): number | null {
  if (!refreshedAt) return null;
  const t = Date.parse(refreshedAt);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

function usd(n: number): string {
  return `$${n.toFixed(n >= 100 ? 0 : 2)}`;
}

function hitPct(slice: { cacheHitPct: number | null; cacheTracked: boolean }): string {
  return slice.cacheHitPct == null ? "—" : `${slice.cacheHitPct.toFixed(0)}%`;
}

const HIT_TITLE =
  "Share of prompt tokens read from cache: cache read ÷ (input + cache read + cache write). A cache write is a miss. “—” when the provider reported no cache data.";

function bucketLabel(bucket: string, kind: "hour" | "day"): string {
  if (kind === "hour") return bucket.slice(11, 16);
  const d = new Date(`${bucket}T00:00:00`);
  return Number.isNaN(d.getTime()) ? bucket : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function UsagePane() {
  const { budgets, spend, loadAll: loadBudgets, refreshAllSpend } = useBudgetsStore();
  const chart = useChartColors();

  const [period, setPeriod] = useState<UsagePeriod>("30d");
  const [custom, setCustom] = useState(() => {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - 29);
    return { from: isoDate(from), to: isoDate(to) };
  });
  const [mode, setMode] = useState<UsageMode>("all");
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [breakdown, setBreakdown] = useState<UsageBreakdown | null>(null);

  // The range is computed on every load, never memoised: a preset ends
  // *now*, so each 10s poll must move its end (and "today" must roll over
  // at midnight) or new spend would never appear.
  const load = useCallback(async () => {
    const range = periodRange(period, custom);
    try {
      const r = await ipc.getUsageReport(
        range.start,
        range.end,
        mode === "all" ? null : mode,
        -new Date().getTimezoneOffset(),
      );
      setReport(r);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
    // Cloud vs local is a side figure; a failure just hides it.
    ipc.getUsageBreakdown(range.start, range.end).then(setBreakdown).catch(() => {});
  }, [period, custom, mode]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    loadBudgets();
  }, [loadBudgets]);

  // ── Pricing freshness ──
  const [refreshingPricing, setRefreshingPricing] = useState(false);
  async function handleRefreshPricing() {
    setRefreshingPricing(true);
    try {
      const r = await ipc.refreshPricing();
      pushToast({ level: "success", title: "Pricing refreshed", body: `${r.modelsUpdated} of ${r.modelsTotal} models updated` });
      await load();
    } catch (e) {
      pushToast({ level: "error", title: "Pricing refresh failed", body: String(e) });
    } finally {
      setRefreshingPricing(false);
    }
  }

  // ── CSV export of the selected period ──
  const [exporting, setExporting] = useState(false);
  async function handleExport() {
    setExporting(true);
    try {
      const range = periodRange(period, custom);
      const csv = await ipc.exportTokenEventsCsv(range.start, range.end);
      const { save } = await import("@tauri-apps/plugin-dialog");
      const dateStr = range.end.slice(0, 10).replace(/-/g, "");
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

  const pricingAge = pricingAgeDays(report?.pricingRefreshedAt ?? null);
  const pricingStale = report != null && (pricingAge == null || pricingAge >= PRICING_STALE_DAYS);

  const surfaces = useMemo(() => {
    if (!report) return [];
    return [...report.bySurface].sort(
      (a, b) => SURFACE_ORDER.indexOf(a.surface) - SURFACE_ORDER.indexOf(b.surface),
    );
  }, [report]);
  const surfacesPresent = useMemo(() => {
    const set = new Set<string>();
    for (const s of report?.bySource ?? []) for (const x of s.surfaces) if (x.costUsd > 0) set.add(x.surface);
    return SURFACE_ORDER.filter((s) => set.has(s));
  }, [report]);

  return (
    <>
      <PaneHeader
        eyebrow="Usage"
        title="What the models cost, and where."
        subtitle="Every billed call, by mode, model and workspace. Refreshes every 10 seconds."
      />

      {/* ── Period · mode ── */}
      <div className="flex max-w-[860px] flex-wrap items-center gap-x-6 gap-y-3">
        <Segments ariaLabel="Period" testId="usage-period" value={period} options={PERIODS} onChange={setPeriod} />
        {period === "custom" && (
          <div className="octo-fade-in flex items-center gap-2">
            <label htmlFor="usage-from" className="font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">From</label>
            <input
              id="usage-from"
              type="date"
              value={custom.from}
              max={custom.to}
              onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
              className="rounded border border-octo-border-strong bg-octo-onyx px-2 py-1 font-mono text-[11px] text-octo-ivory outline-none focus:border-octo-brass"
            />
            <label htmlFor="usage-to" className="font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">To</label>
            <input
              id="usage-to"
              type="date"
              value={custom.to}
              min={custom.from}
              onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
              className="rounded border border-octo-border-strong bg-octo-onyx px-2 py-1 font-mono text-[11px] text-octo-ivory outline-none focus:border-octo-brass"
            />
          </div>
        )}
        <Segments ariaLabel="Mode" testId="usage-mode" value={mode} options={MODES} onChange={setMode} className="ml-auto" />
      </div>

      {error && (
        <div className="mt-4 max-w-[860px] rounded-md border border-octo-hairline bg-octo-panel px-4 py-3 text-[12px] text-octo-rouge">
          {error}
        </div>
      )}

      {!report ? (
        <div className="mt-8 font-serif text-[13px] text-octo-mute">Reading the ledger…</div>
      ) : (
        <>
        {/* Analytics crossfade on a period/mode change; budgets and export
            sit outside the keyed subtree so an open budget dialog survives. */}
        <div key={`${period}-${mode}`} className="octo-fade-in">
          {/* ── Pricing freshness ── */}
          {pricingStale && (
            <div
              data-testid="usage-pricing-stale"
              className="mt-4 flex max-w-[860px] items-center gap-3 rounded-md border border-octo-hairline bg-octo-panel px-4 py-2.5"
            >
              <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: "var(--color-octo-warning)" }} />
              <span className="min-w-0 flex-1 text-[12px] text-octo-sage">
                {pricingAge == null
                  ? "The pricing catalog has never been refreshed — costs use the built-in table."
                  : `The pricing catalog was refreshed ${pricingAge} days ago — costs may be off.`}
              </span>
              <button
                type="button"
                onClick={() => void handleRefreshPricing()}
                disabled={refreshingPricing}
                className="flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 font-serif text-[12px] text-octo-brass transition disabled:opacity-50"
                style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
              >
                <RefreshCw size={11} className={refreshingPricing ? "animate-spin" : ""} />
                {refreshingPricing ? "Refreshing…" : "Refresh pricing"}
              </button>
            </div>
          )}

          {/* ── Headline ── */}
          <div className="mt-6 grid max-w-[860px] grid-cols-2 gap-3 md:grid-cols-4">
            <Stat
              label="Cost"
              value={usd(report.totals.costUsd)}
              note={`${report.totals.calls.toLocaleString()} calls · ${formatTokens(report.totals.inputTokens + report.totals.outputTokens)} tokens`}
              testId="usage-stat-cost"
            />
            <Stat
              label="Per active day"
              value={usd(report.perActiveDayUsd)}
              note={report.activeDays === 1 ? "1 day with spend" : `${report.activeDays} days with spend`}
              title="Cost in the period divided by the days that had any spend."
              testId="usage-stat-per-day"
            />
            <Stat label="Last 24 hours" value={usd(report.last24hUsd)} note="rolling, any period" testId="usage-stat-24h" />
            <Stat
              label="Cache hit"
              value={hitPct(report.totals)}
              note={report.totals.cacheTracked ? `${formatTokens(report.totals.cacheReadTokens)} read from cache` : "no cache data reported"}
              title={HIT_TITLE}
              testId="usage-stat-cache"
            />
          </div>

          {report.unpricedCalls > 0 && (
            <p className="mt-2 max-w-[860px] text-[11px] text-octo-mute">
              {report.unpricedCalls === 1 ? "1 call" : `${report.unpricedCalls} calls`} carried tokens but no price — a model the catalog does not know.
            </p>
          )}

          {/* ── By mode ── */}
          <div className="mt-8 max-w-[860px]">
            <SectionLabel>By mode</SectionLabel>
            {surfaces.length === 0 ? (
              <div className="font-serif text-[12px] text-octo-mute">Nothing billed in this period.</div>
            ) : (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4" data-testid="usage-by-mode">
                {surfaces.map((s) => {
                  const share = report.totals.costUsd > 0 ? (s.costUsd / report.totals.costUsd) * 100 : 0;
                  const active = mode === s.surface;
                  return (
                    <button
                      key={s.surface}
                      type="button"
                      aria-pressed={active}
                      title={active ? "Show every mode" : `Only ${SURFACE_LABEL[s.surface] ?? s.surface}`}
                      onClick={() => setMode(active ? "all" : (s.surface as UsageMode))}
                      className="octo-rise-in rounded-md border px-3 py-3 text-left transition-colors duration-[220ms]"
                      style={{
                        borderColor: active ? "var(--brass-dim)" : "var(--color-octo-hairline)",
                        background: active ? "var(--brass-ghost)" : "var(--color-octo-panel)",
                      }}
                    >
                      <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute">
                        <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: surfaceColor(s.surface, chart) }} />
                        {SURFACE_LABEL[s.surface] ?? s.surface}
                      </div>
                      <div className="octo-tabular mt-1.5 font-serif text-[18px] tracking-[-0.005em] text-octo-ivory">{usd(s.costUsd)}</div>
                      <div className="mt-2 h-[2px] rounded-sm" style={{ background: "var(--color-octo-hairline)" }} title={`${share.toFixed(0)}% of the period's cost`}>
                        <div className="h-full rounded-sm transition-[width] duration-[320ms]" style={{ width: `${share}%`, background: surfaceColor(s.surface, chart) }} />
                      </div>
                      <div className="octo-tabular mt-2 font-mono text-[10px] text-octo-mute">
                        {s.calls.toLocaleString()} calls · {formatTokens(s.inputTokens + s.outputTokens)} · <span title={HIT_TITLE}>hit {hitPct(s)}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* ── Trend ── */}
          {report.trend.length > 0 && (
            <div className="mt-8 max-w-[860px]">
              <SectionLabel>{report.trendBucket === "hour" ? "Cost by hour" : "Cost by day"}</SectionLabel>
              <div className="h-40 rounded-md border border-octo-hairline bg-octo-panel p-3">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={report.trend}>
                    <defs>
                      <linearGradient id="grad-cost-brass" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={chart.accent} stopOpacity={0.5} />
                        <stop offset="95%" stopColor={chart.accent} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <XAxis
                      dataKey="bucket"
                      tickFormatter={(b: string) => bucketLabel(b, report.trendBucket)}
                      tick={{ fill: chart.mute, fontSize: 9 }}
                      axisLine={false}
                      tickLine={false}
                      minTickGap={24}
                    />
                    <YAxis hide />
                    <Tooltip
                      contentStyle={tooltipStyle(chart)}
                      labelFormatter={(b) => bucketLabel(String(b), report.trendBucket)}
                      formatter={(v, _name, item) => {
                        const tokens = (item?.payload as { tokens?: number } | undefined)?.tokens ?? 0;
                        return [`$${Number(v).toFixed(2)} · ${formatTokens(tokens)} tokens`, "Cost"];
                      }}
                    />
                    <Area type="monotone" dataKey="costUsd" stroke={chart.accent} fill="url(#grad-cost-brass)" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* ── Where it went ── */}
          {report.bySource.length > 0 && (
            <div className="mt-8 max-w-[860px]">
              <div className="mb-3 flex items-center justify-between gap-4">
                <SectionLabel>Where it went</SectionLabel>
                {surfacesPresent.length > 1 && (
                  <div className="mb-3 flex items-center gap-3 font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">
                    {surfacesPresent.map((s) => (
                      <span key={s} className="flex items-center gap-1.5">
                        <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: surfaceColor(s, chart) }} />
                        {SURFACE_LABEL[s] ?? s}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <ul className="space-y-1.5" data-testid="usage-sources">
                {report.bySource.map((s) => (
                  <SourceRow key={s.id} source={s} max={report.bySource[0].costUsd} chart={chart} />
                ))}
              </ul>
            </div>
          )}

          {/* ── By model ── */}
          {report.byModel.length > 0 && (
            <div className="mt-8 max-w-[860px]">
              <SectionLabel>By model</SectionLabel>
              <ul className="space-y-1.5" data-testid="usage-models">
                {report.byModel.map((m) => {
                  const share = report.totals.costUsd > 0 ? (m.costUsd / report.totals.costUsd) * 100 : 0;
                  return (
                    <li key={m.model} className="octo-rise-in rounded-md border border-octo-hairline bg-octo-panel px-3 py-2">
                      <div className="flex items-baseline gap-3">
                        <span className="min-w-0 flex-1 truncate font-serif text-[13px] text-octo-ivory" title={m.model}>{m.model}</span>
                        <span className="octo-tabular shrink-0 font-mono text-[10px] text-octo-mute">
                          {m.calls.toLocaleString()} calls · {formatTokens(m.inputTokens + m.outputTokens)} · <span title={HIT_TITLE}>hit {hitPct(m)}</span>
                        </span>
                        <span className="octo-tabular w-16 shrink-0 text-right font-mono text-[11px] text-octo-ivory">{usd(m.costUsd)}</span>
                      </div>
                      <div className="mt-1.5 h-[2px] rounded-sm" style={{ background: "var(--color-octo-hairline)" }} title={`${share.toFixed(0)}% of the period's cost`}>
                        <div className="h-full rounded-sm transition-[width] duration-[320ms]" style={{ width: `${share}%`, background: "var(--color-octo-brass)" }} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* ── Prompt tokens ── */}
          <div className="mt-8 max-w-[860px]">
            <SectionLabel>Tokens</SectionLabel>
            <div className="space-y-1.5 rounded-md border border-octo-hairline bg-octo-panel px-4 py-3 text-[12px]">
              <Row label="Input, uncached" value={formatTokens(report.totals.inputTokens)} />
              <Row label="Cache read" value={formatTokens(report.totals.cacheReadTokens)} />
              <Row label="Cache write" value={formatTokens(report.totals.cacheCreationTokens)} />
              <Row label="Output" value={formatTokens(report.totals.outputTokens)} />
            </div>
            <p className="mt-2 text-[11px] leading-[1.55] text-octo-mute">
              Cache hit is cache read over all prompt tokens (input + cache read + cache write). A write is a miss: it is billed at a premium and only pays off when a later call reads it.
            </p>
          </div>

          {breakdown && breakdown.localTokens > 0 && (
            <div className="mt-8 max-w-[860px]">
              <SectionLabel>Cloud vs local</SectionLabel>
              <div className="grid grid-cols-3 gap-3">
                <Stat label="Cloud spend" value={usd(breakdown.cloudCostUsd)} />
                <Stat label="Local volume" value={formatTokens(breakdown.localTokens)} />
                <Stat label="Est. savings" value={`≈ ${usd(breakdown.estimatedLocalSavingsUsd)}`} title="Local tokens priced at the cheapest enabled cloud model." />
              </div>
            </div>
          )}

        </div>

          {/* ── Budgets ── */}
          <div className="mt-8 max-w-[860px]">
            <BudgetsSection budgets={budgets} spend={spend} onRefresh={refreshAllSpend} />
          </div>

          {/* ── Export ── */}
          <div className="mt-8 max-w-[860px]">
            <SectionLabel>Export ledger</SectionLabel>
            <div className="flex items-center gap-3 rounded-md border border-octo-hairline bg-octo-panel px-4 py-3">
              <span className="min-w-0 flex-1 text-[12px] text-octo-sage">
                Every billed call in the selected period, as CSV.
              </span>
              <button
                type="button"
                onClick={handleExport}
                disabled={exporting}
                className="rounded-md px-4 py-1.5 font-serif text-[13px] text-octo-brass transition disabled:opacity-50"
                style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
              >
                {exporting ? "Exporting…" : "Export CSV"}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}

/** One workspace / RUN session: full name (never an id when a name exists),
 *  what it is, a stacked per-mode bar relative to the top spender, cost. */
function SourceRow({ source, max, chart }: { source: SourceUsage; max: number; chart: ChartColors }) {
  const width = max > 0 ? (source.costUsd / max) * 100 : 0;
  const kind =
    source.kind === "workspace"
      ? source.project ? `workspace · ${source.project}` : "workspace"
      : source.kind === "session"
        ? "run session"
        : "unattributed";
  const lastMs = Date.parse(source.lastTs);
  return (
    <li className="octo-rise-in rounded-md border border-octo-hairline bg-octo-panel px-3 py-2" data-testid="usage-source">
      <div className="flex items-baseline gap-3">
        <span className="min-w-0 flex-1 truncate font-serif text-[13px] text-octo-ivory" title={source.label}>
          {source.label}
        </span>
        <span className="octo-tabular shrink-0 font-mono text-[10px] text-octo-mute">
          {source.calls.toLocaleString()} calls · {formatTokens(source.inputTokens + source.outputTokens)} · <span title={HIT_TITLE}>hit {hitPct(source)}</span>
        </span>
        <span className="octo-tabular w-16 shrink-0 text-right font-mono text-[11px] text-octo-ivory">{usd(source.costUsd)}</span>
      </div>
      <div className="mt-0.5 flex items-baseline gap-2 font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">
        <span>{kind}</span>
        {!Number.isNaN(lastMs) && <span className="tracking-normal normal-case">· last {formatRelative(lastMs)}</span>}
      </div>
      <div className="mt-1.5 flex h-[3px] overflow-hidden rounded-sm" style={{ width: `${width}%`, minWidth: source.costUsd > 0 ? 2 : 0, background: "var(--color-octo-hairline)" }}>
        {source.surfaces.map((s) => (
          <span
            key={s.surface}
            title={`${SURFACE_LABEL[s.surface] ?? s.surface} ${usd(s.costUsd)}`}
            className="h-full transition-[width] duration-[320ms]"
            style={{ width: `${source.costUsd > 0 ? (s.costUsd / source.costUsd) * 100 : 0}%`, background: surfaceColor(s.surface, chart) }}
          />
        ))}
      </div>
    </li>
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
                    className="w-full rounded-md border border-octo-border-strong bg-octo-onyx px-3 py-2 font-mono text-[12px] text-octo-ivory outline-none placeholder:text-octo-mute focus:border-octo-brass"
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
                  className="w-full rounded-md border border-octo-border-strong bg-octo-onyx px-3 py-2 font-mono text-[12px] text-octo-ivory outline-none placeholder:text-octo-mute focus:border-octo-brass"
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
