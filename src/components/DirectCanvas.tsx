import { useEffect, useRef, useState, type ReactElement } from "react";
import type { RunStage } from "../lib/ipc";
import { useRunsStore } from "../stores/runsStore";
import { usePipelineStore } from "../stores/pipelineStore";
import { DirectDashboard } from "./direct/DirectDashboard";
import { PipelineBuilder } from "./PipelineBuilder";
import { RunTrack, labelForRole } from "./RunTrack";
import { StageFocus } from "./StageFocus";
import { CheckpointBar } from "./CheckpointBar";
import { RunLedger } from "./RunLedger";
import { FadeSwap } from "./primitives/FadeSwap";
import { Reveal } from "./primitives/Reveal";

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
  const executingRun = useRunsStore((s) => s.hasExecutingRun(workspaceId));
  const detail = useRunsStore((s) => (viewedId ? s.getDetail(viewedId) : undefined));
  const selectedStageId = useRunsStore((s) => (viewedId ? s.getSelectedStageId(viewedId) : null));
  const selectStage = useRunsStore((s) => s.selectStage);
  const begin = useRunsStore((s) => s.begin);
  const resolve = useRunsStore((s) => s.resolve);
  const abort = useRunsStore((s) => s.abort);
  const stopStage = useRunsStore((s) => s.stopStage);
  const selectRun = useRunsStore((s) => s.selectRun);
  const setLauncherPrefill = useRunsStore((s) => s.setLauncherPrefill);

  // Builder: undefined = closed; null = compose new; a pipelineId = edit that one.
  const [builder, setBuilder] = useState<undefined | null | string>(undefined);
  const pipelines = usePipelineStore((s) => s.pipelines);

  useEffect(() => { if (active) void loadRuns(workspaceId); }, [active, workspaceId, loadRuns]);
  useEffect(() => {
    if (active && viewedId && !detail?.run) void refreshDetail(viewedId);
  }, [active, viewedId, detail?.run, refreshDetail]);

  // Hold the last blocked stage so the strip's content survives the fold-away animation.
  const [lastBlocked, setLastBlocked] = useState<RunStage | null>(null);

  const run = detail?.run;
  const stages = detail?.stages ?? [];
  const blockedStage = stages.find((s) => s.status === "awaiting_checkpoint" || s.status === "failed") ?? null;
  useEffect(() => { if (blockedStage) setLastBlocked(blockedStage); }, [blockedStage]);

  // D4 — focus follows the action. When the MANUALLY selected stage transitions
  // out of "running" (→ done / failed / awaiting_checkpoint), release the pin so
  // the shown stage falls back to activeStage. A pin placed on an already-terminal
  // stage never observes that transition, so it is respected.
  const watchedStage = useRef<{ stageId: string | null; status: string | null }>({ stageId: null, status: null });
  useEffect(() => {
    const stageId = selectedStageId;
    const status = stageId ? stages.find((s) => s.id === stageId)?.status ?? null : null;
    const prev = watchedStage.current;
    if (
      prev.stageId === stageId && stageId !== null && viewedId &&
      prev.status === "running" && status !== null && status !== "running"
    ) {
      selectStage(viewedId, null);
      watchedStage.current = { stageId: null, status: null };
      return;
    }
    // Selection changed (or no transition): re-key the ref to the current pair.
    watchedStage.current = { stageId, status };
  }, [selectedStageId, detail, viewedId, selectStage]); // eslint-disable-line react-hooks/exhaustive-deps -- stages derives from detail

  // Key the builder on its target so switching which pipeline is edited
  // remounts the canvas (its node/edge state is seeded once on mount).
  const canvasKey =
    builder !== undefined ? `builder:${builder ?? "new"}` : !viewedId || !run ? "launcher" : `run:${viewedId}`;

  let body: ReactElement;
  if (builder !== undefined) {
    body = (
      <PipelineBuilder
        pipeline={builder ? pipelines.find((p) => p.pipeline.id === builder) ?? null : null}
        onClose={() => setBuilder(undefined)}
      />
    );
  } else if (!viewedId || !run) {
    body = (
      <DirectDashboard
        workspaceId={workspaceId}
        defaultTask={defaultTask}
        onBegin={(pipelineId, task, stageOverrides, budgetUsd) =>
          void begin(workspaceId, pipelineId, task, stageOverrides, linkedIssueKey ?? undefined, budgetUsd)
        }
        executingRun={executingRun}
        onEditPipeline={(id) => setBuilder(id)}
      />
    );
  } else {
    const activeStage =
      stages.find((s) => s.status === "running" || s.status === "awaiting_checkpoint" || s.status === "failed") ??
      [...stages].reverse().find((s) => s.status === "done") ??
      stages[0] ??
      null;
    const shownStageId = selectedStageId ?? activeStage?.id ?? null;
    const shownStage = stages.find((s) => s.id === shownStageId) ?? null;

    // Loop props (unchanged logic, but computed off blockedStage)
    let loopTargetRole: string | null = null;
    let loopState: { iteration: number; max: number } | null = null;
    // A budget-parked stage (never started) offers no send-back — it has produced
    // nothing to send. Approve overrides the budget once; Reject re-parks.
    const budgetParked = blockedStage !== null && blockedStage.startedAt === null && blockedStage.artifact === null;
    if (blockedStage && !budgetParked && blockedStage.loopMode === "gated" && blockedStage.loopTargetPosition !== null && blockedStage.status === "awaiting_checkpoint") {
      const targetStage = stages.find((s) => s.position === blockedStage.loopTargetPosition);
      if (targetStage) {
        loopTargetRole = labelForRole(targetStage.role);
        loopState = { iteration: blockedStage.loopIterations, max: blockedStage.loopMaxIterations };
      }
    }

    const checkpointOpen = run.status === "paused" && blockedStage !== null;
    const barStage = blockedStage ?? lastBlocked;

    body = (
      <div className="flex min-h-0 flex-1 flex-col">
        <RunTrack
          run={run}
          stages={stages}
          selectedStageId={shownStageId}
          onSelectStage={(id) => selectStage(run.id, id)}
          onStopStage={() => void stopStage(run.id)}
          onAbort={() => void abort(run.id)}
          onRunAgain={() => {
            // Seed the launcher with this run's brief, pipeline, and crew —
            // PipelineSetup consumes the prefill once on mount.
            setLauncherPrefill({
              task: run.task,
              pipelineId: run.pipelineId,
              overrides: stages.map((s) => [s.position, s.agentModel] as [number, string]),
            });
            selectRun(workspaceId, null);
          }}
        />
        <StageFocus stage={shownStage} workspacePath={workspacePath} />
        <RunLedger run={run} stages={stages} />
        <Reveal open={checkpointOpen}>
          {barStage && (
            <CheckpointBar
              blockedStage={barStage}
              onApprove={() => void resolve(run.id, "approve")}
              onReject={(feedback) => void resolve(run.id, "reject", feedback || undefined)}
              onResume={() => void resolve(run.id, "resume")}
              onAbort={() => void abort(run.id)}
              loopTargetRole={loopTargetRole}
              loopState={loopState}
              onSendBack={(fb) => void resolve(run.id, "send_back", fb || undefined)}
            />
          )}
        </Reveal>
      </div>
    );
  }

  return (
    <FadeSwap swapKey={canvasKey} className="flex h-full min-h-0 flex-col">
      {body}
    </FadeSwap>
  );
}
