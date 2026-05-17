import { clsx } from "clsx";
import { MODES, MODE_LABELS, MODE_SHORTCUTS, type WorkspaceMode } from "../lib/modes";

interface Props {
  mode: WorkspaceMode;
  onChange: (next: WorkspaceMode) => void;
}

export function ModeSwitcher({ mode, onChange }: Props) {
  return (
    <div
      role="group"
      aria-label="Workspace mode"
      className="m-4 inline-flex items-center gap-1 rounded-lg border border-octo-hairline bg-octo-panel p-1"
    >
      {MODES.map((m) => {
        const active = m === mode;
        return (
          <button
            key={m}
            type="button"
            onClick={() => onChange(m)}
            aria-pressed={active}
            title={`${MODE_LABELS[m]} (${MODE_SHORTCUTS[m]})`}
            className={clsx(
              "rounded-md px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] transition",
              active
                ? "border text-octo-brass"
                : "border border-transparent text-octo-mute hover:text-octo-sage",
            )}
            style={
              active
                ? {
                    borderColor: "var(--brass-dim)",
                    background: "var(--brass-ghost)",
                  }
                : undefined
            }
          >
            {MODE_LABELS[m]}
          </button>
        );
      })}
    </div>
  );
}
