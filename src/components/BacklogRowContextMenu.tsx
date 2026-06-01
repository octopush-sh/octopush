import { useEffect, useRef } from "react";

interface Props {
  x: number;
  y: number;
  onCreateWorkspace: () => void;
  onClose: () => void;
}

export function BacklogRowContextMenu({ x, y, onCreateWorkspace, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Close on outside click (capture phase)
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 2) return;
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    window.addEventListener("mousedown", onMouseDown, true);
    return () => window.removeEventListener("mousedown", onMouseDown, true);
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Ticket actions"
      className="absolute z-50 w-[220px] rounded-md border border-octo-hairline bg-octo-panel shadow-2xl"
      style={{ left: x, top: y }}
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onCreateWorkspace();
          onClose();
        }}
        className="flex w-full items-center rounded-md px-3 py-2 font-mono text-[11px] text-octo-sage transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass"
      >
        Create workspace for this ticket
      </button>
    </div>
  );
}
