import { useEffect, useState } from "react";
import { ipc } from "../lib/ipc";
import type { Workspace } from "../lib/types";

interface Props {
  projectId: string;
  projectName: string;
  projectPath: string;
  /** Called after a successful restore so the parent can refresh the rail. */
  onRestored: (projectId: string) => void;
  onClose: () => void;
}

export function ArchivedWorkspacesModal({
  projectId,
  projectName,
  projectPath,
  onRestored,
  onClose,
}: Props) {
  const [items, setItems] = useState<Workspace[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    ipc.listArchivedWorkspaces(projectId)
      .then((ws) => { if (alive) setItems(ws); })
      .catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, [projectId]);

  async function restore(w: Workspace) {
    setBusyId(w.id);
    try {
      await ipc.restoreWorkspace(w.id, projectPath, w.branch, w.worktreePath ?? null);
      setItems((prev) => (prev ?? []).filter((x) => x.id !== w.id));
      onRestored(projectId);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="w-[360px] rounded-xl border border-octo-hairline bg-octo-panel p-4 shadow-xl" aria-label="Archived workspaces">
      <div className="font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass">
        Archived · {projectName}
      </div>
      <div className="mt-3 max-h-[300px] overflow-y-auto">
        {items === null ? (
          <div className="py-4 text-center font-mono text-[11px] text-octo-mute">Loading…</div>
        ) : items.length === 0 ? (
          <div className="py-4 text-center font-mono text-[11px] text-octo-mute">No archived workspaces</div>
        ) : (
          <ul className="flex flex-col gap-1">
            {items.map((w) => (
              <li key={w.id} className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-octo-panel-2">
                <span className="flex-1 truncate text-[13px] text-octo-sage">{w.name}</span>
                <span className="truncate font-mono text-[10px] text-octo-mute">{w.branch}</span>
                <button
                  type="button"
                  onClick={() => void restore(w)}
                  disabled={busyId === w.id}
                  className="font-mono text-[10px] text-octo-brass disabled:opacity-40"
                >
                  {busyId === w.id ? "Restoring…" : "Restore"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="mt-4 flex justify-end">
        <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 font-sans text-[12px] text-octo-mute hover:text-octo-sage">
          Close
        </button>
      </div>
    </div>
  );
}
