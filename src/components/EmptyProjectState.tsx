import { useEffect } from "react";
import { X } from "lucide-react";
import { isModalOpen } from "./ModalShell";
import { OctoMark } from "./icons/OctoMark";

interface Props {
  projectName: string;
  onCreateWorkspace: () => void;
  /** When set, renders a dismiss affordance (X icon + Escape) that leaves
   *  this screen — present only when there's somewhere else to go (another
   *  project with workspaces), so the screen never traps the user but also
   *  never shows a dead control. */
  onDismiss?: () => void;
  /** Name of the workspace `onDismiss` returns to, shown in the tooltip. */
  dismissWorkspaceName?: string;
}

export function EmptyProjectState({
  projectName,
  onCreateWorkspace,
  onDismiss,
  dismissWorkspaceName,
}: Props) {
  useEffect(() => {
    if (!onDismiss) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isModalOpen()) {
        e.preventDefault();
        onDismiss();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

  return (
    <div className="relative flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          title={dismissWorkspaceName ? `Back to ${dismissWorkspaceName}` : "Dismiss"}
          aria-label={dismissWorkspaceName ? `Back to ${dismissWorkspaceName}` : "Dismiss"}
          className="absolute right-4 top-4 rounded p-1 text-octo-mute transition hover:text-octo-brass"
        >
          <X size={14} />
        </button>
      )}
      <OctoMark size={28} state="idle" className="opacity-80" />
      <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-mute">
        Project
      </div>
      <div className="font-serif text-[20px] leading-tight tracking-[-0.005em] text-octo-ivory">
        {projectName}
      </div>
      <p className="max-w-md text-[12px] leading-[1.6] text-octo-sage">
        No workspaces here yet. Workspaces are isolated git worktrees — one per task you're working on.
      </p>
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          onClick={onCreateWorkspace}
          className="rounded-md px-4 py-2 font-serif text-[13px] text-octo-brass transition"
          style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
        >
          Create a workspace
        </button>
      </div>
      <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.15em] text-octo-mute">
        Or pick another project from the rail
      </p>
    </div>
  );
}
