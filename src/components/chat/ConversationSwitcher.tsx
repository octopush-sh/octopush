import { useMemo, useRef, useState } from "react";
import { MessageSquare, Pin, Plus } from "lucide-react";
import type { CompanionHistoryChat } from "../CompanionHistory";
import { SwitcherFrame, switcherRowClass } from "../run/SwitcherFrame";
import { tourId } from "../../lib/tour/ids";

interface Props {
  /** The workspace's conversations, in the Companion's order. */
  chats: CompanionHistoryChat[];
  activeChatId: string | null;
  /** The conversations with a turn running. */
  streamingChatIds?: readonly string[];
  onSelect: (id: string) => void;
  onNew: () => void;
  onClose: () => void;
}

/** The conversations whose title holds `query` (case-insensitive). Pure. */
export function filterChats(chats: CompanionHistoryChat[], query: string): CompanionHistoryChat[] {
  const q = query.trim().toLowerCase();
  return q ? chats.filter((c) => c.title.toLowerCase().includes(q)) : chats;
}

/**
 * ⌘⌥K in Talk — the conversation switcher. Run's session switcher in Talk's
 * terms (one frame, `SwitcherFrame`): filter by title, ↑↓ to move, ⏎ to
 * switch, ⌘⏎ for a new conversation from anywhere in it; the last row also
 * starts one.
 */
export function ConversationSwitcher({ chats, activeChatId, streamingChatIds, onSelect, onNew, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => filterChats(chats, query), [chats, query]);
  // The "new conversation" row sits one past the matches.
  const maxSel = matches.length;
  const selected = Math.max(0, Math.min(sel, maxSel));

  const choose = (index: number) => {
    const row = matches[index];
    if (row) {
      if (row.id !== activeChatId) onSelect(row.id);
    } else onNew();
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(maxSel, s + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (!e.repeat) choose(maxSel);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (!e.repeat) choose(selected);
    }
  };

  return (
    <SwitcherFrame
      onClose={onClose}
      ariaLabel="Switch conversation"
      glyph="⌘⌥K"
      inputRef={inputRef}
      query={query}
      onQuery={(value) => {
        setQuery(value);
        setSel(0);
      }}
      onKeyDown={onKeyDown}
      placeholder="Find a conversation…"
      inputLabel="Find a conversation"
      inputTestId="conversation-switcher-input"
      inputTour={tourId("talk-switcher-input")}
      listLabel="Conversations"
      hints={
        <>
          <span>↑↓ · Move</span>
          <span>⏎ · Switch</span>
          <span>⌘⏎ · New</span>
        </>
      }
    >
      {matches.length === 0 && query.trim() !== "" && (
        <div className="px-4 py-6 text-center font-serif text-[13px] text-octo-mute">
          No conversation matches that.
        </div>
      )}

      {matches.map((c, i) => {
        const live = !!streamingChatIds?.includes(c.id);
        return (
          <button
            key={c.id}
            type="button"
            role="option"
            data-testid={`conversation-switcher-row-${c.id}`}
            data-tour={i === 0 ? tourId("talk-switcher-row") : undefined}
            aria-selected={i === selected}
            title={c.title}
            onMouseEnter={() => setSel(i)}
            onClick={() => choose(i)}
            className={switcherRowClass(i === selected)}
          >
            <span className="flex w-4 shrink-0 justify-center">
              {c.pinned ? (
                <Pin size={11} strokeWidth={1.75} aria-label="Pinned" className="text-octo-brass" />
              ) : (
                <MessageSquare size={12} strokeWidth={1.75} aria-hidden className="text-octo-mute" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-serif text-[13px] text-octo-ivory">{c.title}</span>
                {c.id === activeChatId && (
                  <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.18em] text-octo-brass">
                    here
                  </span>
                )}
              </span>
              <span className="mt-0.5 flex min-w-0 items-center gap-1.5 font-mono text-[10px] text-octo-mute">
                {live && (
                  <>
                    <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-octo-brass" />
                    <span className="shrink-0">running ·</span>
                  </>
                )}
                <span className="min-w-0 truncate">{c.meta}</span>
              </span>
            </span>
          </button>
        );
      })}

      <button
        type="button"
        role="option"
        data-testid="conversation-switcher-new"
        aria-selected={selected === maxSel}
        title="Start a new conversation (⌘⏎)"
        onMouseEnter={() => setSel(maxSel)}
        onClick={() => choose(maxSel)}
        className={switcherRowClass(selected === maxSel, matches.length > 0 ? "border-t border-t-octo-hairline" : "")}
      >
        <span className="flex w-4 shrink-0 justify-center text-octo-mute">
          <Plus size={12} strokeWidth={1.75} aria-hidden />
        </span>
        <span className="font-serif text-[13px] text-octo-brass">Begin a new conversation</span>
      </button>
    </SwitcherFrame>
  );
}
