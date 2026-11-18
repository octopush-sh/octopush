import { useShallow } from "zustand/react/shallow";
import { Activity, Check, Square } from "lucide-react";
import { useRunsStore } from "../stores/runsStore";
import { fleetCounts, settledCounts } from "../lib/runStatus";

/** The fleet chip — the top-bar entry to Mission Control. Attention split,
 *  per Law 2's fleet scope (the chip is the ONE thing outside Mission Control
 *  that may pulse): a run waiting on the director → brass `{n} needs you`,
 *  the chip's only pulse trigger; else a run running with nobody waiting →
 *  quiet hairline `{n} in flight`, no pulse (sage — nothing needs you *yet*);
 *  else runs settled this session or while the app was closed (undismissed) →
 *  verdigris `✓ {n} done` (completed runs only — an aborted or failed run is
 *  never "done", #845), or, with nothing completed, a muted `■ {n} ended`,
 *  so the entry doesn't vanish the moment your background work finishes. Hidden
 *  only when the board is truly empty. Clicking opens Mission Control (which
 *  replaced the old popover — one canonical surface for the fleet). */
export function RunsTray({ onOpen }: { onOpen: () => void }) {
  // One shallow-compared triple: needs-you count (same predicate as Mission
  // Control's Needs-you band), in-flight (running, nobody waiting) count, and
  // settled split (completed vs. aborted/failed).
  const [needsYouCount, inFlightCount, doneCount, endedCount] = useRunsStore(
    useShallow((s): [number, number, number, number] => {
      const runs = Object.values(s.runsByWs).flat();
      const { needsYou, inFlight } = fleetCounts(runs);
      const { done, ended } = settledCounts(runs, s.settledAt);
      return [needsYou, inFlight, done, ended];
    }),
  );

  if (needsYouCount === 0 && inFlightCount === 0 && doneCount === 0 && endedCount === 0) return null;

  if (needsYouCount > 0) {
    const label = `${needsYouCount} run${needsYouCount > 1 ? "s" : ""} need${needsYouCount > 1 ? "" : "s"} you — open Mission Control`;
    return (
      <button
        type="button"
        onClick={onOpen}
        aria-label={label}
        title={label}
        data-tour="fleet-chip"
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
        data-tour="fleet-chip"
        className="octo-pop-in flex items-center gap-1.5 rounded border border-octo-hairline px-2 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-octo-sage transition hover:bg-octo-panel-2"
      >
        <Activity size={12} className="shrink-0" />
        {inFlightCount} in flight
      </button>
    );
  }

  if (doneCount > 0) {
    const others = endedCount > 0 ? `, ${endedCount} ended` : "";
    const label = `${doneCount} run${doneCount > 1 ? "s" : ""} done${others} — open Mission Control`;
    return (
      <button
        type="button"
        onClick={onOpen}
        aria-label={label}
        title={label}
        data-tour="fleet-chip"
        className="octo-pop-in flex items-center gap-1.5 rounded px-2 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-octo-verdigris transition hover:bg-[var(--brass-ghost)]"
      >
        <Check size={12} className="shrink-0" />
        {doneCount} done
      </button>
    );
  }

  const label = `${endedCount} run${endedCount > 1 ? "s" : ""} ended without completing — open Mission Control`;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      title={label}
      data-tour="fleet-chip"
      className="octo-pop-in flex items-center gap-1.5 rounded px-2 py-1 font-mono text-[10px] uppercase tracking-[0.15em] text-octo-mute transition hover:bg-octo-panel-2"
    >
      <Square size={10} className="shrink-0" />
      {endedCount} ended
    </button>
  );
}
