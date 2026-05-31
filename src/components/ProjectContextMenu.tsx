import { useEffect, useRef } from "react";
import { Pencil, Palette, Settings, Lock, BookOpen, Trash2, Link2 } from "lucide-react";

interface Props {
  projectId: string;
  projectName: string;
  x: number;
  y: number;
  onRename: () => void;
  onChangeTint: () => void;
  onClose: () => void;
  onDelete: () => void;
  onDismiss: () => void;
  onSetJiraProjectKey?: () => void;
}

export function ProjectContextMenu({
  projectId: _projectId,
  projectName: _projectName,
  x,
  y,
  onRename,
  onChangeTint,
  onClose,
  onDelete,
  onDismiss,
  onSetJiraProjectKey,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onDismiss();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  // Close on outside click (capture phase so it fires before bubbling)
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onDismiss();
      }
    };
    window.addEventListener("mousedown", onMouseDown, true);
    return () => window.removeEventListener("mousedown", onMouseDown, true);
  }, [onDismiss]);

  const handleRename = () => {
    onRename();
    onDismiss();
  };

  const handleChangeTint = () => {
    onChangeTint();
    onDismiss();
  };

  const handleClose = () => {
    onClose();
    onDismiss();
  };

  const handleDelete = () => {
    onDelete();
    onDismiss();
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Project actions"
      className="absolute z-50 w-[200px] rounded-md border border-octo-hairline bg-octo-panel shadow-2xl"
      style={{ left: x, top: y }}
      onMouseLeave={onDismiss}
    >
      <button
        type="button"
        role="menuitem"
        onClick={handleRename}
        className="flex w-full items-center gap-2 rounded-t-md px-3 py-2 font-mono text-[11px] text-octo-sage transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass"
      >
        <Pencil size={12} className="shrink-0" />
        Rename project
      </button>

      <button
        type="button"
        role="menuitem"
        onClick={handleChangeTint}
        className="flex w-full items-center gap-2 px-3 py-2 font-mono text-[11px] text-octo-sage transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass"
      >
        <Palette size={12} className="shrink-0" />
        Change tint
      </button>

      {onSetJiraProjectKey && (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onSetJiraProjectKey();
            onDismiss();
          }}
          className="flex w-full items-center gap-2 px-3 py-2 font-mono text-[11px] text-octo-sage transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass"
        >
          <Link2 size={12} className="shrink-0" />
          Set Jira project key…
        </button>
      )}

      <button
        type="button"
        role="menuitem"
        disabled
        title="Coming soon"
        className="flex w-full items-center gap-2 px-3 py-2 font-mono text-[11px] text-octo-sage opacity-50 cursor-not-allowed"
      >
        <Settings size={12} className="shrink-0" />
        Project settings
      </button>

      <button
        type="button"
        role="menuitem"
        disabled
        title="Coming soon"
        className="flex w-full items-center gap-2 px-3 py-2 font-mono text-[11px] text-octo-sage opacity-50 cursor-not-allowed"
      >
        <Settings size={12} className="shrink-0" />
        Default agent model
      </button>

      <button
        type="button"
        role="menuitem"
        disabled
        title="Coming soon"
        className="flex w-full items-center gap-2 px-3 py-2 font-mono text-[11px] text-octo-sage opacity-50 cursor-not-allowed"
      >
        <Lock size={12} className="shrink-0" />
        Tool permissions
      </button>

      <button
        type="button"
        role="menuitem"
        disabled
        title="Coming soon"
        className="flex w-full items-center gap-2 px-3 py-2 font-mono text-[11px] text-octo-sage opacity-50 cursor-not-allowed"
      >
        <BookOpen size={12} className="shrink-0" />
        Workspace presets
      </button>

      <div className="h-px bg-octo-hairline" />

      <button
        type="button"
        role="menuitem"
        onClick={handleClose}
        className="flex w-full items-center gap-2 px-3 py-2 font-mono text-[11px] text-octo-sage transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass"
      >
        <Settings size={12} className="shrink-0" />
        Close project
      </button>

      <button
        type="button"
        role="menuitem"
        onClick={handleDelete}
        className="flex w-full items-center gap-2 rounded-b-md px-3 py-2 font-mono text-[11px] text-octo-rouge transition hover:bg-[var(--rouge-ghost,rgba(209,139,139,0.08))] hover:text-octo-rouge"
      >
        <Trash2 size={12} className="shrink-0" />
        Delete project from disk
      </button>
    </div>
  );
}
