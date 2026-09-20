import { useEffect, useRef, useState } from "react";
import { ipc } from "../lib/ipc";
import { useMissionsStore } from "../stores/missionsStore";
import { useChatStore } from "../stores/chatStore";
import { useRunsStore } from "../stores/runsStore";
import type { LogbookMissionRow } from "../lib/types";

/**
 * The active mission's Logbook slice (worked hours + cost + savings) for a
 * workspace. Loads on mission change and re-reads when a TALK turn settles
 * (streaming true→false) or a DIRECT run changes status — the edges that
 * land new spend/hours. Figures update in place on a refresh (never blink
 * to empty); they clear only when the mission itself changes.
 */
export function useMissionLogbook(workspaceId: string): {
  missionId: string | null;
  row: LogbookMissionRow | null;
  loaded: boolean;
} {
  const missionId = useMissionsStore((s) => s.missionByWorkspaceId[workspaceId]?.id ?? null);
  const streaming = useChatStore((s) => s.streamingByWs[workspaceId] ?? false);
  // Keyed on status only (not cost) so live per-tick cost updates don't
  // cause a fetch storm — a run settling is the meaningful edge.
  const runsSig = useRunsStore((s) => (s.runsByWs[workspaceId] ?? []).map((r) => r.status).join(","));
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

  return { missionId, row, loaded };
}
