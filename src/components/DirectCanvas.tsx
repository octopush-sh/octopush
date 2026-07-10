import { useEffect, useRef, useState, type ReactElement } from "react";
import { Maximize2 } from "lucide-react";
import { useRunsStore } from "../stores/runsStore";
import { usePipelineStore } from "../stores/pipelineStore";
import { labelForRole } from "../lib/stageMeta";
import { PipelineSetup } from "./PipelineSetup";
import { PipelineBuilder } from "./PipelineBuilder";
import { RunFlow } from "./RunFlow";
import { StageFocus } from "./StageFocus";
import { RunControlBar } from "./RunControlBar";
import { RunLedger } from "./RunLedger";
import { BriefModal } from "./BriefModal";
import { FadeSwap } from "./primitives/FadeSwap";

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
  const start = useRunsStore((s) => s.start);
  const resolve = useRunsStore((s) => s.resolve);
  const abort = useRunsStore((s) => s.abort);
  const stopStage = useRunsStore((s) => s.stopStage);
  const pauseRun = useRunsStore((s) => s.pauseRun);
  const updateStage = useRunsStore((s) => s.updateStage);
  const rerunFromStage = useRunsStore((s) => s.rerunFromStage);
  const selectRun = useRunsStore((s) => s.selectRun);
  const setLauncherPrefill = useRunsStore((s) => s.setLauncherPrefill);

  // Builder: undefined = closed; null = compose new; a pipelineId = edit that one.
  const [builder, setBuilder] = useState<undefined | null | string>(undefined);
  const pipelines = usePipelineStore((s) => s.pipelines);
  const [briefOpen, setBriefOpen] = useState(false);

  useEffect(() => { if (active) void loadRuns(workspaceId); }, [active, workspaceId, loadRuns]);
  useEffect(() => {
    if (active && viewedId && !detail?.run) void refreshDetail(viewedId);
  }, [active, viewedId, detail?.run, refreshDetail]);

  const run = detail?.run;
  const stages = detail?.stages ?? [];
  const blockedStage = stages.find((s) => s.status === "awaiting_checkpoint" || s.status === "failed") ?? null;

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
      <PipelineSetup
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

    const doneCount = stages.filter((s) => s.status === "done").length;
    const onRunAgain = () => {
      // Seed the launcher with this run's brief, pipeline, and crew — the
      // launcher consumes the prefill once on mount.
      setLauncherPrefill({
        task: run.task,
        pipelineId: run.pipelineId,
        overrides: stages.map((s) => [s.position, s.agentModel] as [number, string]),
      });
      selectRun(workspaceId, null);
    };

    body = (
      <div className="flex min-h-0 flex-1 flex-col">
        {/* Run header — stage count + the brief, always legible. */}
        <div className="flex items-center gap-4 border-b border-octo-hairline bg-octo-panel px-4 py-2.5">
          <div className="shrink-0">
            <div className="font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute">stage</div>
            <div className="octo-tabular font-mono text-[13px] text-octo-ivory">
              {Math.min(doneCount + 1, stages.length)} / {stages.length}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setBriefOpen(true)}
            aria-label="View the full brief"
            title="View the full brief"
            className="group flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
          >
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute">the brief</div>
              <div className="truncate font-serif text-[13px] text-octo-ivory">{run.task}</div>
            </div>
            <Maximize2 size={12} className="shrink-0 text-octo-mute transition-colors duration-[180ms] group-hover:text-octo-brass" />
          </button>
        </div>
        {/* The living pipeline. */}
        <div className="border-b border-octo-hairline bg-octo-panel px-4 py-2">
          <RunFlow stages={stages} selectedStageId={shownStageId} onSelectStage={(id) => selectStage(run.id, id)} />
        </div>
        <StageFocus
          stage={shownStage}
          workspacePath={workspacePath}
          run={run}
          onUpdateStage={(patch) => (shownStage ? updateStage(run.id, shownStage.id, patch) : Promise.resolve())}
          onRerunFromStage={() => (shownStage ? rerunFromStage(run.id, shownStage.id) : Promise.resolve())}
        />
        <RunLedger run={run} stages={stages} />
        <RunControlBar
          run={run}
          blockedStage={blockedStage}
          loopTargetRole={loopTargetRole}
          loopState={loopState}
          onStart={() => void start(run.id)}
          onPause={() => void pauseRun(run.id)}
          onStopStage={() => void stopStage(run.id)}
          onAbort={() => void abort(run.id)}
          onApprove={() => void resolve(run.id, "approve")}
          onReject={(fb, maxTurns) => void resolve(run.id, "reject", fb || undefined, undefined, maxTurns)}
          onResume={(maxTurns) => void resolve(run.id, "resume", undefined, undefined, maxTurns)}
          onDiscard={() => void resolve(run.id, "discard")}
          onSendBack={(fb) => void resolve(run.id, "send_back", fb || undefined)}
          onRunAgain={onRunAgain}
        />
        {briefOpen && (
          <BriefModal
            task={run.task}
            pipelineName={pipelines.find((p) => p.pipeline.id === run.pipelineId)?.pipeline.name ?? "Unknown ensemble"}
            stageCount={stages.length}
            onClose={() => setBriefOpen(false)}
          />
        )}
      </div>
    );
  }

  return (
    <FadeSwap swapKey={canvasKey} className="flex h-full min-h-0 flex-col">
      {body}
    </FadeSwap>
  );
}
