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
import type { ModelInfo, ProviderConfig, SkillMeta } from "../../lib/types";
import {
  findActiveMention,
  rankFiles,
  extractMentions,
  applyMention,
} from "../../lib/mentions";
import { ModelPicker } from "../ModelPicker";
import { EffortSelector } from "./EffortSelector";
import { MentionPopover } from "./MentionPopover";
import { SlashMenu } from "./SlashMenu";
import { CommandHistoryPopover } from "./CommandHistoryPopover";
import { AttachmentTray } from "./AttachmentTray";
import { fileToAttachment } from "../../lib/attachments";
import { parseShellCommand } from "../../lib/shellCommand";
import { FadeSwap } from "../primitives/FadeSwap";
import { X, Paperclip, TerminalSquare } from "lucide-react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";

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
  const runShell = useChatStore((s) => s.runShell);
  const shellCwd = useChatStore((s) => s.getShellCwd(workspaceId));
  const shellCwdAbs = useChatStore((s) => s.getShellCwdAbs(workspaceId));
  const shellHistory = useChatStore((s) => s.getShellHistory(workspaceId));
  const loadShellHistory = useChatStore((s) => s.loadShellHistory);
  const stop = useChatStore((s) => s.stop);
  const activeSkill = useChatStore((s) => s.getActiveSkill(workspaceId));
  const setActiveSkill = useChatStore((s) => s.setActiveSkill);
  const attachments = useChatStore((s) => s.getAttachments(workspaceId));
  const addAttachment = useChatStore((s) => s.addAttachment);
  const removeAttachment = useChatStore((s) => s.removeAttachment);
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

  // ── @file mentions ──────────────────────────────────────────────────
  // Worktree file catalog (loaded once per workspace) + the active mention
  // popover state. filesSetRef gives extractMentions an O(1) membership test.
  const [files, setFiles] = useState<string[]>([]);
  const filesSetRef = useRef<Set<string>>(new Set());
  const [mention, setMention] = useState<{ query: string; start: number; caret: number } | null>(null);
  const [mentionItems, setMentionItems] = useState<string[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);

  // ── /skill slash menu ───────────────────────────────────────────────
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashItems, setSlashItems] = useState<SkillMeta[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);
  useEffect(() => {
    let cancelled = false;
    ipc
      .listSkills(workspacePath)
      .then((s) => !cancelled && setSkills(s))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspacePath]);

  function closeSlash() {
    setSlashOpen(false);
    setSlashItems([]);
    setSlashIndex(0);
  }

  /** A `/` at the very start of the input opens the skill menu, filtered by the
   *  text after it (until the first space). */
  function refreshSlash(value: string) {
    if (value.startsWith("/") && !value.includes(" ") && !value.includes("\n")) {
      const q = value.slice(1).toLowerCase();
      const items = q
        ? skills.filter((s) => s.name.toLowerCase().includes(q))
        : skills;
      setSlashOpen(true);
      setSlashItems(items);
      setSlashIndex(0);
    } else {
      closeSlash();
    }
  }

  function selectSkill(skill: SkillMeta) {
    setActiveSkill(workspaceId, skill.name);
    setInput("");
    closeSlash();
    pendingCaretRef.current = 0;
  }

  // ── `$` command-recall palette ───────────────────────────────────────
  const [cmdHistOpen, setCmdHistOpen] = useState(false);
  const [cmdHistItems, setCmdHistItems] = useState<string[]>([]);
  const [cmdHistIndex, setCmdHistIndex] = useState(0);
  useEffect(() => {
    void loadShellHistory(workspaceId);
  }, [workspaceId, loadShellHistory]);

  function closeCmdHist() {
    setCmdHistOpen(false);
    setCmdHistItems([]);
    setCmdHistIndex(0);
  }

  /** In command mode (`$ …`), surface recent commands filtered by the partial
   *  command typed so far. Empty `$`/`$ ` shows the full recent list. */
  function refreshCmdHist(value: string) {
    const m = /^\$\s*(.*)$/s.exec(value);
    if (!m || m[1].includes("\n")) {
      closeCmdHist();
      return;
    }
    const q = m[1].trim().toLowerCase();
    const items = (q ? shellHistory.filter((c) => c.toLowerCase().includes(q)) : shellHistory)
      // Don't offer the exact thing already typed.
      .filter((c) => c.toLowerCase() !== q)
      .slice(0, 8);
    if (items.length === 0) {
      closeCmdHist();
      return;
    }
    setCmdHistOpen(true);
    setCmdHistItems(items);
    setCmdHistIndex(0);
  }

  function selectCommand(command: string) {
    const next = `$ ${command}`;
    setInput(next);
    closeCmdHist();
    pendingCaretRef.current = next.length;
    textareaRef.current?.focus();
  }
  // Caret to apply after a mention insertion re-renders the textarea.
  const pendingCaretRef = useRef<number | null>(null);
  // Tracks the onBlur dismiss timer so it can be cleared on unmount.
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
  }, []);
  // True while @file mentions are being read+expanded on send — blocks a second
  // send during that async window (streaming only flips once send() runs).
  const expandingRef = useRef(false);
  const [expanding, setExpanding] = useState(false);

  useEffect(() => {
    let cancelled = false;
    ipc
      .listWorkspaceFiles(workspacePath)
      .then((paths) => {
        if (cancelled) return;
        setFiles(paths);
        filesSetRef.current = new Set(paths);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspacePath]);

  function closeMention() {
    setMention(null);
    setMentionItems([]);
    setMentionIndex(0);
  }

  /** Recompute the active mention from the textarea's current value + caret. */
  function refreshMention(value: string, caret: number) {
    const m = findActiveMention(value, caret);
    if (!m) {
      closeMention();
      return;
    }
    const items = rankFiles(files, m.query);
    setMention({ ...m, caret });
    setMentionItems(items);
    setMentionIndex(0);
  }

  function selectMention(path: string) {
    if (!mention) return;
    const { text, caret } = applyMention(inputRef.current, mention.start, mention.caret, path);
    pendingCaretRef.current = caret;
    setInput(text);
    closeMention();
  }

  // After a mention insertion, restore focus + caret to the textarea.
  useEffect(() => {
    if (pendingCaretRef.current == null) return;
    const ta = textareaRef.current;
    const pos = pendingCaretRef.current;
    pendingCaretRef.current = null;
    if (ta) {
      ta.focus();
      ta.setSelectionRange(pos, pos);
    }
  }, [input]);

  // Reset per-workspace prompt history when switching workspaces.
  useEffect(() => {
    historyRef.current = [];
    historyIdxRef.current = -1;
    setInput("");
    closeMention();
    closeSlash();
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // ── Image attachments (paste / drag-drop / file picker) ─────────────
  async function addFiles(files: FileList | File[]) {
    for (const file of Array.from(files)) {
      const att = await fileToAttachment(file);
      if (att) addAttachment(workspaceId, att);
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    // Pasted screenshots live in clipboardData.items (kind 'file'), NOT in
    // .files (which is empty for clipboard images in Chromium/WebKit).
    const imgs = Array.from(e.clipboardData.items)
      .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
      .map((it) => it.getAsFile())
      .filter((f): f is File => f != null);
    if (imgs.length > 0) {
      e.preventDefault();
      void addFiles(imgs);
    }
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    if (e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    void addFiles(e.dataTransfer.files);
  }

  async function pickAttachments() {
    try {
      const selected = await openFileDialog({
        multiple: true,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
      });
      const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
      for (const path of paths) {
        try {
          const att = await ipc.readAttachment(path);
          addAttachment(workspaceId, att);
        } catch {
          // skip unreadable / oversized files
        }
      }
    } catch {
      // dialog cancelled / unavailable
    }
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value;
    setInput(val);
    historyIdxRef.current = -1; // any manual edit exits history navigation
    refreshMention(val, e.target.selectionStart ?? val.length);
    refreshSlash(val);
    refreshCmdHist(val);
    const ta = e.target;
    ta.style.height = "auto";
    const lineHeight = 20;
    const maxHeight = lineHeight * 8 + 24;
    ta.style.height = `${Math.min(ta.scrollHeight, maxHeight)}px`;
  }

  const handleSend = useCallback(() => {
    const trimmed = inputRef.current.trim();
    // Allow an image-only send (attachments, no text).
    const hasAttachments =
      useChatStore.getState().getAttachments(workspaceId).length > 0;
    if ((!trimmed && !hasAttachments) || streaming || expandingRef.current) return;
    setInput("");
    historyIdxRef.current = -1;
    closeMention();
    closeSlash();
    closeCmdHist();
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    // Prepend to history, de-duplicating only consecutive duplicates. History
    // keeps the user's literal text (with @mentions / `$`), not the expansion.
    if (historyRef.current[0] !== trimmed) {
      historyRef.current = [trimmed, ...historyRef.current];
    }

    // `$ <cmd>` / `/run <cmd>` — run directly in the thread's shell, no LLM.
    // Any staged attachments are intentionally left in the tray (a shell
    // command doesn't consume images): they stay visible and ride the user's
    // next actual chat message instead of being dropped here.
    const shellCmd = parseShellCommand(trimmed);
    if (shellCmd) {
      void runShell(workspaceId, workspacePath, shellCmd);
      return;
    }

    // `\$…` escape hatch: a leading backslash sends the literal `$…` text to
    // the agent instead of running it.
    const outgoing = trimmed.startsWith("\\$") ? trimmed.slice(1) : trimmed;

    // Expand any @file mentions into fenced context blocks appended to the
    // message, so the model receives the referenced files' contents. The chat
    // shows exactly what was sent (transparent). Files are read with a byte cap.
    const mentions = extractMentions(outgoing, filesSetRef.current);
    if (mentions.length === 0) {
      send(workspaceId, workspacePath, outgoing);
      return;
    }
    expandingRef.current = true;
    setExpanding(true);
    void (async () => {
      try {
        const blocks = await Promise.all(
          mentions.map(async (rel) => {
            try {
              const res = await ipc.readFileChecked(`${workspacePath}/${rel}`, 64_000);
              if (res.kind === "text") {
                return `\n\n§ ${rel}\n\`\`\`\n${res.content}\n\`\`\``;
              }
              return `\n\n§ ${rel} _(not included: ${res.kind})_`;
            } catch {
              return "";
            }
          }),
        );
        send(workspaceId, workspacePath, outgoing + blocks.join(""));
      } finally {
        expandingRef.current = false;
        setExpanding(false);
      }
    })();
  }, [streaming, send, runShell, workspaceId, workspacePath]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // ── `$` command-recall palette takes precedence while open ──
    if (cmdHistOpen && cmdHistItems.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setCmdHistIndex((i) => (i + 1) % cmdHistItems.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setCmdHistIndex((i) => (i - 1 + cmdHistItems.length) % cmdHistItems.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        selectCommand(cmdHistItems[cmdHistIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeCmdHist();
        return;
      }
    }

    // ── Slash (skill) menu takes precedence while open ──
    if (slashOpen && slashItems.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % slashItems.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + slashItems.length) % slashItems.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        selectSkill(slashItems[slashIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeSlash();
        return;
      }
    }

    // ── Mention popover takes precedence over history/send while open ──
    if (mention && mentionItems.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionItems.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((i) => (i - 1 + mentionItems.length) % mentionItems.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        selectMention(mentionItems[mentionIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        closeMention();
        return;
      }
    }

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
    !streaming &&
    !expanding &&
    (input.trim().length > 0 || attachments.length > 0) &&
    (!isBudgetError || overrideActive);

  // The TALK shell's cwd badge — shown once the user has `cd`'d away from the
  // workspace root. The label is computed once in the backend (single source);
  // here we just render it (empty string ⇒ at root ⇒ no badge).
  const cwdLabel = shellCwd || null;

  return (
    <div className="px-6 pb-4 pt-3">
      <div
        onDrop={handleDrop}
        onDragOver={(e) => e.preventDefault()}
        className={clsx(
          "relative rounded-lg border bg-octo-onyx transition-colors duration-[180ms]",
          streaming
            ? "border-octo-hairline opacity-60"
            : "border-octo-hairline focus-within:border-[var(--brass-dim)]",
        )}
      >
        <AttachmentTray
          attachments={attachments}
          onRemove={(i) => removeAttachment(workspaceId, i)}
        />
        {mention && (
          <MentionPopover
            items={mentionItems}
            activeIndex={mentionIndex}
            onSelect={selectMention}
            onHover={setMentionIndex}
          />
        )}
        {slashOpen && (
          <SlashMenu
            items={slashItems}
            activeIndex={slashIndex}
            onSelect={selectSkill}
            onHover={setSlashIndex}
          />
        )}
        {cmdHistOpen && (
          <CommandHistoryPopover
            items={cmdHistItems}
            activeIndex={cmdHistIndex}
            onSelect={selectCommand}
            onHover={setCmdHistIndex}
          />
        )}
        {/* Active skill chip — the turn runs under this skill until cleared. */}
        {activeSkill && (
          <div className="flex items-center gap-1.5 px-4 pt-2.5">
            <span
              className="flex items-center gap-1.5 rounded-md px-2 py-0.5 font-mono text-[10px] text-octo-brass"
              style={{ background: "var(--brass-ghost)", border: "1px solid var(--brass-dim)" }}
            >
              <span className="font-serif" aria-hidden>§</span>
              {activeSkill}
              <button
                type="button"
                onClick={() => setActiveSkill(workspaceId, null)}
                aria-label="Clear active skill"
                title="Clear active skill"
                className="flex items-center text-octo-mute transition-colors hover:text-octo-rouge"
              >
                <X size={11} />
              </button>
            </span>
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          // Recompute the mention on every caret move (click, ArrowLeft/Right,
          // Home/End) — not just on typing — so the popover closes when the
          // caret leaves the trigger and mention.caret never goes stale.
          onSelect={(e) =>
            refreshMention(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)
          }
          onBlur={() => {
            // Let a popover mouse-down selection land first (it preventDefaults
            // blur), then dismiss on a genuine focus loss. Tracked so it can be
            // cleared on unmount.
            if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
            blurTimerRef.current = setTimeout(() => {
              closeMention();
              closeCmdHist();
            }, 120);
          }}
          disabled={streaming}
          placeholder="Ask anything…   @ file · / skill · $ run a command"
          rows={1}
          className="w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-[14px] leading-[1.5] text-octo-ivory outline-none placeholder:font-serif placeholder:not-italic placeholder:text-octo-mute"
          style={{ maxHeight: "calc(8 * 1.25rem + 1.5rem)" }}
        />

        {/* Control bar — model + effort on the left, cost + send/stop on the right. */}
        <div className="flex items-center gap-3 px-3 pb-2.5">
          <ModelPicker activeModel={model} onSelectModel={setModel} />
          <EffortSelector />
          <button
            type="button"
            onClick={pickAttachments}
            title="Attach an image"
            aria-label="Attach an image"
            className="flex items-center text-octo-mute transition-colors hover:text-octo-brass"
          >
            <Paperclip size={14} />
          </button>

          {cwdLabel && (
            <span
              className="flex items-center gap-1 font-mono text-[10px] text-octo-sage"
              title={`TALK shell working directory: ${shellCwdAbs || shellCwd}`}
            >
              <TerminalSquare size={11} className="text-octo-brass" />
              {cwdLabel}
            </span>
          )}

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

          {/* Send while idle, Stop while streaming — crossfades in one slot so
              the bar never shifts (stability S2). */}
          <FadeSwap swapKey={streaming ? "stop" : "send"} className={clsx(inlineCost === null && "ml-auto")}>
            {streaming ? (
              <ComposerActionButton
                onClick={() => stop(workspaceId)}
                title="Stop generating"
                label="Stop"
                glyph="◼"
                color="var(--color-octo-rouge)"
                bg="var(--rouge-ghost)"
                border="1px solid var(--rouge-border)"
              />
            ) : (
              <ComposerActionButton
                onClick={handleSend}
                disabled={!canSend}
                title="Send (Enter)"
                label="Send"
                glyph="⟶"
                color={canSend ? "var(--color-octo-brass)" : "var(--color-octo-mute)"}
                bg={canSend ? "var(--brass-ghost)" : "transparent"}
                border={canSend ? "1px solid var(--brass-dim)" : "1px solid var(--color-octo-hairline)"}
              />
            )}
          </FadeSwap>
        </div>
      </div>

      {/* Quiet hint line beneath the box. */}
      <div className="mt-1.5 px-1 font-mono text-[9px] uppercase tracking-[0.2em] text-octo-mute">
        Enter to send · ⇧↵ for newline · ↑ for history
      </div>
    </div>
  );
}

/** The composer's primary action button — Send (brass) or Stop (rouge). One
 *  shape, parameterized by accent tokens, so the two states can't drift. All
 *  colors are CSS-var tokens; no hardcoded literals. */
function ComposerActionButton({
  onClick,
  disabled = false,
  title,
  label,
  glyph,
  color,
  bg,
  border,
}: {
  onClick: () => void;
  disabled?: boolean;
  title: string;
  label: string;
  glyph: string;
  color: string;
  bg: string;
  border: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className="flex h-7 items-center gap-1.5 rounded-md px-3 font-mono text-[10px] uppercase tracking-[0.2em] transition-colors duration-[180ms] disabled:cursor-not-allowed disabled:opacity-40"
      style={{ color, background: bg, border }}
    >
      <span style={{ fontSize: 12, lineHeight: 1 }} aria-hidden>
        {glyph}
      </span>
      {label}
    </button>
  );
}
