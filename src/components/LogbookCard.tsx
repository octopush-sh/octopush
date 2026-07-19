import { useEffect, useRef, useState } from "react";
import { ChevronRight, Maximize2 } from "lucide-react";
import { Reveal } from "./primitives/Reveal";
import { ipc } from "../lib/ipc";
import { useMissionsStore } from "../stores/missionsStore";
import { useChatStore } from "../stores/chatStore";
import { useRunsStore } from "../stores/runsStore";
import { fmtHours } from "../lib/logbook";
import type { LogbookMissionRow } from "../lib/types";

/**
 * The Logbook card — the free per-mission slice of the Logbook. Shows worked
 * hours + cost + savings for the active mission (mission scope is free; the
 * cross-mission Logbook Room is Pro). Loads on mission change; geometry is
 * reserved so nothing shifts while it resolves.
 */
export function LogbookCard({
  workspaceId,
  onOpenRoom,
}: {
  workspaceId: string;
  /** Opens the full Logbook Room (⌘⇧L) — the free card is its teaser. */
  onOpenRoom?: () => void;
}) {
  const missionId = useMissionsStore((s) => s.missionByWorkspaceId[workspaceId]?.id ?? null);
  // Refresh signals: a TALK turn completing (streaming true→false) and a DIRECT
  // run changing status both land new spend/hours we should re-read. Keyed on
  // status only (not cost) so live per-tick cost updates don't cause a fetch
  // storm — a run settling is the meaningful edge.
  const streaming = useChatStore((s) => s.streamingByWs[workspaceId] ?? false);
  const runsSig = useRunsStore((s) =>
    (s.runsByWs[workspaceId] ?? []).map((r) => r.status).join(","),
  );
  const [open, setOpen] = useState(true);
  const [row, setRow] = useState<LogbookMissionRow | null>(null);
  const [loaded, setLoaded] = useState(false);
  const seq = useRef(0);
  const prevMission = useRef<string | null>(null);

  useEffect(() => {
    if (!missionId) {
      seq.current += 1;
      prevMission.current = null;
      setRow(null);
      setLoaded(false);
      return;
    }
    // Clear only when the mission itself changed — a plain refresh updates the
    // figures in place, so numbers never blink to empty on a background refetch.
    if (prevMission.current !== missionId) {
      prevMission.current = missionId;
      setRow(null);
      setLoaded(false);
    }
    const token = ++seq.current;
    const to = new Date().toISOString();
    const from = "2000-01-01T00:00:00+00:00"; // mission lifetime
    void ipc
      .logbookSummary("mission", missionId, from, to)
      .then((rows) => {
        if (seq.current !== token) return; // a newer load superseded this one
        setRow(rows[0] ?? null);
        setLoaded(true);
      })
      .catch(() => {
        if (seq.current === token) setLoaded(true);
      });
  }, [missionId, streaming, runsSig]);

  if (!missionId) return null;

  const hasWork = !!row && (row.hoursSecs > 0 || row.costUsd > 0);

  return (
    <div className="border-t border-octo-hairline px-3 py-2.5">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title="This mission's worked time and spend"
          className="flex flex-1 items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute transition-colors duration-[220ms] hover:text-octo-sage focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
        >
          <ChevronRight
            size={11}
            aria-hidden
            className={`transition-transform duration-[220ms] ${open ? "rotate-90" : ""}`}
          />
          Logbook
        </button>
        {onOpenRoom && (
          <button
            type="button"
            onClick={onOpenRoom}
            title="Open the Logbook"
            aria-label="Open the Logbook"
            className="shrink-0 text-octo-mute transition-colors duration-[180ms] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
          >
            <Maximize2 size={11} aria-hidden />
          </button>
        )}
      </div>
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
