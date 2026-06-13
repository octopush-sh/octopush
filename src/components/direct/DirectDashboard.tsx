import { PipelineSetup } from "../PipelineSetup";
import { DirectOverview } from "./DirectOverview";
import { RecentRuns } from "./RecentRuns";

interface Props {
  workspaceId: string;
  defaultTask: string;
  onBegin: (
    pipelineId: string,
    task: string,
    stageOverrides: [number, string][],
    budgetUsd: number | null,
  ) => void;
  executingRun: boolean;
  onEditPipeline: (pipelineId: string | null) => void;
}

/** The Direct landing — what you see on entering the mode with no active run.
 *  A ceremonial header with an at-a-glance overview, the launch composer, and a
 *  recent-runs gallery side by side (stacking on a narrow canvas). */
export function DirectDashboard({ workspaceId, defaultTask, onBegin, executingRun, onEditPipeline }: Props) {
  return (
    <div className="@container min-h-0 flex-1 overflow-auto px-8 py-6 octo-fade-in">
      {/* Ceremony header — title left, the overview riding to the right. */}
      <div className="mb-8">
        <p className="mb-1 font-mono text-[10px] uppercase tracking-[0.25em] text-octo-brass">direct</p>
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <h1 className="m-0 font-serif text-[22px] tracking-[-0.005em] text-octo-ivory">Direct the work</h1>
          <DirectOverview workspaceId={workspaceId} />
        </div>
        <div className="animate-brass-grow mt-2 h-px bg-gradient-to-r from-octo-brass to-transparent" style={{ width: 28 }} />
      </div>

      {/* Compose on the left/primary; recent runs as a rail that drops below on
          a narrow canvas (container-query, so it follows the canvas not the
          window). */}
      <div className="flex flex-col gap-10 @4xl:flex-row @4xl:items-start @4xl:gap-12">
        <div className="min-w-0 @4xl:flex-1">
          <PipelineSetup
            defaultTask={defaultTask}
            onBegin={onBegin}
            executingRun={executingRun}
            onEditPipeline={onEditPipeline}
          />
        </div>
        <div className="@4xl:w-[340px] @4xl:shrink-0">
          <RecentRuns workspaceId={workspaceId} />
        </div>
      </div>
    </div>
  );
}
