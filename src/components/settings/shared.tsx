// Shared primitives for the Settings panes — page/section headers, the toggle
// row, stat/row helpers, token formatting, and the theme-reactive chart-color
// hook. Kept in one small module so panes stay focused on their own concern.
import { useEffect, useState } from "react";
import { useThemeStore } from "../../stores/themeStore";

// ─── Headers ──────────────────────────────────────────────────────────

export function PaneHeader({ eyebrow, title, subtitle }: {
  eyebrow: string;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="mb-8">
      <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-brass">
        {eyebrow}
      </div>
      <h2 className="mt-2 font-serif text-[22px] leading-tight tracking-[-0.005em] text-octo-ivory">
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

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-3 font-mono text-[9px] uppercase tracking-[0.3em] text-octo-mute">
      {children}
    </div>
  );
}

// ─── Toggle row ───────────────────────────────────────────────────────

export function ToggleRow({
  label,
  description,
  checked,
  onChange,
  testId,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  testId?: string;
}) {
  return (
    <label
      className="flex cursor-pointer items-start justify-between gap-4 rounded-lg px-4 py-3"
      style={{
        border: "1px solid var(--color-octo-hairline)",
        background: "var(--color-octo-panel)",
      }}
    >
      <div className="min-w-0 flex-1">
        <div className="font-serif text-[14px] leading-tight text-octo-ivory">
          {label}
        </div>
        {description && (
          <div className="mt-1 text-[12px] leading-[1.55] text-octo-sage">
            {description}
          </div>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        data-testid={testId}
        onClick={() => onChange(!checked)}
        className="relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors"
        style={{
          background: checked ? "var(--brass-ghost)" : "var(--color-octo-onyx)",
          border: `1px solid ${checked ? "var(--brass-dim)" : "var(--color-octo-hairline)"}`,
        }}
      >
        <span
          className="absolute top-[2px] h-3.5 w-3.5 rounded-full transition-all"
          style={{
            left: checked ? "18px" : "3px",
            background: checked ? "var(--color-octo-brass)" : "var(--color-octo-mute)",
          }}
        />
      </button>
    </label>
  );
}

// ─── Small data helpers ───────────────────────────────────────────────

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-octo-hairline bg-octo-panel px-3 py-3">
      <div className="font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute">
        {label}
      </div>
      <div className="octo-tabular mt-1.5 font-serif text-[18px] tracking-[-0.005em] text-octo-ivory">
        {value}
      </div>
    </div>
  );
}

export function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="font-sans text-octo-sage">{label}</span>
      <span className="octo-tabular font-mono text-octo-ivory">{value}</span>
    </div>
  );
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ms).toLocaleString();
}

// ─── Theme-reactive chart colors ──────────────────────────────────────

export interface ChartColors {
  accent: string;
  tooltipBg: string;
  hairline: string;
  ivory: string;
  mute: string;
  sage: string;
  /** Categorical series palette, all derived from live tokens. */
  series: string[];
}

function readVar(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const v = style.getPropertyValue(name).trim();
  return v || fallback;
}

/** Reads chart colors from the live CSS custom properties so Recharts (which
 *  needs concrete colors, not `var(--…)`) follows the active theme. Recomputes
 *  whenever the theme changes — both via the store and the `octo:theme` event
 *  that themeStore dispatches after it rewrites the root variables. */
export function useChartColors(): ChartColors {
  const themeName = useThemeStore((s) => s.theme?.name ?? null);
  const [colors, setColors] = useState<ChartColors>(readChartColors);

  useEffect(() => {
    setColors(readChartColors());
    const onTheme = () => setColors(readChartColors());
    window.addEventListener("octo:theme", onTheme);
    return () => window.removeEventListener("octo:theme", onTheme);
  }, [themeName]);

  return colors;
}

function readChartColors(): ChartColors {
  // Guard for non-DOM test environments.
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") {
    return {
      accent: "#d4a574",
      tooltipBg: "#14110d",
      hairline: "#2a2419",
      ivory: "#f4ecdb",
      mute: "#6d6354",
      sage: "#95897a",
      series: ["#d4a574", "#8fc9a8", "#7a9cb8", "#a888b8", "#d18b8b", "#6d6354"],
    };
  }
  const s = getComputedStyle(document.documentElement);
  const accent = readVar(s, "--color-octo-brass", "#d4a574");
  const verdigris = readVar(s, "--color-octo-verdigris", "#8fc9a8");
  const stateBlue = readVar(s, "--color-octo-state-blue", "#7a9cb8");
  const statePurple = readVar(s, "--color-octo-state-purple", "#a888b8");
  const rouge = readVar(s, "--color-octo-rouge", "#d18b8b");
  const mute = readVar(s, "--color-octo-mute", "#6d6354");
  return {
    accent,
    tooltipBg: readVar(s, "--color-octo-panel", "#14110d"),
    hairline: readVar(s, "--color-octo-hairline", "#2a2419"),
    ivory: readVar(s, "--color-octo-ivory", "#f4ecdb"),
    mute,
    sage: readVar(s, "--color-octo-sage", "#95897a"),
    series: [accent, verdigris, stateBlue, statePurple, rouge, mute],
  };
}
