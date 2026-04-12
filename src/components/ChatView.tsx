import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { MessageSquare, ArrowUp, AlertTriangle, Settings } from "lucide-react";
import { clsx } from "clsx";
import { useChatStore, type ToolExecution, type ConversationItem } from "../stores/chatStore";
import { AgentBar } from "./AgentBar";
import { ChatMessage } from "./ChatMessage";
// import { ToolCallCard } from "./ToolCallCard";

interface Props {
  workspaceId: string;
  workspacePath: string;
  onOpenSettings?: () => void;
}

const AGENT_COLORS: Record<string, string> = {
  "claude-sonnet-4-6": "#cc785c",
  "claude-opus-4-6": "#cc785c",
  "gpt-4o": "#74aa9c",
  "claude-haiku-4-5": "#cc785c",
};

const AGENT_NAMES: Record<string, string> = {
  "claude-sonnet-4-6": "Claude",
  "claude-opus-4-6": "Opus",
  "gpt-4o": "GPT-4o",
  "claude-haiku-4-5": "Haiku",
};

export function ChatView({ workspaceId, workspacePath, onOpenSettings }: Props) {
  const { messages, streaming, streamBuffer, model, error, loadHistory, send, setModel, clearError } =
    useChatStore();

  // Compute timeline directly from messages — no store indirection.
  const timeline = useMemo<ConversationItem[]>(() => {
    const items: ConversationItem[] = [];
    for (const msg of messages) {
      const role = String(msg.role);
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
  }, [messages]);

  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load history on mount / workspace change
  useEffect(() => {
    loadHistory(workspaceId);
  }, [workspaceId, loadHistory]);

  // Simple scroll: follow during streaming only.
  useEffect(() => {
    if (streaming) {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [streaming, streamBuffer]);

  // Auto-grow textarea
  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInput(e.target.value);
    const ta = e.target;
    ta.style.height = "auto";
    const lineHeight = 20;
    const maxHeight = lineHeight * 6 + 24; // 6 rows + padding
    ta.style.height = `${Math.min(ta.scrollHeight, maxHeight)}px`;
  }

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || streaming) return;
    setInput("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    send(workspaceId, workspacePath, trimmed);
  }, [input, streaming, send, workspaceId]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const activeColor = AGENT_COLORS[model] ?? "#a78bfa";
  const activeName = AGENT_NAMES[model] ?? model;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Agent bar */}
      <AgentBar activeModel={model} onSelectModel={setModel} />

      {/* Message list */}
      <div
        ref={scrollRef}
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-4"
      >
        {/* DEBUG: visible counter — remove after fixing */}
        <div className="shrink-0 rounded bg-zinc-800 px-2 py-1 text-[10px] font-mono text-octo-warning">
          msgs={messages.length} timeline={timeline.length} tools={timeline.filter(i => i.kind === "tool").length} roles=[{messages.map(m => String(m.role)[0]).join(",")}]
        </div>

        {messages.length === 0 && !streaming ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
            <MessageSquare size={36} className="text-zinc-700" />
            <div>
              <p className="text-sm font-medium text-zinc-400">Start a conversation</p>
              <p className="mt-1 text-xs text-zinc-600">Ask anything to get started</p>
            </div>
          </div>
        ) : (
          <>
            {/* Render the timeline: messages + tool cards interleaved */}
            {timeline.map((item, idx) =>
              item.kind === "tool" ? (
                <div key={`tool-${item.id}`} style={{ background: "red", color: "white", padding: 12, borderRadius: 8, margin: "4px 0" }}>
                  TOOL #{idx}: {item.tool.toolName} — {JSON.stringify(item.tool.toolInput).slice(0, 80)}
                </div>
              ) : (
                <ChatMessage key={item.message.id} message={item.message} />
              ),
            )}

            {/* Streaming partial message */}
            {streaming && streamBuffer && (
              <ChatMessage
                message={{
                  role: "assistant",
                  content: streamBuffer + "▊",
                  model: null,
                  inputTokens: null,
                  outputTokens: null,
                }}
              />
            )}

            {/* Working indicator while tools are executing */}
            {streaming && !streamBuffer && (
              <div className="mx-auto flex items-center gap-2 rounded-full bg-zinc-900/50 px-4 py-2 text-[11px] text-zinc-500">
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-octo-accent" />
                Working...
              </div>
            )}

            {/* Error message */}
            {error && (
              <div className="mx-auto max-w-lg rounded-lg border border-octo-danger/40 bg-octo-danger/10 px-4 py-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle size={16} className="mt-0.5 shrink-0 text-octo-danger" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-octo-danger">Chat error</div>
                    <div className="mt-0.5 text-xs text-zinc-400">{error}</div>
                    {error.includes("API key") && onOpenSettings && (
                      <button
                        onClick={() => { clearError(); onOpenSettings(); }}
                        className="mt-2 flex items-center gap-1.5 rounded-md border border-octo-border bg-octo-panel px-3 py-1.5 text-xs text-zinc-300 transition hover:border-octo-accent/50"
                      >
                        <Settings size={12} />
                        Configure API Key
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* Input area */}
      <div className="border-t border-octo-border bg-octo-panel px-6 py-4">
        <div
          className={clsx(
            "rounded-xl border bg-octo-bg transition",
            streaming ? "border-octo-border/50 opacity-60" : "border-octo-border",
          )}
        >
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            disabled={streaming}
            placeholder="Ask anything…"
            rows={1}
            className="w-full resize-none bg-transparent px-4 py-3 text-sm text-zinc-200 placeholder-zinc-600 outline-none"
            style={{ maxHeight: "calc(6 * 1.25rem + 1.5rem)" }}
          />

          {/* Bottom row: model indicator + send button */}
          <div className="flex items-center justify-between px-3 pb-2.5">
            <div className="flex items-center gap-1.5">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: activeColor }}
              />
              <span className="text-[10px] text-zinc-600">{activeName}</span>
            </div>

            <button
              onClick={handleSend}
              disabled={streaming || !input.trim()}
              className={clsx(
                "flex h-7 w-7 items-center justify-center rounded-full transition",
                streaming || !input.trim()
                  ? "cursor-not-allowed bg-octo-accent/30 text-zinc-500"
                  : "bg-octo-accent text-white hover:bg-octo-accent-dim",
              )}
              title="Send (Enter)"
            >
              <ArrowUp size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
