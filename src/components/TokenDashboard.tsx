import { useEffect } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  Cell,
} from "recharts";
import { Coins, TrendingUp, Gauge, Zap } from "lucide-react";
import { useTokenStore } from "../stores/tokenStore";
import { clsx } from "clsx";

const POLL_MS = 10_000;

const PALETTE = [
  "#a78bfa",
  "#34d399",
  "#fbbf24",
  "#f87171",
  "#60a5fa",
  "#c084fc",
  "#f472b6",
  "#22d3ee",
];

export function TokenDashboard() {
  const { report, refresh } = useTokenStore();

  // Poll every 10s for updated stats.
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  if (!report) return null;

  const totalTokens = report.totalInput + report.totalOutput;

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col overflow-y-auto border-l border-octo-border bg-octo-panel">
      <header className="border-b border-octo-border px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <Coins size={14} className="text-octo-accent" />
          Token Dashboard
        </div>
      </header>

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-2 p-3">
        <StatCard
          icon={<Coins size={12} />}
          label="Total cost"
          value={`$${report.totalCostUsd.toFixed(2)}`}
        />
        <StatCard
          icon={<Zap size={12} />}
          label="Tokens"
          value={formatTokens(totalTokens)}
        />
        <StatCard
          icon={<TrendingUp size={12} />}
          label="Projected/day"
          value={`$${report.projectedDailyCost.toFixed(2)}`}
        />
        <StatCard
          icon={<Gauge size={12} />}
          label="Cache hits"
          value={
            totalTokens > 0
              ? `${((report.totalCached / totalTokens) * 100).toFixed(0)}%`
              : "—"
          }
        />
      </div>

      {/* Budget gauge */}
      {report.budgetRemaining != null && (
        <div className="px-4 pb-3">
          <BudgetGauge
            remaining={report.budgetRemaining}
            total={report.budgetRemaining + totalTokens}
          />
        </div>
      )}

      {/* Hourly trend */}
      {report.hourlyTrend.length > 0 && (
        <Section title="Burn rate (24h)">
          <div className="h-28">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={report.hourlyTrend}>
                <defs>
                  <linearGradient id="grad-tokens" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#a78bfa" stopOpacity={0.4} />
                    <stop offset="95%" stopColor="#a78bfa" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="hour"
                  tickFormatter={(h: string) => h.slice(11, 16)}
                  tick={{ fill: "#71717a", fontSize: 9 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis hide />
                <Tooltip
                  contentStyle={{
                    background: "#18181b",
                    border: "1px solid #27272a",
                    borderRadius: 8,
                    fontSize: 11,
                  }}
                  labelFormatter={(h) => String(h).slice(11, 16)}
                  formatter={(v) => [`${formatTokens(Number(v))}`, "Tokens"]}
                />
                <Area
                  type="monotone"
                  dataKey="tokens"
                  stroke="#a78bfa"
                  fill="url(#grad-tokens)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Section>
      )}

      {/* Cost by session */}
      {report.costBySession.length > 0 && (
        <Section title="Cost by session">
          <div className="h-32">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={report.costBySession}
                layout="vertical"
                margin={{ left: 60 }}
              >
                <XAxis type="number" hide />
                <YAxis
                  type="category"
                  dataKey="label"
                  tick={{ fill: "#a1a1aa", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  width={56}
                />
                <Tooltip
                  contentStyle={{
                    background: "#18181b",
                    border: "1px solid #27272a",
                    borderRadius: 8,
                    fontSize: 11,
                  }}
                  formatter={(v) => [`$${Number(v).toFixed(3)}`, "Cost"]}
                />
                <Bar dataKey="costUsd" radius={[0, 4, 4, 0]} barSize={14}>
                  {report.costBySession.map((_, i) => (
                    <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>
      )}

      {/* Cost by model */}
      {report.costByModel.length > 0 && (
        <Section title="Cost by model">
          <ul className="space-y-1.5 px-4 pb-3">
            {report.costByModel.map((m, i) => (
              <li key={m.label} className="flex items-center gap-2 text-xs">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: PALETTE[i % PALETTE.length] }}
                />
                <span className="flex-1 truncate text-zinc-300">
                  {m.label}
                </span>
                <span className="font-mono text-zinc-500">
                  ${m.costUsd.toFixed(3)}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* I/O breakdown */}
      <Section title="Token breakdown">
        <div className="space-y-1 px-4 pb-3 text-xs">
          <Row label="Input" value={formatTokens(report.totalInput)} />
          <Row label="Output" value={formatTokens(report.totalOutput)} />
          <Row label="Cache read" value={formatTokens(report.totalCached)} />
        </div>
      </Section>
    </aside>
  );
}

function StatCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-octo-border bg-octo-bg p-2.5">
      <div className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wider text-zinc-500">
        {icon}
        {label}
      </div>
      <div className="text-sm font-semibold tracking-tight">{value}</div>
    </div>
  );
}

function BudgetGauge({
  remaining,
  total,
}: {
  remaining: number;
  total: number;
}) {
  const pct = total === 0 ? 0 : ((total - remaining) / total) * 100;
  const color =
    pct > 90
      ? "bg-octo-danger"
      : pct > 70
        ? "bg-octo-warning"
        : "bg-octo-success";

  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-zinc-500">
        <span>Budget</span>
        <span>{pct.toFixed(0)}% used</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
        <div
          className={clsx("h-full rounded-full transition-all", color)}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
      <div className="mt-0.5 text-right text-[10px] text-zinc-600">
        {formatTokens(remaining)} remaining
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border-t border-octo-border pt-2">
      <div className="px-4 pb-1 text-[10px] uppercase tracking-wider text-zinc-500">
        {title}
      </div>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-zinc-400">{label}</span>
      <span className="font-mono text-zinc-300">{value}</span>
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
