import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { ipc } from "../lib/ipc";
import type { ChatMessage, ChatStreamEvent } from "../lib/types";
import { useWorkspaceStore } from "./workspaceStore";

export interface ToolExecution {
  toolName: string;
  toolInput: Record<string, unknown>;
  result: string;
}

/** A display item in the conversation — either a regular message or a tool execution. */
export type ConversationItem =
  | { kind: "message"; message: ChatMessage }
  | { kind: "tool"; tool: ToolExecution; id: number };

/**
 * Emitted by the backend whenever a chat message is persisted to the DB.
 * Carries the DB rowid (stable, unique, monotonic) + the full row, so the
 * frontend can append to local state without inventing an id.
 *
 * This event replaces the legacy `chat://tool-use` event and the
 * final-text-on-done shortcut: user, tool, and assistant all flow here.
 */
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

interface ChatState {
  /** All messages for the active workspace, keyed by DB rowid. */
  messages: ChatMessage[];
  streaming: boolean;
  /** Live text buffer for the partial assistant bubble during streaming. */
  streamBuffer: string;
  model: string;
  error: string | null;

  /** Compute the conversation timeline (messages + tool cards interleaved). */
  getTimeline: () => ConversationItem[];

  loadHistory: (workspaceId: string) => Promise<void>;
  send: (
    workspaceId: string,
    workspacePath: string,
    content: string,
    systemPrompt?: string,
  ) => Promise<void>;
  setModel: (model: string) => void;
  clear: () => void;
  clearError: () => void;
}

export const useChatStore = create<ChatState>((set, get) => {
  // Single event channel for every persisted message — user, tool, assistant.
  // Backend supplies the DB rowid so React keys are stable and unique.
  listen<MessageAddedEvent>("chat://message-added", (ev) => {
    const payload = ev.payload;
    set((s) => {
      // Idempotent: if a message with this id is already in state, no-op.
      // Defends against duplicate listener registration (HMR, strict mode).
      if (s.messages.some((m) => m.id === payload.id)) {
        return {};
      }
      const newMessage: ChatMessage = {
        id: payload.id,
        workspaceId: payload.workspaceId,
        // ChatMessage typed as "user" | "assistant"; the runtime "tool" value
        // is handled by getTimeline() via a string check.
        role: payload.role as "user" | "assistant",
        content: payload.content,
        model: payload.model,
        inputTokens: payload.inputTokens,
        outputTokens: payload.outputTokens,
        costUsd: payload.costUsd,
        createdAt: payload.createdAt,
      };
      return { messages: [...s.messages, newMessage] };
    });
    // Notify workspace if a message arrived for a non-active workspace.
    const wsStore = useWorkspaceStore.getState();
    if (payload.workspaceId && payload.workspaceId !== wsStore.activeId) {
      wsStore.notify(payload.workspaceId);
    }
  });

  // Streaming text deltas for the live assistant bubble. `done: true` is
  // metadata-only: the assistant message already arrived via message-added.
  listen<ChatStreamEvent>("chat://stream", (ev) => {
    const payload = ev.payload;
    if (payload.done) {
      set({ streaming: false, streamBuffer: "" });
    } else {
      set((s) => ({ streamBuffer: s.streamBuffer + payload.delta }));
    }
  });

  return {
    messages: [],
    streaming: false,
    streamBuffer: "",
    model: "claude-sonnet-4-6",
    error: null,

    getTimeline: () => {
      const items: ConversationItem[] = [];
      const msgs = get().messages;
      for (const msg of msgs) {
        const role = msg.role as string;
        if (role === "tool") {
          try {
            const tool: ToolExecution = JSON.parse(msg.content);
            items.push({ kind: "tool", tool, id: msg.id });
          } catch {
            items.push({ kind: "message", message: msg });
          }
        } else {
          items.push({ kind: "message", message: msg });
        }
      }
      return items;
    },

    loadHistory: async (workspaceId) => {
      const messages = await ipc.listChatMessages(workspaceId);
      set({ messages: messages as ChatMessage[] });
    },

    send: async (workspaceId, workspacePath, content, _systemPrompt) => {
      // Start streaming immediately for instant visual feedback. The user
      // message itself arrives via chat://message-added in ~5ms once the
      // backend persists it — no optimistic local append with a fake id.
      set({
        streaming: true,
        streamBuffer: "",
        error: null,
      });

      try {
        await ipc.sendChatMessage({
          workspaceId,
          workspacePath,
          model: get().model,
          userMessage: content,
          system: _systemPrompt,
          maxTokens: 8192,
        });
      } catch (e) {
        set({ streaming: false, streamBuffer: "", error: String(e) });
      }
    },

    setModel: (model) => set({ model }),
    clear: () => set({ messages: [], streamBuffer: "", error: null }),
    clearError: () => set({ error: null }),
  };
});
