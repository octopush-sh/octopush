import { useEffect, useState } from "react";
import { Server, X } from "lucide-react";
import { ipc } from "../lib/ipc";
import type { ProjectMcpServer } from "../lib/types";
import { useChatStore } from "../stores/chatStore";
import { revokeError, useMcpChangeTick } from "./settings/ProjectMcpApprovals";

const EASE = "transition-colors duration-[var(--dur-quick)] ease-[var(--ease-octo)]";

/** A project server chip's tooltip: what it runs, rendered as the approval
 *  card shows it (`display`: shell-quoted argv with nothing hidden, then
 *  its env), and where it stands. Pure. */
export function projectServerTitle(s: ProjectMcpServer): string {
  const state = {
    approved: "approved in this project · click × to revoke",
    waiting: "waits for your approval · the next turn asks",
    changed: "changed since you approved it · the next turn asks",
    clash: "your Settings server of this name runs instead",
  }[s.state];
  return `${s.name} · ${s.display} · ${state}`;
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
  // The server being revoked (its button waits), and the last failure.
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  // Not optimistic: the chip changes only once the revoke is done, and a
  // failure keeps it approved and says why.
  const revoke = (name: string) => {
    setBusy(name);
    setError(null);
    ipc
      .revokeProjectMcpServer(name, { workspacePath: worktreePath })
      .then(() => setServers((l) => l.map((s) => (s.name === name ? { ...s, state: "waiting" } : s))))
      .catch((e) => setError(revokeError(name, e)))
      .finally(() => setBusy(null));
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
              disabled={busy === s.name}
              aria-label={`Revoke ${s.name}`}
              title={`Revoke ${s.name}: stop it, and ask again before it starts`}
              className={`rounded p-0.5 text-octo-mute hover:text-octo-rouge disabled:opacity-40 ${EASE}`}
            >
              <X size={10} />
            </button>
          )}
        </span>
      ))}
      {error && (
        <span role="alert" className="octo-fade-in w-full font-mono text-[10px] text-octo-rouge">
          {error}
        </span>
      )}
    </div>
  );
}
