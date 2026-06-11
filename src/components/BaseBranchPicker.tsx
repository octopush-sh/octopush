import { useState } from "react";
import { createPortal } from "react-dom";
import { Check, GitBranch } from "lucide-react";
import { useMenuChrome } from "../lib/useMenuChrome";

interface Props {
  /** Local branches, repo default first (as returned by `ipc.listBranches`). */
  branches: string[];
  /** Currently selected base branch, or null while loading / unavailable. */
  value: string | null;
  onSelect: (branch: string) => void;
}

const LABEL =
  "inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.2em] text-octo-sage";

/**
 * Quiet inline control for the workspace creator's branch preview row:
 * shows the base branch the new workspace will start from and, on click,
 * opens the house portal+fixed menu (FileTreeContextMenu chrome) to pick
 * any local branch. With no branches to offer it degrades to a static label.
 */
export function BaseBranchPicker({ branches, value, onSelect }: Props) {
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const label = value ?? "default";

  if (branches.length === 0) {
    return (
      <span className={LABEL}>
        <GitBranch size={10} className="shrink-0" />
        <span className="max-w-[28ch] truncate" title={label}>
          {label}
        </span>
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={menuAt !== null}
        title={`Base branch: ${label} — the new branch starts from here`}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setMenuAt({ x: rect.left, y: rect.bottom + 4 });
        }}
        className={`${LABEL} rounded-sm transition-colors duration-[220ms] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass`}
      >
        <GitBranch size={10} className="shrink-0" />
        <span className="max-w-[28ch] truncate">{label}</span>
      </button>
      {menuAt && (
        <BranchMenu
          branches={branches}
          value={value}
          x={menuAt.x}
          y={menuAt.y}
          onSelect={(b) => {
            onSelect(b);
            setMenuAt(null);
          }}
          onDismiss={() => setMenuAt(null)}
        />
      )}
    </>
  );
}

function BranchMenu({
  branches,
  value,
  x,
  y,
  onSelect,
  onDismiss,
}: {
  branches: string[];
  value: string | null;
  x: number;
  y: number;
  onSelect: (branch: string) => void;
  onDismiss: () => void;
}) {
  const { ref, pos } = useMenuChrome(x, y, onDismiss);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Choose base branch"
      className="octo-menu-enter fixed z-[60] w-[224px] rounded-md border border-octo-hairline bg-octo-panel py-1 shadow-2xl"
      style={{ left: pos.left, top: pos.top, transformOrigin: "top left" }}
    >
      {branches.map((branch) => {
        const selected = branch === value;
        return (
          <button
            key={branch}
            type="button"
            role="menuitem"
            title={branch}
            onClick={() => onSelect(branch)}
            className={`flex w-full items-center gap-2 px-3 py-2 font-mono text-[11px] transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass ${
              selected ? "text-octo-brass" : "text-octo-sage"
            }`}
          >
            <span className="flex w-3 shrink-0 items-center justify-center">
              {selected && <Check size={12} className="text-octo-brass" />}
            </span>
            <span className="truncate">{branch}</span>
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
