import { useEffect } from "react";
import { useRunsStore } from "../stores/runsStore";
import { PipelineSetup } from "./PipelineSetup";
import { RunTrack } from "./RunTrack";
import { StageFocus } from "./StageFocus";
import { CheckpointBar } from "./CheckpointBar";

interface Props {
  workspaceId: string;
  defaultTask: string;
  linkedIssueKey: string | null;
}

export function DirectCanvas({ workspaceId, defaultTask, linkedIssueKey }: Props) {
  const loadRuns = useRunsStore((s) => s.loadRuns);
  const activeRunId = useRunsStore((s) => s.getActiveRunId(workspaceId));
  const detail = useRunsStore((s) => (activeRunId ? s.getDetail(activeRunId) : undefined));
  const selectedStageId = useRunsStore((s) => (activeRunId ? s.getSelectedStageId(activeRunId) : null));
  const selectStage = useRunsStore((s) => s.selectStage);
  const begin = useRunsStore((s) => s.begin);
  const resolve = useRunsStore((s) => s.resolve);
  const abort = useRunsStore((s) => s.abort);

  useEffect(() => { void loadRuns(workspaceId); }, [workspaceId, loadRuns]);

  if (!activeRunId || !detail?.run) {
    return (
      <PipelineSetup
        defaultTask={defaultTask}
        onBegin={(pipelineId, task) =>
          void begin(workspaceId, pipelineId, task, linkedIssueKey ?? undefined)
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

  return (
    <div className="flex h-full flex-col">
      <RunTrack
        run={run}
        stages={stages}
        selectedStageId={shownStageId}
        onSelectStage={(id) => selectStage(run.id, id)}
      />
      <StageFocus stage={shownStage} />
      {run.status === "paused" && blockedStage && (
        <CheckpointBar
          blockedStage={blockedStage}
          onApprove={() => void resolve(run.id, "approve")}
          onReject={(feedback) => void resolve(run.id, "reject", feedback || undefined)}
          onAbort={() => void abort(run.id)}
        />
      )}
    </div>
  );
}
