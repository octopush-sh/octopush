import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, GitBranch } from "lucide-react";
import { useMenuChrome } from "../lib/useMenuChrome";

/** Above this many branches the menu pins a filter input at the top. */
const FILTER_THRESHOLD = 8;

interface Props {
  /** Local branches, repo default first (as returned by `ipc.listBranches`). */
  branches: string[];
  /** Remote-tracking branches, fully qualified (`origin/dev`). Selecting one
   *  passes the full name through — the backend accepts it as a base. */
  remoteBranches?: string[];
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
export function BaseBranchPicker({ branches, remoteBranches = [], value, onSelect }: Props) {
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const label = value ?? "default";

  if (branches.length === 0 && remoteBranches.length === 0) {
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
          remoteBranches={remoteBranches}
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
  remoteBranches,
  value,
  x,
  y,
  onSelect,
  onDismiss,
}: {
  branches: string[];
  remoteBranches: string[];
  value: string | null;
  x: number;
  y: number;
  onSelect: (branch: string) => void;
  onDismiss: () => void;
}) {
  const { ref, pos } = useMenuChrome(x, y, onDismiss);
  const [query, setQuery] = useState("");
  const filterable = branches.length + remoteBranches.length > FILTER_THRESHOLD;
  const q = query.trim().toLowerCase();
  const matches = (b: string) => b.toLowerCase().includes(q);
  const visible = q ? branches.filter(matches) : branches;
  const visibleRemote = q ? remoteBranches.filter(matches) : remoteBranches;

  // useMenuChrome focuses the first menuitem on open; when the filter input
  // exists it must win instead. This layout effect is registered after the
  // hook's, so it runs after it and reclaims focus for the input.
  const inputRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Bring the currently selected branch into view when the menu opens — with
  // a long, scrollable list it could otherwise sit below the fold.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, []);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Choose base branch"
      className="octo-menu-enter fixed z-[60] w-[224px] rounded-md border border-octo-hairline bg-octo-panel py-1 shadow-2xl"
      style={{ left: pos.left, top: pos.top, transformOrigin: "top left" }}
    >
      {filterable && (
        <div className="border-b border-octo-hairline px-3 pb-1.5 pt-0.5">
          <input
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter branches"
            aria-label="Filter branches"
            className="w-full bg-transparent font-mono text-[11px] text-octo-ivory outline-none placeholder:font-mono placeholder:not-italic placeholder:text-octo-mute"
          />
        </div>
      )}
      <div ref={listRef} className="max-h-[40vh] overflow-y-auto">
        {visible.map((branch) => (
          <BranchItem key={branch} branch={branch} selected={branch === value} onSelect={onSelect} />
        ))}
        {visibleRemote.length > 0 && (
          <>
            {visible.length > 0 && (
              <div role="separator" className="my-1 border-t border-octo-hairline" />
            )}
            <div className="px-3 pb-1 pt-1.5 font-mono text-[9px] uppercase tracking-[0.25em] text-octo-mute">
              REMOTE
            </div>
            {visibleRemote.map((branch) => (
              <BranchItem
                key={branch}
                branch={branch}
                selected={branch === value}
                onSelect={onSelect}
              />
            ))}
          </>
        )}
        {visible.length === 0 && visibleRemote.length === 0 && (
          <div className="px-3 py-2 font-mono text-[11px] text-octo-mute">
            No branches match
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

function BranchItem({
  branch,
  selected,
  onSelect,
}: {
  branch: string;
  selected: boolean;
  onSelect: (branch: string) => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      title={branch}
      data-selected={selected || undefined}
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
}
