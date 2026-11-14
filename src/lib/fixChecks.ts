import { ipc } from "./ipc";
import { failedRunIds, fixChecksBrief } from "./prChecks";
import type { Pr } from "./types";
import { useRunsStore } from "../stores/runsStore";

/** PR chip "Fix failing checks…": read the failed runs' log tail, then seed
 *  this workspace's Direct launcher with the brief and show the launcher. The
 *  empty `pipelineId` fills in the brief only, so the launcher keeps its usual
 *  crew selection; nothing starts until the user presses Start. A log that
 *  can't be read, or checks with no Actions run, still give a brief that
 *  names the failed checks — just without the log section. */
export async function prefillFixChecks(pr: Pr, workspaceId: string, workspacePath: string): Promise<void> {
  if (!pr.checks) return;
  const runIds = failedRunIds(pr.checks);
  const log = runIds.length
    ? await ipc.prFailedCheckLogs(workspacePath, runIds).catch(() => "")
    : "";
  const runs = useRunsStore.getState();
  runs.setLauncherPrefill({
    task: fixChecksBrief(pr, log),
    pipelineId: "",
    overrides: [],
    workspaceId,
  });
  runs.selectRun(workspaceId, null);
}
