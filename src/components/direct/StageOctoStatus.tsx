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
 *  work journal as an inline row (not pinned to the canvas bottom, where it
 *  read as a stalled stage). StageFocus docks it at the live journal's tail,
 *  or right under the header in any other active state. A `done` stage earns
 *  the ✓ beat; a `failed` one leaves quietly; switching focused stages
 *  hard-resets (identity = stage id). An aborted run (`runAborted`) leaves
 *  its stage row frozen at running / awaiting_checkpoint — the Player leaves
 *  quietly then too, so the pane never keeps saying "Waiting for you" (#844). */
export function StageOctoStatus({
  stage,
  entries,
  runAborted = false,
}: {
  stage: RunStage | null;
  entries: LiveEntry[];
  runAborted?: boolean;
}) {
  const status: RunStageStatus = stage?.status ?? "pending";
  return (
    <OctoPlayer
      identity={String(stage?.id ?? "none")}
      active={!runAborted && (status === "running" || status === "awaiting_checkpoint")}
      role={roleForStage(entries, status)}
      skipBeat={runAborted || status === "failed"}
      placement="inline"
    />
  );
}
