import { useEffect, useRef, useState, useCallback } from "react";
import { clsx } from "clsx";
import { useChatStore } from "../../stores/chatStore";
import { useBudgetsStore, BUDGET_CAP_MSG } from "../../stores/budgetsStore";
import {
  estimateNextTurnTokens,
  estimatePerMessageCost,
  formatPerMessageCost,
  formatTokens,
} from "../../lib/cost";
import { ipc } from "../../lib/ipc";
import type { ModelInfo, ProviderConfig } from "../../lib/types";
import { ModelPicker } from "../ModelPicker";

interface Props {
  workspaceId: string;
  workspacePath: string;
}

/**
 * The TALK composer — a single bounded box with the textarea and a quiet
 * control bar (model · cost · send) along its base. Extracted from ChatView
 * (P1) so later phases (attachments, @file, slash, stop) plug into one place.
 *
 * Behavior is preserved verbatim from the prior inline implementation:
 * autosizing textarea, Enter-to-send, ⌘K focus, arrow-key prompt history,
 * budget-cap gating. The covering tests live in ChatView.test.tsx.
 */
export function Composer({ workspaceId, workspacePath }: Props) {
  const streaming = useChatStore((s) => s.getStreaming(workspaceId));
  const error = useChatStore((s) => s.getError(workspaceId));
  const messages = useChatStore((s) => s.getMessages(workspaceId));
  const model = useChatStore((s) => s.model);
  const setModel = useChatStore((s) => s.setModel);
  const send = useChatStore((s) => s.send);
  const overrideActive = useBudgetsStore((s) => s.overrideActive);

  const [input, setInputState] = useState("");
  // Ref mirrors input so key handlers always read the latest value without a
  // stale closure (the arrow-history logic depends on this).
  const inputRef = useRef("");
  function setInput(val: string) {
    inputRef.current = val;
    setInputState(val);
  }

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Prompt history — refs so handleKeyDown sees current values without
  // re-creating the handler each render.
  const historyRef = useRef<string[]>([]);
  const historyIdxRef = useRef<number>(-1); // -1 = not navigating

  // Reset per-workspace prompt history when switching workspaces.
  useEffect(() => {
    historyRef.current = [];
    historyIdxRef.current = -1;
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [workspaceId]);

  // ── Inline cost preview ─────────────────────────────────────────────
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

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value;
    setInput(val);
    historyIdxRef.current = -1; // any manual edit exits history navigation
    const ta = e.target;
    ta.style.height = "auto";
    const lineHeight = 20;
    const maxHeight = lineHeight * 8 + 24;
    ta.style.height = `${Math.min(ta.scrollHeight, maxHeight)}px`;
  }

  const handleSend = useCallback(() => {
    const trimmed = inputRef.current.trim();
    if (!trimmed || streaming) return;
    setInput("");
    historyIdxRef.current = -1;
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    // Prepend to history, de-duplicating only consecutive duplicates.
    if (historyRef.current[0] !== trimmed) {
      historyRef.current = [trimmed, ...historyRef.current];
    }
    send(workspaceId, workspacePath, trimmed);
  }, [streaming, send, workspaceId, workspacePath]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const hist = historyRef.current;
    const idx = historyIdxRef.current;

    if (e.key === "ArrowUp" && !e.shiftKey) {
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
      setInput(next < 0 ? "" : hist[next] ?? "");
      return;
    }
    if (e.key === "Escape" && idx >= 0) {
      e.preventDefault();
      setInput("");
      historyIdxRef.current = -1;
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const isBudgetError = error === BUDGET_CAP_MSG;
  const canSend =
    !streaming && input.trim().length > 0 && (!isBudgetError || overrideActive);

  return (
    <div className="px-6 pb-4 pt-3">
      <div
        className={clsx(
          "rounded-lg border bg-octo-onyx transition-colors duration-[180ms]",
          streaming
            ? "border-octo-hairline opacity-60"
            : "border-octo-hairline focus-within:border-[var(--brass-dim)]",
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
          className="w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-[14px] leading-[1.5] text-octo-ivory outline-none placeholder:font-serif placeholder:not-italic placeholder:text-octo-mute"
          style={{ maxHeight: "calc(8 * 1.25rem + 1.5rem)" }}
        />

        {/* Control bar — model on the left, cost + send on the right. */}
        <div className="flex items-center gap-3 px-3 pb-2.5">
          <ModelPicker activeModel={model} onSelectModel={setModel} />

          {inlineCost !== null && (
            <div
              className="octo-tabular ml-auto font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute"
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
            className={clsx(
              "flex h-7 items-center gap-1.5 rounded-md px-3 font-mono text-[10px] uppercase tracking-[0.2em] transition-colors duration-[180ms] disabled:cursor-not-allowed disabled:opacity-40",
              inlineCost === null && "ml-auto",
            )}
            style={{
              color: canSend ? "var(--color-octo-brass)" : "var(--color-octo-mute)",
              background: canSend ? "var(--brass-ghost)" : "transparent",
              border: canSend
                ? "1px solid var(--brass-dim)"
                : "1px solid var(--color-octo-hairline)",
            }}
          >
            <span style={{ fontSize: 12, lineHeight: 1 }} aria-hidden>
              ⟶
            </span>
            Send
          </button>
        </div>
      </div>

      {/* Quiet hint line beneath the box. */}
      <div className="mt-1.5 px-1 font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">
        Enter to send · ⇧↵ for newline · ↑ for history
      </div>
    </div>
  );
}
