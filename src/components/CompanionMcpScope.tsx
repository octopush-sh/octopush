import { useEffect, useState } from "react";
import { Server } from "lucide-react";
import { ipc } from "../lib/ipc";
import type { McpServerStatus } from "../lib/types";
import { useChatStore } from "../stores/chatStore";
import { useMcpScopeStore } from "../stores/mcpScopeStore";

// Stable empties so the selectors never hand React a fresh array per render.
const NO_STATUS: McpServerStatus[] = [];
const NONE_OFF: string[] = [];

const EASE = "transition-colors duration-[var(--dur-quick)] ease-[var(--ease-octo)]";

/** A chip's tooltip: the server, what Talk knows about it, and what a click
 *  does. Pure so the copy is tested. */
export function chipTitle(s: McpServerStatus, off: boolean, canToggle: boolean): string {
  if (off) return `${s.name} · off in this conversation${canToggle ? " · click to turn it back on" : ""}`;
  const state =
    s.state === "connected"
      ? s.tools == null
        ? "connected"
        : `connected · ${s.tools} ${s.tools === 1 ? "tool" : "tools"}`
      : s.state === "failed"
        ? `failed${s.reason ? `: ${s.reason}` : ""}`
        : "not started yet · it starts on first use";
  return `${s.name} · ${state}${canToggle ? " · click to turn off in this conversation" : ""}`;
}

/** The server icon's colour carries the state (its title says it in words):
 *  verdigris connected, rouge failed, mute not started or off. Never brass:
 *  status is not the accent. */
export function chipTone(state: McpServerStatus["state"], off: boolean): string {
  if (off) return "text-octo-mute";
  return state === "connected" ? "text-octo-verdigris" : state === "failed" ? "text-octo-rouge" : "text-octo-mute";
}

/** The servers configured for the worktree, their status and which are off in
 *  the open conversation. The status re-reads on a workspace or thread change,
 *  when a turn starts or settles, and on `mcp://config-changed` (Settings
 *  saved) or `mcp://status-changed` (Reconnect, a turn's discovery). */
function useMcpScope(worktreePath: string | undefined, workspaceId: string) {
  const threadId = useChatStore((s) => (workspaceId ? (s.activeThreadByWs[workspaceId] ?? null) : null));
  const streaming = useChatStore((s) => s.streamingByWs[workspaceId] ?? false);
  const status = useMcpScopeStore((s) => (worktreePath ? s.statusByPath[worktreePath] : undefined) ?? NO_STATUS);
  const off = useMcpScopeStore((s) => (threadId ? s.offByThread[threadId] : undefined) ?? NONE_OFF);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void ipc
      .onMcpChanged(() => setTick((t) => t + 1))
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (worktreePath) void useMcpScopeStore.getState().loadStatus(worktreePath);
  }, [worktreePath, threadId, streaming, tick]);

  useEffect(() => {
    if (threadId) void useMcpScopeStore.getState().loadOff(threadId);
  }, [threadId]);

  return { threadId, status, off };
}

/**
 * The Conversation section's "can use" row: one chip per MCP server
 * configured for the workspace (Settings › Integrations, or the repo's
 * `.claude/mcp.json`). Every server is on in every conversation; clicking a
 * chip turns it off for this conversation only, and clicking again turns it
 * back on. Hidden when no server is configured.
 */
export function CompanionMcpScope({ worktreePath, workspaceId }: { worktreePath?: string; workspaceId?: string }) {
  const { threadId, status, off } = useMcpScope(worktreePath, workspaceId ?? "");
  if (status.length === 0) return null;
  return (
    <div
      className="octo-rise-in mt-3 flex flex-wrap items-center gap-x-3 gap-y-1"
      data-tour="companion-can-use"
      data-testid="companion-can-use"
    >
      <span
        className="text-octo-sage"
        title="MCP servers from Settings › Integrations. Click one to turn it off or back on in this conversation."
      >
        can use
      </span>
      {status.map((s) => {
        const isOff = off.includes(s.name);
        const title = chipTitle(s, isOff, !!threadId);
        const body = (
          <>
            <Server size={10} aria-hidden className={`shrink-0 ${EASE} ${chipTone(s.state, isOff)}`} />
            <span
              className={`font-mono ${EASE} ${
                isOff ? "text-octo-mute line-through decoration-octo-mute/60" : "text-octo-ivory"
              }`}
            >
              {s.name}
            </span>
          </>
        );
        if (!threadId) {
          return (
            <span key={s.name} className="octo-fade-in flex items-center gap-1 text-[10px]" title={title}>
              {body}
            </span>
          );
        }
        return (
          <button
            key={s.name}
            type="button"
            aria-pressed={!isOff}
            title={title}
            data-state={isOff ? "off" : s.state}
            onClick={() => void useMcpScopeStore.getState().toggle(threadId, s.name)}
            className={`octo-fade-in -mx-1 flex items-center gap-1 rounded px-1 text-[10px] ${EASE} hover:bg-[var(--brass-ghost)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass`}
          >
            {body}
          </button>
        );
      })}
    </div>
  );
}
