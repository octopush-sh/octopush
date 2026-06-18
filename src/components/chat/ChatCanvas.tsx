import { useEffect, useRef, useMemo } from "react";
import { AlertTriangle, Settings, Copy, Check } from "lucide-react";
import { useChatStore, buildTimeline, type ConversationItem } from "../../stores/chatStore";
import { useBudgetsStore, BUDGET_CAP_MSG } from "../../stores/budgetsStore";
import { useCopyFeedback } from "../../hooks/useCopyFeedback";
import { BrassRule } from "../BrassRule";
import { ChatMessage } from "../ChatMessage";
import { ToolCallCard } from "../ToolCallCard";
import { LiveToolCard } from "./LiveToolCard";

interface Props {
  workspaceId: string;
  workspacePath: string;
  onOpenSettings?: () => void;
  onOpenInEditor?: (path: string) => void;
  /** Re-run a tool's shell command in the RUN-mode terminal (cross-mode, P9). */
  onRunInTerminal?: (command: string) => void;
}

/**
 * The TALK timeline — the scrolling conversation surface. Owns history load,
 * the message→timeline projection, autoscroll, and the empty/error/streaming
 * states. Extracted from ChatView (P1). The composer is a sibling, not a child.
 *
 * Content is centered in a readable max-width column for a calmer, more
 * premium reading rhythm; full-bleed chrome (scroll) stays edge-to-edge.
 */
export function ChatCanvas({
  workspaceId,
  workspacePath,
  onOpenSettings,
  onOpenInEditor,
  onRunInTerminal,
}: Props) {
  const messages = useChatStore((s) => s.getMessages(workspaceId));
  const streaming = useChatStore((s) => s.getStreaming(workspaceId));
  const streamBuffer = useChatStore((s) => s.getStreamBuffer(workspaceId));
  const error = useChatStore((s) => s.getError(workspaceId));
  const liveTools = useChatStore((s) => s.getLiveTools(workspaceId));
  const model = useChatStore((s) => s.model);
  const loadHistory = useChatStore((s) => s.loadHistory);
  const clearError = useChatStore((s) => s.clearError);
  const enableOverride = useBudgetsStore((s) => s.enableOverride);
  const isBudgetError = error === BUDGET_CAP_MSG;

  const scrollRef = useRef<HTMLDivElement>(null);

  // Compute the timeline locally with useMemo. Do NOT read it from a store
  // selector that builds a new array each call — that makes Zustand think the
  // value changed every render and spins an infinite re-render loop. The guard
  // against that exact bug is asserted in ChatView.test.tsx. `buildTimeline` is
  // the same projection the store's getTimeline uses, so both agree.
  const timeline = useMemo<ConversationItem[]>(
    () => buildTimeline(messages),
    [messages],
  );

  useEffect(() => {
    loadHistory(workspaceId);
  }, [workspaceId, loadHistory]);

  // Smooth autoscroll while streaming (stability doctrine S6).
  useEffect(() => {
    if (streaming) {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [streaming, streamBuffer]);

  const isEmpty = messages.length === 0 && !streaming && !error;

  return (
    <div
      ref={scrollRef}
      className="flex min-h-0 flex-1 flex-col overflow-y-auto px-8 py-6"
    >
      {isEmpty ? (
        <EmptyState />
      ) : (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
          {timeline.map((item) => {
            if (item.kind === "tool") {
              return (
                <ToolCallCard
                  key={`tool-${item.id}`}
                  tool={item.tool}
                  workspacePath={workspacePath}
                  onOpenInEditor={onOpenInEditor}
                  onRunInTerminal={onRunInTerminal}
                />
              );
            }
            if (item.kind === "error") {
              return (
                <ErrorBlock
                  key={`error-${item.message.id}`}
                  error={item.message.content}
                  onConfigureApiKey={onOpenSettings ?? null}
                />
              );
            }
            return (
              <MessageRow key={item.message.id}>
                <ChatMessage message={item.message} onOpenInEditor={onOpenInEditor} />
              </MessageRow>
            );
          })}

          {/* Live tool cards — one per in-flight tool, in call order. They
              retire as their resolved rows arrive (see chatStore). */}
          {liveTools.map((t) => (
            <LiveToolCard key={`live-${t.callId}`} tool={t} />
          ))}

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

          {/* Only the bare "Thinking…" pulse when nothing else is live. */}
          {streaming && !streamBuffer && liveTools.length === 0 && <ThinkingIndicator />}

          {error && isBudgetError ? (
            <BudgetErrorBlock
              onOverride={() => {
                enableOverride();
                clearError(workspaceId);
              }}
            />
          ) : error ? (
            <ErrorBlock
              error={error}
              onConfigureApiKey={
                onOpenSettings
                  ? () => {
                      clearError(workspaceId);
                      onOpenSettings();
                    }
                  : null
              }
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

/** Wraps a message so a quiet Copy affordance reveals on hover (group). */
function MessageRow({ children }: { children: React.ReactNode }) {
  const { copied, copy } = useCopyFeedback();
  const ref = useRef<HTMLDivElement>(null);

  function handleCopy() {
    copy(ref.current?.innerText ?? "");
  }

  return (
    <div className="group/msg relative">
      <div ref={ref}>{children}</div>
      <button
        type="button"
        onClick={handleCopy}
        aria-label="Copy message"
        title={copied ? "Copied" : "Copy message"}
        className="absolute -top-1 right-0 flex h-6 w-6 items-center justify-center rounded p-1 text-octo-mute opacity-0 transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass group-hover/msg:opacity-100"
      >
        {copied ? (
          <Check size={12} className="text-octo-verdigris" />
        ) : (
          <Copy size={12} />
        )}
      </button>
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
        Ask anything — Octopus will read files, run commands, and write changes
        inside this workspace's worktree.
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
