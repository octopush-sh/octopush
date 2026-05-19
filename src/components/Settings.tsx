import { useEffect, useState } from "react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell,
} from "recharts";
import { ipc } from "../lib/ipc";
import { useTokenStore } from "../stores/tokenStore";
import { useThemeStore } from "../stores/themeStore";
import { useBudgetsStore } from "../stores/budgetsStore";
import {
  SETTINGS_TABS,
  SETTINGS_TAB_LABELS,
  type SettingsTab,
} from "../lib/settingsTabs";
import type { Budget, BudgetPeriod, BudgetScope, ProviderConfig, UsageBreakdown } from "../lib/types";

interface Props {
  open: boolean;
  initialTab?: SettingsTab;
  onClose: () => void;
}

const POLL_MS = 10_000;

export function Settings({ open, initialTab = "general", onClose }: Props) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);

  // When (re)opened, jump to the requested tab.
  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  // Esc closes Settings.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="absolute inset-0 z-40 flex flex-col bg-octo-bg"
      data-tauri-drag-region
      style={{
        background:
          "radial-gradient(ellipse at 20% 10%, rgba(212,165,116,0.04), transparent 50%), var(--color-octo-onyx)",
      }}
    >
      {/* Header */}
      <header className="flex items-baseline gap-4 border-b border-octo-hairline px-8 py-6">
        <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-brass">
          Preferences
        </span>
        <h1 className="font-serif italic text-[22px] tracking-[-0.005em] text-octo-ivory">
          Octopus
        </h1>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close settings"
          className="ml-auto rounded-md px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-mute hover:text-octo-brass"
        >
          ESC · CLOSE
        </button>
      </header>

      {/* Body: nav + pane */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Side nav */}
        <aside className="flex w-[180px] shrink-0 flex-col border-r border-octo-hairline px-3 py-6">
          {SETTINGS_TABS.map((t) => (
            <TabButton
              key={t}
              label={SETTINGS_TAB_LABELS[t]}
              active={tab === t}
              onClick={() => setTab(t)}
            />
          ))}
        </aside>

        {/* Pane */}
        <main className="flex-1 overflow-y-auto px-10 py-8">
          {tab === "general" && <GeneralPane />}
          {tab === "models" && <ModelsPane />}
          {tab === "appearance" && <AppearancePane />}
          {tab === "usage" && <UsagePane />}
          {tab === "shortcuts" && <ShortcutsPane />}
          {tab === "privacy" && <PrivacyPane />}
        </main>
      </div>
    </div>
  );
}

// ─── Nav item ─────────────────────────────────────────────────────────

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-1 flex w-full items-baseline rounded-md px-3 py-2 text-left transition"
      style={
        active
          ? { background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }
          : { border: "1px solid transparent" }
      }
    >
      <span
        className={
          active
            ? "font-serif italic text-[14px] text-octo-brass"
            : "font-sans text-[13px] text-octo-sage hover:text-octo-ivory"
        }
      >
        {label}
      </span>
    </button>
  );
}

// ─── Shared pane primitives ───────────────────────────────────────────

function PaneHeader({ eyebrow, title, subtitle }: {
  eyebrow: string;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="mb-8">
      <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-brass">
        {eyebrow}
      </div>
      <h2 className="mt-2 font-serif italic text-[22px] leading-tight tracking-[-0.005em] text-octo-ivory">
        {title}
      </h2>
      {subtitle && (
        <p className="mt-2 max-w-[60ch] text-[12px] leading-[1.55] text-octo-sage">
          {subtitle}
        </p>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-3 font-mono text-[9px] uppercase tracking-[0.3em] text-octo-mute">
      {children}
    </div>
  );
}

function Placeholder({ note }: { note: string }) {
  return (
    <div className="text-[13px] leading-[1.6] text-octo-mute">
      <em className="font-serif">{note}</em>
    </div>
  );
}

// ─── Tab: General ─────────────────────────────────────────────────────

function GeneralPane() {
  return (
    <>
      <PaneHeader
        eyebrow="General"
        title="The basics."
        subtitle="Application-wide preferences live here. More options will appear as the app grows."
      />
      <Placeholder note="Nothing to configure yet." />
    </>
  );
}

// ─── Tab: Models & Providers ──────────────────────────────────────────

function ModelsPane() {
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [baseUrls, setBaseUrls] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [refreshingPricing, setRefreshingPricing] = useState(false);
  const [lastPricingRefresh, setLastPricingRefresh] = useState<string | null>(null);
  const [pricingMessage, setPricingMessage] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([ipc.listProviders(), ipc.getSettings()]).then(([provs, settings]) => {
      setProviders(provs);
      setKeys(settings.providerKeys ?? {});
      setBaseUrls(settings.providerBaseUrls ?? {});
      setLastPricingRefresh(settings.lastPricingRefresh ?? null);
    });
  }, []);

  async function handleSave() {
    setSaving(true);
    await ipc.saveSettings({
      providerKeys: Object.fromEntries(
        Object.entries(keys).filter(([_, v]) => v && v.length > 0),
      ),
      providerBaseUrls: Object.fromEntries(
        Object.entries(baseUrls).filter(([_, v]) => v && v.length > 0),
      ),
      gitCredentials: {},
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function handleRefreshPricing() {
    setRefreshingPricing(true);
    setPricingMessage(null);
    try {
      const result = await ipc.refreshPricing();
      setLastPricingRefresh(result.fetchedAt);
      setPricingMessage(`Updated pricing for ${result.modelsUpdated} of ${result.modelsTotal} models`);
      // Reload providers to reflect new prices in UI.
      const provs = await ipc.listProviders();
      setProviders(provs);
    } catch (e) {
      setPricingMessage(`Refresh failed: ${String(e)}`);
    } finally {
      setRefreshingPricing(false);
      setTimeout(() => setPricingMessage(null), 5000);
    }
  }

  function formatLastRefresh(iso: string | null): string {
    if (!iso) return "Never refreshed";
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffH = Math.floor(diffMs / 3_600_000);
    const diffMin = Math.floor(diffMs / 60_000);
    if (diffH >= 24) return `Last refreshed ${Math.floor(diffH / 24)}d ago`;
    if (diffH >= 1) return `Last refreshed ${diffH}h ago`;
    if (diffMin >= 1) return `Last refreshed ${diffMin}m ago`;
    return "Last refreshed just now";
  }

  return (
    <>
      <PaneHeader
        eyebrow="Models & Providers"
        title="Choose where your tokens go."
        subtitle="API keys live on this machine in ~/.octopush/settings.json. They never leave the device except in requests to the providers themselves."
      />

      {/* Pricing refresh row */}
      <div className="mb-6 flex max-w-[680px] items-center gap-3 rounded-md border border-octo-hairline bg-octo-panel px-4 py-3">
        <div className="flex-1">
          <div className="font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute">
            Model Pricing
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-octo-sage">
            {pricingMessage ?? formatLastRefresh(lastPricingRefresh)}
          </div>
        </div>
        <button
          type="button"
          onClick={handleRefreshPricing}
          disabled={refreshingPricing}
          className="rounded-md px-3 py-1.5 font-serif italic text-[12px] text-octo-brass transition disabled:opacity-50"
          style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
        >
          {refreshingPricing ? "Refreshing…" : "Refresh pricing"}
        </button>
      </div>

      <div className="max-w-[680px] space-y-7">
        {providers.map((p) => (
          <ProviderRow
            key={p.name}
            provider={p}
            value={keys[p.name] ?? ""}
            baseUrl={baseUrls[p.name] ?? ""}
            show={shown[p.name] ?? false}
            onChange={(v) => setKeys((s) => ({ ...s, [p.name]: v }))}
            onChangeBaseUrl={(v) => setBaseUrls((s) => ({ ...s, [p.name]: v }))}
            onToggleShow={() => setShown((s) => ({ ...s, [p.name]: !s[p.name] }))}
          />
        ))}

        <div className="flex items-center gap-3 pt-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="rounded-md px-4 py-2 font-serif italic text-[13px] text-octo-brass transition disabled:opacity-50"
            style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
          >
            {saved ? "✓ Saved" : saving ? "Saving…" : "Save changes"}
          </button>
          {saved && (
            <span className="font-mono text-[9px] uppercase tracking-[0.25em] text-octo-verdigris">
              Saved to disk
            </span>
          )}
        </div>
      </div>
    </>
  );
}

function ProviderRow({
  provider, value, baseUrl, show, onChange, onChangeBaseUrl, onToggleShow,
}: {
  provider: ProviderConfig;
  value: string;
  baseUrl: string;
  show: boolean;
  onChange: (v: string) => void;
  onChangeBaseUrl: (v: string) => void;
  onToggleShow: () => void;
}) {
  const displayName = provider.name[0].toUpperCase() + provider.name.slice(1);
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="font-serif italic text-[16px] text-octo-ivory">{displayName}</span>
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-octo-mute">
          {provider.models.length} models · {provider.local ? "local" : "cloud"}
        </span>
      </div>
      <div className="mt-1 text-[12px] text-octo-sage">
        {providerDescription(provider)}
      </div>

      {!provider.local && (
        <div className="relative mt-3">
          <input
            type={show ? "text" : "password"}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="API key"
            className="w-full rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 pr-10 font-mono text-[12px] text-octo-ivory outline-none placeholder:text-octo-mute focus:border-octo-brass"
          />
          <button
            type="button"
            onClick={onToggleShow}
            className="absolute right-2 top-1/2 -translate-y-1/2 px-1 font-mono text-[10px] uppercase tracking-[0.15em] text-octo-mute hover:text-octo-brass"
          >
            {show ? "Hide" : "Show"}
          </button>
        </div>
      )}

      <div className="mt-2">
        <div className="mb-1 font-mono text-[8px] uppercase tracking-[0.25em] text-octo-mute">
          BASE URL {provider.local ? "(required)" : "(optional override)"}
        </div>
        <input
          value={baseUrl}
          onChange={(e) => onChangeBaseUrl(e.target.value)}
          placeholder={provider.apiBase}
          className="w-full rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-mono text-[11px] text-octo-ivory outline-none placeholder:text-octo-mute focus:border-octo-brass"
        />
      </div>
    </div>
  );
}

function providerDescription(p: ProviderConfig): string {
  switch (p.name) {
    case "anthropic": return "Claude models (Opus, Sonnet, Haiku). Get your key at console.anthropic.com.";
    case "openai": return "GPT-4o and friends. Get your key at platform.openai.com.";
    case "deepseek": return "Cheaper alternative with strong code performance. platform.deepseek.com.";
    case "ollama": return "Local models running on this machine. Install via ollama.com — no key required.";
    default: return `${p.protocol} provider at ${p.apiBase}.`;
  }
}

// ─── Tab: Appearance ──────────────────────────────────────────────────

function AppearancePane() {
  const { themes, theme: current, apply } = useThemeStore();

  return (
    <>
      <PaneHeader
        eyebrow="Appearance"
        title="A palette to live in."
        subtitle="Octopush ships with Atelier (Onyx & Brass). Legacy themes remain available for power users."
      />

      <SectionLabel>Theme</SectionLabel>
      <div className="grid max-w-[640px] grid-cols-2 gap-3">
        {themes.map((t) => {
          const active = current?.name === t.name;
          return (
            <button
              key={t.name}
              type="button"
              onClick={() => apply(t)}
              className="flex items-center gap-3 rounded-md p-3 text-left transition"
              style={{
                border: active
                  ? "1px solid var(--brass-dim)"
                  : "1px solid var(--color-octo-hairline)",
                background: active ? "var(--brass-ghost)" : "transparent",
              }}
            >
              <span
                aria-hidden
                className="h-8 w-8 shrink-0 rounded-md"
                style={{ background: t.bg, border: `1px solid ${t.accent}` }}
              />
              <div className="min-w-0 flex-1">
                <div className={active
                  ? "font-serif italic text-[14px] text-octo-brass"
                  : "font-serif italic text-[14px] text-octo-ivory"}
                >
                  {t.name}
                </div>
                <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">
                  accent {t.accent}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </>
  );
}

// ─── Tab: Usage (was TokenDashboard) ──────────────────────────────────

function UsagePane() {
  const { report, refresh } = useTokenStore();
  const { budgets, spend, loadAll: loadBudgets, refreshAllSpend } = useBudgetsStore();
  const [breakdown, setBreakdown] = useState<UsageBreakdown | null>(null);

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

      // Use Tauri dialog plugin to pick save path, then write via ipc.writeFile
      const { save } = await import("@tauri-apps/plugin-dialog");
      const dateStr = exportEnd.replace(/-/g, "");
      const pickedPath = await save({
        defaultPath: `octopush-usage-${dateStr}.csv`,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (pickedPath) {
        await ipc.writeFile(pickedPath as string, csv);
        const { pushToast } = await import("./Toasts");
        pushToast({ level: "success", title: "Ledger exported", body: pickedPath as string });
      }
    } catch (e) {
      const { pushToast } = await import("./Toasts");
      pushToast({ level: "error", title: "Export failed", body: String(e) });
    } finally {
      setExporting(false);
    }
  }

  if (!report) {
    return (
      <>
        <PaneHeader
          eyebrow="Usage"
          title="Loading…"
        />
      </>
    );
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
        <BudgetsSection
          budgets={budgets}
          spend={spend}
          onRefresh={refreshAllSpend}
        />
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
                    <stop offset="5%" stopColor="#d4a574" stopOpacity={0.5} />
                    <stop offset="95%" stopColor="#d4a574" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="hour"
                  tickFormatter={(h: string) => h.slice(11, 16)}
                  tick={{ fill: "#6d6354", fontSize: 9 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis hide />
                <Tooltip
                  contentStyle={{
                    background: "#14110d",
                    border: "1px solid #2a2419",
                    borderRadius: 6,
                    fontSize: 11,
                    color: "#f4ecdb",
                  }}
                  labelFormatter={(h) => String(h).slice(11, 16)}
                  formatter={(v) => [formatTokens(Number(v)), "Tokens"]}
                />
                <Area
                  type="monotone"
                  dataKey="tokens"
                  stroke="#d4a574"
                  fill="url(#grad-tokens-brass)"
                  strokeWidth={2}
                />
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
                  tick={{ fill: "#95897a", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  width={56}
                />
                <Tooltip
                  contentStyle={{
                    background: "#14110d",
                    border: "1px solid #2a2419",
                    borderRadius: 6,
                    fontSize: 11,
                    color: "#f4ecdb",
                  }}
                  formatter={(v) => [`$${Number(v).toFixed(3)}`, "Cost"]}
                />
                <Bar dataKey="costUsd" radius={[0, 4, 4, 0]} barSize={14}>
                  {report.costBySession.map((_, i) => (
                    <Cell key={i} fill={BRASS_PALETTE[i % BRASS_PALETTE.length]} />
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
                <span
                  aria-hidden
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ background: BRASS_PALETTE[i % BRASS_PALETTE.length] }}
                />
                <span className="flex-1 truncate font-serif italic text-[13px] text-octo-ivory">
                  {m.label}
                </span>
                <span className="font-mono text-[11px] text-octo-sage">
                  ${m.costUsd.toFixed(3)}
                </span>
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
            <label className="font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">From</label>
            <input
              type="date"
              value={exportStart}
              onChange={(e) => setExportStart(e.target.value)}
              className="rounded border border-octo-hairline bg-octo-onyx px-2 py-1 font-mono text-[11px] text-octo-ivory outline-none focus:border-octo-brass"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">To</label>
            <input
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
            className="ml-auto rounded-md px-4 py-1.5 font-serif italic text-[13px] text-octo-brass transition disabled:opacity-50"
            style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
          >
            {exporting ? "Exporting…" : "Export CSV"}
          </button>
        </div>
      </div>
    </>
  );
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
        <div className="font-mono text-[9px] uppercase tracking-[0.3em] text-octo-mute">
          Budgets <span className="text-octo-brass">¶</span>
        </div>
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="rounded-md px-3 py-1 font-mono text-[9px] uppercase tracking-[0.2em] text-octo-sage transition hover:text-octo-brass"
          style={{ border: "1px solid var(--color-octo-hairline)" }}
        >
          + Add budget
        </button>
      </div>

      {budgets.length === 0 ? (
        <div className="text-[12px] text-octo-mute">
          <em className="font-serif">No budgets configured.</em>
        </div>
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
                <div className="mb-1.5 font-serif italic text-[13px] text-octo-sage">
                  {scopeLabel}
                </div>
                <div className="space-y-1.5 rounded-md border border-octo-hairline bg-octo-panel px-3 py-2">
                  {groupBudgets.map((b) => {
                    const key = `${b.scopeType}:${b.scopeId}:${b.period}`;
                    const snap = spend[key] ?? { costUsd: 0, tokens: 0 };
                    const pct = b.limitUsd > 0 ? Math.min(100, (snap.costUsd / b.limitUsd) * 100) : 0;
                    const barColor = pct >= 100
                      ? "var(--color-octo-rouge)"
                      : pct >= 80
                      ? "var(--color-octo-warning, #d4a250)"
                      : pct >= 50
                      ? "#d4a574cc"
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
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setShowAdd(false)}
        >
          <div
            className="w-[360px] rounded-xl border border-octo-hairline bg-octo-panel p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass">
              Add Budget
            </div>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">Scope</label>
                <select
                  value={addState.scope}
                  onChange={(e) => setAddState((s) => ({ ...s, scope: e.target.value as BudgetScope, scopeId: "" }))}
                  className="w-full rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-mono text-[12px] text-octo-ivory outline-none focus:border-octo-brass"
                >
                  <option value="global">Global</option>
                  <option value="workspace">Workspace</option>
                  <option value="project">Project</option>
                </select>
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
                <select
                  value={addState.period}
                  onChange={(e) => setAddState((s) => ({ ...s, period: e.target.value as BudgetPeriod }))}
                  className="w-full rounded-md border border-octo-hairline bg-octo-onyx px-3 py-2 font-mono text-[12px] text-octo-ivory outline-none focus:border-octo-brass"
                >
                  <option value="daily">Daily</option>
                  <option value="monthly">Monthly</option>
                </select>
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
                className="rounded-md px-4 py-2 font-serif italic text-[13px] text-octo-brass transition disabled:opacity-50"
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
        </div>
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
            className="w-20 rounded border border-octo-brass bg-octo-onyx px-2 py-0.5 font-mono text-[11px] text-octo-ivory outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => { setDraft(budget.limitUsd.toFixed(2)); setEditing(true); }}
            className="w-20 rounded border border-octo-hairline px-2 py-0.5 text-left font-mono text-[11px] text-octo-ivory transition hover:border-octo-brass"
          >
            ${budget.limitUsd.toFixed(2)}
          </button>
        )}
        <span className="flex-1 text-octo-mute">
          Spent: <span className="text-octo-ivory">${spentUsd.toFixed(2)}</span>
          <span className="ml-1 text-octo-mute">{pct.toFixed(0)}%</span>
        </span>
        <button
          type="button"
          onClick={onClear}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded font-mono text-[14px] leading-none text-octo-mute transition hover:bg-octo-rouge/15 hover:text-octo-rouge"
          title="Remove budget"
          aria-label="Remove budget"
        >
          ×
        </button>
      </div>
      <div
        className="ml-16 h-[2px] rounded-sm"
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-octo-hairline bg-octo-panel px-3 py-3">
      <div className="font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute">
        {label}
      </div>
      <div className="mt-1.5 font-serif italic text-[18px] tracking-[-0.005em] text-octo-ivory">
        {value}
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
        <span>{pct.toFixed(0)}% used</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full" style={{ background: "var(--color-octo-hairline)" }}>
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${Math.min(pct, 100)}%`, background: tint }}
        />
      </div>
      <div className="mt-2 text-right font-mono text-[10px] text-octo-mute">
        {formatTokens(remaining)} remaining
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="font-sans text-octo-sage">{label}</span>
      <span className="font-mono text-octo-ivory">{value}</span>
    </div>
  );
}

// Brass-aware palette for charts. Keeps the visual harmony with Atelier.
const BRASS_PALETTE = ["#d4a574", "#8fc9a8", "#8a93c9", "#b59ac9", "#d8c9a8", "#d18b8b", "#a8a8a8"];

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// ─── Tab: Shortcuts ───────────────────────────────────────────────────

function ShortcutsPane() {
  return (
    <>
      <PaneHeader
        eyebrow="Shortcuts"
        title="The grammar of the keyboard."
        subtitle="A reference of every keybinding Octopus respects."
      />

      <div className="max-w-[640px]">
        <ShortcutGroup title="Navigation">
          <Shortcut keys="⌘1 … ⌘9" desc="Switch to workspace N" />
          <Shortcut keys="⌘⇧1" desc="Talk mode" />
          <Shortcut keys="⌘⇧2" desc="Run mode" />
          <Shortcut keys="⌘⇧3" desc="Review mode" />
          <Shortcut keys="⌘\\" desc="Toggle companion" />
        </ShortcutGroup>

        <ShortcutGroup title="Actions">
          <Shortcut keys="⌘K" desc="Command palette" />
          <Shortcut keys="⌘N" desc="New workspace" />
          <Shortcut keys="⌘," desc="Open Settings" />
          <Shortcut keys="⌘⇧T" desc="Open Settings · Usage" />
        </ShortcutGroup>

        <ShortcutGroup title="Chat">
          <Shortcut keys="↵" desc="Send message" />
          <Shortcut keys="⇧↵" desc="New line in message" />
        </ShortcutGroup>
      </div>
    </>
  );
}

function ShortcutGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6">
      <SectionLabel>{title}</SectionLabel>
      <ul className="divide-y divide-octo-hairline rounded-md border border-octo-hairline bg-octo-panel">
        {children}
      </ul>
    </div>
  );
}

function Shortcut({ keys, desc }: { keys: string; desc: string }) {
  return (
    <li className="flex items-baseline justify-between px-4 py-2.5">
      <span className="text-[13px] text-octo-sage">{desc}</span>
      <kbd className="rounded border border-octo-hairline bg-octo-onyx px-2 py-0.5 font-mono text-[10px] text-octo-brass">
        {keys}
      </kbd>
    </li>
  );
}

// ─── Tab: Privacy ─────────────────────────────────────────────────────

function PrivacyPane() {
  return (
    <>
      <PaneHeader
        eyebrow="Privacy"
        title="What stays, what leaves."
        subtitle="Octopus stores all chat history, API keys, and tokens locally. Provider API requests go directly to Anthropic/OpenAI from this machine."
      />

      <ul className="max-w-[640px] space-y-2 text-[13px] leading-[1.6] text-octo-sage">
        <li>· <span className="font-serif italic text-octo-ivory">Local-only data:</span> projects, workspaces, chat messages, tool executions, token usage. Stored in <span className="font-mono text-octo-brass">~/Library/Application Support/octopush/octopush.db</span>.</li>
        <li>· <span className="font-serif italic text-octo-ivory">API keys:</span> stored in <span className="font-mono text-octo-brass">~/.octopush/settings.json</span>.</li>
        <li>· <span className="font-serif italic text-octo-ivory">Outbound traffic:</span> only to providers you configure (Anthropic, OpenAI). No analytics, no telemetry.</li>
      </ul>
    </>
  );
}
