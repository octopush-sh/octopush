import { ModeSwitcher } from "./ModeSwitcher";
import { FadeSwap } from "./primitives/FadeSwap";
import type { WorkspaceMode } from "../lib/modes";

interface Props {
  mode: WorkspaceMode;
  onChange: (next: WorkspaceMode) => void;
  /** Forwarded to the switcher so an in-workspace attention flag can pulse the
   *  Run/Talk segment. */
  workspaceId?: string;
  /** The active mode's status tail ("2 terminals", "7 files changed · +214 −61"),
   *  or null when the mode has nothing worth reporting. */
  meta?: string | null;
}

/** The mode band — the switcher's own line, directly above the canvas and
 *  spanning only the canvas column, because the modes govern the canvas and
 *  nothing else. Its prominence comes from that isolation rather than from
 *  type size, which is why the control stays a compact mono segmented pill.
 *  The right end carries the active mode's status tail.
 *
 *  Layout is a 1fr/auto/1fr grid rather than a flex row with a spacer: the
 *  switcher is centred on the canvas — not on the leftover room beside the
 *  tail — and the equal side tracks keep it there however long the tail gets,
 *  while the tail truncates in its own cell instead of overlapping the pill. */
export function ModeBand({ mode, onChange, workspaceId, meta }: Props) {
  return (
    <div className="mb-3 grid grid-cols-[1fr_auto_1fr] items-center gap-3">
      <span aria-hidden />
      <ModeSwitcher mode={mode} onChange={onChange} workspaceId={workspaceId} />
      {/* Keyed on the mode so the tail crossfades with the canvas instead of
          snapping to the new mode's numbers (motion rule S3). */}
      <FadeSwap swapKey={mode} className="min-w-0 justify-self-end">
        {meta && (
          <span
            title={meta}
            className="block truncate font-mono text-[10px] uppercase tracking-[0.15em] text-octo-mute"
          >
            {meta}
          </span>
        )}
      </FadeSwap>
    </div>
  );
}
