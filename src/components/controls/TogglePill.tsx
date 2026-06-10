// src/components/controls/TogglePill.tsx
interface Props {
  on: boolean;
  onChange: (on: boolean) => void;
  label: string;
  ariaLabel?: string;
}

/** Labeled on/off pill. Off: hairline + mute. On: brass-dim border, brass-ghost
 *  fill, brass text. The premium replacement for a bare checkbox. */
export function TogglePill({ on, onChange, label, ariaLabel }: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={ariaLabel ?? label}
      onClick={() => onChange(!on)}
      className={`shrink-0 rounded-sm border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.25em] transition-colors duration-[220ms] ${
        on
          ? "border-[var(--brass-dim)] bg-[var(--brass-ghost)] text-octo-brass"
          : "border-octo-hairline text-octo-mute hover:text-octo-sage"
      }`}
    >
      {label}
    </button>
  );
}
