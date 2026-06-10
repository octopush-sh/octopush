// src/components/controls/IconButton.tsx
import type { ReactNode } from "react";

interface Props {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: ReactNode;
}

/** Square ghost button for lucide icons — replaces ASCII ↑ ↓ ✕ buttons. */
export function IconButton({ label, onClick, disabled = false, danger = false, children }: Props) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-sm border border-octo-hairline text-octo-sage transition-colors duration-[180ms] hover:border-[var(--brass-dim)] disabled:opacity-30 ${
        danger ? "hover:text-octo-rouge" : "hover:text-octo-ivory"
      }`}
    >
      {children}
    </button>
  );
}
