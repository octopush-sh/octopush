import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { AlertTriangle, Settings } from "lucide-react";
import { clsx } from "clsx";
import { useChatStore, type ToolExecution, type ConversationItem } from "../stores/chatStore";
import { useBudgetsStore, BUDGET_CAP_MSG } from "../stores/budgetsStore";
import {
  estimateNextTurnTokens,
  estimatePerMessageCost,
  formatPerMessageCost,
  formatTokens,
} from "../lib/cost";
import { ipc } from "../lib/ipc";
import type { ModelInfo, ProviderConfig } from "../lib/types";
import { BrassRule } from "./BrassRule";
import { ChatMessage } from "./ChatMessage";
import { ModelPicker } from "./ModelPicker";
import { ToolCallCard } from "./ToolCallCard";

interface Props {
  workspaceId: string;
  workspacePath: string;
  onOpenSettings?: () => void;
  /** Open a file (relative or absolute) in the in-app editor. When provided,
   *  WRITE tool cards show an "Open in editor" button, and bare file paths
   *  rendered in chat messages become clickable links. */
  onOpenInEditor?: (path: string) => void;
}

export function ChatView({
  workspaceId,
  workspacePath,
  onOpenSettings,
  onOpenInEditor,
}: Props) {
  const messages = useChatStore((s) => s.getMessages(workspaceId));
  const streaming = useChatStore((s) => s.getStreaming(workspaceId));
  const streamBuffer = useChatStore((s) => s.getStreamBuffer(workspaceId));
  const error = useChatStore((s) => s.getError(workspaceId));
  const model = useChatStore((s) => s.model);
  const loadHistory = useChatStore((s) => s.loadHistory);
  const send = useChatStore((s) => s.send);
  const setModel = useChatStore((s) => s.setModel);
  const clearError = useChatStore((s) => s.clearError);

  // Compute timeline locally with useMemo. Do NOT use
  //   useChatStore((s) => s.getTimeline())
  // because getTimeline() returns a new array on every call, which makes
  // Zustand's selector think the value changed every render → infinite
  // re-render loop. The render guard against this exact bug lives in
  // ChatView.test.tsx ("survives the done event…").
  const timeline = useMemo<ConversationItem[]>(() => {
    const items: ConversationItem[] = [];
    for (const msg of messages) {
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
  }, [messages]);

  const [input, setInputState] = useState("");
  // Keep a ref in sync with input so event handlers always read the latest
  // value without depending on React's render cycle (avoids stale closures).
  const inputRef = useRef("");
  function setInput(val: string) {
    inputRef.current = val;
    setInputState(val);
  }

  // Load the provider/model catalog once so the inline cost preview can find
  // the active model's price.
  const [modelCatalog, setModelCatalog] = useState<ProviderConfig[]>([]);
  useEffect(() => {
    ipc.listProviders().then(setModelCatalog).catch(() => {});
  }, []);
  const activeModelInfo: ModelInfo | null = (() => {
    for (const p of modelCatalog) {
      for (const m of p.models) {
        if (m.id === model) return m;
      }
    }
    return null;
  })();
  const estimatedTokens = estimateNextTurnTokens(messages, input);
  const inlineCost =
    activeModelInfo && estimatedTokens > 0
      ? estimatePerMessageCost(activeModelInfo, estimatedTokens)
      : null;
  // Prompt history — use refs so handleKeyDown always sees current values
  // without needing to be recreated on every render.
  const historyRef = useRef<string[]>([]);
  const historyIdxRef = useRef<number>(-1); // -1 = not navigating
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    loadHistory(workspaceId);
    // Reset per-workspace prompt history when switching workspaces.
    historyRef.current = [];
    historyIdxRef.current = -1;
  }, [workspaceId, loadHistory]);

  useEffect(() => {
    if (streaming) {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [streaming, streamBuffer]);

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value;
    setInput(val);
    // Any manual edit exits history navigation.
    historyIdxRef.current = -1;
    const ta = e.target;
    ta.style.height = "auto";
    const lineHeight = 20;
    const maxHeight = lineHeight * 6 + 24;
    ta.style.height = `${Math.min(ta.scrollHeight, maxHeight)}px`;
  }

  const handleSend = useCallback(() => {
    const trimmed = inputRef.current.trim();
    if (!trimmed || streaming) return;
    setInput("");
    historyIdxRef.current = -1;
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    // Prepend to history, deduplicate consecutive duplicates.
    if (historyRef.current[0] !== trimmed) {
      historyRef.current = [trimmed, ...historyRef.current];
    }
    send(workspaceId, workspacePath, trimmed);
  }, [streaming, send, workspaceId, workspacePath]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const hist = historyRef.current;
    const idx = historyIdxRef.current;

    // ── Arrow-key prompt history ──────────────────────────────────
    if (e.key === "ArrowUp" && !e.shiftKey) {
      // Navigate back: only when input is empty OR already navigating.
      if (inputRef.current === "" || idx >= 0) {
        e.preventDefault();
        const next = Math.min(hist.length - 1, idx + 1);
        historyIdxRef.current = next;
        if (next >= 0) setInput(hist[next] ?? "");
        return;
      }
    }
    if (e.key === "ArrowDown" && !e.shiftKey && idx >= 0) {
      e.preventDefault();
      const next = idx - 1;
      historyIdxRef.current = next;
      if (next < 0) {
        setInput("");
      } else {
        setInput(hist[next] ?? "");
      }
      return;
    }
    if (e.key === "Escape" && idx >= 0) {
      e.preventDefault();
      setInput("");
      historyIdxRef.current = -1;
      return;
    }
    // ── Regular send ─────────────────────────────────────────────
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const enableOverride = useBudgetsStore((s) => s.enableOverride);
  const isBudgetError = error === BUDGET_CAP_MSG;
  const overrideActive = useBudgetsStore((s) => s.overrideActive);
  const canSend = !streaming && input.trim().length > 0 && (!isBudgetError || overrideActive);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        ref={scrollRef}
        className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-8 py-6"
      >
        {messages.length === 0 && !streaming && !error ? (
          <EmptyState />
        ) : (
          <>
            {timeline.map((item) => {
              if (item.kind === "tool") {
                return (
                  <ToolCallCard
                    key={`tool-${item.id}`}
                    tool={item.tool}
                    workspacePath={workspacePath}
                    onOpenInEditor={onOpenInEditor}
                  />
                );
              }
              if (item.kind === "error") {
                return (
                  <ErrorBlock
                    key={`error-${item.message.id}`}
                    error={item.message.content}
                    onConfigureApiKey={
                      onOpenSettings
                        ? () => {
                            onOpenSettings();
                          }
                        : null
                    }
                  />
                );
              }
              return (
                <ChatMessage
                  key={item.message.id}
                  message={item.message}
                  onOpenInEditor={onOpenInEditor}
                />
              );
            })}

            {streaming && streamBuffer && (
              <ChatMessage
                message={{
                  role: "assistant",
                  content: streamBuffer + "▊",
                  model,
                  inputTokens: null,
                  outputTokens: null,
                }}
                onOpenInEditor={onOpenInEditor}
              />
            )}

            {streaming && !streamBuffer && <ThinkingIndicator />}

            {error && isBudgetError ? (
              <BudgetErrorBlock
                onOverride={() => {
                  enableOverride();
                  clearError(workspaceId);
                  // Override is armed; user still needs to click Send.
                }}
              />
            ) : error ? (
              <ErrorBlock
                error={error}
                onConfigureApiKey={onOpenSettings ? () => { clearError(workspaceId); onOpenSettings(); } : null}
              />
            ) : null}
          </>
        )}
      </div>

      <div className="border-t border-octo-hairline bg-octo-panel px-6 pb-0 pt-3">
        {/* Model picker row — sits tight above the input box */}
        <div className="mb-2 flex items-center">
          <ModelPicker
            activeModel={model}
            onSelectModel={setModel}
            onOpenSettings={onOpenSettings}
          />
        </div>

        {/* Input wrapper */}
        <div className="pb-4">
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
            className="w-full resize-none bg-transparent px-4 py-3 text-[14px] leading-[1.5] text-octo-ivory outline-none placeholder:font-serif placeholder:not-italic placeholder:text-octo-mute"
            style={{ maxHeight: "calc(6 * 1.25rem + 1.5rem)" }}
          />

          <div className="flex items-center justify-between gap-3 px-3 pb-2.5">
            <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">
              ⌘ K to focus
            </div>

            {/* Inline cost preview — shows the projected $ and rough token
                count for the active model + current prompt. Only renders
                when the user has typed something and the catalog is loaded;
                otherwise the row stays clean. */}
            {inlineCost !== null && (
              <div
                className="ml-auto font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute"
                title={`Estimate for ${activeModelInfo!.displayName || activeModelInfo!.id}; assumes 30% output ratio`}
              >
                <span className="text-octo-brass">{formatPerMessageCost(inlineCost)}</span>
                <span className="px-1 opacity-50">·</span>
                <span>{formatTokens(estimatedTokens)}</span>
              </div>
            )}

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
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
      <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-mute">
        Talk
      </div>
      <div className="font-serif text-[24px] leading-tight tracking-[-0.005em] text-octo-ivory">
        Begin a conversation.
      </div>
      <p className="max-w-md text-[12px] leading-[1.6] text-octo-sage">
        Ask anything — Octopus will read files, run commands, and write changes inside this workspace's worktree.
      </p>
      <BrassRule className="mt-2 w-7" />
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
      <span className="font-serif text-[13px] text-octo-sage">Thinking…</span>
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
          <div className="font-serif text-[14px] text-octo-rouge">
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

function BudgetErrorBlock({ onOverride }: { onOverride: () => void }) {
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
          <div className="font-serif text-[14px] text-octo-rouge">
            Budget cap reached.
          </div>
          <div className="mt-1 text-[12px] leading-[1.55] text-octo-sage">
            Sending is blocked to stay within your configured budget.
          </div>
          <button
            onClick={onOverride}
            className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-octo-hairline px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-sage transition-colors hover:text-octo-brass"
          >
            Override for this turn
          </button>
        </div>
      </div>
    </div>
  );
}
