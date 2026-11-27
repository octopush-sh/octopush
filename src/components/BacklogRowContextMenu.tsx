import { useEffect, useRef } from "react";
import { ClipboardCheck, FilePlus2 } from "lucide-react";

interface Props {
  x: number;
  y: number;
  onCreateWorkspace: () => void;
  /** Opens the new-mission wizard on "Test a ticket", with the ticket linked. */
  onTestTicket: () => void;
  onClose: () => void;
}

const ITEM =
  "flex w-full items-center gap-2 rounded-md px-3 py-2 font-mono text-[11px] text-octo-sage transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass";

export function BacklogRowContextMenu({ x, y, onCreateWorkspace, onTestTicket, onClose }: Props) {
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
      className="octo-menu-enter absolute z-50 w-[200px] rounded-md border border-octo-hairline bg-octo-panel shadow-2xl"
      style={{ left: x, top: y, transformOrigin: "top left" }}
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onCreateWorkspace();
          onClose();
        }}
        className={ITEM}
      >
        <FilePlus2 size={12} className="shrink-0" />
        Create workspace
      </button>
      <button
        type="button"
        role="menuitem"
        data-tour="backlog-test-ticket"
        title="Build and run this ticket in a throwaway workspace that ships nothing"
        onClick={() => {
          onTestTicket();
          onClose();
        }}
        className={ITEM}
      >
        <ClipboardCheck size={12} className="shrink-0" />
        Test this ticket
      </button>
    </div>
  );
}
