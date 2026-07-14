// src/components/controls/SegmentedControl.tsx
export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Active-state classes override (e.g. substrate state colors). Default: brass. */
  activeClass?: string;
  /** Native tooltip — explains what the option does (e.g. its token budget). */
  title?: string;
}

interface Props<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  /** Stretch the track to its container's full width with equal segments and
   *  tighter type — for 5+ options that would overflow the default inline
   *  track (e.g. the per-stage effort selector). Default: inline + roomy. */
  fill?: boolean;
  /** Dim + block interaction when the control doesn't apply (mirrors the tool
   *  switches' `disabled` on a CLI stage). Default: enabled. */
  disabled?: boolean;
}

/** 2–4 mutually exclusive options in a hairline track (or 5+ with `fill`).
 *  Brass (or the option's own accent) marks the active segment; inactive
 *  segments are quiet. */
export function SegmentedControl<T extends string>({ options, value, onChange, ariaLabel, fill = false, disabled = false }: Props<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled}
      className={`items-center gap-0.5 rounded-md border border-octo-hairline bg-octo-onyx p-0.5 ${
        fill ? "flex w-full" : "inline-flex shrink-0"
      } ${disabled ? "opacity-40" : ""}`}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={`rounded-sm font-mono uppercase transition-colors duration-[220ms] disabled:cursor-not-allowed ${
              fill ? "flex-1 px-1 py-1 text-[9px] tracking-[0.12em]" : "px-2 py-1 text-[10px] tracking-[0.25em]"
            } ${
              active ? (o.activeClass ?? "bg-[var(--brass-ghost)] text-octo-brass") : "text-octo-mute hover:text-octo-sage"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
