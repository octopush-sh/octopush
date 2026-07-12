import { useAttentionStore } from "../stores/attentionStore";
import { useChatStore } from "../stores/chatStore";
import { useRunsStore } from "../stores/runsStore";
import type { OctoState } from "../components/icons/OctoMark";

/** Derives the top-bar mascot's body language from real app state.
 *  Priority: something needs you (blocked) > agents working > idle. */
export function useMascotState(): { state: OctoState; label: string } {
  const attention = useAttentionStore((s) => Object.keys(s.flagsByWs).length);
  const streaming = useChatStore(
    (s) => Object.values(s.streamingByWs).filter(Boolean).length,
  );
  const activeRuns = useRunsStore(
    (s) =>
      Object.values(s.runsByWs)
        .flat()
        .filter((r) => r.status === "running" || r.status === "paused").length,
  );

  if (attention > 0) {
    return {
      state: "blocked",
      label: `Octopush — ${attention} workspace${attention > 1 ? "s" : ""} need${attention > 1 ? "" : "s"} you`,
    };
  }
  const working = streaming + activeRuns;
  if (working > 0) {
    return {
      state: "working",
      label: `Octopush — ${working} agent${working > 1 ? "s" : ""} working`,
    };
  }
  return { state: "idle", label: "Octopush — idle" };
}
