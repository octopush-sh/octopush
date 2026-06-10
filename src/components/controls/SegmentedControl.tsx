// src/components/controls/SegmentedControl.tsx
export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Active-state classes override (e.g. substrate state colors). Default: brass. */
  activeClass?: string;
}

interface Props<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
}

/** 2–4 mutually exclusive options in a hairline track. Brass (or the option's
 *  own accent) marks the active segment; inactive segments are quiet. */
export function SegmentedControl<T extends string>({ options, value, onChange, ariaLabel }: Props<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-octo-hairline bg-octo-onyx p-0.5"
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={`rounded-sm px-2 py-1 font-mono text-[10px] uppercase tracking-[0.25em] transition-colors duration-[220ms] ${
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
