import { useEffect, useRef, useMemo, useState, useCallback } from "react";
import { AlertTriangle, Settings, Copy, CopyPlus, Check, ArrowDown, RefreshCw, Pencil, History, GitFork, CircleSlash } from "lucide-react";
import { useChatStore, buildTimeline, isAgentToolName, type ConversationItem } from "../../stores/chatStore";
import { ipc } from "../../lib/ipc";
import { rewindError, skippedLabel } from "../../lib/talkRewind";
import { pushToast } from "../Toasts";
import { RewindDialog } from "./RewindDialog";
import { TurnChanges } from "./TurnChanges";
import { turnEnds } from "../../lib/turnChanges";
import { tourId } from "../../lib/tour/ids";
import { useTourStore } from "../../stores/tourStore";
import type { ChatMessage as StoredMessage } from "../../lib/types";
import { useBudgetsStore, BUDGET_CAP_MSG } from "../../stores/budgetsStore";
import { useCopyFeedback } from "../../hooks/useCopyFeedback";
import {
  ACTION_LABEL,
  bannerErrorKind,
  errorAction,
  errorHeadline,
  errorKindOf,
  keptLine,
  roundsKept,
  type TalkErrorKind,
} from "../../lib/talkError";
import { parseSentContext, typedText } from "../../lib/sentContext";
import { expandDraft } from "../../lib/talkContextResolve";
import { sessionRefs } from "../../lib/talkContext";
import { useTerminalsStore } from "../../stores/terminalsStore";
import { prefersReducedMotion } from "../../lib/motion";
import { ChatMessage } from "../ChatMessage";
import { OctoWatcher } from "./OctoWatcher";
import { LiveToolCard } from "./LiveToolCard";
import { WorkBlock } from "./WorkBlock";
import { groupWork, type TalkBlock } from "../../lib/talkWork";
import { CrewCard, crewAgentsFromLive, crewAgentsFromTools } from "./CrewCard";
import { ApprovalCard } from "./ApprovalCard";
import { SubagentCapCard } from "./SubagentCapCard";
import { OctoStatus } from "./OctoStatus";

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
  const streamSince = useChatStore((s) => s.streamSinceByWs[workspaceId]);
  const streamBuffer = useChatStore((s) => s.getStreamBuffer(workspaceId));
  const error = useChatStore((s) => s.getError(workspaceId));
  const liveTools = useChatStore((s) => s.getLiveTools(workspaceId));
  const pendingApprovals = useChatStore((s) => s.getPendingApprovals(workspaceId));
  const activeThreadId = useChatStore((s) => s.activeThreadByWs[workspaceId]);
  // Per thread: a Stop in one conversation says nothing about another's turn.
  const stopRequested = useChatStore((s) => (activeThreadId ? s.stopRequestedByThread[activeThreadId] : false) ?? false);
  const turnNotice = useChatStore((s) =>
    activeThreadId ? (s.turnNoticeByThread[activeThreadId]?.text ?? null) : null,
  );
  const respondApproval = useChatStore((s) => s.respondApproval);
  const pendingCaps = useChatStore((s) => s.getPendingCaps(workspaceId));
  const skillNames = useChatStore((s) => s.getSkillNames(workspaceId));
  const respondSubagentCap = useChatStore((s) => s.respondSubagentCap);
  const regenerate = useChatStore((s) => s.regenerate);
  const continueTurn = useChatStore((s) => s.continueTurn);
  const editAndResend = useChatStore((s) => s.editAndResend);
  const forkThread = useChatStore((s) => s.forkThread);
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
  // Narration and tool calls in a row become one work block (lib/talkWork).
  const blocks = useMemo<TalkBlock[]>(() => groupWork(timeline), [timeline]);
  // Where each turn ends, so its changes row (#1152) sits under its answer.
  const ends = useMemo(() => turnEnds(blocks), [blocks]);
  const askById = useMemo(() => new Map(messages.map((m) => [m.id, m.content])), [messages]);
  // The work of the turn in flight doesn't fold while it streams (it folds
  // when the turn ends). That work comes after the last user turn AND was
  // saved after the turn started: the backend saves the new user row a
  // moment after streaming begins (later still for a `$` command, after its
  // secret scan), and until it lands the last user turn on screen is the
  // previous one, whose folded rounds must stay folded.
  const currentTurnStart = useMemo(() => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.kind === "message" && b.message.role === "user") return i + 1;
    }
    return 0;
  }, [blocks]);
  const isLiveWork = (id: number, index: number) =>
    streaming && index >= currentTurnStart && id > (streamSince ?? -1);
  // Where the running calls' rows continue the turn's work block: right
  // under it, as one more row of its last round (no gap) or as a new round
  // after a narration line (the block's 2px gap), exactly where each row
  // will land once it resolves, so nothing jumps.
  const lastBlock = blocks[blocks.length - 1];
  const liveContinues =
    lastBlock?.kind === "work"
      ? lastBlock.entries[lastBlock.entries.length - 1]?.kind === "round"
        ? "-mt-6"
        : "-mt-6 pt-0.5"
      : "";
  const liveAgents = useMemo(() => liveTools.filter((t) => isAgentToolName(t.toolName)), [liveTools]);
  const liveOthers = useMemo(() => liveTools.filter((t) => !isAgentToolName(t.toolName)), [liveTools]);

  useEffect(() => {
    loadHistory(workspaceId);
  }, [workspaceId, loadHistory]);

  // The user turns whose files can be rewound (#958): each turn that could
  // write took a checkpoint before it ran, unless the snapshot was over its
  // budget, in which case the turn says it has none. Re-read when a turn ends.
  const [checkpoints, setCheckpoints] = useState<ReadonlySet<number>>(() => new Set());
  const [skipped, setSkipped] = useState<ReadonlyMap<number, string>>(() => new Map());
  const [rewindAt, setRewindAt] = useState<number | null>(null);
  useEffect(() => {
    if (!activeThreadId || streaming || typeof ipc.listTalkCheckpoints !== "function") return;
    let live = true;
    ipc
      .listTalkCheckpoints(activeThreadId)
      .then((c) => {
        if (!live || !c || !Array.isArray(c.turns)) return;
        setCheckpoints(new Set(c.turns));
        setSkipped(new Map((c.skipped ?? []).map((s) => [s.messageId, s.reason])));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [activeThreadId, streaming, messages.length]);

  // An ask sent with `@` context is edited as typed, so on resend its tokens
  // resolve fresh, as from the composer (#1150). While they resolve, the
  // turn's actions stay disabled, so a second Resend can't race the first.
  const [resolving, setResolving] = useState(false);
  const resolvingRef = useRef(false);
  const resendEdit = useCallback(
    async (id: number, text: string, hadContext: boolean) => {
      if (!hadContext) return editAndResend(workspaceId, workspacePath, id, text);
      if (resolvingRef.current) return;
      resolvingRef.current = true;
      setResolving(true);
      try {
        const sessions = sessionRefs(useTerminalsStore.getState().getTerminals(workspaceId));
        const { content, context } = await expandDraft(text, workspacePath, sessions);
        await editAndResend(workspaceId, workspacePath, id, content, undefined, context);
      } finally {
        resolvingRef.current = false;
        setResolving(false);
      }
    },
    [editAndResend, workspaceId, workspacePath],
  );

  const handleFork = useCallback(
    (messageId: number) => {
      if (!activeThreadId) return;
      forkThread(workspaceId, activeThreadId, messageId)
        .then(() => pushToast({ level: "success", title: "Forked into a new conversation.", body: "The turn's text is in the composer." }))
        .catch((e) => pushToast({ level: "error", title: "Couldn't fork the conversation.", body: rewindError(e) }));
    },
    [forkThread, workspaceId, activeThreadId],
  );

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

  // Jump to the latest message instantly when a conversation first loads or the
  // user switches threads — a smooth glide here would visibly scroll PAST the
  // history on open. After that initial settle, new turns glide smoothly.
  const settledRef = useRef(false);
  useEffect(() => {
    settledRef.current = false; // re-arm on workspace/thread switch
  }, [workspaceId]);
  useEffect(() => {
    if (timeline.length === 0) return;
    if (!settledRef.current) {
      settledRef.current = true;
      scrollToBottom(false); // instant on first paint of this thread
    } else if (atBottom) {
      scrollToBottom(true); // glide for subsequent turns while following
    }
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

  // Player visibility with a linger: OctoStatus stays mounted ~640ms after
  // deactivation for its beat+fade exit, so everything that arranges itself
  // around it (wash, jump pill, bottom padding) must track that window, not
  // the raw streaming flag — otherwise the pill snaps onto the exiting mascot.
  const capsForThread = useMemo(
    () => (activeThreadId ? pendingCaps.filter((c) => c.threadId === activeThreadId) : pendingCaps),
    [pendingCaps, activeThreadId],
  );
  const playerActive = streaming || approvalsForThread.length > 0 || capsForThread.length > 0;
  const [playerVisible, setPlayerVisible] = useState(playerActive);
  useEffect(() => {
    if (playerActive) {
      setPlayerVisible(true);
      return;
    }
    const t = setTimeout(() => setPlayerVisible(false), 700);
    return () => clearTimeout(t);
  }, [playerActive]);

  const renderBlock = (item: TalkBlock, index: number) => {
    if (item.kind === "crew") {
      return (
        <CrewCard
          key={`crew-${item.id}`}
          workspaceId={workspaceId}
          agents={crewAgentsFromTools(item.agents)}
        />
      );
    }
    if (item.kind === "work") {
      return (
        <WorkBlock
          key={`work-${item.id}`}
          entries={item.entries}
          calls={item.calls}
          live={isLiveWork(item.id, index)}
          workspacePath={workspacePath}
          onOpenInEditor={onOpenInEditor}
          onRunInTerminal={onRunInTerminal}
        />
      );
    }
    if (item.kind === "error") {
      const at = messages.indexOf(item.message);
      // Only the turn's latest word can be continued, and not while
      // a turn runs.
      const canRetry = at === messages.length - 1 && !streaming;
      return (
        <ErrorBlock
          key={`error-${item.message.id}`}
          error={item.message.content}
          kind={errorKindOf(item.message.errorKind)}
          kept={keptLine(roundsKept(messages, at))}
          onRetry={canRetry ? () => void continueTurn(workspaceId, workspacePath) : null}
          onConfigureApiKey={onOpenSettings ?? null}
        />
      );
    }
    return (
      <MessageRow
        key={item.message.id}
        message={item.message}
        skillNames={skillNames}
        onOpenInEditor={onOpenInEditor}
        onRegenerate={
          item.message.role === "assistant" && item.message.id === lastAssistantId
            ? (id) => regenerate(workspaceId, workspacePath, id)
            : undefined
        }
        onEdit={
          item.message.role === "user" && item.message.id === lastUserId
            ? (id, content, hadContext) => void resendEdit(id, content, hadContext)
            : undefined
        }
        onRewind={
          item.message.role === "user" && checkpoints.has(item.message.id)
            ? setRewindAt
            : undefined
        }
        noCheckpoint={item.message.role === "user" ? skipped.get(item.message.id) : undefined}
        onFork={item.message.role === "user" && activeThreadId ? handleFork : undefined}
        disabled={streaming || resolving}
      />
    );
  };

  // A finished turn that took a checkpoint ends with what it changed
  // (#1152); the turn in flight shows nothing until it ends, so its row
  // mounts (and reads the turn's refs) once both checkpoints exist.
  const turnChangesAfter = (index: number) => {
    const ask = ends.get(index);
    if (ask === undefined || !activeThreadId || !checkpoints.has(ask)) return null;
    if (streaming && ask === lastUserId) return null;
    return (
      <TurnChanges
        key={`changes-${ask}`}
        workspaceId={workspaceId}
        threadId={activeThreadId}
        messageId={ask}
        ask={askById.get(ask) ?? ""}
        onRewind={setRewindAt}
        disabled={streaming || resolving}
      />
    );
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className={`octo-scroll flex min-h-0 flex-1 flex-col overflow-y-auto px-8 pt-6 ${
        playerVisible ? "pb-[118px]" : "pb-6"
      }`}
    >
      {isEmpty ? (
        <EmptyState areaRef={scrollRef} />
      ) : (
        <section aria-label="Conversation" className="mx-auto flex w-full max-w-3xl flex-col gap-6">
          {blocks.flatMap((item, index) => [renderBlock(item, index), turnChangesAfter(index)])}

          {/* Live sub-agents — every in-flight `Agent` call of the turn as ONE
              crew card (they run concurrently); retires as the resolved rows
              land and the timeline's crew item takes over. */}
          {liveAgents.length > 0 && (
            <CrewCard workspaceId={workspaceId} agents={crewAgentsFromLive(liveAgents)} />
          )}

          {/* Live tool rows — one per in-flight tool, in call order, on the
              work hairline: when the turn's work block is the last thing on
              screen the rows continue its line (-mt-6 closes the feed's
              gap-6), otherwise they start one. Rows sit flush, like a round's. Always this one
              wrapper, so a row never remounts as its block appears. They
              retire as their resolved rows arrive (see chatStore). */}
          {liveOthers.length > 0 && (
            <div
              data-role="live-work"
              className={`flex flex-col border-l border-octo-hairline pl-3 ${liveContinues}`}
            >
              {liveOthers.map((t) => (
                <LiveToolCard key={`live-${t.callId}`} tool={t} />
              ))}
            </div>
          )}

          {/* Turn-limit cards — a writing sub-agent stopped mid-work; the
              turn is paused until the user grants turns or accepts. */}
          {capsForThread.map((c) => (
            <SubagentCapCard
              key={`cap-${c.callId}`}
              cap={c}
              onRespond={(extra) => respondSubagentCap(workspaceId, c.callId, extra)}
            />
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
            </div>
          )}

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
              kind={bannerErrorKind(error)}
              kept={null}
              onRetry={null}
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
        </section>
      )}
    </div>
      {/* Bottom exit wash — keeps the pinned Player legible over the journal
          while (and only while) the Player is on stage. A surface, not a line
          (design-system §3); gone when idle so scrolled history stays legible. */}
      {!isEmpty && playerVisible && (
        <div
          aria-hidden
          className="octo-fade-in pointer-events-none absolute inset-x-0 bottom-0 h-[110px]"
          style={{ background: "linear-gradient(transparent, var(--color-octo-bg) 76%)" }}
        />
      )}

      {/* The Player — always-visible activity figure (spec 2026-07-19 §4). */}
      <OctoStatus
        workspaceId={workspaceId}
        streaming={streaming}
        hasError={Boolean(error)}
        wasStopped={stopRequested}
        streamBuffer={streamBuffer}
        liveTools={liveTools}
        approvals={approvalsForThread.length}
        notice={streaming ? turnNotice : null}
      />
      {showJump && (
        <button
          type="button"
          onClick={() => scrollToBottom(true)}
          aria-label="Jump to latest"
          title="Jump to latest"
          className={`octo-pop-in absolute left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-octo-hairline bg-octo-panel px-3 py-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-octo-sage shadow-lg transition-colors hover:text-octo-brass ${
            playerVisible ? "bottom-16" : "bottom-3"
          }`}
        >
          <ArrowDown size={12} />
          Latest
        </button>
      )}
      {rewindAt !== null && activeThreadId && (
        <RewindDialog
          workspaceId={workspaceId}
          threadId={activeThreadId}
          messageId={rewindAt}
          onClose={() => setRewindAt(null)}
        />
      )}
    </div>
  );
}

/**
 * Wraps a message with hover/focus actions: Copy always, Regenerate on assistant
 * turns, Edit on user turns. Editing swaps the bubble for an inline composer that
 * truncates from this message and resends. A user turn also offers Rewind files
 * to here (when it took a checkpoint; a turn whose checkpoint was skipped says so) and Fork from here. Actions are disabled
 * while a turn streams.
 */
function MessageRow({
  message,
  skillNames,
  onOpenInEditor,
  onRegenerate,
  onEdit,
  onRewind,
  noCheckpoint,
  onFork,
  disabled,
}: {
  message: StoredMessage;
  skillNames?: string[];
  onOpenInEditor?: (path: string) => void;
  onRegenerate?: (id: number) => void;
  onEdit?: (id: number, newContent: string, hadContext: boolean) => void;
  onRewind?: (id: number) => void;
  /** Set (to the reason, possibly empty) when the turn ran without a checkpoint. */
  noCheckpoint?: string;
  onFork?: (id: number) => void;
  disabled?: boolean;
}) {
  const { copied, copy } = useCopyFeedback();
  const { copied: copiedAll, copy: copyAll } = useCopyFeedback();
  const ref = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const tourTarget = useTourStore((s) => s.target);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  // An ask sent with `@` context: what was typed, apart from its blocks.
  const sent = message.role === "user" ? parseSentContext(message.contextBlocks, message.content) : null;
  const typed = sent ? typedText(message.content, sent) : message.content;

  function handleCopy() {
    // A user turn copies what was typed; its header (eyebrow, time) and its
    // context chips are chrome. An answer copies its rendered text, as before.
    copy(message.role === "user" ? typed : (ref.current?.innerText ?? message.content));
  }

  function startEdit() {
    setDraft(typed);
    setEditing(true);
  }

  function saveEdit() {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== typed) onEdit?.(message.id, next, sent !== null);
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

  // A tour pointing at one of these actions shows the bar, as a hover would.
  const toured = tourTarget !== null && actionsRef.current?.contains(tourTarget) === true;

  const isUser = message.role === "user";
  const actions = (
    <div
      ref={actionsRef}
      data-tour={onFork ? tourId("talk-turn-actions") : undefined}
      className={`flex items-center gap-0.5 transition group-hover/msg:opacity-100 focus-within:opacity-100 ${
        isUser ? "" : "absolute -top-1 right-0 "
      }${toured ? "opacity-100" : "opacity-0"}`}
    >
      {onRewind && (
        <RowAction
          label="Rewind files to here"
          tour={tourId("talk-turn-rewind")}
          onClick={() => onRewind(message.id)}
          disabled={disabled}
          icon={<History size={12} />}
        />
      )}
      {!onRewind && noCheckpoint !== undefined && (
        <span
          role="img"
          data-tour={tourId("talk-turn-no-checkpoint")}
          aria-label={skippedLabel(noCheckpoint)}
          title={skippedLabel(noCheckpoint)}
          className="flex h-6 w-6 items-center justify-center rounded p-1 text-octo-mute opacity-60"
        >
          <CircleSlash size={12} aria-hidden />
        </span>
      )}
      {onFork && (
        <RowAction
          label="Fork from here"
          tour={tourId("talk-turn-fork")}
          onClick={() => onFork(message.id)}
          disabled={disabled}
          icon={<GitFork size={12} />}
        />
      )}
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
      {sent && (
        <RowAction
          label={copiedAll ? "Copied" : "Copy with context"}
          onClick={() => copyAll(message.content)}
          icon={copiedAll ? <Check size={12} className="text-octo-verdigris" /> : <CopyPlus size={12} />}
        />
      )}
    </div>
  );

  // The actions live inside their turn's article. A user turn sets them in
  // its header, between "— You" and the time, so they come right after the
  // ask in focus order; an answer sets them over its eyebrow line, last in
  // its article, so they come after its text.
  return (
    <div className="group/msg relative">
      <div ref={ref}>
        <ChatMessage
          message={message}
          onOpenInEditor={onOpenInEditor}
          skillNames={skillNames}
          actions={actions}
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
  tour,
}: {
  label: string;
  onClick: () => void;
  icon: React.ReactNode;
  disabled?: boolean;
  tour?: string;
}) {
  return (
    <button
      type="button"
      data-tour={tour}
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

function EmptyState({ areaRef }: { areaRef: React.RefObject<HTMLDivElement | null> }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
      <OctoWatcher size={72} areaRef={areaRef} />
      <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-octo-mute">
        Talk
      </div>
      <div className="font-serif text-[22px] leading-tight tracking-[-0.005em] text-octo-ivory">
        Begin a conversation.
      </div>
      <p className="max-w-md text-[12px] leading-[1.6] text-octo-sage">
        Ask anything — Octopush will read files, run commands, and write changes
        inside this workspace's worktree.
      </p>
    </div>
  );
}

/** A turn that ended on an error: what failed, what of the turn is kept, and
 *  one action for its kind (`lib/talkError`). An action that can't run here
 *  ("Try again" on an earlier error, no settings to open) falls back to
 *  copying the details. */
function ErrorBlock({
  error,
  kind,
  kept,
  onRetry,
  onConfigureApiKey,
}: {
  error: string;
  kind: TalkErrorKind;
  /** What of the turn survives ("Work up to round 14 is kept."); null for
   *  an error that was never part of a turn. */
  kept: string | null;
  onRetry: (() => void) | null;
  onConfigureApiKey: (() => void) | null;
}) {
  const { copied, copy } = useCopyFeedback();
  const wanted = errorAction(kind);
  const action =
    (wanted === "retry" && !onRetry) || (wanted === "configure" && !onConfigureApiKey) ? "copy" : wanted;
  const run = action === "retry" ? onRetry : action === "configure" ? onConfigureApiKey : () => copy(error);
  const label = action === "copy" && copied ? "Copied" : ACTION_LABEL[action];
  const icon =
    action === "retry" ? <RefreshCw size={11} /> : action === "configure" ? <Settings size={11} /> : copied ? <Check size={11} className="text-octo-verdigris" /> : <Copy size={11} />;
  return (
    <div
      data-error-kind={kind}
      className="octo-fade-in mx-auto max-w-lg rounded-md p-4"
      style={{
        borderLeft: "1px solid var(--color-octo-rouge)",
        background: "var(--rouge-ghost)",
      }}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle size={14} className="mt-0.5 shrink-0 text-octo-rouge" />
        <div className="min-w-0 flex-1">
          <div className="font-serif text-[14px] text-octo-rouge">
            {errorHeadline(kind)}
            {kept && <span className="text-octo-ivory"> {kept}</span>}
          </div>
          <div className="mt-1 break-words text-[12px] leading-[1.55] text-octo-sage">{error}</div>
          <button
            type="button"
            data-tour="talk-error-action"
            title={label}
            onClick={() => run?.()}
            className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-octo-border-strong px-3 py-1.5 font-serif text-[13px] text-octo-sage transition-colors duration-[180ms] hover:text-octo-ivory focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
          >
            {icon}
            {label}
          </button>
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
        background: "var(--rouge-ghost)",
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
