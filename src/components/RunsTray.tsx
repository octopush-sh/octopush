import { useShallow } from "zustand/react/shallow";
import { Activity, Check } from "lucide-react";
import { useRunsStore } from "../stores/runsStore";

/** The fleet chip — the top-bar entry to Mission Control. Two states:
 *  active runs in flight → brass `Activity {n} run(s)`; none active but runs
 *  settled this session (undismissed) → verdigris `✓ {n} done`, so the entry
 *  doesn't vanish the moment your background work finishes. Hidden only when
 *  the board is truly empty. Clicking opens the Mission Control room (which
 *  replaced the old popover — one canonical surface for the fleet). */
export function RunsTray({ onOpen }: { onOpen: () => void }) {
  // One shallow-compared tuple: active count + combined live cost + settled
  // count. The combined figure keeps the A3 "live spend across active runs"
  // number one hover away, without opening the room.
  const [activeCount, totalCost, settledCount] = useRunsStore(
    useShallow((s): [number, number, number] => {
      const active = Object.values(s.runsByWs)
        .flat()
        .filter((r) => r.status === "running" || r.status === "paused");
      return [
        active.length,
        active.reduce((sum, r) => sum + r.costUsd, 0),
        Object.keys(s.settledAt).length,
      ];
    }),
  );

  if (activeCount === 0 && settledCount === 0) return null;

  const active = activeCount > 0;
  const label = active
    ? `${activeCount} run${activeCount > 1 ? "s" : ""} in progress · $${totalCost.toFixed(2)} combined — open Mission Control`
    : `${settledCount} run${settledCount > 1 ? "s" : ""} settled — open Mission Control`;

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      title={label}
      className={`octo-pop-in flex items-center gap-1.5 rounded px-2 py-1 font-mono text-[10px] uppercase tracking-[0.15em] transition hover:bg-[var(--brass-ghost)] ${
        active ? "text-octo-brass" : "text-octo-verdigris"
      }`}
    >
      {active ? <Activity size={12} className="shrink-0" /> : <Check size={12} className="shrink-0" />}
      {active
        ? `${activeCount} ${activeCount > 1 ? "runs" : "run"}`
        : `${settledCount} done`}
    </button>
  );
}
