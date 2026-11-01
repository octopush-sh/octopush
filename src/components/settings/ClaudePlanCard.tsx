// Settings → Usage: the Claude plan card. Every window a Claude-plan CLI
// stage last reported (5-hour, weekly, per-model weekly, and any kind Claude
// Code adds later), with how much is used, when it resets and how old the
// reading is. Hidden until such a stage has reported — API-key users never
// see it.
import { useEffect } from "react";
import { useClaudePlanStore } from "../../stores/claudePlanStore";
import { useNow } from "../ClaudePlanLine";
import {
  ageLabel, hasReset, orderWindows, pctLabel, planWarning, resetLabel, toneClass, toneColor, windowName, windowTone,
} from "../../lib/claudePlan";
import { SectionLabel } from "./shared";

const RELOAD_MS = 30_000;

export function ClaudePlanCard() {
  const windows = useClaudePlanStore((s) => s.windows);
  const load = useClaudePlanStore((s) => s.load);
  const now = useNow(RELOAD_MS);
  useEffect(() => {
    void load();
  }, [load, now]);

  if (windows.length === 0) return null;
  const warning = planWarning(windows, now);
  return (
    <div className="octo-fade-in mt-8 max-w-[860px]" data-tour="usage-claude-plan">
      <SectionLabel>Claude plan</SectionLabel>
      <ul className="space-y-1.5" data-testid="usage-claude-plan">
        {orderWindows(windows).map((w) => {
          const reset = hasReset(w, now);
          const tone = windowTone(w, now);
          const name = windowName(w.kind);
          const used = reset
            ? "reset since"
            : w.status === "rejected" && w.utilization == null
              ? "limit reached"
              : pctLabel(w.utilization);
          const width = reset || w.utilization == null ? 0 : Math.min(100, Math.max(0, w.utilization * 100));
          const meta = [
            w.resetsAt != null ? `${reset ? "reset" : "resets"} ${resetLabel(w.resetsAt, now)}` : null,
            ageLabel(w.seenAt, now),
            w.usingOverage ? "using extra usage" : null,
          ].filter(Boolean).join(" · ");
          return (
            <li key={w.kind} className="octo-rise-in rounded-md border border-octo-hairline bg-octo-panel px-3 py-2">
              <div className="flex items-baseline gap-3">
                <span className="min-w-0 flex-1 truncate font-serif text-[13px] text-octo-ivory" title={w.kind}>
                  {name.charAt(0).toUpperCase()}{name.slice(1)}
                </span>
                <span className={`octo-tabular shrink-0 font-mono text-[11px] ${toneClass(tone)}`}>{used}</span>
              </div>
              <div className="mt-1.5 h-[2px] rounded-sm" style={{ background: "var(--color-octo-hairline)" }}>
                <div className="h-full rounded-sm transition-[width] duration-[320ms]" style={{ width: `${width}%`, background: toneColor(tone) }} />
              </div>
              <div className="octo-tabular mt-1 font-mono text-[10px] text-octo-mute">{meta}</div>
            </li>
          );
        })}
      </ul>
      {warning && <p className="octo-fade-in mt-2 text-[12px] text-octo-sage">{warning}</p>}
      <p className="mt-2 text-[11px] leading-[1.55] text-octo-mute">
        As your Claude Code stages last reported it while running on your Claude plan. It updates when the next one runs.
      </p>
    </div>
  );
}
