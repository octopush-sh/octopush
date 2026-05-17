# Phase 6 — Side Surfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Settings stops being a modal dialog and becomes a full-screen section with side nav. CommandPalette stops looking like a Cursor-clone and gets the Atelier brass glow + `§` glyph treatment. `TokenDashboard` overlay disappears entirely — its rich content (4 stat cards + budget gauge + 24h burn-rate chart + cost-by-session bars + cost-by-model list + token breakdown) is relocated to a new `Usage` tab inside Settings. Plus, real token data finally lights up the Companion's Context panel (the hardcoded `tokensUsed: 0` from Phase 2).

**Architecture:** `Settings.tsx` replaces `SettingsDialog.tsx` as a full-window overlay (not a modal — it covers the entire viewport when open). 6 tabs: General, Models & Providers, Appearance, Usage, Shortcuts, Privacy. App.tsx tracks `settingsTab: SettingsTab | null` (null = closed). `⌘,` opens it on `general`; `⌘⇧T` opens it on `usage`. `showTokens` state and `TokenDashboard` mount are removed. The Companion's `tokensUsed` is wired to the real `useTokenStore` report (with a periodic refresh hook). CommandPalette is rewritten in place using the design system. The legacy `TokenDashboard.tsx` file is deleted last, after all consumers have moved off it.

**Tech stack:** React 19, Tailwind v4 + Onyx & Brass tokens, recharts (preserved for the burn-rate / cost-by-session charts inside Settings · Usage), existing Zustand stores (`tokenStore`, `themeStore`, `sessionStore`, `workspaceStore`).

---

## Spec reference

Source of truth: `docs/superpowers/specs/2026-05-16-octopus-ux-redesign-design.md` §4.7 (Settings), §4.8 (Command Palette), §7 Phase 6 (rollout). Cheatsheet: `docs/design-system.md`.

---

## File structure

**Created**

| Path | Responsibility |
|------|----------------|
| `src/components/Settings.tsx` | Full-window Settings overlay. Side nav + tab content. Includes `SettingsUsage` sub-component carrying the chart/stat content from the deleted `TokenDashboard`. |
| `src/lib/settingsTabs.ts` | `SettingsTab` union type + constants (tab order + display labels). Tiny module; lives separately so App.tsx and Settings.tsx import the same type. |

**Modified**

| Path | Why |
|------|-----|
| `src/App.tsx` | Swap `SettingsDialog` for `Settings`. Replace `showSettings: boolean` with `settingsTab: SettingsTab \| null`. Remove `showTokens` state and `TokenDashboard` import/render. Wire `useTokenStore` into `companionContextProps.tokensUsed`. `⌘,` → `setSettingsTab("general")`. `⌘⇧T` → `setSettingsTab("usage")`. |
| `src/components/CommandPalette.tsx` | Full visual rewrite to Onyx & Brass: brass glow border, `§` glyphs, mono uppercase group eyebrows, italic-serif item titles where appropriate, brass-ghost selected state. Behavior preserved (all actions, all groups). |

**Deleted**

| Path | Why |
|------|-----|
| `src/components/SettingsDialog.tsx` | Replaced by `Settings.tsx`. |
| `src/components/TokenDashboard.tsx` | Content moved into `Settings.tsx`'s `Usage` tab. The `showTokens` overlay pattern is gone. |

**Not touched in Phase 6**

- `Toasts.tsx` — Phase 4 ChatView already wired its error pattern; Toasts global styling can be a future polish.
- Stores (`tokenStore`, `sessionStore`, `themeStore`) — interfaces unchanged. We just consume them in new places.
- Backend — no Rust changes.

---

## Design patterns (used across this phase)

### Full-window overlay shell
```tsx
<div
  className="absolute inset-0 z-40 flex bg-octo-bg"
  data-tauri-drag-region
>
  {/* Left nav + Right pane */}
</div>
```

### Settings nav item (left pane)
```tsx
<button
  type="button"
  onClick={() => setActiveTab("usage")}
  className="flex w-full items-baseline gap-2 rounded-md px-3 py-2 text-left"
  style={
    active
      ? { background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }
      : { border: "1px solid transparent" }
  }
>
  <span className={active ? "font-serif italic text-[14px] text-octo-brass" : "font-sans text-[13px] text-octo-sage"}>
    Usage
  </span>
</button>
```

### Brass-glow palette container (CommandPalette)
```tsx
<div
  className="rounded-xl bg-octo-panel"
  style={{
    border: "1px solid var(--brass-dim)",
    boxShadow:
      "0 30px 60px -10px rgba(0,0,0,0.6), 0 0 0 6px rgba(212, 165, 116, 0.04)",
  }}
>
  {/* Palette content */}
</div>
```

---

## Tasks

### Task 1: Create `Settings.tsx` and `settingsTabs.ts`

**Files:**
- Create: `src/lib/settingsTabs.ts`
- Create: `src/components/Settings.tsx`

`Settings.tsx` is large because it absorbs the entire TokenDashboard content into its `Usage` tab. Keep it in one file — the sub-tab components are small and only consumed by Settings itself; extracting them would scatter the surface.

- [ ] **Step 1: Create `src/lib/settingsTabs.ts`**

```typescript
// Settings tab identifiers — shared between Settings.tsx (renders tabs) and
// App.tsx (decides which tab to open via keyboard / palette).

export type SettingsTab =
  | "general"
  | "models"
  | "appearance"
  | "usage"
  | "shortcuts"
  | "privacy";

export const SETTINGS_TABS: SettingsTab[] = [
  "general",
  "models",
  "appearance",
  "usage",
  "shortcuts",
  "privacy",
];

export const SETTINGS_TAB_LABELS: Record<SettingsTab, string> = {
  general: "General",
  models: "Models & Providers",
  appearance: "Appearance",
  usage: "Usage",
  shortcuts: "Shortcuts",
  privacy: "Privacy",
};
```

- [ ] **Step 2: Create `src/components/Settings.tsx`**

Write the full Settings component. It accepts `{ open, initialTab, onClose }` and renders nothing when `!open`. When open, it covers the entire viewport.

```tsx
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
      setAnthropicKey(s.anthropicApiKey ?? "");
      setOpenaiKey(s.openaiApiKey ?? "");
      setSaved(false);
    });
  }, []);

  async function handleSave() {
    setSaving(true);
    await ipc.saveSettings({
      anthropicApiKey: anthropicKey || null,
      openaiApiKey: openaiKey || null,
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
```

- [ ] **Step 3: Run typecheck**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
npm run typecheck
```

Expected: clean. (`SettingsDialog.tsx` still exists at this stage — TypeScript may briefly show duplicate exports if both files declare `Settings`/`SettingsDialog`. They don't share names, so this should be fine.)

- [ ] **Step 4: Run all tests**

```bash
npm test
```

Expected: all 64 pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/settingsTabs.ts src/components/Settings.tsx
git commit -m "feat: Settings as full-window section with 6 tabs (Usage absorbs TokenDashboard)"
```

---

### Task 2: App.tsx wiring + delete legacy files

**Files:**
- Modify: `src/App.tsx`
- Delete: `src/components/SettingsDialog.tsx`
- Delete: `src/components/TokenDashboard.tsx`

This task swaps the modal `SettingsDialog` for the new full-window `Settings`, removes `showTokens` and the `TokenDashboard` mount entirely, wires the Companion's `tokensUsed` to real data via `useTokenStore`, and updates keyboard shortcuts (`⌘,` → general, `⌘⇧T` → usage).

- [ ] **Step 1: Patch `src/App.tsx`**

Read the current `src/App.tsx` to confirm the relevant chunks. Then apply these edits via the Edit tool:

**1a.** Replace the import:
- Find: `import { SettingsDialog } from "./components/SettingsDialog";`
- Replace with: `import { Settings } from "./components/Settings";`
- Also find and remove: `import { TokenDashboard } from "./components/TokenDashboard";`

**1b.** Add to the imports section (after the workspace/theme/tokenStore imports):
- Find: `import { useThemeStore } from "./stores/themeStore";`
- Add after it (a new line):
  ```typescript
  import { useTokenStore } from "./stores/tokenStore";
  import type { SettingsTab } from "./lib/settingsTabs";
  ```

**1c.** Replace `showSettings` + `showTokens` state declarations:
- Find:
  ```typescript
    const [showTokens, setShowTokens] = useState(false);
  ```
- Delete that line entirely.

- Find:
  ```typescript
    const [showSettings, setShowSettings] = useState(false);
  ```
- Replace with:
  ```typescript
    const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  ```

**1d.** Wire tokenStore. Just below the `useThemeStore` line (`const loadTheme = useThemeStore((s) => s.load);` or similar), add:
```typescript
  const tokenReport = useTokenStore((s) => s.report);
  const refreshTokens = useTokenStore((s) => s.refresh);
```

Also add a periodic refresh effect near the existing `loadTheme()` effect:
```typescript
  // Refresh token usage periodically so the Companion + Settings · Usage
  // stay current. 30s is enough for a workspace-level glance.
  useEffect(() => {
    refreshTokens();
    const id = setInterval(refreshTokens, 30_000);
    return () => clearInterval(id);
  }, [refreshTokens]);
```

**1e.** Update `companionContextProps`:
- Find:
  ```typescript
    const companionContextProps = useMemo(
      () => ({
        tokensUsed: 0,        // wired to real data in Phase 6 (TokenDashboard migration)
        tokensLimit: 200_000,
        filesInFlight: gitStatus?.changedFiles.length ?? 0,
        toolCalls: 0,
      }),
      [gitStatus],
    );
  ```
- Replace with:
  ```typescript
    const companionContextProps = useMemo(() => {
      const tokensUsed =
        (tokenReport?.totalInput ?? 0) + (tokenReport?.totalOutput ?? 0);
      return {
        tokensUsed,
        tokensLimit: 200_000,
        filesInFlight: gitStatus?.changedFiles.length ?? 0,
        toolCalls: 0,
      };
    }, [gitStatus, tokenReport]);
  ```

**1f.** Update keyboard shortcut handlers. Find the `⌘,` handler:
- Find:
  ```typescript
        // ⌘, → settings
        if (mod && e.key === ",") {
          e.preventDefault();
          setShowSettings(true);
          return;
        }
  ```
- Replace with:
  ```typescript
        // ⌘, → Settings (General tab)
        if (mod && e.key === ",") {
          e.preventDefault();
          setSettingsTab("general");
          return;
        }
  ```

- Find:
  ```typescript
        // ⌘⇧T → Settings · Usage
        if (mod && e.shiftKey && (e.key === "T" || e.key === "t")) {
          e.preventDefault();
          setShowTokens((v) => !v);
          bumpLayout();
          return;
        }
  ```
- Replace with:
  ```typescript
        // ⌘⇧T → Settings · Usage
        if (mod && e.shiftKey && (e.key === "T" || e.key === "t")) {
          e.preventDefault();
          setSettingsTab("usage");
          return;
        }
  ```

**1g.** Remove the `⌘\` companion-toggle handler's coupling to `showTokens` (it currently toggles `showTokens` as a stand-in). Find:
```typescript
      // ⌘\ → toggle companion
      if (mod && e.key === "\\") {
        e.preventDefault();
        setShowTokens((v) => !v);
        bumpLayout();
        return;
      }
```
Replace with:
```typescript
      // ⌘\ → toggle companion (no-op for now; pending true companion visibility state)
      if (mod && e.key === "\\") {
        e.preventDefault();
        bumpLayout();
        return;
      }
```
(A proper companion-hide is out of scope; spec acknowledges this.)

**1h.** Remove the TokenDashboard render and update the SettingsDialog render. Find:
```typescript
      {showTokens && <TokenDashboard />}
```
Delete that line entirely.

Find:
```typescript
      <SettingsDialog
        open={showSettings}
        onClose={() => setShowSettings(false)}
      />
```
Replace with:
```typescript
      <Settings
        open={settingsTab !== null}
        initialTab={settingsTab ?? "general"}
        onClose={() => setSettingsTab(null)}
      />
```

**1i.** Update the `CommandPalette` `onToggleTokens` prop — Settings is now where Usage lives:
```typescript
      <CommandPalette
        open={showPalette}
        onClose={() => setShowPalette(false)}
        onNewSession={() => {
          setShowPalette(false);
          setShowCreator(true);
        }}
        onToggleTokens={() => setSettingsTab("usage")}
      />
```

**1j.** Also update `ChatView`'s `onOpenSettings` callback. Find:
```typescript
              <ChatView
                workspaceId={activeChatId!}
                workspacePath={activeWorkspace.worktreePath || project.path}
                onOpenSettings={() => setShowSettings(true)}
              />
```
Replace `setShowSettings(true)` with `setSettingsTab("general")`.

- [ ] **Step 2: Delete legacy files**

After verifying App.tsx compiles, remove the two old files:

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
rm src/components/SettingsDialog.tsx
rm src/components/TokenDashboard.tsx
```

Confirm nothing else imports them:
```bash
grep -rn "SettingsDialog\|TokenDashboard" src/ --include="*.ts" --include="*.tsx"
```
Expected: zero matches.

- [ ] **Step 3: Run typecheck + tests + dev boot**

```bash
npm run typecheck
npm test
npm run dev 2>&1 | head -15
```

Expected: clean typecheck, 64/64 tests pass, Vite ready.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: App.tsx uses Settings + real token data in Companion; remove TokenDashboard + SettingsDialog"
```

---

### Task 3: CommandPalette redesign

**Files:** Modify `src/components/CommandPalette.tsx` (full rewrite preserving all current actions).

- [ ] **Step 1: Replace the file**

Overwrite `src/components/CommandPalette.tsx`:

```tsx
import { Command } from "cmdk";
import { useEffect, useState, useCallback } from "react";
import { useSessionStore } from "../stores/sessionStore";
import { ipc } from "../lib/ipc";
import { pushToast } from "./Toasts";
import type { ModelWithProvider, SessionTemplate } from "../lib/types";
import { useThemeStore } from "../stores/themeStore";

interface Props {
  open: boolean;
  onClose: () => void;
  onNewSession: () => void;
  onToggleTokens: () => void;
}

export function CommandPalette({
  open,
  onClose,
  onNewSession,
  onToggleTokens,
}: Props) {
  const { sessions, activeId, select, kill } = useSessionStore();
  const refresh = useSessionStore((s) => s.refresh);
  const [models, setModels] = useState<ModelWithProvider[]>([]);
  const [templates, setTemplates] = useState<SessionTemplate[]>([]);
  const { themes, apply: applyTheme } = useThemeStore();

  useEffect(() => {
    if (open) {
      ipc.listModels().then(setModels).catch(() => {});
      ipc.listTemplates().then(setTemplates).catch(() => {});
    }
  }, [open]);

  const run = useCallback(
    (fn: () => void | Promise<void>) => {
      onClose();
      fn();
    },
    [onClose],
  );

  if (!open) return null;

  const activeSession = sessions.find((s) => s.id === activeId);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[18vh]"
      style={{ background: "rgba(12, 10, 8, 0.55)", backdropFilter: "blur(4px)" }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[560px] rounded-xl bg-octo-panel"
        style={{
          border: "1px solid var(--brass-dim)",
          boxShadow:
            "0 30px 60px -10px rgba(0,0,0,0.6), 0 0 0 6px rgba(212, 165, 116, 0.04)",
        }}
      >
        <Command loop className="overflow-hidden rounded-xl">
          <div className="flex items-center gap-3 border-b border-octo-hairline px-4 py-3">
            <span className="font-mono text-[11px] text-octo-brass">⌘ K</span>
            <Command.Input
              autoFocus
              placeholder="Type a command, or search…"
              className="flex-1 bg-transparent font-serif italic text-[14px] text-octo-ivory outline-none placeholder:text-octo-mute"
            />
            <span className="rounded border border-octo-hairline bg-octo-onyx px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.15em] text-octo-mute">
              ESC
            </span>
          </div>

          <Command.List className="max-h-[380px] overflow-y-auto py-2">
            <Command.Empty className="px-6 py-8 text-center font-serif italic text-[13px] text-octo-mute">
              Nothing matches.
            </Command.Empty>

            {/* Sessions */}
            <Group heading="Sessions">
              <Item glyph="+" label="New session" shortcut="⌘T" onSelect={() => run(onNewSession)} />
              {sessions.map((s) => (
                <Item
                  key={s.id}
                  glyph={s.name.charAt(0).toUpperCase() || "?"}
                  label={`Switch to ${s.name}`}
                  detail={s.agent.model}
                  onSelect={() => run(() => select(s.id))}
                />
              ))}
              {activeSession && (
                <Item
                  glyph="×"
                  label={`Kill ${activeSession.name}`}
                  onSelect={() =>
                    run(async () => {
                      await kill(activeSession.id);
                    })
                  }
                />
              )}
            </Group>

            {/* Models */}
            <Group heading="Models">
              {models.map((m) => (
                <Item
                  key={m.model.id}
                  glyph="◇"
                  label={`Model: ${m.model.displayName}`}
                  detail={`${m.provider} · $${m.model.inputCostPerM}/M in`}
                  onSelect={() =>
                    run(async () => {
                      if (activeId) {
                        const result = await ipc.switchAgent(activeId, m.model.id);
                        await refresh();
                        pushToast({
                          level: result.appliedToPty ? "success" : "info",
                          title: `Model → ${m.model.displayName}`,
                          body: result.message,
                        });
                      }
                    })
                  }
                />
              ))}
            </Group>

            {/* Templates */}
            {templates.length > 0 && (
              <Group heading="Templates">
                {templates.map((t) => (
                  <Item
                    key={t.name}
                    glyph="❦"
                    label={`Template: ${t.name}`}
                    detail={t.projectRoot}
                    onSelect={() => run(onNewSession)}
                  />
                ))}
              </Group>
            )}

            {/* Actions */}
            <Group heading="Actions">
              <Item
                glyph="§"
                label="Open Settings · Usage"
                shortcut="⌘⇧T"
                onSelect={() => run(onToggleTokens)}
              />
              {activeSession && (
                <Item
                  glyph="◷"
                  label="Set token budget"
                  onSelect={() =>
                    run(async () => {
                      const input = prompt("Token budget (e.g. 100000):");
                      if (input) {
                        const budget = parseInt(input.replace(/[^0-9]/g, ""), 10);
                        if (!isNaN(budget) && activeId) {
                          await ipc.setTokenBudget(activeId, budget);
                          await refresh();
                        }
                      }
                    })
                  }
                />
              )}
              {activeSession && (
                <>
                  <Item
                    glyph="↓"
                    label="Export session (JSON)"
                    onSelect={() =>
                      run(async () => {
                        const json = await ipc.exportSessionJson(activeSession.id);
                        downloadFile(`${activeSession.name}.json`, json, "application/json");
                      })
                    }
                  />
                  <Item
                    glyph="↓"
                    label="Export session (CSV)"
                    onSelect={() =>
                      run(async () => {
                        const csv = await ipc.exportSessionCsv(activeSession.id);
                        downloadFile(`${activeSession.name}.csv`, csv, "text/csv");
                      })
                    }
                  />
                </>
              )}
            </Group>

            {/* Themes */}
            {themes.length > 0 && (
              <Group heading="Themes">
                {themes.map((t) => (
                  <Item
                    key={t.name}
                    glyph="◐"
                    label={`Theme: ${t.name}`}
                    detail={t.accent}
                    onSelect={() => run(() => applyTheme(t))}
                  />
                ))}
              </Group>
            )}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}

function Group({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <Command.Group
      heading={heading}
      className="px-1 pb-1 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-[8px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.3em] [&_[cmdk-group-heading]]:text-octo-brass"
    >
      {children}
    </Command.Group>
  );
}

function Item({
  glyph,
  label,
  detail,
  shortcut,
  onSelect,
}: {
  glyph: string;
  label: string;
  detail?: string;
  shortcut?: string;
  onSelect: () => void;
}) {
  return (
    <Command.Item
      onSelect={onSelect}
      className="group mx-1 flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-[13px] text-octo-sage aria-selected:text-octo-ivory"
      style={
        {
          // Tailwind aria-selected variant doesn't reach inline style; use a CSS variable
          // here so the rule below can pick it up via `aria-selected="true"` attribute.
        }
      }
    >
      <span
        aria-hidden
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded font-serif italic text-[12px] text-octo-mute group-aria-selected:text-octo-brass"
        style={{
          border: "1px solid var(--color-octo-hairline)",
        }}
      >
        {glyph}
      </span>
      <span className="flex-1 truncate">{label}</span>
      {detail && (
        <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.15em] text-octo-mute">
          {detail}
        </span>
      )}
      {shortcut && (
        <kbd className="shrink-0 rounded border border-octo-hairline bg-octo-onyx px-1.5 py-0.5 font-mono text-[9px] tracking-[0.05em] text-octo-mute">
          {shortcut}
        </kbd>
      )}
    </Command.Item>
  );
}

// CSS for aria-selected highlight (overrides Tailwind ordering and applies a
// brass-ghost background to the currently focused item).
const _styleInject = `
[cmdk-item][aria-selected="true"] {
  background: var(--brass-ghost);
}
[cmdk-item][aria-selected="true"] > span:first-child {
  border-color: var(--brass-dim);
}
`;
if (typeof document !== "undefined" && !document.getElementById("cmdk-brass-styles")) {
  const el = document.createElement("style");
  el.id = "cmdk-brass-styles";
  el.textContent = _styleInject;
  document.head.appendChild(el);
}

function downloadFile(name: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
```

Key changes:
- Backdrop is a warm onyx tint (`rgba(12, 10, 8, 0.55)`) with a 4px backdrop blur, not the cool black/50.
- Palette container has a `1px brass-dim` border plus a soft `0 0 0 6px rgba(212, 165, 116, 0.04)` brass glow.
- Input has `⌘ K` brass prefix and italic-serif placeholder.
- ESC kbd badge top-right.
- Group headings: mono `0.3em` tracking, brass, uppercase.
- Items: brass-ghost selected state via injected CSS for `aria-selected` (cmdk applies that aria attribute on the active item). The leading glyph is in an italic-serif square; when selected, its border becomes brass-dim and the glyph turns brass.
- Lucide icons replaced with unicode glyphs (`+`, `×`, `◇`, `❦`, `§`, `◷`, `↓`, `◐`).
- The "Toggle token dashboard" action becomes "Open Settings · Usage" with the `§` glyph; behavior unchanged (calls `onToggleTokens`, which in App.tsx now opens Settings on the Usage tab).
- "View session recap" was removed — it relied on `alert()` and felt out of place. Users can find usage in Settings · Usage instead.

- [ ] **Step 2: Run typecheck and tests**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
npm run typecheck
npm test
```

Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add src/components/CommandPalette.tsx
git commit -m "feat: CommandPalette in Atelier — brass glow, § glyphs, italic-serif query"
```

---

### Task 4: E2E verification + report

**Files:** none.

- [ ] **Step 1: Full sweep**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
git log --oneline -8
npm run typecheck && npm test
cd src-tauri && cargo test 2>&1 | grep "test result.*passed" | head -3
```

Expected: typecheck clean, 64/64 frontend tests, 39/39 Rust tests.

- [ ] **Step 2: Boot dev server**

```bash
cd /Users/jonathan/TYPEFY/octopus/octopus-sh
npm run dev 2>&1 | head -15
```

Expected: Vite ready, no errors.

- [ ] **Step 3: Visual verification (user)**

User boots the production build. Inspect:

- **`⌘,` opens Settings on General tab** — full-window overlay with side nav (General, Models & Providers, Appearance, Usage, Shortcuts, Privacy). Brass `PREFERENCES` eyebrow, italic-serif "Octopus" title, ESC closes.
- **Models & Providers tab**: API key inputs (Anthropic, OpenAI) with Show/Hide toggles. "Save changes" italic-serif brass CTA.
- **Appearance tab**: theme picker grid showing current themes.
- **`⌘⇧T` opens Settings directly on Usage** — 4 brass stat cards (Cost / Tokens / Projected per day / Cache hit), budget gauge if set, brass-toned burn-rate area chart, cost-by-session bars in brass palette, cost-by-model list, token breakdown.
- **Shortcuts tab**: keybinding reference grouped (Navigation / Actions / Chat) with brass `kbd` chips.
- **Privacy tab**: 3-bullet local-only data summary.
- **`⌘K` opens Command Palette** — soft brass glow border, ⌘K brass prefix, italic-serif placeholder "Type a command, or search…". Group headings ("SESSIONS", "MODELS", "ACTIONS"…) in mono brass 0.3em tracking. Items show brass-bordered glyph squares; selected item has brass-ghost background.
- **Companion · Context (Talk mode)** — `tokens` row now shows REAL numbers (e.g. "42k / 200k") instead of "0 / 200k", with the brass meter filling proportionally.

- [ ] **Step 4: Report blockers**

If anything regresses (Settings doesn't render charts, palette items don't highlight on hover), apply targeted fix commits and report.

---

## Self-review

**Spec coverage (§7 Phase 6):**
- Settings as full-screen section ✓
- CommandPalette redesign ✓
- TokenDashboard removed; content in Settings · Usage ✓
- `⌘⇧T` repurposed for Settings · Usage ✓
- `showTokens` state removed from App.tsx ✓
- Companion `tokensUsed` wired to real data ✓

**Type/contract consistency:**
- `SettingsTab` union typed and imported in both App.tsx and Settings.tsx (single declaration in `src/lib/settingsTabs.ts`).
- `CommandPalette` props unchanged (`open, onClose, onNewSession, onToggleTokens`) — only the visual implementation changed.
- `useTokenStore` interface unchanged.

**Risks:**
- The CommandPalette uses a CSS-injection trick to apply `aria-selected` styling because Tailwind `aria-selected:` variants don't easily extend to nested children. The injected `<style>` is keyed by ID so it doesn't duplicate on re-mount, and lives globally in the document head. Acceptable trade-off; the alternative is per-item React state on selection.
- BRASS_PALETTE for charts uses 7 colors (brass, verdigris, indigo, lavender, bone, rouge, smoke). If a user has more than 7 sessions/models in a chart, colors wrap. Fine for typical use; the 8th item just shares brass with the 1st.
- The `tokensUsed` figure in Companion is global (not workspace-scoped). It refreshes every 30s. If the user wants per-workspace tokens, that's a future enhancement (requires scoping `useTokenStore.setScope`).
- The companion-toggle `⌘\` becomes a no-op (was previously cluttered with `showTokens`). Spec explicitly defers companion-hide; users will mostly use ⌘K + Settings now.

**Phase 6 ships when:**
- 4 implementation commits land on the branch.
- typecheck + tests pass.
- Visual smoke (Task 4 Step 3) confirms Settings opens correctly on both `⌘,` and `⌘⇧T`, Command Palette feels distinct from generic cmdk, and Companion's `tokens` row shows non-zero usage during a chat session.
