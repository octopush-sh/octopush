import { ModeSwitcher } from "./ModeSwitcher";
import { FadeSwap } from "./primitives/FadeSwap";
import type { WorkspaceMode } from "../lib/modes";

interface Props {
  mode: WorkspaceMode;
  onChange: (next: WorkspaceMode) => void;
  /** Forwarded to the switcher so an in-workspace attention flag can pulse the
   *  Run/Talk segment. */
  workspaceId?: string;
  /** The active mode's status tail. A string is rendered as the canonical
   *  mono status line; a node is rendered as-is, which is how Run mode puts a
   *  live control there (the session line) instead of a read-out. Null when
   *  the mode has nothing worth reporting. */
  meta?: React.ReactNode;
  /** The least width, in px, the tail's track keeps: set when the tail is a
   *  control that must never be squeezed out (Run's session line and its
   *  floor). The left track gives up its room first, so the switcher slides
   *  off centre rather than the control losing a button. */
  tailMin?: number;
  /** The control tail's last rung, in px: the floor its track keeps once the
   *  band is too narrow for `tailMin` beside the switcher (Run: the session
   *  line's ⌘⌥K list button alone). */
  tailLastMin?: number;
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
 *  while the tail truncates in its own cell instead of overlapping the pill.
 *
 *  Two details make that truncation real. The side tracks are
 *  `minmax(0,1fr)`, not bare `1fr` (whose `auto` minimum is the content's
 *  width). And the tail cell stretches across its track and right-aligns its
 *  content with flex, instead of `justify-self-end`: a self-aligned grid item
 *  is sized to fit its content, never narrower than its min-content, so a
 *  nowrap tail kept its full width and spilled left across the switcher.
 *
 *  The band is a container (`.octo-modeband`, styles.css) with a ladder of
 *  its own: on a narrow canvas the switcher's inactive modes shed their
 *  labels, which is what makes room for the tail (at 720px and under beside a
 *  control tail, at 600px and under in every mode); and once a control
 *  tail's floor (`tailMin`) no longer fits beside even that switcher, its
 *  track keeps only `tailLastMin`, and the control sheds down to fit it.
 *
 *  The container is a wrapper around the grid, not the grid itself: a
 *  container query styles only what is inside the container, and that last
 *  rung changes the grid's own columns. */
export function ModeBand({ mode, onChange, workspaceId, meta, tailMin, tailLastMin }: Props) {
  const vars = tailMin
    ? ({
        ["--modeband-tail-min" as string]: `${tailMin}px`,
        ["--modeband-tail-last" as string]: `${tailLastMin ?? tailMin}px`,
      } as React.CSSProperties)
    : undefined;
  return (
    <div className="octo-modeband" style={vars}>
    <div
      className="octo-modeband-grid mb-[var(--shell-stack)] grid grid-cols-[minmax(0,1fr)_auto_minmax(var(--modeband-tail-min,0px),1fr)] items-center gap-3"
      // A control tail (Run's session line) has a floor of its own, which
      // the last rung in styles.css selects on.
      data-tail={tailMin ? "control" : undefined}
    >
      <span aria-hidden />
      <ModeSwitcher mode={mode} onChange={onChange} workspaceId={workspaceId} />
      {/* Keyed on the mode so the tail crossfades with the canvas instead of
          snapping to the new mode's numbers (motion rule S3). */}
      <FadeSwap swapKey={mode} className="flex min-w-0 justify-end">
        {typeof meta === "string" ? (
          <span
            title={meta}
            className="block min-w-0 truncate font-mono text-[10px] uppercase tracking-[0.15em] text-octo-mute"
          >
            {meta}
          </span>
        ) : (
          meta
        )}
      </FadeSwap>
    </div>
    </div>
  );
}
