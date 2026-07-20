import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from "@xyflow/react";
import { X } from "lucide-react";
import type { EdgeData } from "./graph";
import { useBuilder } from "./BuilderContext";

/** Midpoint ✕ shown while an edge is selected — the visible way to part two
 *  stages (Backspace works too once selected; the tooltip teaches it). */
function DisconnectPill({ edgeId, x, y }: { edgeId: string; x: number; y: number }) {
  const { onDisconnect } = useBuilder();
  return (
    <EdgeLabelRenderer>
      <button
        type="button"
        aria-label="Disconnect"
        title="Disconnect — or press Backspace"
        onClick={(e) => {
          e.stopPropagation();
          onDisconnect(edgeId);
        }}
        className="octo-pop-in nopan nodrag pointer-events-auto absolute flex h-5 w-5 items-center justify-center rounded-full border border-[var(--brass-dim)] bg-octo-onyx text-octo-brass transition-colors duration-[150ms] hover:border-octo-rouge hover:text-octo-rouge"
        style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
      >
        <X size={11} strokeWidth={2} />
      </button>
    </EdgeLabelRenderer>
  );
}

/** A flow dependency: a calm brass hairline with an arrowhead. Stroke lives in
 *  styles.css (.octo-flow) so hover/selected states can restyle it — an inline
 *  stroke here would override them. */
export function FlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, markerEnd }: EdgeProps) {
  const [path, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 10 });
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} />
      {selected && <DisconnectPill edgeId={id} x={labelX} y={labelY} />}
    </>
  );
}

/** A loop back-edge from a review stage to an ancestor: a dashed brass arc with
 *  a small `⟲ ×N` pill so the loop reads at a glance even when zoomed out. */
export function LoopEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, markerEnd }: EdgeProps) {
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
      <BaseEdge id={id} path={path} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        <div
          // nopan/nodrag so a click on the badge doesn't pan the canvas.
          className="nopan nodrag pointer-events-none absolute rounded-sm border border-[var(--brass-dim)] bg-octo-onyx/90 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-octo-brass"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          title={auto ? "Loops automatically on a parsed verdict" : "Pauses for your decision before looping"}
        >
          ⟲ ×{max}
          {auto ? " · auto" : ""}
        </div>
      </EdgeLabelRenderer>
      {/* Sits just above the ⟲ badge so both stay legible. */}
      {selected && <DisconnectPill edgeId={id} x={labelX} y={labelY - 22} />}
    </>
  );
}
