import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { ipc } from "../../lib/ipc";
import type { ProjectMcpApproval } from "../../lib/types";

const EASE = "transition-colors duration-[var(--dur-quick)] ease-[var(--ease-octo)]";

/** Re-read whenever the MCP config or an approval changes
 *  (`mcp://config-changed`, which an approval and a revoke emit). */
export function useMcpChangeTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    // Optional calls, as in McpServersSection: a pane test may mock ipc without them.
    void Promise.resolve(ipc.onMcpChanged?.(() => setTick((t) => t + 1)))
      .then((u) => {
        if (!u) return;
        if (disposed) u();
        else unlisten = u;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  return tick;
}

/** Settings › Integrations, under MCP Servers: the project servers you
 *  approved (#1245), each with a revoke button that stops it and makes it
 *  ask again. Hidden while there is none. */
export function ProjectMcpApprovals() {
  const [list, setList] = useState<ProjectMcpApproval[]>([]);
  const tick = useMcpChangeTick();
  useEffect(() => {
    let live = true;
    Promise.resolve(ipc.listProjectMcpApprovals?.())
      .then((l) => live && setList(l ?? []))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [tick]);
  if (list.length === 0) return null;
  const revoke = (a: ProjectMcpApproval) => {
    setList((l) => l.filter((x) => x !== a));
    void ipc.revokeProjectMcpServer(a.server, { projectId: a.projectId }).catch(() => {});
  };
  return (
    <div className="octo-rise-in mt-4" data-tour="settings-mcp-project-approvals">
      <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-octo-mute">Approved project servers</div>
      <p className="mt-1 text-[12px] text-octo-mute">
        A server a project's <span className="font-mono text-octo-sage">.claude/mcp.json</span> defines starts only
        once you approve it in Talk, and any change to its entry asks again.
      </p>
      <div className="mt-2 space-y-1.5">
        {list.map((a) => (
          <div
            key={`${a.projectId}/${a.server}`}
            className="octo-fade-in flex items-center gap-3 rounded-md border border-octo-hairline bg-octo-panel px-3 py-2"
          >
            <span className="font-mono text-[12px] text-octo-ivory">{a.server}</span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-octo-mute">{a.projectName}</span>
            <button
              type="button"
              onClick={() => revoke(a)}
              aria-label={`Revoke ${a.server} in ${a.projectName}`}
              title="Revoke: stop it, and ask again before it starts"
              className={`flex items-center justify-center rounded p-1 text-octo-mute hover:text-octo-rouge ${EASE}`}
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
