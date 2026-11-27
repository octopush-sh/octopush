import { Hourglass } from "lucide-react";
import { queuedLine, waitingLine } from "../lib/prerequisite";
import { usePrerequisitesStore } from "../stores/prerequisitesStore";
import { findWorkspaceName, useWorkspaceStore } from "../stores/workspaceStore";

/** The waiting mission's line ("Starts after auth-flow's run passes its last
 *  gate", or, once met but queued for the launcher, "… Ready to start once
 *  you open docs in Direct"), or null while it waits on nothing (#960). */
function usePrerequisiteLine(workspaceId: string): string | null {
  const link = usePrerequisitesStore((s) => s.byWs[workspaceId]);
  const hold = usePrerequisitesStore((s) => s.holdByWs[workspaceId] ?? null);
  const queued = usePrerequisitesStore((s) => s.queuedByWs[workspaceId]);
  const afterName = useWorkspaceStore((s) => (link ? findWorkspaceName(s.workspacesByProjectId, link.afterWorkspaceId) : null));
  const seededName = useWorkspaceStore((s) => (queued ? findWorkspaceName(s.workspacesByProjectId, queued) : null));
  if (!link || !afterName) return null;
  if (queued !== undefined) return queuedLine(link.afterCondition, afterName, seededName);
  return waitingLine(link.afterCondition, afterName, hold);
}

/** Rail row meta: a mute hourglass while the mission waits on another. */
export function PrerequisiteMark({ workspaceId }: { workspaceId: string }) {
  const line = usePrerequisiteLine(workspaceId);
  if (!line) return null;
  return (
    <span role="img" aria-label={line} title={line} data-tour="rail-prerequisite" className="octo-pop-in flex">
      <Hourglass size={10} strokeWidth={1.75} aria-hidden />
    </span>
  );
}

/** Mission Control card: the same wait as one mute line. */
export function PrerequisiteCardLine({ workspaceId }: { workspaceId: string }) {
  const line = usePrerequisiteLine(workspaceId);
  if (!line) return null;
  return (
    <span data-tour="mission-control-card-prerequisite" title={line} className="octo-fade-in flex min-w-0 items-center gap-1.5 font-mono text-[10px] text-octo-mute">
      <Hourglass size={10} strokeWidth={1.75} aria-hidden className="shrink-0" />
      <span className="min-w-0 truncate">{line}</span>
    </span>
  );
}
