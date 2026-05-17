import { useEffect, useRef, useState, useCallback } from "react";
import { AlertTriangle, Settings } from "lucide-react";
import { clsx } from "clsx";
import { useChatStore } from "../stores/chatStore";
import { AgentBar } from "./AgentBar";
import { ChatMessage } from "./ChatMessage";
import { ToolCallCard } from "./ToolCallCard";

interface Props {
  workspaceId: string;
  workspacePath: string;
  onOpenSettings?: () => void;
}

export function ChatView({ workspaceId, workspacePath, onOpenSettings }: Props) {
  const { messages, streaming, streamBuffer, model, error, loadHistory, send, setModel, clearError } =
    useChatStore();

  // Single source of truth for the timeline — defined in chatStore.
  // Subscribes to `messages` and re-derives on change.
  const timeline = useChatStore((s) => s.getTimeline());

  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    loadHistory(workspaceId);
  }, [workspaceId, loadHistory]);

  useEffect(() => {
    if (streaming) {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [streaming, streamBuffer]);

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInput(e.target.value);
    const ta = e.target;
    ta.style.height = "auto";
    const lineHeight = 20;
    const maxHeight = lineHeight * 6 + 24;
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
  }, [input, streaming, send, workspaceId, workspacePath]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const canSend = !streaming && input.trim().length > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <AgentBar activeModel={model} onSelectModel={setModel} />

      <div
        ref={scrollRef}
        className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-8 py-6"
      >
        {messages.length === 0 && !streaming ? (
          <EmptyState />
        ) : (
          <>
            {timeline.map((item) =>
              item.kind === "tool" ? (
                <ToolCallCard
                  key={`tool-${item.id}`}
                  tool={item.tool}
                  workspacePath={workspacePath}
                />
              ) : (
                <ChatMessage key={item.message.id} message={item.message} />
              ),
            )}

            {streaming && streamBuffer && (
              <ChatMessage
                message={{
                  role: "assistant",
                  content: streamBuffer + "▊",
                  model,
                  inputTokens: null,
                  outputTokens: null,
                }}
              />
            )}

            {streaming && !streamBuffer && <ThinkingIndicator />}

            {error && (
              <ErrorBlock
                error={error}
                onConfigureApiKey={onOpenSettings ? () => { clearError(); onOpenSettings(); } : null}
              />
            )}
          </>
        )}
      </div>

      <div className="border-t border-octo-hairline bg-octo-panel px-6 py-4">
        <div
          className={clsx(
            "rounded-xl border bg-octo-onyx transition-colors",
            streaming
              ? "border-octo-hairline opacity-60"
              : "border-octo-hairline focus-within:border-octo-brass",
          )}
        >
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            disabled={streaming}
            placeholder="Ask Octopus anything…"
            rows={1}
            className="w-full resize-none bg-transparent px-4 py-3 text-[14px] leading-[1.5] text-octo-ivory outline-none placeholder:font-serif placeholder:italic placeholder:text-octo-mute"
            style={{ maxHeight: "calc(6 * 1.25rem + 1.5rem)" }}
          />

          <div className="flex items-center justify-between px-3 pb-2.5">
            <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">
              ⌘ K to focus
            </div>

            <button
              onClick={handleSend}
              disabled={!canSend}
              title="Send (Enter)"
              aria-label="Send message"
              className="flex h-7 items-center gap-1.5 rounded-md px-3 font-mono text-[10px] uppercase tracking-[0.2em] transition-colors disabled:cursor-not-allowed disabled:opacity-40"
              style={{
                color: canSend ? "var(--color-octo-brass)" : "var(--color-octo-mute)",
                background: canSend ? "var(--brass-ghost)" : "transparent",
                border: canSend ? "1px solid var(--brass-dim)" : "1px solid var(--color-octo-hairline)",
              }}
            >
              <span style={{ fontSize: 12, lineHeight: 1 }} aria-hidden>
                ⟶
              </span>
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
      <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-mute">
        Talk
      </div>
      <div className="font-serif italic text-[24px] leading-tight tracking-[-0.005em] text-octo-ivory">
        Begin a conversation.
      </div>
      <p className="max-w-md text-[12px] leading-[1.6] text-octo-sage">
        Ask anything — Octopus will read files, run commands, and write changes inside this workspace's worktree.
      </p>
      <div
        aria-hidden
        className="mt-2 h-px w-7"
        style={{ background: "linear-gradient(90deg, var(--color-octo-brass), transparent)" }}
      />
    </div>
  );
}

function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2 self-start">
      <span
        aria-hidden
        className="inline-block h-1.5 w-1.5 animate-pulse rounded-full"
        style={{ background: "var(--color-octo-brass)" }}
      />
      <span className="font-serif italic text-[13px] text-octo-sage">Thinking…</span>
    </div>
  );
}

function ErrorBlock({
  error,
  onConfigureApiKey,
}: {
  error: string;
  onConfigureApiKey: (() => void) | null;
}) {
  return (
    <div
      className="mx-auto max-w-lg rounded-md p-4"
      style={{
        borderLeft: "1px solid var(--color-octo-rouge)",
        background: "rgba(209, 139, 139, 0.08)",
      }}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-octo-rouge" />
        <div className="min-w-0 flex-1">
          <div className="font-serif italic text-[14px] text-octo-rouge">
            Something went wrong.
          </div>
          <div className="mt-1 text-[12px] leading-[1.55] text-octo-sage">{error}</div>
          {error.includes("API key") && onConfigureApiKey && (
            <button
              onClick={onConfigureApiKey}
              className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-octo-hairline px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-sage transition-colors hover:text-octo-brass"
            >
              <Settings size={11} />
              Configure API key
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
