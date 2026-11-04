import type { ReactNode } from "react";

interface Props {
  active: boolean;
  /** Never take the pointer itself, even while active; children opt back in.
   *  For a layer drawn over the other overlays (`TerminalHost`). */
  passThrough?: boolean;
  children: ReactNode;
}

/** The positioned, opacity-gated container shared by every workspace-mode canvas overlay. */
export function ModeOverlay({ active, passThrough = false, children }: Props) {
  return (
    <div
      className="absolute inset-0 transition-opacity duration-200 ease-out"
      style={{
        opacity: active ? 1 : 0,
        pointerEvents: active && !passThrough ? "auto" : "none",
        visibility: active ? "visible" : "hidden",
      }}
    >
      {children}
    </div>
  );
}
