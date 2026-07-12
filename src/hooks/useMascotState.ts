import { useAttentionStore } from "../stores/attentionStore";
import { useChatStore } from "../stores/chatStore";
import { useRunsStore } from "../stores/runsStore";
import type { OctoState } from "../components/icons/OctoMark";

/** Derives the top-bar mascot's body language from real app state.
 *  Priority: something needs you (blocked) > agents working > idle.
 *  A `paused` Direct run (checkpoint gate / budget park / halt) is
 *  waiting on the director, not working — it counts as needs-you,
 *  matching Mission Control's triage semantics. */
export function useMascotState(): { state: OctoState; label: string } {
  const attention = useAttentionStore((s) => Object.keys(s.flagsByWs).length);
  const streaming = useChatStore(
    (s) => Object.values(s.streamingByWs).filter(Boolean).length,
  );
  const runningRuns = useRunsStore(
    (s) =>
      Object.values(s.runsByWs)
        .flat()
        .filter((r) => r.status === "running").length,
  );
  const pausedRuns = useRunsStore(
    (s) =>
      Object.values(s.runsByWs)
        .flat()
        .filter((r) => r.status === "paused").length,
  );

  const needsYou = attention + pausedRuns;
  if (needsYou > 0) {
    return {
      state: "blocked",
      label: `Octopush — ${needsYou} need${needsYou > 1 ? "" : "s"} you`,
    };
  }
  const working = streaming + runningRuns;
  if (working > 0) {
    return {
      state: "working",
      label: `Octopush — ${working} agent${working > 1 ? "s" : ""} working`,
    };
  }
  return { state: "idle", label: "Octopush — idle" };
}
