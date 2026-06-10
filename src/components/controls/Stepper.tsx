// src/components/controls/Stepper.tsx
interface Props {
  value: number;
  min?: number;
  max?: number;
  onChange: (value: number) => void;
  ariaLabel: string;
}

/** `− n +` numeric stepper with tabular numeral — no native spinner. */
export function Stepper({ value, min = 1, max = 9, onChange, ariaLabel }: Props) {
  return (
    <div aria-label={ariaLabel} className="inline-flex shrink-0 items-center rounded-md border border-octo-hairline bg-octo-onyx">
      <button
        type="button"
        aria-label="Decrease"
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
        className="px-2 py-1 font-mono text-xs text-octo-sage transition-colors duration-[180ms] hover:text-octo-ivory disabled:opacity-30"
      >
        −
      </button>
      <span className="octo-tabular w-6 text-center font-mono text-[11px] text-octo-ivory">{value}</span>
      <button
        type="button"
        aria-label="Increase"
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
        className="px-2 py-1 font-mono text-xs text-octo-sage transition-colors duration-[180ms] hover:text-octo-ivory disabled:opacity-30"
      >
        +
      </button>
    </div>
  );
}
