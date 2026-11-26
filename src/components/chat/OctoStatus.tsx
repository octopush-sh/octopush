import { OctoPlayer, ROLES, roleForToolName, type OctoRole } from "../OctoPlayer";
import type { LiveTool } from "../../stores/chatStore";
import { isAgentToolName } from "../../lib/agentTools";

export type { OctoRole };

/** The Player's script for TALK: what is the turn actually doing right now?
 *  Priority: someone must answer (wait) > a retry or pause notice > a live
 *  tool > text flowing > thought. */
export function roleForActivity(args: {
  approvals: number;
  liveTools: LiveTool[];
  streamBuffer: string;
  /** The director's live notice ("Model overloaded — retrying in 8s …"). */
  notice?: string | null;
}): OctoRole {
  if (args.approvals > 0) return ROLES.wait;
  if (args.notice) return { ...ROLES.retry, label: args.notice };
  const live = [...args.liveTools].reverse().find((t) => !t.done);
  // A running crew reads as delegation, whatever the last card was.
  if (live && isAgentToolName(live.toolName)) return ROLES.delegate;
  if (live) return roleForToolName(live.toolName) ?? ROLES.work;
  if (args.streamBuffer) return ROLES.write;
  return ROLES.think;
}

interface Props {
  /** Identity of the conversation — a change hard-resets the machine so a
   *  workspace switch can never play a phantom ✓ in the wrong chat. */
  workspaceId: string;
  streaming: boolean;
  hasError: boolean;
  /** True when the user pressed Stop this turn — an aborted run leaves
   *  quietly, it is not celebrated. */
  wasStopped: boolean;
  streamBuffer: string;
  liveTools: LiveTool[];
  approvals: number;
  /** The director's retry / rate-limit notice for this thread, if any. */
  notice?: string | null;
}

/** TALK adapter over the shared OctoPlayer (spec 2026-07-19 §4). */
export function OctoStatus({
  workspaceId,
  streaming,
  hasError,
  wasStopped,
  streamBuffer,
  liveTools,
  approvals,
  notice = null,
}: Props) {
  return (
    <OctoPlayer
      identity={workspaceId}
      active={streaming || approvals > 0}
      role={roleForActivity({ approvals, liveTools, streamBuffer, notice })}
      skipBeat={hasError || wasStopped}
    />
  );
}
