import { OctoPlayer, ROLES, roleForToolName, type OctoRole } from "../OctoPlayer";
import type { LiveEntry, RunStage, RunStageStatus } from "../../lib/ipc";

/** The Player's script for DIRECT: what is the focused stage doing right now?
 *  awaiting_checkpoint = someone must answer; otherwise the newest journal
 *  entry tells the story — a tool entry acts its family, model prose acts
 *  Writing, anything else is thought. */
export function roleForStage(entries: LiveEntry[], status: RunStageStatus): OctoRole {
  if (status === "awaiting_checkpoint") return ROLES.wait;
  const last = entries[entries.length - 1];
  if (last?.kind === "tool") return roleForToolName(last.tool) ?? ROLES.work;
  if (last?.kind === "text") return ROLES.write;
  return ROLES.think;
}

/** DIRECT adapter over the shared OctoPlayer: narrates the focused stage's
 *  work journal. A `done` stage earns the ✓ beat; a `failed` one leaves
 *  quietly; switching focused stages hard-resets (identity = stage id). */
export function StageOctoStatus({
  stage,
  entries,
}: {
  stage: RunStage | null;
  entries: LiveEntry[];
}) {
  const status: RunStageStatus = stage?.status ?? "pending";
  return (
    <OctoPlayer
      identity={String(stage?.id ?? "none")}
      active={status === "running" || status === "awaiting_checkpoint"}
      role={roleForStage(entries, status)}
      skipBeat={status === "failed"}
    />
  );
}
