import { formatContextTokens } from "../lib/cost";

export type ContextTone = "ok" | "warning" | "rouge";

/** How full a context window is: the share used (0–100) and the tone it is
 *  drawn in — brass, amber past 80%, rouge past 95%. A window of 0 (unknown)
 *  is 0% and calm. */
export function contextTone(used: number, limit: number): { pct: number; tone: ContextTone } {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  return { pct, tone: pct >= 95 ? "rouge" : pct >= 80 ? "warning" : "ok" };
}

const TONE_COLOR: Record<ContextTone, string> = {
  ok: "var(--color-octo-brass)",
  warning: "var(--color-octo-warning)",
  rouge: "var(--color-octo-rouge)",
};

interface Props {
  /** The last prompt's size, in tokens. */
  used: number;
  /** The model's context window. `null` when it isn't known: the figure then
   *  stands alone, with no window and no bar, rather than against a guess. */
  limit: number | null;
  /** A leading label: Talk's `context` row, whose figure takes the tone.
   *  Without one the figure leads in ivory (the section's eyebrow already
   *  says what it measures) and only the bar carries the tone. */
  label?: string;
  title?: string;
  testId?: string;
}

/**
 * The context meter: `148k / 1M` over a thin bar. One component for Talk's
 * Conversation section and Run's Context section, so the figure, the bar
 * and the two thresholds read the same in both. The bar's width is the
 * percentage; it is never also printed (design-system §9).
 */
export function ContextMeter({ used, limit, label, title, testId }: Props) {
  const { pct, tone } = contextTone(used, limit ?? 0);
  const color = TONE_COLOR[tone];
  const figure =
    limit != null ? `${formatContextTokens(used)} / ${formatContextTokens(limit)}` : formatContextTokens(used);
  return (
    <div data-testid={testId} data-tone={tone}>
      <div className="flex items-baseline justify-between gap-3" title={title}>
        {label != null && <span className="shrink-0">{label}</span>}
        <span
          className={`octo-tabular truncate font-mono ${label != null ? "text-[10px]" : "text-[12px] text-octo-ivory"}`}
          style={label != null ? { color } : undefined}
        >
          {figure}
        </span>
      </div>
      {limit != null && (
        <div className="mt-1.5 h-[3px] rounded-sm" style={{ background: "var(--color-octo-hairline)" }}>
          <div
            className="h-full rounded-sm transition-[width] duration-[220ms]"
            style={{ width: `${pct}%`, background: color }}
          />
        </div>
      )}
    </div>
  );
}
