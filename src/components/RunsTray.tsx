import { useShallow } from "zustand/react/shallow";
import { Activity, Check } from "lucide-react";
import { useRunsStore } from "../stores/runsStore";
import { needsYou } from "../lib/runStatus";

/** The fleet chip — the top-bar entry to Mission Control. Attention split,
 *  per Law 2's fleet scope (the chip is the ONE thing outside Mission Control
 *  that may pulse): a run waiting on the director → brass `{n} needs you`,
 *  the chip's only pulse trigger; else a run running with nobody waiting →
 *  quiet hairline `{n} in flight`, no pulse (sage — nothing needs you *yet*);
 *  else runs settled this session (undismissed) → verdigris `✓ {n} done`, so
 *  the entry doesn't vanish the moment your background work finishes. Hidden
 *  only when the board is truly empty. Clicking opens Mission Control (which
 *  replaced the old popover — one canonical surface for the fleet). */
export function RunsTray({ onOpen }: { onOpen: () => void }) {
  // One shallow-compared triple: needs-you count (same predicate as Mission
  // Control's Needs-you band), in-flight (running, nobody waiting) count, and
  // settled count.
  const [needsYouCount, inFlightCount, settledCount] = useRunsStore(
    useShallow((s): [number, number, number] => {
      const all = Object.values(s.runsByWs).flat();
      let needs = 0;
      let flight = 0;
      for (const r of all) {
        if (needsYou(r)) needs += 1;
        else if (r.status === "running") flight += 1;
      }
      return [needs, flight, Object.keys(s.settledAt).length];
    }),
  );

  if (needsYouCount === 0 && inFlightCount === 0 && settledCount === 0) return null;

  if (needsYouCount > 0) {
    const label = `${needsYouCount} run${needsYouCount > 1 ? "s" : ""} need${needsYouCount > 1 ? "" : "s"} you — open Mission Control`;
    return (
      <button
        type="button"
        onClick={onOpen}
        aria-label={label}
        title={label}
        className="octo-pop-in octo-stage-pulse flex items-center gap-1.5 rounded px-2 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-octo-brass transition hover:bg-[var(--brass-ghost)]"
      >
        <Activity size={12} className="shrink-0" />
        {needsYouCount} needs you
      </button>
    );
  }

  if (inFlightCount > 0) {
    const label = `${inFlightCount} run${inFlightCount > 1 ? "s" : ""} in flight — open Mission Control`;
    return (
      <button
        type="button"
        onClick={onOpen}
        aria-label={label}
        title={label}
        className="octo-pop-in flex items-center gap-1.5 rounded border border-octo-hairline px-2 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-octo-sage transition hover:bg-octo-panel-2"
      >
        <Activity size={12} className="shrink-0" />
        {inFlightCount} in flight
      </button>
    );
  }

  const label = `${settledCount} run${settledCount > 1 ? "s" : ""} settled — open Mission Control`;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      title={label}
      className="octo-pop-in flex items-center gap-1.5 rounded px-2 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-octo-verdigris transition hover:bg-[var(--brass-ghost)]"
    >
      <Check size={12} className="shrink-0" />
      {settledCount} done
    </button>
  );
}
