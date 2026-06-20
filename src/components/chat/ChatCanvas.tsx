import { useEffect, useRef, useMemo, useState, useCallback } from "react";
import { AlertTriangle, Settings, Copy, Check, ArrowDown, RefreshCw, Pencil } from "lucide-react";
import { useChatStore, buildTimeline, type ConversationItem } from "../../stores/chatStore";
import type { ChatMessage as StoredMessage } from "../../lib/types";
import { useBudgetsStore, BUDGET_CAP_MSG } from "../../stores/budgetsStore";
import { useCopyFeedback } from "../../hooks/useCopyFeedback";
import { BrassRule } from "../BrassRule";
import { prefersReducedMotion } from "../../lib/motion";
import { ChatMessage } from "../ChatMessage";
import { ToolCallCard } from "../ToolCallCard";
import { LiveToolCard } from "./LiveToolCard";
import { ApprovalCard } from "./ApprovalCard";

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
  const pendingApprovals = useChatStore((s) => s.getPendingApprovals(workspaceId));
  const activeThreadId = useChatStore((s) => s.activeThreadByWs[workspaceId]);
  const respondApproval = useChatStore((s) => s.respondApproval);
  const regenerate = useChatStore((s) => s.regenerate);
  const editAndResend = useChatStore((s) => s.editAndResend);
  const model = useChatStore((s) => s.model);
  const loadHistory = useChatStore((s) => s.loadHistory);
  const clearError = useChatStore((s) => s.clearError);
  const enableOverride = useBudgetsStore((s) => s.enableOverride);
  const isBudgetError = error === BUDGET_CAP_MSG;

  const scrollRef = useRef<HTMLDivElement>(null);
  // True while the user is pinned near the bottom. Autoscroll only follows then,
  // so reading back through history is never interrupted by a yank to the end.
  const [atBottom, setAtBottom] = useState(true);

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

  // Regenerate / Edit truncate the thread from the targeted message onward, so
  // they're offered ONLY on the latest exchange — the last assistant turn and
  // the last user turn. This prevents silently deleting a long conversation's
  // tail by clicking an action on an old message. (Mid-history edit with an
  // explicit confirmation is a deliberate future enhancement.)
  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return messages[i].id;
    }
    return -1;
  }, [messages]);
  const lastUserId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") return messages[i].id;
    }
    return -1;
  }, [messages]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setAtBottom(distance < 80);
  }, []);

  const scrollToBottom = useCallback((smooth: boolean) => {
    const el = scrollRef.current;
    if (!el) return;
    const animate = smooth && !prefersReducedMotion();
    if (typeof el.scrollTo === "function") {
      el.scrollTo({ top: el.scrollHeight, behavior: animate ? "smooth" : "auto" });
    } else {
      el.scrollTop = el.scrollHeight; // jsdom / older engines
    }
  }, []);

  // Follow streaming output, but only while the user is at the bottom — instant
  // (not smooth) so the view stays glued to fast token output without lag.
  useEffect(() => {
    if (streaming && atBottom) scrollToBottom(false);
  }, [streaming, streamBuffer, atBottom, scrollToBottom]);

  // Glide to the bottom when a new turn lands, if the user is following along.
  useEffect(() => {
    if (atBottom) scrollToBottom(true);
    // Only re-run when the conversation grows, not when atBottom toggles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeline.length]);

  // Only surface approval cards for the conversation on screen — approving a
  // destructive command you can't see (another thread) would be unsafe. The
  // store keeps them workspace-wide (stable ref); we scope at render.
  const approvalsForThread = useMemo(
    () =>
      activeThreadId
        ? pendingApprovals.filter((a) => a.threadId === activeThreadId)
        : pendingApprovals,
    [pendingApprovals, activeThreadId],
  );

  const isEmpty = messages.length === 0 && !streaming && !error;
  const showJump = !atBottom && !isEmpty;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="octo-scroll flex min-h-0 flex-1 flex-col overflow-y-auto px-8 py-6"
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
              <MessageRow
                key={item.message.id}
                message={item.message}
                onOpenInEditor={onOpenInEditor}
                onRegenerate={
                  item.message.role === "assistant" && item.message.id === lastAssistantId
                    ? (id) => regenerate(workspaceId, workspacePath, id)
                    : undefined
                }
                onEdit={
                  item.message.role === "user" && item.message.id === lastUserId
                    ? (id, content) => editAndResend(workspaceId, workspacePath, id, content)
                    : undefined
                }
                disabled={streaming}
              />
            );
          })}

          {/* Live tool cards — one per in-flight tool, in call order. They
              retire as their resolved rows arrive (see chatStore). */}
          {liveTools.map((t) => (
            <LiveToolCard key={`live-${t.callId}`} tool={t} />
          ))}

          {/* Inline approval cards — the turn is paused on these. */}
          {approvalsForThread.map((a) => (
            <ApprovalCard
              key={`approval-${a.callId}`}
              approval={a}
              onRespond={(d) => respondApproval(workspaceId, a.callId, d)}
            />
          ))}

          {streaming && streamBuffer && (
            <div className="octo-fade-in">
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
              {/* Explicit "this message is still being written" marker so a live
                  turn is never mistaken for a finished one when the stream pauses. */}
              <div className="mt-1.5 flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="inline-block h-1 w-1 animate-pulse rounded-full"
                  style={{ background: "var(--color-octo-brass)" }}
                />
                <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">
                  Generating
                </span>
              </div>
            </div>
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
      {showJump && (
        <button
          type="button"
          onClick={() => scrollToBottom(true)}
          aria-label="Jump to latest"
          title="Jump to latest"
          className="octo-pop-in absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-octo-hairline bg-octo-panel px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-octo-sage shadow-lg transition-colors hover:text-octo-brass"
        >
          <ArrowDown size={12} />
          Latest
        </button>
      )}
    </div>
  );
}

/**
 * Wraps a message with hover/focus actions: Copy always, Regenerate on assistant
 * turns, Edit on user turns. Editing swaps the bubble for an inline composer that
 * truncates from this message and resends. Actions hide while a turn streams.
 */
function MessageRow({
  message,
  onOpenInEditor,
  onRegenerate,
  onEdit,
  disabled,
}: {
  message: StoredMessage;
  onOpenInEditor?: (path: string) => void;
  onRegenerate?: (id: number) => void;
  onEdit?: (id: number, newContent: string) => void;
  disabled?: boolean;
}) {
  const { copied, copy } = useCopyFeedback();
  const ref = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  function handleCopy() {
    copy(ref.current?.innerText ?? message.content);
  }

  function startEdit() {
    setDraft(message.content);
    setEditing(true);
  }

  function saveEdit() {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== message.content) onEdit?.(message.id, next);
  }

  if (editing) {
    return (
      <div className="octo-fade-in rounded-md border border-[var(--brass-dim)] bg-[var(--brass-ghost)] p-2">
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setEditing(false);
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveEdit();
          }}
          rows={Math.min(10, Math.max(2, draft.split("\n").length))}
          className="w-full resize-none bg-transparent font-sans text-[13px] leading-[1.6] text-octo-ivory outline-none"
        />
        <div className="mt-1.5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="font-mono text-[10px] uppercase tracking-[0.2em] text-octo-mute transition-colors hover:text-octo-sage"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={saveEdit}
            title="Resend from this message (⌘↵)"
            className="rounded-md border border-[var(--brass-dim)] bg-[var(--brass-ghost)] px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-octo-brass"
          >
            Resend
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="group/msg relative">
      <div ref={ref}>
        <ChatMessage message={message} onOpenInEditor={onOpenInEditor} />
      </div>
      <div className="absolute -top-1 right-0 flex items-center gap-0.5 opacity-0 transition group-hover/msg:opacity-100 focus-within:opacity-100">
        {onEdit && (
          <RowAction
            label="Edit & resend"
            onClick={startEdit}
            disabled={disabled}
            icon={<Pencil size={12} />}
          />
        )}
        {onRegenerate && (
          <RowAction
            label="Regenerate"
            onClick={() => onRegenerate(message.id)}
            disabled={disabled}
            icon={<RefreshCw size={12} />}
          />
        )}
        <RowAction
          label={copied ? "Copied" : "Copy message"}
          onClick={handleCopy}
          icon={
            copied ? (
              <Check size={12} className="text-octo-verdigris" />
            ) : (
              <Copy size={12} />
            )
          }
        />
      </div>
    </div>
  );
}

function RowAction({
  label,
  onClick,
  icon,
  disabled,
}: {
  label: string;
  onClick: () => void;
  icon: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex h-6 w-6 items-center justify-center rounded p-1 text-octo-mute transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass disabled:cursor-not-allowed disabled:opacity-30"
    >
      {icon}
    </button>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
      <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-mute">
        Talk
      </div>
      <div className="font-serif text-[22px] leading-tight tracking-[-0.005em] text-octo-ivory">
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
