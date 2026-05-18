import { clsx } from "clsx";
import { MODES, MODE_LABELS, MODE_SHORTCUTS, type WorkspaceMode } from "../lib/modes";

interface Props {
  mode: WorkspaceMode;
  onChange: (next: WorkspaceMode) => void;
}

// Each mode button is fixed width so the gliding indicator math is predictable.
// If MODE_LABELS ever gets translated to longer strings, increase BUTTON_W.
const BUTTON_W = 68;

export function ModeSwitcher({ mode, onChange }: Props) {
  const activeIndex = MODES.indexOf(mode);

  return (
    <div
      role="group"
      aria-label="Workspace mode"
      className="relative inline-flex items-center self-end rounded-lg border border-octo-hairline bg-octo-panel p-1"
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
        return (
          <button
            key={m}
            type="button"
            onClick={() => onChange(m)}
            aria-pressed={active}
            title={`${MODE_LABELS[m]} (${MODE_SHORTCUTS[m]})`}
            style={{ width: `${BUTTON_W}px` }}
            className={clsx(
              "relative z-10 rounded-md px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] transition-colors",
              active ? "text-octo-brass" : "text-octo-mute hover:text-octo-sage",
            )}
          >
            {MODE_LABELS[m]}
          </button>
        );
      })}
    </div>
  );
}
