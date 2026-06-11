import { clsx } from "clsx";
import { MODES, MODE_LABELS, MODE_SHORTCUTS, type WorkspaceMode } from "../lib/modes";
import { useAttentionStore } from "../stores/attentionStore";

interface Props {
  mode: WorkspaceMode;
  onChange: (next: WorkspaceMode) => void;
  /** When set, an attention flag for this workspace will pulse the
   *  Run or Talk tab (whichever corresponds to the flag's kind), so
   *  the user knows to switch modes *within* the workspace they're
   *  already in. Without this, an in-workspace alert would be
   *  silently swallowed by the cross-workspace monogram filter. */
  workspaceId?: string;
}

// Each mode button is fixed width so the gliding indicator math is predictable.
// If MODE_LABELS ever gets translated to longer strings, increase BUTTON_W.
const BUTTON_W = 68;

export function ModeSwitcher({ mode, onChange, workspaceId }: Props) {
  const activeIndex = MODES.indexOf(mode);
  const flag = useAttentionStore((s) =>
    workspaceId ? s.flagsByWs[workspaceId] : undefined,
  );
  // Map the flag's kind to the mode tab that should pulse. We only
  // pulse when the user is in a DIFFERENT mode than the one needing
  // attention — otherwise the alert and the user are already on the
  // same surface and the pulse is just noise.
  const flagMode: WorkspaceMode | null =
    flag?.kind === "chat" ? "talk" : flag?.kind === "terminal" ? "run" : null;
  const shouldPulse = (m: WorkspaceMode) => flagMode === m && mode !== m;

  return (
    <div
      role="group"
      aria-label="Workspace mode"
      // No own border/bg: the group sits inside Companion's already-bordered
      // header on the same panel surface — the gliding brass-ghost indicator
      // alone marks the active mode. p-1 keeps the indicator's breathing room.
      className="relative inline-flex items-center p-1"
    >
      {/* Gliding brass indicator. Translates by activeIndex * BUTTON_W. */}
      <div
        aria-hidden
        className="absolute top-1 bottom-1 rounded-md transition-transform duration-[280ms] ease-[cubic-bezier(0.2,0.8,0.3,1)]"
        style={{
          left: "4px",
          width: `${BUTTON_W}px`,
          transform: `translateX(${activeIndex * BUTTON_W}px)`,
          background: "var(--brass-ghost)",
          border: "1px solid var(--brass-dim)",
        }}
      />
      {MODES.map((m) => {
        const active = m === mode;
        const pulse = shouldPulse(m);
        return (
          <button
            key={m}
            type="button"
            onClick={() => onChange(m)}
            aria-pressed={active}
            title={
              pulse
                ? `${MODE_LABELS[m]} needs your attention`
                : `${MODE_LABELS[m]} (${MODE_SHORTCUTS[m]})`
            }
            style={{ width: `${BUTTON_W}px` }}
            className={clsx(
              // Label color glides on the same clock as the indicator (280ms)
              // so the brass handoff and the rect arrive together.
              "relative z-10 rounded-md px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] transition-colors duration-[280ms] ease-[cubic-bezier(0.2,0.8,0.3,1)]",
              active ? "text-octo-brass" : "text-octo-mute hover:text-octo-sage",
              pulse && "animate-attention-pulse !text-octo-brass",
            )}
          >
            {MODE_LABELS[m]}
          </button>
        );
      })}
    </div>
  );
}
