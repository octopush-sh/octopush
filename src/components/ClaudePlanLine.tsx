import { useEffect, useState } from "react";
import { useClaudePlanStore } from "../stores/claudePlanStore";
import { ageLabel, latestSeen, planLine, planTone, planWarning, toneClass } from "../lib/claudePlan";

/** Re-render on a slow clock so the snapshot's age and "reset since" stay true. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * The Claude plan's headroom as a mono-meta line in the Companion:
 * `Claude plan · 5h 62% · resets 19:40 · week 31%` and its age. Sage, amber
 * at ≥ 80%, rouge when a window is used up, with one calm sentence when it
 * matters. Renders nothing until a Claude-plan stage has reported, so an
 * API-key user never sees it. `reloadKey` re-reads the snapshot when it
 * changes (a detached run's worker writes it without an app event).
 */
export function ClaudePlanLine({ reloadKey }: { reloadKey?: unknown }) {
  const windows = useClaudePlanStore((s) => s.windows);
  const load = useClaudePlanStore((s) => s.load);
  const now = useNow(30_000);
  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  if (windows.length === 0) return null;
  const tone = planTone(windows, now);
  const warning = planWarning(windows, now);
  const seen = latestSeen(windows);
  return (
    <div data-tour="companion-claude-plan" className="octo-fade-in mt-1.5">
      <div
        className={`flex flex-wrap items-baseline gap-x-2 font-mono text-[10px] transition-colors duration-[220ms] ${toneClass(tone)}`}
        title="What Claude Code last reported about your Claude plan's usage windows — a snapshot, not a live reading."
      >
        <span className="octo-tabular">{planLine(windows, now)}</span>
        {seen && <span className="text-octo-mute">{ageLabel(seen, now)}</span>}
      </div>
      {warning && (
        <p className="octo-fade-in mt-1 text-[11px] leading-[1.45] text-octo-sage" data-testid="claude-plan-warning">
          {warning}
        </p>
      )}
    </div>
  );
}
