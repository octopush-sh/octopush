import { useEffect, useState } from "react";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  BarChart, Bar, Cell,
} from "recharts";
import { ipc } from "../lib/ipc";
import { useTokenStore } from "../stores/tokenStore";
import { useThemeStore } from "../stores/themeStore";
import {
  SETTINGS_TABS,
  SETTINGS_TAB_LABELS,
  type SettingsTab,
} from "../lib/settingsTabs";

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
  const [anthropicKey, setAnthropicKey] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [showAnthropic, setShowAnthropic] = useState(false);
  const [showOpenai, setShowOpenai] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    ipc.getSettings().then((s) => {
      // Read from new providerKeys map; fall back to legacy fields for old settings files.
      setAnthropicKey(s.providerKeys?.["anthropic"] ?? s.anthropicApiKey ?? "");
      setOpenaiKey(s.providerKeys?.["openai"] ?? s.openaiApiKey ?? "");
      setSaved(false);
    });
  }, []);

  async function handleSave() {
    setSaving(true);
    await ipc.saveSettings({
      providerKeys: {
        ...(anthropicKey ? { anthropic: anthropicKey } : {}),
        ...(openaiKey ? { openai: openaiKey } : {}),
      },
      providerBaseUrls: {},
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <>
      <PaneHeader
        eyebrow="Models & Providers"
        title="Choose where your tokens go."
        subtitle="API keys live on this machine in ~/.octopus-sh/settings.json. They never leave the device except in requests to the providers."
      />

      <div className="max-w-[600px] space-y-6">
        <ProviderRow
          name="Anthropic"
          description="Required for Claude (Sonnet, Opus, Haiku)."
          link="console.anthropic.com"
          value={anthropicKey}
          show={showAnthropic}
          onChange={setAnthropicKey}
          onToggleShow={() => setShowAnthropic((v) => !v)}
        />
        <ProviderRow
          name="OpenAI"
          description="Optional. Required for GPT-4o."
          link="platform.openai.com"
          value={openaiKey}
          show={showOpenai}
          onChange={setOpenaiKey}
          onToggleShow={() => setShowOpenai((v) => !v)}
        />

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
  name, description, link, value, show, onChange, onToggleShow,
}: {
  name: string;
  description: string;
  link: string;
  value: string;
  show: boolean;
  onChange: (v: string) => void;
  onToggleShow: () => void;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="font-serif italic text-[16px] text-octo-ivory">{name}</span>
        <a
          href={`https://${link}`}
          target="_blank"
          rel="noopener"
          className="font-mono text-[10px] uppercase tracking-[0.2em] text-octo-mute hover:text-octo-brass"
        >
          {link} ↗
        </a>
      </div>
      <div className="mt-1 text-[12px] text-octo-sage">{description}</div>
      <div className="relative mt-3">
        <input
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="sk-..."
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
    </div>
  );
}

// ─── Tab: Appearance ──────────────────────────────────────────────────

function AppearancePane() {
  const { themes, theme: current, apply } = useThemeStore();

  return (
    <>
      <PaneHeader
        eyebrow="Appearance"
        title="A palette to live in."
        subtitle="Octopus ships with Atelier (Onyx & Brass). Legacy themes remain available for power users."
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

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

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

      <div className="grid max-w-[800px] grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Cost" value={`$${report.totalCostUsd.toFixed(2)}`} />
        <Stat label="Tokens" value={formatTokens(totalTokens)} />
        <Stat label="Projected / day" value={`$${report.projectedDailyCost.toFixed(2)}`} />
        <Stat label="Cache hit" value={cacheHitPct} />
      </div>

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
    </>
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
        <li>· <span className="font-serif italic text-octo-ivory">Local-only data:</span> projects, workspaces, chat messages, tool executions, token usage. Stored in <span className="font-mono text-octo-brass">~/Library/Application Support/octopus-sh/octopus.db</span>.</li>
        <li>· <span className="font-serif italic text-octo-ivory">API keys:</span> stored in <span className="font-mono text-octo-brass">~/.octopus-sh/settings.json</span>.</li>
        <li>· <span className="font-serif italic text-octo-ivory">Outbound traffic:</span> only to providers you configure (Anthropic, OpenAI). No analytics, no telemetry.</li>
      </ul>
    </>
  );
}
