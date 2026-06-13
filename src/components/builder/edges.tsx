import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from "@xyflow/react";
import type { EdgeData } from "./graph";

/** A flow dependency: a calm brass hairline with an arrowhead. */
export function FlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd }: EdgeProps) {
  const [path] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 10 });
  return <BaseEdge id={id} path={path} markerEnd={markerEnd} style={{ stroke: "var(--brass-rule-dim)", strokeWidth: 1.5 }} />;
}

/** A loop back-edge from a review stage to an ancestor: a dashed brass arc with
 *  a small `⟜ ×N` pill so the loop reads at a glance even when zoomed out. */
export function LoopEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd }: EdgeProps) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 14,
  });
  const d = data as EdgeData | undefined;
  const max = d?.loopMax ?? 2;
  const auto = d?.loopMode === "auto";
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{ stroke: "var(--brass-dim)", strokeWidth: 1.5, strokeDasharray: "4 4" }}
      />
      <EdgeLabelRenderer>
        <div
          // nopan/nodrag so a click on the pill doesn't pan the canvas.
          className="nopan nodrag pointer-events-none absolute rounded-sm border border-[var(--brass-dim)] bg-octo-onyx/90 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-octo-brass"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          title={auto ? "Loops automatically on a parsed verdict" : "Pauses for your decision before looping"}
        >
          ⟜ ×{max}
          {auto ? " · auto" : ""}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
