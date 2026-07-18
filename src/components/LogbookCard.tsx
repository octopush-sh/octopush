import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Reveal } from "./primitives/Reveal";
import { ipc } from "../lib/ipc";
import { useMissionsStore } from "../stores/missionsStore";
import type { LogbookMissionRow } from "../lib/types";

/** Compact worked-time formatting: `45s` · `12m` · `3h 20m`. */
function fmtHours(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * The Logbook card — the free per-mission slice of the Logbook. Shows worked
 * hours + cost + savings for the active mission (mission scope is free; the
 * cross-mission Logbook Room is Pro). Loads on mission change; geometry is
 * reserved so nothing shifts while it resolves.
 */
export function LogbookCard({ workspaceId }: { workspaceId: string }) {
  const missionId = useMissionsStore((s) => s.missionByWorkspaceId[workspaceId]?.id ?? null);
  const [open, setOpen] = useState(true);
  const [row, setRow] = useState<LogbookMissionRow | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!missionId) {
      setRow(null);
      setLoaded(false);
      return;
    }
    let cancelled = false;
    setLoaded(false);
    const to = new Date().toISOString();
    const from = "2000-01-01T00:00:00+00:00"; // mission lifetime
    void ipc
      .logbookSummary("mission", missionId, from, to)
      .then((rows) => {
        if (cancelled) return;
        setRow(rows[0] ?? null);
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [missionId]);

  if (!missionId) return null;

  const hasWork = !!row && (row.hoursSecs > 0 || row.costUsd > 0);

  return (
    <div className="border-t border-octo-hairline px-3 py-2.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="This mission's worked time and spend"
        className="flex w-full items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute transition-colors duration-[220ms] hover:text-octo-sage focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
      >
        <ChevronRight
          size={11}
          aria-hidden
          className={`transition-transform duration-[220ms] ${open ? "rotate-90" : ""}`}
        />
        Logbook
      </button>
      <Reveal open={open} className="mt-2">
        {/* Reserved-height row so the figures fading in never shift layout. */}
        <div className="flex h-4 items-baseline gap-4 font-mono text-[11px]">
          {hasWork ? (
            <>
              <span
                className="octo-fade-in octo-tabular text-octo-sage"
                title="Worked time (activity-span union)"
              >
                {fmtHours(row!.hoursSecs)}
              </span>
              <span className="octo-fade-in octo-tabular text-octo-brass" title="Spend on this mission">
                ${row!.costUsd.toFixed(2)}
              </span>
              {row!.savingsUsd > 0 && (
                <span
                  className="octo-fade-in octo-tabular text-octo-verdigris"
                  title="Saved vs an all-premium baseline"
                >
                  saved ${row!.savingsUsd.toFixed(2)}
                </span>
              )}
            </>
          ) : (
            <span className="text-[10px] text-octo-mute">
              {loaded ? "No work recorded yet." : ""}
            </span>
          )}
        </div>
      </Reveal>
    </div>
  );
}
