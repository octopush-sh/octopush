import { useEffect, useState } from "react";
import { Server, X } from "lucide-react";
import { ipc } from "../lib/ipc";
import type { ProjectMcpServer } from "../lib/types";
import { useChatStore } from "../stores/chatStore";
import { useMcpChangeTick } from "./settings/ProjectMcpApprovals";

const EASE = "transition-colors duration-[var(--dur-quick)] ease-[var(--ease-octo)]";

/** A project server chip's tooltip: what it runs and where it stands. Pure. */
export function projectServerTitle(s: ProjectMcpServer): string {
  const runs = [s.command, ...s.args].join(" ");
  const env = s.envNames.length ? ` · env ${s.envNames.join(", ")}` : "";
  const state = {
    approved: "approved in this project · click × to revoke",
    waiting: "waits for your approval · the next turn asks",
    changed: "changed since you approved it · the next turn asks",
    clash: "your Settings server of this name runs instead",
  }[s.state];
  return `${s.name} · ${runs}${env} · ${state}`;
}

/** The Companion's MCP scope, under "can use": the servers the worktree's
 *  own `.claude/mcp.json` defines (#1245), each with where it stands. An
 *  approved one has a revoke button; one waiting or changed asks on a card
 *  in the next turn. Hidden when the project defines none. Re-reads on a
 *  workspace change, when a turn starts or settles, and on
 *  `mcp://config-changed`. */
export function CompanionProjectServers({ worktreePath, workspaceId }: { worktreePath?: string; workspaceId?: string }) {
  const streaming = useChatStore((s) => (workspaceId ? (s.streamingByWs[workspaceId] ?? false) : false));
  const tick = useMcpChangeTick();
  const [servers, setServers] = useState<ProjectMcpServer[]>([]);
  useEffect(() => {
    if (!worktreePath) return;
    let live = true;
    Promise.resolve(ipc.listProjectMcpServers?.(worktreePath))
      .then((l) => live && setServers(l ?? []))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [worktreePath, streaming, tick]);
  if (!worktreePath || servers.length === 0) return null;
  const revoke = (name: string) => {
    setServers((l) => l.map((s) => (s.name === name ? { ...s, state: "waiting" } : s)));
    void ipc.revokeProjectMcpServer(name, { workspacePath: worktreePath }).catch(() => {});
  };
  return (
    <div className="octo-rise-in mt-1 flex flex-wrap items-center gap-x-3 gap-y-1" data-tour="companion-project-servers">
      <span className="text-octo-sage" title="The servers this project's .claude/mcp.json defines. Each starts only once you approve it, and a change asks again.">
        project servers
      </span>
      {servers.map((s) => (
        <span key={s.name} className="octo-fade-in flex items-center gap-1 text-[10px]" title={projectServerTitle(s)} data-state={s.state}>
          <Server size={10} aria-hidden className={`shrink-0 ${s.state === "approved" ? "text-octo-sage" : "text-octo-mute"}`} />
          <span className={`font-mono ${s.state === "approved" ? "text-octo-ivory" : "text-octo-mute line-through decoration-octo-mute/60"}`}>
            {s.name}
          </span>
          {s.state === "approved" && (
            <button
              type="button"
              onClick={() => revoke(s.name)}
              aria-label={`Revoke ${s.name}`}
              title={`Revoke ${s.name}: stop it, and ask again before it starts`}
              className={`rounded p-0.5 text-octo-mute hover:text-octo-rouge ${EASE}`}
            >
              <X size={10} />
            </button>
          )}
        </span>
      ))}
    </div>
  );
}
