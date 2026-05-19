import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { ipc } from "../lib/ipc";
import type { ChatMessage, ChatStreamEvent } from "../lib/types";
import { useWorkspaceStore } from "./workspaceStore";
import { useBudgetsStore, BUDGET_CAP_MSG } from "./budgetsStore";

export interface ToolExecution {
  toolName: string;
  toolInput: Record<string, unknown>;
  result: string;
}

/** A display item in the conversation — either a regular message, tool execution, or persisted error. */
export type ConversationItem =
  | { kind: "message"; message: ChatMessage }
  | { kind: "tool"; tool: ToolExecution; id: number }
  | { kind: "error"; message: ChatMessage };

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

interface ChatState {
  /** Messages keyed by workspaceId. Each workspace has its own conversation. */
  messagesByWs: Record<string, ChatMessage[]>;
  /** Streaming flag per workspace. `true` only while THAT workspace's agentic loop runs. */
  streamingByWs: Record<string, boolean>;
  /** Partial assistant text being streamed per workspace. */
  streamBufferByWs: Record<string, string>;
  /** Last error per workspace. */
  errorByWs: Record<string, string | null>;

  /** Global model preference. Applies to whichever workspace the user types in. */
  model: string;

  // Selectors (read-only, scoped by workspaceId)
  getMessages: (workspaceId: string) => ChatMessage[];
  getStreaming: (workspaceId: string) => boolean;
  getStreamBuffer: (workspaceId: string) => string;
  getError: (workspaceId: string) => string | null;
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
      return {
        messagesByWs: {
          ...s.messagesByWs,
          [wsId]: [...existing, newMessage],
        },
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
      }));
    } else {
      set((s) => ({
        streamBufferByWs: {
          ...s.streamBufferByWs,
          [wsId]: (s.streamBufferByWs[wsId] ?? "") + payload.delta,
        },
      }));
    }
  });

  return {
    messagesByWs: {},
    streamingByWs: {},
    streamBufferByWs: {},
    errorByWs: {},
    model: "claude-sonnet-4-6",

    getMessages: (workspaceId) => get().messagesByWs[workspaceId] ?? EMPTY_MESSAGES,
    getStreaming: (workspaceId) => get().streamingByWs[workspaceId] ?? false,
    getStreamBuffer: (workspaceId) => get().streamBufferByWs[workspaceId] ?? "",
    getError: (workspaceId) => get().errorByWs[workspaceId] ?? null,

    getTimeline: (workspaceId) => {
      const msgs = get().messagesByWs[workspaceId];
      if (!msgs || msgs.length === 0) return EMPTY_TIMELINE;
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
        } else {
          items.push({ kind: "message", message: msg });
        }
      }
      return items;
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
      }));

      try {
        await ipc.sendChatMessage({
          workspaceId,
          workspacePath,
          model: get().model,
          userMessage: content,
          system: systemPrompt,
          maxTokens: 8192,
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

    clear: (workspaceId) =>
      set((s) => ({
        messagesByWs: { ...s.messagesByWs, [workspaceId]: EMPTY_MESSAGES },
        streamBufferByWs: { ...s.streamBufferByWs, [workspaceId]: "" },
        errorByWs: { ...s.errorByWs, [workspaceId]: null },
      })),

    clearError: (workspaceId) =>
      set((s) => ({
        errorByWs: { ...s.errorByWs, [workspaceId]: null },
      })),
  };
});
