import { useEffect } from "react";
import { useRunsStore } from "../stores/runsStore";
import { PipelineSetup } from "./PipelineSetup";
import { RunTrack, labelForRole } from "./RunTrack";
import { StageFocus } from "./StageFocus";
import { CheckpointBar } from "./CheckpointBar";
import { RunCostMeter } from "./RunCostMeter";

interface Props {
  active: boolean;
  workspaceId: string;
  defaultTask: string;
  linkedIssueKey: string | null;
  workspacePath: string;
}

export function DirectCanvas({ active, workspaceId, defaultTask, linkedIssueKey, workspacePath }: Props) {
  const loadRuns = useRunsStore((s) => s.loadRuns);
  const refreshDetail = useRunsStore((s) => s.refreshDetail);
  const viewedId = useRunsStore((s) => s.getViewedRunId(workspaceId));
  const detail = useRunsStore((s) => (viewedId ? s.getDetail(viewedId) : undefined));
  const selectedStageId = useRunsStore((s) => (viewedId ? s.getSelectedStageId(viewedId) : null));
  const selectStage = useRunsStore((s) => s.selectStage);
  const begin = useRunsStore((s) => s.begin);
  const resolve = useRunsStore((s) => s.resolve);
  const abort = useRunsStore((s) => s.abort);

  useEffect(() => { if (active) void loadRuns(workspaceId); }, [active, workspaceId, loadRuns]);
  useEffect(() => {
    if (active && viewedId && !detail?.run) void refreshDetail(viewedId);
  }, [active, viewedId, detail?.run, refreshDetail]);

  if (!viewedId || !detail?.run) {
    return (
      <PipelineSetup
        defaultTask={defaultTask}
        onBegin={(pipelineId, task, stageOverrides) =>
          void begin(workspaceId, pipelineId, task, stageOverrides, linkedIssueKey ?? undefined)
        }
      />
    );
  }

  const { run, stages } = detail;
  const activeStage =
    stages.find((s) => s.status === "running" || s.status === "awaiting_checkpoint" || s.status === "failed") ??
    [...stages].reverse().find((s) => s.status === "done") ??
    stages[0] ??
    null;
  const shownStageId = selectedStageId ?? activeStage?.id ?? null;
  const shownStage = stages.find((s) => s.id === shownStageId) ?? null;
  const blockedStage = stages.find((s) => s.status === "awaiting_checkpoint" || s.status === "failed") ?? null;

  // Compute loop props for CheckpointBar
  let loopTargetRole: string | null = null;
  let loopState: { iteration: number; max: number } | null = null;
  if (blockedStage && blockedStage.loopMode === "gated" && blockedStage.loopTargetPosition !== null && blockedStage.status === "awaiting_checkpoint") {
    const targetStage = stages.find((s) => s.position === blockedStage.loopTargetPosition);
    if (targetStage) {
      loopTargetRole = labelForRole(targetStage.role);
      loopState = { iteration: blockedStage.loopIterations, max: blockedStage.loopMaxIterations };
    }
  }

  return (
    <div className="flex h-full flex-col">
      <RunTrack
        run={run}
        stages={stages}
        selectedStageId={shownStageId}
        onSelectStage={(id) => selectStage(run.id, id)}
      />
      <StageFocus stage={shownStage} workspacePath={workspacePath} />
      <RunCostMeter run={run} stages={stages} />
      {run.status === "paused" && blockedStage && (
        <CheckpointBar
          blockedStage={blockedStage}
          onApprove={() => void resolve(run.id, "approve")}
          onReject={(feedback) => void resolve(run.id, "reject", feedback || undefined)}
          onAbort={() => void abort(run.id)}
          loopTargetRole={loopTargetRole}
          loopState={loopState}
          onSendBack={(fb) => void resolve(run.id, "send_back", fb || undefined)}
        />
      )}
    </div>
  );
}
