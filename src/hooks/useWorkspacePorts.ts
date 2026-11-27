import { useEffect, useState } from "react";
import { ipc, type PortBlock } from "../lib/ipc";

/**
 * The workspace's block of local ports (`workspace_ports`, #1219), for the
 * header. Asking allocates the block when the workspace has none yet, so the
 * range shown is the one its Run terminals and Talk shell get. Null for no
 * workspace, while the answer is on its way, and when none could be given.
 * A block never changes while its workspace lives, so it is read once per
 * workspace.
 */
export function useWorkspacePorts(workspaceId: string | null): PortBlock | null {
  const [state, setState] = useState<{ id: string | null; block: PortBlock | null }>({ id: null, block: null });

  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    // Through `then` so a missing or throwing IPC reads as "no block". No
    // block needs no state: another workspace's is never returned for this one.
    void Promise.resolve()
      .then(() => ipc.workspacePorts(workspaceId))
      .then(
        (block) => {
          if (live && block) setState({ id: workspaceId, block });
        },
        () => {},
      );
    return () => {
      live = false;
    };
  }, [workspaceId]);

  return workspaceId && state.id === workspaceId ? state.block : null;
}

/** `40000–40009`: the block's first and last port. */
export function portRange(block: PortBlock): string {
  return `${block.base}–${block.base + block.count - 1}`;
}
