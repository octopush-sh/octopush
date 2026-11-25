import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { McpServerStatus } from "../lib/types";

/** Which MCP servers each Talk conversation can use, and what Talk's registry
 *  knows about each server (the Companion's "can use" chips).
 *
 *  Every configured server is on in every conversation until the user turns
 *  one off there. The off list is stored per thread (`chat_threads.mcp_disabled`)
 *  and read by the backend at the start of each turn and each sub-agent
 *  fan-out, so a turn never offers the model a server that is off. */
interface McpScopeState {
  /** The last status read per worktree path. Kept while a reload runs, so
   *  the chips never blink out. */
  statusByPath: Record<string, McpServerStatus[]>;
  /** The servers off per thread; absent until loaded. */
  offByThread: Record<string, string[]>;
  loadStatus: (worktreePath: string) => Promise<void>;
  loadOff: (threadId: string) => Promise<void>;
  /** Turn one server off in a conversation, or back on. Optimistic: the
   *  chip changes at once and goes back if the write fails. */
  toggle: (threadId: string, server: string) => Promise<boolean>;
}

/** Bumped per path by every status load, so a slower, older answer never
 *  overwrites a newer one. */
const statusSeq: Record<string, number> = {};
/** Bumped per thread by every load and write, so a load that started before
 *  a write never overwrites what the write set. */
const offSeq: Record<string, number> = {};

export const useMcpScopeStore = create<McpScopeState>((set, get) => ({
  statusByPath: {},
  offByThread: {},

  loadStatus: async (worktreePath) => {
    const seq = (statusSeq[worktreePath] = (statusSeq[worktreePath] ?? 0) + 1);
    try {
      const status = await ipc.listMcpServerStatus(worktreePath);
      if (statusSeq[worktreePath] !== seq) return;
      set((s) => ({ statusByPath: { ...s.statusByPath, [worktreePath]: status } }));
    } catch {
      // Keep the last reading: a failed read says nothing about the servers.
    }
  },

  loadOff: async (threadId) => {
    const seq = (offSeq[threadId] = (offSeq[threadId] ?? 0) + 1);
    try {
      const off = await ipc.getThreadMcpDisabled(threadId);
      if (offSeq[threadId] !== seq) return;
      set((s) => ({ offByThread: { ...s.offByThread, [threadId]: off } }));
    } catch {
      /* unknown: the chips read as on, which is what the backend defaults to */
    }
  },

  toggle: async (threadId, server) => {
    const before = get().offByThread[threadId] ?? [];
    const next = before.includes(server) ? before.filter((n) => n !== server) : [...before, server].sort();
    const seq = (offSeq[threadId] = (offSeq[threadId] ?? 0) + 1);
    set((s) => ({ offByThread: { ...s.offByThread, [threadId]: next } }));
    try {
      await ipc.setThreadMcpDisabled(threadId, next);
      return true;
    } catch {
      if (offSeq[threadId] === seq) set((s) => ({ offByThread: { ...s.offByThread, [threadId]: before } }));
      return false;
    }
  },
}));
