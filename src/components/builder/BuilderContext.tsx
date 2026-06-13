import { createContext, useContext } from "react";

/** Shared state the custom node/edge components read without prop-drilling
 *  through @xyflow. Validation is recomputed in the builder on every change. */
export interface BuilderCtx {
  /** Per-node first error / first warning, keyed by node id. */
  validation: Record<string, { error?: string; warning?: string }>;
  /** The currently-selected node id (drives the brass ring). */
  selectedId: string | null;
  /** Remove a stage node (and its edges). Disabled for the last node. */
  onRemove: (id: string) => void;
  canRemove: boolean;
}

const Ctx = createContext<BuilderCtx | null>(null);

export const BuilderProvider = Ctx.Provider;

export function useBuilder(): BuilderCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useBuilder must be used inside a BuilderProvider");
  return v;
}
