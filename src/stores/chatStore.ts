import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { ipc } from "../lib/ipc";
import type { ChatMessage, ChatStreamEvent } from "../lib/types";
import { useWorkspaceStore } from "./workspaceStore";
import { useBudgetsStore, BUDGET_CAP_MSG } from "./budgetsStore";
import { useAttentionStore } from "./attentionStore";
import { focus } from "../lib/focus";

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
  callId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  startedAt: string;
}

interface ToolEndEvent {
  workspaceId: string;
  callId: string;
  ok: boolean;
  durationMs: number;
}

/** Generation effort presets — map to the output-token budget (and, later,
 *  thinking budget). Swift is cheap/snappy; Deep gives the model more room. */
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

  // Actions
  loadHistory: (workspaceId: string) => Promise<void>;
  send: (
    workspaceId: string,
    workspacePath: string,
    content: string,
    systemPrompt?: string,
  ) => Promise<void>;
  setModel: (model: string) => void;
  setEffort: (effort: Effort) => void;
  /** Stop the in-flight turn for this workspace (best-effort; backend halts
   *  before its next iteration/tool and emits the done event). */
  stop: (workspaceId: string) => void;
  clear: (workspaceId: string) => void;
  clearError: (workspaceId: string) => void;
}

export const useChatStore = create<ChatState>((set, get) => {
  // ── chat://message-added ──────────────────────────────────────
  // Append a message to ITS workspace's bucket, with idempotency on id.
  listen<MessageAddedEvent>("chat://message-added", (ev) => {
    const payload = ev.payload;
    const wsId = payload.workspaceId;

    set((s) => {
      const existing = s.messagesByWs[wsId] ?? EMPTY_MESSAGES;
      if (existing.some((m) => m.id === payload.id)) {
        return {};
      }
      const newMessage: ChatMessage = {
        id: payload.id,
        workspaceId: payload.workspaceId,
        role: payload.role as "user" | "assistant" | "tool" | "error",
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

    if (payload.done) {
      set((s) => ({
        streamingByWs: { ...s.streamingByWs, [wsId]: false },
        streamBufferByWs: { ...s.streamBufferByWs, [wsId]: "" },
        // Clear any stragglers (e.g. a tool whose result errored before its
        // resolved row landed) so no spinner outlives the turn.
        liveToolsByWs: { ...s.liveToolsByWs, [wsId]: EMPTY_LIVE_TOOLS },
      }));
      // Only ring the chime / pulse the rail if the user isn't already
      // looking at this chat — otherwise they'll just be told what
      // they're already seeing.
      if (focus.workspaceId !== wsId || focus.mode !== "talk") {
        useAttentionStore.getState().ping(wsId, "chat");
      }
    } else {
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

  return {
    messagesByWs: {},
    streamingByWs: {},
    streamBufferByWs: {},
    errorByWs: {},
    liveToolsByWs: {},
    model: "claude-sonnet-4-6",
    effort: "standard",

    getMessages: (workspaceId) => get().messagesByWs[workspaceId] ?? EMPTY_MESSAGES,
    getStreaming: (workspaceId) => get().streamingByWs[workspaceId] ?? false,
    getStreamBuffer: (workspaceId) => get().streamBufferByWs[workspaceId] ?? "",
    getError: (workspaceId) => get().errorByWs[workspaceId] ?? null,
    getLiveTools: (workspaceId) => get().liveToolsByWs[workspaceId] ?? EMPTY_LIVE_TOOLS,

    getTimeline: (workspaceId) => {
      const msgs = get().messagesByWs[workspaceId];
      if (!msgs || msgs.length === 0) return EMPTY_TIMELINE;
      return buildTimeline(msgs);
    },

    loadHistory: async (workspaceId) => {
      const messages = await ipc.listChatMessages(workspaceId);
      set((s) => ({
        messagesByWs: { ...s.messagesByWs, [workspaceId]: messages as ChatMessage[] },
      }));
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

      set((s) => ({
        streamingByWs: { ...s.streamingByWs, [workspaceId]: true },
        streamBufferByWs: { ...s.streamBufferByWs, [workspaceId]: "" },
        errorByWs: { ...s.errorByWs, [workspaceId]: null },
        liveToolsByWs: { ...s.liveToolsByWs, [workspaceId]: EMPTY_LIVE_TOOLS },
      }));

      try {
        await ipc.sendChatMessage({
          workspaceId,
          workspacePath,
          model: get().model,
          userMessage: content,
          system: systemPrompt,
          maxTokens: EFFORT_MAX_TOKENS[get().effort],
        });
      } catch (e) {
        set((s) => ({
          streamingByWs: { ...s.streamingByWs, [workspaceId]: false },
          streamBufferByWs: { ...s.streamBufferByWs, [workspaceId]: "" },
          errorByWs: { ...s.errorByWs, [workspaceId]: String(e) },
        }));
      }
    },

    setModel: (model) => set({ model }),
    setEffort: (effort) => set({ effort }),

    stop: (workspaceId) => {
      // Fire-and-forget; the backend emits `chat://stream` done which clears
      // the streaming flag, so we don't optimistically flip it here.
      void ipc.cancelChat(workspaceId).catch(() => {});
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
  };
});
