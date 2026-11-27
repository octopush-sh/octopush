import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { McpServerStatus, McpTrust } from "../lib/types";

/** Which MCP servers each Talk conversation can use, and what Talk's registry
 *  knows about each server (the Companion's "can use" chips).
 *
 *  Every configured server is on in every conversation until the user turns
 *  one off there. The off list is stored per thread (`chat_threads.mcp_disabled`);
 *  the backend reads it at the start of each turn and fan-out (what the model
 *  is offered) and again at every MCP call (what may run). */
interface McpScopeState {
  /** The last status read per worktree path. Kept while a reload runs, so
   *  the chips never blink out. */
  statusByPath: Record<string, McpServerStatus[]>;
  /** The servers off per thread; absent until loaded. */
  offByThread: Record<string, string[]>;
  loadStatus: (worktreePath: string) => Promise<void>;
  loadOff: (threadId: string) => Promise<void>;
  /** Turn one server off in a conversation, or back on. Ignored until the
   *  thread's list has loaded. The chip changes at once; writes for one
   *  thread go out one at a time, in click order, each setting just that
   *  server, and the last one's answer is the list shown. A failed write
   *  re-reads the list. Resolves false when ignored or failed. */
  toggle: (threadId: string, server: string) => Promise<boolean>;
  /** What the user trusts to run without an MCP card in Edit freely
   *  (#1243), as it holds in a worktree (its path), or app-wide (`""`,
   *  Settings › Integrations). */
  trustByPath: Record<string, McpTrust[]>;
  loadTrust: (worktreePath?: string) => Promise<void>;
  /** Revoke a server's tool, or the whole server (`tool` null); the
   *  app-wide list becomes what the backend kept, and the worktrees' lists
   *  read again on the change event. A failure re-reads it and resolves false. */
  revokeTrust: (server: string, tool: string | null) => Promise<boolean>;
}

/** The trust for `server`, if any. */
export function trustFor(trust: McpTrust[], server: string): McpTrust | undefined {
  return trust.find((t) => t.server === server && (t.all || t.tools.length > 0));
}

/** Bumped per path by every status load, so a slower, older answer never
 *  overwrites a newer one. */
const statusSeq: Record<string, number> = {};
/** Bumped per thread by every load and toggle, so only the newest of them
 *  sets the thread's list: a load that started before a click never
 *  overwrites it. */
const offSeq: Record<string, number> = {};
/** The tail of each thread's queue of writes. */
const writeTail: Record<string, Promise<unknown>> = {};
/** Bumped per path by every trust read and revoke: only the newest answer
 *  is kept. */
const trustSeq: Record<string, number> = {};

export const useMcpScopeStore = create<McpScopeState>((set, get) => ({
  statusByPath: {},
  offByThread: {},
  trustByPath: {},

  loadTrust: async (worktreePath = "") => {
    const seq = (trustSeq[worktreePath] = (trustSeq[worktreePath] ?? 0) + 1);
    try {
      const trust = await ipc.listMcpTrust(worktreePath || undefined);
      if (trustSeq[worktreePath] === seq && Array.isArray(trust)) {
        set((s) => ({ trustByPath: { ...s.trustByPath, [worktreePath]: trust } }));
      }
    } catch {
      // Keep the last reading.
    }
  },

  revokeTrust: async (server, tool) => {
    const seq = (trustSeq[""] = (trustSeq[""] ?? 0) + 1);
    try {
      const trust = await ipc.revokeMcpTrust(server, tool);
      if (trustSeq[""] === seq) set({ trustByPath: { "": trust } });
      return true;
    } catch {
      await get().loadTrust();
      return false;
    }
  },

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
      /* still unloaded: the chips read as on (the backend's default) and ignore clicks */
    }
  },

  toggle: async (threadId, server) => {
    const current = get().offByThread[threadId];
    if (!current) return false;
    const off = !current.includes(server);
    const seq = (offSeq[threadId] = (offSeq[threadId] ?? 0) + 1);
    set((s) => ({
      offByThread: {
        ...s.offByThread,
        [threadId]: off ? [...current, server].sort() : current.filter((n) => n !== server),
      },
    }));
    const write = (writeTail[threadId] ?? Promise.resolve())
      .catch(() => {})
      .then(() => ipc.setThreadMcpServer(threadId, server, off));
    writeTail[threadId] = write;
    try {
      const stored = await write;
      if (offSeq[threadId] === seq) set((s) => ({ offByThread: { ...s.offByThread, [threadId]: stored } }));
      return true;
    } catch {
      if (offSeq[threadId] === seq) await get().loadOff(threadId);
      return false;
    }
  },
}));
