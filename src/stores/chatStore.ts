import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { ipc } from "../lib/ipc";
import type { ChatMessage, ChatStreamEvent, ChatThread, Attachment } from "../lib/types";
import { useWorkspaceStore } from "./workspaceStore";
import { useBudgetsStore, BUDGET_CAP_MSG } from "./budgetsStore";
import { useAttentionStore } from "./attentionStore";
import { focus } from "../lib/focus";
import { deriveChatTitle } from "../lib/chatTitle";

export interface ToolExecution {
  toolName: string;
  toolInput: Record<string, unknown>;
  result: string;
  /** Provider tool_use id — correlates the resolved card to its live card. */
  callId?: string;
}

/** A tool currently executing (between `chat://tool-start` and the resolved
 *  `chat://message-added` role=tool). Rendered as a live "running" card. */
export interface LiveTool {
  callId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  /** Backend's RFC3339 start timestamp — the elapsed timer measures from here,
   *  not from card mount, so a slow first paint doesn't under-report. */
  startedAt: string;
  /** True once `chat://tool-end` arrived; the card briefly shows a verdict. */
  done: boolean;
  ok: boolean;
  durationMs: number | null;
}

interface ToolStartEvent {
  workspaceId: string;
  threadId?: string;
  callId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  startedAt: string;
}

interface ToolEndEvent {
  workspaceId: string;
  threadId?: string;
  callId: string;
  ok: boolean;
  durationMs: number;
}

/** Generation effort presets — map to the output-token budget (and, later,
 *  thinking budget). Swift is cheap/snappy; Deep gives the model more room. */
/** A promoted long-running `$`-direct process, rendered in a pinned terminal. */
export interface LiveProcess {
  callId: string;
  command: string;
  workspaceId: string;
  /** The thread whose shell runs this process — targets interactive stdin/resize. */
  threadId: string;
}

/** Buffered live-process output, kept so the pinned terminal can render even if
 *  it mounts after the first chunks arrive (the listener is always-on, so no
 *  output is lost to a mount race). `total` is the monotonic count of all bytes
 *  ever appended — `text` is capped, so the panel writes `total - written` from
 *  the tail. */
export interface LiveOutput {
  text: string;
  total: number;
}

/** Cap on the in-memory live-output buffer (xterm holds its own scrollback). */
const LIVE_OUTPUT_CAP = 262_144;

/** A pending approval request for a destructive agent command (inline card). */
export interface PendingApproval {
  callId: string;
  threadId: string;
  command: string;
  reason: string;
}

export type Effort = "swift" | "standard" | "deep";

export const EFFORT_MAX_TOKENS: Record<Effort, number> = {
  swift: 8192,
  standard: 32768,
  deep: 64000,
};

/** A display item in the conversation — either a regular message, tool execution, or persisted error. */
export type ConversationItem =
  | { kind: "message"; message: ChatMessage }
  | { kind: "tool"; tool: ToolExecution; id: number }
  | { kind: "error"; message: ChatMessage };

/** Strip the trailing `[tool_calls: …]` bookkeeping suffix the engine appends
 *  to persisted `assistant_tool_use` rows, returning only the human-facing
 *  lead text. Empty result ⇒ the row is pure bookkeeping and should be hidden. */
function stripToolCallsSuffix(content: string): string {
  const idx = content.indexOf("[tool_calls:");
  return (idx === -1 ? content : content.slice(0, idx)).trim();
}

/** Project persisted messages into renderable timeline items. Shared by the
 *  store's `getTimeline` selector and the canvas useMemo so both agree on how
 *  tool rows, errors, and `assistant_tool_use` bookkeeping are handled. */
export function buildTimeline(msgs: ChatMessage[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  for (const msg of msgs) {
    const role = msg.role as string;
    if (role === "tool") {
      try {
        const tool: ToolExecution = JSON.parse(msg.content);
        items.push({ kind: "tool", tool, id: msg.id });
      } catch {
        items.push({ kind: "message", message: msg });
      }
    } else if (role === "error") {
      items.push({ kind: "error", message: msg });
    } else if (role === "assistant_tool_use") {
      // Reloaded from DB: show only the model's lead text, never the raw
      // `[tool_calls: …]` JSON. Skip rows that are pure bookkeeping.
      const text = stripToolCallsSuffix(msg.content);
      if (text) items.push({ kind: "message", message: { ...msg, content: text } });
    } else {
      items.push({ kind: "message", message: msg });
    }
  }
  return items;
}

export interface MessageAddedEvent {
  workspaceId: string;
  threadId?: string;
  id: number;
  role: string;
  content: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  createdAt: string;
}

// Stable empty values returned by selectors when a workspace has no data.
// Critical: returning a NEW empty array per call would make Zustand selectors
// invalidate every render → infinite re-render loop (caught in Phase 4 bug fix).
const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_TIMELINE: ConversationItem[] = [];
const EMPTY_LIVE_TOOLS: LiveTool[] = [];
const EMPTY_THREADS: ChatThread[] = [];
const EMPTY_ATTACHMENTS: Attachment[] = [];
const EMPTY_HISTORY: string[] = [];
const EMPTY_APPROVALS: PendingApproval[] = [];

/** True when a turn must be blocked for budget — workspace or global cap is
 *  exceeded and no per-turn override is available to consume. Mirrors the gate
 *  inside `send`; shared by regenerate / editAndResend so they can refuse BEFORE
 *  truncating (a blocked action must not delete the rows it can't re-run). */
function overBudgetBlocked(workspaceId: string): boolean {
  const { isOverBudget, consumeOverride } = useBudgetsStore.getState();
  if (isOverBudget("workspace", workspaceId) || isOverBudget("global", "")) {
    return !consumeOverride();
  }
  return false;
}

/** Whether an event for `threadId` should apply to the workspace's currently
 *  shown thread. Lenient: when no active thread is recorded yet (e.g. tests) or
 *  the event omits a threadId, it applies — preserving pre-thread behavior so
 *  the existing test suite keeps passing. */
function isActiveThread(
  activeThreadByWs: Record<string, string>,
  wsId: string,
  threadId?: string,
): boolean {
  const active = activeThreadByWs[wsId];
  return !active || !threadId || threadId === active;
}

interface ChatState {
  /** Messages keyed by workspaceId. Each workspace has its own conversation. */
  messagesByWs: Record<string, ChatMessage[]>;
  /** Streaming flag per workspace. `true` only while THAT workspace's agentic loop runs. */
  streamingByWs: Record<string, boolean>;
  /** Partial assistant text being streamed per workspace. */
  streamBufferByWs: Record<string, string>;
  /** Last error per workspace. */
  errorByWs: Record<string, string | null>;
  /** Tools currently executing per workspace (live "running" cards). */
  liveToolsByWs: Record<string, LiveTool[]>;

  /** Conversation threads per workspace (most-recent-first). */
  threadsByWs: Record<string, ChatThread[]>;
  /** The thread currently shown per workspace. The `…ByWs` chat state above
   *  always reflects THIS thread; switching threads reloads it. */
  activeThreadByWs: Record<string, string>;
  /** Which thread (if any) currently has an in-flight turn per workspace, even
   *  if it's not the one being shown — lets the streaming indicator be restored
   *  when switching back to a still-running thread. */
  streamingThreadByWs: Record<string, string | null>;
  /** Active skill name per workspace — appended to the system prompt + tool
   *  scoping for each turn until cleared. */
  activeSkillByWs: Record<string, string | null>;
  /** Pending image attachments per workspace — sent with the next turn, then
   *  cleared. */
  attachmentsByWs: Record<string, Attachment[]>;
  /** Working directory of each thread's TALK shell (keyed by threadId), updated
   *  after every `$`-direct command so the composer can show a cwd badge once
   *  the user has `cd`'d away from the workspace root. */
  shellCwdByThread: Record<string, string>;
  /** Absolute cwd per thread — kept alongside the label so the badge tooltip can
   *  show the full path (the label elides out-of-tree prefixes). */
  shellCwdAbsByThread: Record<string, string>;
  /** A live (long-running) `$`-direct process per thread, shown as a pinned
   *  mini-terminal. Present between chat://shell-live-start and shell-exit. */
  liveProcessByThread: Record<string, LiveProcess>;
  /** Buffered output for each live process, keyed by callId. */
  liveOutputByCallId: Record<string, LiveOutput>;
  /** Recent `$`-direct commands per workspace (newest first) — the recall
   *  palette + `$ `↑ history. Persisted backend-side; cached here. */
  shellHistoryByWs: Record<string, string[]>;
  /** Pending dangerous-command approval requests per workspace (inline cards).
   *  Present between chat://approval-request and approval-resolved. */
  pendingApprovalsByWs: Record<string, PendingApproval[]>;

  /** Global model preference. Applies to whichever workspace the user types in. */
  model: string;
  /** Global generation-effort preference (maps to the output-token budget). */
  effort: Effort;

  // Selectors (read-only, scoped by workspaceId)
  getMessages: (workspaceId: string) => ChatMessage[];
  getStreaming: (workspaceId: string) => boolean;
  getStreamBuffer: (workspaceId: string) => string;
  getError: (workspaceId: string) => string | null;
  getLiveTools: (workspaceId: string) => LiveTool[];
  getTimeline: (workspaceId: string) => ConversationItem[];
  getThreads: (workspaceId: string) => ChatThread[];
  getActiveThread: (workspaceId: string) => string | null;
  getActiveSkill: (workspaceId: string) => string | null;
  getAttachments: (workspaceId: string) => Attachment[];
  /** The active thread's TALK shell cwd label (badge text), or null. */
  getShellCwd: (workspaceId: string) => string | null;
  /** The active thread's absolute TALK shell cwd (for the badge tooltip). */
  getShellCwdAbs: (workspaceId: string) => string | null;
  /** The active thread's live `$`-direct process, or null if none is running. */
  getLiveProcess: (workspaceId: string) => LiveProcess | null;
  /** Buffered output for a live process (by callId) — for the pinned terminal. */
  getLiveOutput: (callId: string) => LiveOutput | null;
  /** Recent `$`-direct commands for a workspace (newest first). */
  getShellHistory: (workspaceId: string) => string[];
  /** Pending dangerous-command approvals for the active thread. */
  getPendingApprovals: (workspaceId: string) => PendingApproval[];

  // Actions
  loadHistory: (workspaceId: string) => Promise<void>;
  send: (
    workspaceId: string,
    workspacePath: string,
    content: string,
    systemPrompt?: string,
  ) => Promise<void>;
  /** Internal: dispatch one agentic turn (shared by send / regenerate). */
  runTurn: (
    workspaceId: string,
    workspacePath: string,
    threadId: string,
    opts: {
      userMessage: string;
      systemPrompt?: string;
      attachments?: Attachment[];
      regenerate?: boolean;
    },
  ) => Promise<void>;
  /** Internal: budget-gate, truncate from a cutoff message id, then dispatch.
   *  Shared by regenerate / editAndResend. */
  truncateAndRun: (
    workspaceId: string,
    workspacePath: string,
    threadId: string,
    cutoffId: number,
    opts: {
      userMessage: string;
      systemPrompt?: string;
      attachments?: Attachment[];
      regenerate?: boolean;
    },
  ) => Promise<void>;
  /** Regenerate an assistant turn: drop it (and any trailing tool rows) back to
   *  the prompting user message, then re-run the loop on the unchanged history. */
  regenerate: (
    workspaceId: string,
    workspacePath: string,
    assistantMessageId: number,
    systemPrompt?: string,
  ) => Promise<void>;
  /** Edit a user message and resend: truncate from it, then dispatch the new
   *  text as a fresh turn. */
  editAndResend: (
    workspaceId: string,
    workspacePath: string,
    userMessageId: number,
    newContent: string,
    systemPrompt?: string,
  ) => Promise<void>;
  /** Run a `$`-direct command in the thread's TALK shell, bypassing the LLM.
   *  The command + output are persisted into the conversation as context. */
  runShell: (
    workspaceId: string,
    workspacePath: string,
    command: string,
  ) => Promise<void>;
  /** SIGINT (Ctrl-C) the active thread's live `$`-direct process. */
  stopShellProcess: (workspaceId: string) => void;
  /** Load the workspace's recent `$`-command history into the cache. */
  loadShellHistory: (workspaceId: string) => Promise<void>;
  /** Resolve a dangerous-command approval card (removes it + tells the backend). */
  respondApproval: (
    workspaceId: string,
    callId: string,
    decision: "approve" | "always" | "deny",
  ) => void;
  setModel: (model: string) => void;
  setEffort: (effort: Effort) => void;
  setActiveSkill: (workspaceId: string, skill: string | null) => void;
  addAttachment: (workspaceId: string, attachment: Attachment) => void;
  removeAttachment: (workspaceId: string, index: number) => void;
  clearAttachments: (workspaceId: string) => void;
  /** Stop the in-flight turn for this workspace (best-effort; backend halts
   *  before its next iteration/tool and emits the done event). */
  stop: (workspaceId: string) => void;
  clear: (workspaceId: string) => void;
  clearError: (workspaceId: string) => void;
  // Thread actions
  /** Return the workspace's active thread id, creating+loading a default one
   *  if none is active yet (so a send can never orphan a message). */
  ensureThread: (workspaceId: string) => Promise<string>;
  selectThread: (workspaceId: string, threadId: string) => Promise<void>;
  newThread: (workspaceId: string) => Promise<void>;
  renameThread: (workspaceId: string, threadId: string, title: string) => Promise<void>;
  deleteThread: (workspaceId: string, threadId: string) => Promise<void>;
}

export const useChatStore = create<ChatState>((set, get) => {
  // Guards loadHistory against concurrent double-creation of a default thread
  // (rapid workspace switches / mount races). Mirrors the terminal-init guard.
  const loadingHistory = new Set<string>();

  // ── chat://message-added ──────────────────────────────────────
  // Append a message to ITS workspace's bucket, with idempotency on id.
  listen<MessageAddedEvent>("chat://message-added", (ev) => {
    const payload = ev.payload;
    const wsId = payload.workspaceId;

    set((s) => {
      // Only reflect events for the thread currently shown in this workspace;
      // background-thread messages are persisted server-side and load on switch.
      if (!isActiveThread(s.activeThreadByWs, wsId, payload.threadId)) {
        return {};
      }
      const existing = s.messagesByWs[wsId] ?? EMPTY_MESSAGES;
      if (existing.some((m) => m.id === payload.id)) {
        return {};
      }
      const newMessage: ChatMessage = {
        id: payload.id,
        workspaceId: payload.workspaceId,
        role: payload.role as "user" | "assistant" | "tool" | "error" | "stopped",
        content: payload.content,
        model: payload.model,
        inputTokens: payload.inputTokens,
        outputTokens: payload.outputTokens,
        costUsd: payload.costUsd,
        createdAt: payload.createdAt,
      };

      // When a resolved tool row arrives, retire its live "running" card so the
      // ToolCallCard from the timeline takes over with no flash. Correlate by
      // the callId embedded in the persisted record.
      let liveToolsByWs = s.liveToolsByWs;
      if (payload.role === "tool") {
        const live = s.liveToolsByWs[wsId];
        if (live && live.length > 0) {
          let callId: string | undefined;
          try {
            callId = (JSON.parse(payload.content) as ToolExecution).callId;
          } catch {
            callId = undefined;
          }
          // Retire strictly by callId — the producer (tool-start) always tags
          // it, so there's no positional guessing. An untagged row (legacy/
          // replayed) simply leaves the live list untouched; the stream `done`
          // sweep is the backstop.
          if (callId) {
            liveToolsByWs = {
              ...s.liveToolsByWs,
              [wsId]: live.filter((t) => t.callId !== callId),
            };
          }
        }
      }

      return {
        messagesByWs: {
          ...s.messagesByWs,
          [wsId]: [...existing, newMessage],
        },
        liveToolsByWs,
      };
    });

    // Cross-workspace notification (unchanged behavior).
    const wsStore = useWorkspaceStore.getState();
    if (wsId && wsId !== wsStore.activeId) {
      wsStore.notify(wsId);
    }
  });

  // ── chat://stream ─────────────────────────────────────────────
  // Stream deltas or done signal — routed to the originating workspace.
  listen<ChatStreamEvent>("chat://stream", (ev) => {
    const payload = ev.payload;
    const wsId = payload.workspaceId;
    if (!wsId) return;
    const active = isActiveThread(get().activeThreadByWs, wsId, payload.threadId);

    if (payload.done) {
      // The done event clears the streaming-thread tracker and fires the
      // attention ping even for a BACKGROUND thread (so its flag never sticks
      // and its completion is still announced). View state only clears for the
      // thread currently on screen.
      set((s) => {
        const clearsTracker =
          payload.threadId == null || s.streamingThreadByWs[wsId] === payload.threadId;
        const streamingThreadByWs = clearsTracker
          ? { ...s.streamingThreadByWs, [wsId]: null }
          : s.streamingThreadByWs;
        if (!active) return { streamingThreadByWs };
        // Clear any stragglers (e.g. a tool whose result errored before its
        // resolved row landed) so no spinner outlives the turn — BUT keep the
        // live card of a `$`-direct process that's still running in this
        // workspace (its callId is tracked in liveProcessByThread); the LLM
        // turn finishing must not erase a concurrently streaming process.
        const liveCallIds = new Set(
          Object.values(s.liveProcessByThread)
            .filter((p) => p.workspaceId === wsId)
            .map((p) => p.callId),
        );
        const kept = (s.liveToolsByWs[wsId] ?? EMPTY_LIVE_TOOLS).filter((t) =>
          liveCallIds.has(t.callId),
        );
        return {
          streamingByWs: { ...s.streamingByWs, [wsId]: false },
          streamBufferByWs: { ...s.streamBufferByWs, [wsId]: "" },
          liveToolsByWs: {
            ...s.liveToolsByWs,
            [wsId]: kept.length ? kept : EMPTY_LIVE_TOOLS,
          },
          streamingThreadByWs,
        };
      });
      // Only ring the chime / pulse the rail if the user isn't already
      // looking at this chat — otherwise they'll just be told what
      // they're already seeing.
      if (focus.workspaceId !== wsId || focus.mode !== "talk") {
        useAttentionStore.getState().ping(wsId, "chat");
      }
    } else if (active) {
      set((s) => ({
        streamBufferByWs: {
          ...s.streamBufferByWs,
          [wsId]: (s.streamBufferByWs[wsId] ?? "") + payload.delta,
        },
      }));
    }
  });

  // ── chat://tool-start ─────────────────────────────────────────
  // A tool began executing — show a live "running" card immediately.
  listen<ToolStartEvent>("chat://tool-start", (ev) => {
    const p = ev.payload;
    if (!p.workspaceId) return;
    if (!isActiveThread(get().activeThreadByWs, p.workspaceId, p.threadId)) return;
    set((s) => {
      const live = s.liveToolsByWs[p.workspaceId] ?? EMPTY_LIVE_TOOLS;
      if (live.some((t) => t.callId === p.callId)) return {};
      const entry: LiveTool = {
        callId: p.callId,
        toolName: p.toolName,
        toolInput: p.toolInput ?? {},
        startedAt: p.startedAt,
        done: false,
        ok: true,
        durationMs: null,
      };
      return {
        liveToolsByWs: { ...s.liveToolsByWs, [p.workspaceId]: [...live, entry] },
      };
    });
  });

  // ── chat://tool-end ───────────────────────────────────────────
  // The tool finished — mark the live card done (timing + verdict). The
  // resolved row (message-added) removes it moments later.
  listen<ToolEndEvent>("chat://tool-end", (ev) => {
    const p = ev.payload;
    if (!p.workspaceId) return;
    if (!isActiveThread(get().activeThreadByWs, p.workspaceId, p.threadId)) return;
    set((s) => {
      const live = s.liveToolsByWs[p.workspaceId];
      if (!live || !live.some((t) => t.callId === p.callId)) return {};
      const next = live.map((t) =>
        t.callId === p.callId
          ? { ...t, done: true, ok: p.ok, durationMs: p.durationMs }
          : t,
      );
      return { liveToolsByWs: { ...s.liveToolsByWs, [p.workspaceId]: next } };
    });
  });

  // ── chat://shell-live-start ───────────────────────────────────
  // A `$`-direct command was promoted to a live process — open a pinned
  // mini-terminal for the thread. The `initial` output is painted on mount;
  // subsequent chunks arrive as chat://shell-output (consumed by TerminalView).
  listen<{
    workspaceId: string;
    threadId: string;
    callId: string;
    command: string;
  }>("chat://shell-live-start", (ev) => {
    const p = ev.payload;
    if (!p.threadId) return;
    set((s) => ({
      liveProcessByThread: {
        ...s.liveProcessByThread,
        [p.threadId]: {
          callId: p.callId,
          command: p.command,
          workspaceId: p.workspaceId,
          threadId: p.threadId,
        },
      },
    }));
  });

  // ── chat://shell-output ───────────────────────────────────────
  // Live-process output chunks. Buffered here (listener always active) so the
  // pinned terminal never loses output to a mount race; capped, with a monotonic
  // `total` so the panel can write only the tail it hasn't shown yet.
  listen<{ threadId: string; callId: string; chunk: string }>(
    "chat://shell-output",
    (ev) => {
      const { callId, chunk } = ev.payload;
      if (!chunk) return;
      set((s) => {
        const prev = s.liveOutputByCallId[callId] ?? { text: "", total: 0 };
        let text = prev.text + chunk;
        if (text.length > LIVE_OUTPUT_CAP) text = text.slice(text.length - LIVE_OUTPUT_CAP);
        return {
          liveOutputByCallId: {
            ...s.liveOutputByCallId,
            [callId]: { text, total: prev.total + chunk.length },
          },
        };
      });
    },
  );

  // ── chat://approval-request ───────────────────────────────────
  // The agent wants to run a destructive command — show an inline Approve/Deny
  // card; the backend turn is paused until respondApproval resolves it.
  listen<{
    workspaceId: string;
    threadId: string;
    callId: string;
    command: string;
    reason: string;
  }>("chat://approval-request", (ev) => {
    const p = ev.payload;
    if (!p.workspaceId) return;
    set((s) => {
      const cur = s.pendingApprovalsByWs[p.workspaceId] ?? EMPTY_APPROVALS;
      if (cur.some((a) => a.callId === p.callId)) return {};
      return {
        pendingApprovalsByWs: {
          ...s.pendingApprovalsByWs,
          [p.workspaceId]: [
            ...cur,
            { callId: p.callId, threadId: p.threadId, command: p.command, reason: p.reason },
          ],
        },
      };
    });
  });

  // ── chat://approval-resolved ──────────────────────────────────
  // The request was answered (or timed out) — retire the card.
  listen<{ workspaceId: string; callId: string }>("chat://approval-resolved", (ev) => {
    const p = ev.payload;
    if (!p.workspaceId) return;
    set((s) => {
      const cur = s.pendingApprovalsByWs[p.workspaceId];
      if (!cur) return {};
      return {
        pendingApprovalsByWs: {
          ...s.pendingApprovalsByWs,
          [p.workspaceId]: cur.filter((a) => a.callId !== p.callId),
        },
      };
    });
  });

  // ── chat://shell-cwd ──────────────────────────────────────────
  // The agent's run_command moved the shared shell's cwd — update the badge so
  // it stays accurate (the `$`-direct path updates from its result instead).
  listen<{ threadId: string; cwd: string; cwdLabel: string }>(
    "chat://shell-cwd",
    (ev) => {
      const p = ev.payload;
      if (!p.threadId) return;
      set((s) => ({
        shellCwdByThread: { ...s.shellCwdByThread, [p.threadId]: p.cwdLabel ?? "" },
        shellCwdAbsByThread: { ...s.shellCwdAbsByThread, [p.threadId]: p.cwd ?? "" },
      }));
    },
  );

  // ── chat://shell-exit ─────────────────────────────────────────
  // The live process exited — close the pinned terminal and update the cwd.
  listen<{
    threadId: string;
    callId: string;
    exitCode: number;
    cwd: string;
    cwdLabel: string;
  }>("chat://shell-exit", (ev) => {
    const p = ev.payload;
    if (!p.threadId) return;
    set((s) => {
      const next = { ...s.liveProcessByThread };
      delete next[p.threadId];
      const nextOut = { ...s.liveOutputByCallId };
      delete nextOut[p.callId];
      return {
        liveProcessByThread: next,
        liveOutputByCallId: nextOut,
        // Backend-computed label is the badge's single source (empty = root).
        shellCwdByThread: { ...s.shellCwdByThread, [p.threadId]: p.cwdLabel ?? "" },
        shellCwdAbsByThread: { ...s.shellCwdAbsByThread, [p.threadId]: p.cwd ?? "" },
      };
    });
  });

  return {
    messagesByWs: {},
    streamingByWs: {},
    streamBufferByWs: {},
    errorByWs: {},
    liveToolsByWs: {},
    threadsByWs: {},
    activeThreadByWs: {},
    streamingThreadByWs: {},
    activeSkillByWs: {},
    attachmentsByWs: {},
    shellCwdByThread: {},
    shellCwdAbsByThread: {},
    liveProcessByThread: {},
    liveOutputByCallId: {},
    shellHistoryByWs: {},
    pendingApprovalsByWs: {},
    model: "claude-sonnet-4-6",
    effort: "standard",

    getMessages: (workspaceId) => get().messagesByWs[workspaceId] ?? EMPTY_MESSAGES,
    getStreaming: (workspaceId) => get().streamingByWs[workspaceId] ?? false,
    getStreamBuffer: (workspaceId) => get().streamBufferByWs[workspaceId] ?? "",
    getError: (workspaceId) => get().errorByWs[workspaceId] ?? null,
    getLiveTools: (workspaceId) => get().liveToolsByWs[workspaceId] ?? EMPTY_LIVE_TOOLS,
    getThreads: (workspaceId) => get().threadsByWs[workspaceId] ?? EMPTY_THREADS,
    getActiveThread: (workspaceId) => get().activeThreadByWs[workspaceId] ?? null,
    getActiveSkill: (workspaceId) => get().activeSkillByWs[workspaceId] ?? null,
    getAttachments: (workspaceId) => get().attachmentsByWs[workspaceId] ?? EMPTY_ATTACHMENTS,
    getShellCwd: (workspaceId) => {
      const threadId = get().activeThreadByWs[workspaceId];
      return threadId ? get().shellCwdByThread[threadId] ?? null : null;
    },
    getShellCwdAbs: (workspaceId) => {
      const threadId = get().activeThreadByWs[workspaceId];
      return threadId ? get().shellCwdAbsByThread[threadId] ?? null : null;
    },
    getLiveProcess: (workspaceId) => {
      const threadId = get().activeThreadByWs[workspaceId];
      return threadId ? get().liveProcessByThread[threadId] ?? null : null;
    },
    getLiveOutput: (callId) => get().liveOutputByCallId[callId] ?? null,
    getShellHistory: (workspaceId) => get().shellHistoryByWs[workspaceId] ?? EMPTY_HISTORY,
    // Returns the workspace's pending approvals as a STABLE slice ref (no new
    // array per call → no spurious re-renders). The consumer (ChatCanvas) scopes
    // these to the on-screen thread at render time — approving a command you
    // can't see would be unsafe. (Surfacing a "thread N needs approval" signal in
    // the chat list for a backgrounded thread is a separate, future affordance.)
    getPendingApprovals: (workspaceId) =>
      get().pendingApprovalsByWs[workspaceId] ?? EMPTY_APPROVALS,

    getTimeline: (workspaceId) => {
      const msgs = get().messagesByWs[workspaceId];
      if (!msgs || msgs.length === 0) return EMPTY_TIMELINE;
      return buildTimeline(msgs);
    },

    loadHistory: async (workspaceId) => {
      // In-flight guard: two concurrent calls would each see zero threads and
      // both create a default. The loser simply skips (the winner populates).
      if (loadingHistory.has(workspaceId)) return;
      loadingHistory.add(workspaceId);
      try {
        // Ensure the workspace has at least one thread, pick the active one
        // (keeping a valid prior selection), then load that thread's messages.
        let threads = await ipc.listChatThreads(workspaceId);
        if (threads.length === 0) {
          const created = await ipc.createChatThread(workspaceId, "New conversation");
          threads = [created];
        }
        const prior = get().activeThreadByWs[workspaceId];
        const activeId =
          prior && threads.some((t) => t.id === prior) ? prior : threads[0].id;
        set((s) => ({
          threadsByWs: { ...s.threadsByWs, [workspaceId]: threads },
          activeThreadByWs: { ...s.activeThreadByWs, [workspaceId]: activeId },
        }));
        const messages = await ipc.listChatMessages(activeId);
        set((s) => ({
          messagesByWs: { ...s.messagesByWs, [workspaceId]: messages as ChatMessage[] },
        }));
      } finally {
        loadingHistory.delete(workspaceId);
      }
    },

    send: async (workspaceId, workspacePath, content, systemPrompt) => {
      // ── Budget hard-stop ────────────────────────────────────────
      const { isOverBudget, consumeOverride } = useBudgetsStore.getState();
      if (isOverBudget("workspace", workspaceId) || isOverBudget("global", "")) {
        if (!consumeOverride()) {
          set((s) => ({
            errorByWs: { ...s.errorByWs, [workspaceId]: BUDGET_CAP_MSG },
          }));
          return;
        }
      }

      // Guarantee a real thread BEFORE persisting, so a fast first-send during
      // the loadHistory race can never orphan the turn under thread_id="".
      const threadId = await get().ensureThread(workspaceId);
      if (!threadId) {
        set((s) => ({
          errorByWs: { ...s.errorByWs, [workspaceId]: "Could not start a conversation." },
        }));
        return;
      }

      // The first message names the thread: persist a derived title if it's
      // still the untouched default, so the History list stays meaningful even
      // for threads that aren't the active one.
      const existingMsgs = get().messagesByWs[workspaceId] ?? EMPTY_MESSAGES;
      const thread = (get().threadsByWs[workspaceId] ?? EMPTY_THREADS).find((t) => t.id === threadId);
      if (
        existingMsgs.length === 0 &&
        thread &&
        (thread.title === "New conversation" || thread.title === "Conversation")
      ) {
        const title = deriveChatTitle([{ role: "user", content } as ChatMessage]);
        void get().renameThread(workspaceId, threadId, title).catch(() => {});
      }

      // Snapshot + clear pending attachments — they ride along on this turn only.
      const attachments = get().attachmentsByWs[workspaceId] ?? EMPTY_ATTACHMENTS;
      if (attachments.length > 0) {
        set((s) => ({ attachmentsByWs: { ...s.attachmentsByWs, [workspaceId]: EMPTY_ATTACHMENTS } }));
      }

      await get().runTurn(workspaceId, workspacePath, threadId, {
        userMessage: content,
        systemPrompt,
        attachments,
      });
    },

    // Core turn dispatch shared by send / regenerate. Sets the streaming flags,
    // fires the IPC, and on failure restores the flags + any staged attachments.
    runTurn: async (workspaceId, workspacePath, threadId, opts) => {
      set((s) => ({
        streamingByWs: { ...s.streamingByWs, [workspaceId]: true },
        streamingThreadByWs: { ...s.streamingThreadByWs, [workspaceId]: threadId },
        streamBufferByWs: { ...s.streamBufferByWs, [workspaceId]: "" },
        errorByWs: { ...s.errorByWs, [workspaceId]: null },
        liveToolsByWs: { ...s.liveToolsByWs, [workspaceId]: EMPTY_LIVE_TOOLS },
      }));
      const attachments = opts.attachments ?? EMPTY_ATTACHMENTS;
      try {
        await ipc.sendChatMessage({
          workspaceId,
          threadId,
          workspacePath,
          model: get().model,
          userMessage: opts.userMessage,
          system: opts.systemPrompt,
          maxTokens: EFFORT_MAX_TOKENS[get().effort],
          skill: get().activeSkillByWs[workspaceId] ?? undefined,
          attachments: attachments.length
            ? attachments.map((a) => ({ mediaType: a.mediaType, data: a.data }))
            : undefined,
          regenerate: opts.regenerate || undefined,
        });
      } catch (e) {
        set((s) => ({
          streamingByWs: { ...s.streamingByWs, [workspaceId]: false },
          streamingThreadByWs: { ...s.streamingThreadByWs, [workspaceId]: null },
          streamBufferByWs: { ...s.streamBufferByWs, [workspaceId]: "" },
          errorByWs: { ...s.errorByWs, [workspaceId]: String(e) },
          // Restore the staged attachments so a failed turn doesn't lose them.
          attachmentsByWs: attachments.length
            ? { ...s.attachmentsByWs, [workspaceId]: attachments }
            : s.attachmentsByWs,
        }));
        // Resync the visible conversation with the DB. Critical after a
        // regenerate/editAndResend whose truncate committed but whose dispatch
        // then failed — without this the UI keeps the optimistically-removed rows
        // out of view while diverging from what's persisted. (For a plain send
        // failure this is a harmless reload of the same rows.)
        void get().loadHistory(workspaceId);
      }
    },

    // Shared core for regenerate / editAndResend: budget-gate, truncate from the
    // cutoff (DB first, then local — no drift on failure), then dispatch. Both
    // entry points must stay in sync, so the order lives in one place.
    truncateAndRun: async (workspaceId, workspacePath, threadId, cutoffId, opts) => {
      // Budget gate BEFORE truncating — a blocked action must never delete the
      // rows it can't re-run.
      if (overBudgetBlocked(workspaceId)) {
        set((s) => ({ errorByWs: { ...s.errorByWs, [workspaceId]: BUDGET_CAP_MSG } }));
        return;
      }
      try {
        await ipc.truncateChatAfter(threadId, cutoffId);
      } catch (e) {
        set((s) => ({ errorByWs: { ...s.errorByWs, [workspaceId]: String(e) } }));
        return;
      }
      set((s) => ({
        messagesByWs: {
          ...s.messagesByWs,
          [workspaceId]: (s.messagesByWs[workspaceId] ?? EMPTY_MESSAGES).filter(
            (m) => m.id < cutoffId,
          ),
        },
      }));
      await get().runTurn(workspaceId, workspacePath, threadId, opts);
    },

    regenerate: async (workspaceId, workspacePath, assistantMessageId, systemPrompt) => {
      const threadId = get().activeThreadByWs[workspaceId];
      if (!threadId) return;
      const msgs = get().messagesByWs[workspaceId] ?? EMPTY_MESSAGES;
      const aIdx = msgs.findIndex((m) => m.id === assistantMessageId);
      if (aIdx < 0) return;
      // Find the user message that prompted this assistant turn. Without one we
      // can't regenerate (re-running with empty history 400s) and truncating would
      // wipe the whole thread — so bail. Otherwise truncate from the START of the
      // turn (the row after that user message) so its TOOL rows go too; cutting at
      // the assistant text id alone would leave orphaned tool rows.
      let pu = aIdx - 1;
      while (pu >= 0 && msgs[pu].role !== "user") pu--;
      if (pu < 0) return;
      const truncateFromId = msgs[pu + 1]?.id ?? assistantMessageId;
      await get().truncateAndRun(workspaceId, workspacePath, threadId, truncateFromId, {
        userMessage: "",
        systemPrompt,
        regenerate: true,
      });
    },

    editAndResend: async (workspaceId, workspacePath, userMessageId, newContent, systemPrompt) => {
      const threadId = get().activeThreadByWs[workspaceId];
      if (!threadId || !newContent.trim()) return;
      // Carry any staged attachments onto the resent turn (like send does), then
      // clear them so they're not double-sent.
      const attachments = get().attachmentsByWs[workspaceId] ?? EMPTY_ATTACHMENTS;
      if (attachments.length > 0) {
        set((s) => ({ attachmentsByWs: { ...s.attachmentsByWs, [workspaceId]: EMPTY_ATTACHMENTS } }));
      }
      await get().truncateAndRun(workspaceId, workspacePath, threadId, userMessageId, {
        userMessage: newContent,
        systemPrompt,
        attachments,
      });
    },

    runShell: async (workspaceId, workspacePath, command) => {
      const threadId = await get().ensureThread(workspaceId);
      if (!threadId) {
        set((s) => ({
          errorByWs: { ...s.errorByWs, [workspaceId]: "Could not start a conversation." },
        }));
        return;
      }

      // Name an untouched thread after its first command, mirroring `send`.
      const existingMsgs = get().messagesByWs[workspaceId] ?? EMPTY_MESSAGES;
      const thread = (get().threadsByWs[workspaceId] ?? EMPTY_THREADS).find((t) => t.id === threadId);
      if (
        existingMsgs.length === 0 &&
        thread &&
        (thread.title === "New conversation" || thread.title === "Conversation")
      ) {
        const title = deriveChatTitle([{ role: "user", content: `$ ${command}` } as ChatMessage]);
        void get().renameThread(workspaceId, threadId, title).catch(() => {});
      }

      // Reuse the streaming flag so input disables and the live tool card shows
      // while the command runs; the tool-start/end + message-added events do the
      // rest. Cleared in `finally` since `$`-direct emits no stream-done event.
      // Note: if the command is promoted to a live process the IPC resolves
      // (live:true) and this clears — re-enabling the composer ON PURPOSE so the
      // user can keep working; the pinned LiveProcessPanel + the still-running
      // `§ RUN` card are the "process running" indicators while it streams.
      set((s) => ({
        streamingByWs: { ...s.streamingByWs, [workspaceId]: true },
        streamingThreadByWs: { ...s.streamingThreadByWs, [workspaceId]: threadId },
        errorByWs: { ...s.errorByWs, [workspaceId]: null },
        liveToolsByWs: { ...s.liveToolsByWs, [workspaceId]: EMPTY_LIVE_TOOLS },
      }));

      try {
        const result = await ipc.runShellCommand({
          workspaceId,
          threadId,
          workspacePath,
          command,
        });
        // Update the badge from the backend-computed label (the single source).
        // Only when a command actually RAN in the shell (result.cwd non-empty):
        // skip live promotions (cwd known later, via shell-exit) and Busy/error
        // results (cwd empty) so they don't wipe a valid badge.
        if (result && !result.live && result.cwd) {
          set((s) => ({
            shellCwdByThread: { ...s.shellCwdByThread, [threadId]: result.cwdLabel ?? "" },
            shellCwdAbsByThread: { ...s.shellCwdAbsByThread, [threadId]: result.cwd },
          }));
        }
        // Refresh the recall history so the just-run command surfaces.
        void get().loadShellHistory(workspaceId);
      } catch (e) {
        set((s) => ({ errorByWs: { ...s.errorByWs, [workspaceId]: String(e) } }));
      } finally {
        // Only clear if THIS run still owns the streaming slot — a normal LLM
        // turn that started on the same workspace meanwhile must not be clobbered.
        set((s) =>
          s.streamingThreadByWs[workspaceId] === threadId
            ? {
                streamingByWs: { ...s.streamingByWs, [workspaceId]: false },
                streamingThreadByWs: { ...s.streamingThreadByWs, [workspaceId]: null },
              }
            : {},
        );
      }
    },

    stopShellProcess: (workspaceId) => {
      const threadId = get().activeThreadByWs[workspaceId];
      if (threadId) void ipc.stopShellCommand(threadId).catch(() => {});
    },

    respondApproval: (workspaceId, callId, decision) => {
      // Snapshot the card so we can restore it if the IPC fails — otherwise the
      // card vanishes (looks resolved) while the backend turn stays parked until
      // its 300s timeout, with no way to retry the decision.
      const card = (get().pendingApprovalsByWs[workspaceId] ?? EMPTY_APPROVALS).find(
        (a) => a.callId === callId,
      );
      // Optimistically retire the card; the backend also emits approval-resolved.
      set((s) => {
        const cur = s.pendingApprovalsByWs[workspaceId];
        if (!cur) return {};
        return {
          pendingApprovalsByWs: {
            ...s.pendingApprovalsByWs,
            [workspaceId]: cur.filter((a) => a.callId !== callId),
          },
        };
      });
      void ipc.respondApproval(callId, decision).catch((e) => {
        // Restore the card + surface the error so the decision can be retried.
        set((s) => ({
          errorByWs: { ...s.errorByWs, [workspaceId]: `Could not send approval: ${String(e)}` },
          pendingApprovalsByWs: card
            ? {
                ...s.pendingApprovalsByWs,
                [workspaceId]: [...(s.pendingApprovalsByWs[workspaceId] ?? EMPTY_APPROVALS), card],
              }
            : s.pendingApprovalsByWs,
        }));
      });
    },

    loadShellHistory: async (workspaceId) => {
      try {
        const items = await ipc.listShellHistory(workspaceId, 50);
        set((s) => ({ shellHistoryByWs: { ...s.shellHistoryByWs, [workspaceId]: items } }));
      } catch {
        /* history is a convenience — ignore load failures */
      }
    },

    setModel: (model) => set({ model }),
    setEffort: (effort) => set({ effort }),
    setActiveSkill: (workspaceId, skill) =>
      set((s) => ({ activeSkillByWs: { ...s.activeSkillByWs, [workspaceId]: skill } })),
    addAttachment: (workspaceId, attachment) =>
      set((s) => ({
        attachmentsByWs: {
          ...s.attachmentsByWs,
          [workspaceId]: [...(s.attachmentsByWs[workspaceId] ?? EMPTY_ATTACHMENTS), attachment],
        },
      })),
    removeAttachment: (workspaceId, index) =>
      set((s) => ({
        attachmentsByWs: {
          ...s.attachmentsByWs,
          [workspaceId]: (s.attachmentsByWs[workspaceId] ?? EMPTY_ATTACHMENTS).filter(
            (_, i) => i !== index,
          ),
        },
      })),
    clearAttachments: (workspaceId) =>
      set((s) => ({ attachmentsByWs: { ...s.attachmentsByWs, [workspaceId]: EMPTY_ATTACHMENTS } })),

    stop: (workspaceId) => {
      // Fire-and-forget; the backend emits `chat://stream` done which clears
      // the streaming flag, so we don't optimistically flip it here. Cancel the
      // workspace's active thread (the one being shown).
      const threadId = get().activeThreadByWs[workspaceId];
      if (threadId) void ipc.cancelChat(threadId).catch(() => {});
      // Retire the cancelled thread's pending approval card immediately — the
      // backend also resolves it as Deny on cancel. Only this thread's cards are
      // cleared (cancel() denies only this thread), so another thread's pending
      // approval isn't wiped from the UI while its backend turn stays parked.
      if (threadId && get().pendingApprovalsByWs[workspaceId]?.some((a) => a.threadId === threadId)) {
        set((s) => ({
          pendingApprovalsByWs: {
            ...s.pendingApprovalsByWs,
            [workspaceId]: (s.pendingApprovalsByWs[workspaceId] ?? EMPTY_APPROVALS).filter(
              (a) => a.threadId !== threadId,
            ),
          },
        }));
      }
    },

    clear: (workspaceId) =>
      set((s) => ({
        messagesByWs: { ...s.messagesByWs, [workspaceId]: EMPTY_MESSAGES },
        streamBufferByWs: { ...s.streamBufferByWs, [workspaceId]: "" },
        errorByWs: { ...s.errorByWs, [workspaceId]: null },
        liveToolsByWs: { ...s.liveToolsByWs, [workspaceId]: EMPTY_LIVE_TOOLS },
      })),

    clearError: (workspaceId) =>
      set((s) => ({
        errorByWs: { ...s.errorByWs, [workspaceId]: null },
      })),

    // ── Thread actions ───────────────────────────────────────────
    ensureThread: async (workspaceId) => {
      const existing = get().activeThreadByWs[workspaceId];
      if (existing) return existing;
      // No active thread yet — load (creates a default if needed). The guard in
      // loadHistory makes a concurrent send + canvas-mount safe.
      await get().loadHistory(workspaceId);
      return get().activeThreadByWs[workspaceId] ?? "";
    },

    selectThread: async (workspaceId, threadId) => {
      // Switch the shown thread and load its messages. Restore the streaming
      // indicator if the target thread is the one currently running in the
      // background (its tracker survives the switch).
      set((s) => ({
        activeThreadByWs: { ...s.activeThreadByWs, [workspaceId]: threadId },
        streamingByWs: {
          ...s.streamingByWs,
          [workspaceId]: s.streamingThreadByWs[workspaceId] === threadId,
        },
        streamBufferByWs: { ...s.streamBufferByWs, [workspaceId]: "" },
        errorByWs: { ...s.errorByWs, [workspaceId]: null },
        liveToolsByWs: { ...s.liveToolsByWs, [workspaceId]: EMPTY_LIVE_TOOLS },
        messagesByWs: { ...s.messagesByWs, [workspaceId]: EMPTY_MESSAGES },
        // A skill is a per-conversation choice — don't leak it across threads.
        activeSkillByWs: { ...s.activeSkillByWs, [workspaceId]: null },
      }));
      const messages = await ipc.listChatMessages(threadId);
      set((s) => ({
        messagesByWs: { ...s.messagesByWs, [workspaceId]: messages as ChatMessage[] },
      }));
    },

    newThread: async (workspaceId) => {
      const created = await ipc.createChatThread(workspaceId, "New conversation");
      set((s) => ({
        threadsByWs: {
          ...s.threadsByWs,
          [workspaceId]: [created, ...(s.threadsByWs[workspaceId] ?? EMPTY_THREADS)],
        },
        activeThreadByWs: { ...s.activeThreadByWs, [workspaceId]: created.id },
        // Fresh, empty conversation view.
        messagesByWs: { ...s.messagesByWs, [workspaceId]: EMPTY_MESSAGES },
        streamingByWs: { ...s.streamingByWs, [workspaceId]: false },
        streamBufferByWs: { ...s.streamBufferByWs, [workspaceId]: "" },
        errorByWs: { ...s.errorByWs, [workspaceId]: null },
        liveToolsByWs: { ...s.liveToolsByWs, [workspaceId]: EMPTY_LIVE_TOOLS },
        activeSkillByWs: { ...s.activeSkillByWs, [workspaceId]: null },
      }));
    },

    renameThread: async (workspaceId, threadId, title) => {
      await ipc.renameChatThread(threadId, title);
      set((s) => ({
        threadsByWs: {
          ...s.threadsByWs,
          [workspaceId]: (s.threadsByWs[workspaceId] ?? EMPTY_THREADS).map((t) =>
            t.id === threadId ? { ...t, title } : t,
          ),
        },
      }));
    },

    deleteThread: async (workspaceId, threadId) => {
      const wasActive = get().activeThreadByWs[workspaceId] === threadId;
      await ipc.deleteChatThread(threadId);
      // Remove inside a functional update so interleaved deletes don't resurrect
      // a row from a stale snapshot.
      set((s) => ({
        threadsByWs: {
          ...s.threadsByWs,
          [workspaceId]: (s.threadsByWs[workspaceId] ?? EMPTY_THREADS).filter(
            (t) => t.id !== threadId,
          ),
        },
      }));
      // Only reload the view if we deleted the thread being shown; deleting a
      // background thread leaves the active conversation untouched.
      if (wasActive) {
        const remaining = get().threadsByWs[workspaceId] ?? EMPTY_THREADS;
        if (remaining.length > 0) {
          await get().selectThread(workspaceId, remaining[0].id);
        } else {
          await get().newThread(workspaceId);
        }
      }
    },
  };
});
