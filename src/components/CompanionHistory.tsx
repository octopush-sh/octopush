import { useMemo, useState } from "react";
import { Plus, X, Pencil, Check, Search } from "lucide-react";

export interface CompanionHistoryChat {
  id: string;
  title: string;
  meta: string;
}

interface Props {
  chats: CompanionHistoryChat[];
  activeChatId: string | null;
  onSelectChat: (id: string) => void;
  onNewChat: () => void;
  onDeleteChat?: (id: string) => void;
  onRenameChat?: (id: string, title: string) => void;
  /** The thread (if any) with an in-flight turn — shows a live pulse dot. */
  streamingChatId?: string | null;
}

export function CompanionHistory({
  chats,
  activeChatId,
  onSelectChat,
  onNewChat,
  onDeleteChat,
  onRenameChat,
  streamingChatId,
}: Props) {
  const [query, setQuery] = useState("");
  // Row-local transient states (one at a time): editing a title / confirming a
  // delete. Keyed by chat id so a re-render keeps the right row in its state.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? chats.filter((c) => c.title.toLowerCase().includes(q)) : chats;
  }, [chats, query]);

  function startRename(c: CompanionHistoryChat) {
    setConfirmingId(null);
    setDraft(c.title);
    setEditingId(c.id);
  }
  function saveRename(id: string) {
    const next = draft.trim();
    setEditingId(null);
    if (next) onRenameChat?.(id, next);
  }

  return (
    <section>
      {/* Eyebrow bar — converges on the CompanionFileTree quality bar. */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-octo-hairline px-4">
        <h3 className="font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass">
          Chats
        </h3>
        <button
          type="button"
          onClick={onNewChat}
          aria-label="New conversation"
          title="New conversation"
          className="flex items-center justify-center rounded p-1 text-octo-mute transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
        >
          <Plus size={12} />
        </button>
      </div>

      {/* Filter — appears once there are enough conversations to need it. */}
      {chats.length > 4 && (
        <div className="flex items-center gap-1.5 border-b border-octo-hairline px-3 py-1.5">
          <Search size={11} className="shrink-0 text-octo-mute" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter conversations"
            aria-label="Filter conversations"
            className="w-full bg-transparent font-mono text-[10px] text-octo-ivory outline-none placeholder:text-octo-mute"
          />
        </div>
      )}

      <ul className="space-y-1 px-2 py-2">
        {chats.length === 0 && (
          <li className="px-2 py-3 text-center">
            <div className="text-[11px] leading-relaxed text-octo-mute">No conversations yet.</div>
            <button
              type="button"
              onClick={onNewChat}
              className="mt-1.5 font-serif text-[12px] text-octo-brass transition-colors hover:text-octo-ivory"
            >
              Begin a new conversation
            </button>
          </li>
        )}
        {chats.length > 0 && filtered.length === 0 && (
          <li className="px-2 py-1 text-[11px] text-octo-mute">No matches.</li>
        )}
        {filtered.map((c) => {
          const active = c.id === activeChatId;
          const editing = c.id === editingId;
          const confirming = c.id === confirmingId;
          const live = !!streamingChatId && c.id === streamingChatId;
          return (
            <li key={c.id}>
              <div
                className={`octo-rise-in group relative flex items-center rounded-md border-l pr-1 transition-colors duration-[220ms] hover:bg-[var(--brass-ghost)] ${
                  active
                    ? "border-l-[color:var(--brass-dim)] bg-[var(--brass-ghost)]"
                    : "border-l-transparent"
                }`}
              >
                {editing ? (
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => saveRename(c.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        saveRename(c.id);
                      }
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    aria-label="Conversation title"
                    className="min-w-0 flex-1 rounded-md bg-transparent px-2 py-1.5 font-serif text-[12px] text-octo-ivory outline-none ring-1 ring-octo-brass"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => onSelectChat(c.id)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
                  >
                    {live && (
                      <span
                        aria-label="Generating"
                        title="Generating…"
                        className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full"
                        style={{ background: "var(--color-octo-brass)" }}
                      />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-serif text-[12px] leading-tight text-octo-ivory">
                        {c.title}
                      </span>
                      <span className="mt-0.5 block font-mono text-[8px] uppercase tracking-[0.15em] text-octo-mute">
                        {c.meta}
                      </span>
                    </span>
                  </button>
                )}

                {/* Row actions — confirm-delete swaps in over the default set. */}
                {!editing && confirming ? (
                  <span className="flex shrink-0 items-center gap-0.5 pr-0.5">
                    <span className="font-mono text-[8px] uppercase tracking-[0.15em] text-octo-rouge">
                      Delete?
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmingId(null);
                        onDeleteChat?.(c.id);
                      }}
                      title="Confirm delete"
                      aria-label="Confirm delete"
                      className="flex items-center justify-center rounded p-1 text-octo-rouge transition hover:bg-octo-rouge/15"
                    >
                      <Check size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingId(null)}
                      title="Cancel"
                      aria-label="Cancel delete"
                      className="flex items-center justify-center rounded p-1 text-octo-mute transition hover:text-octo-sage"
                    >
                      <X size={13} />
                    </button>
                  </span>
                ) : !editing ? (
                  <span className="flex shrink-0 items-center opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                    {onRenameChat && (
                      <button
                        type="button"
                        onClick={() => startRename(c)}
                        title="Rename conversation"
                        aria-label="Rename conversation"
                        className="flex items-center justify-center rounded p-1 text-octo-mute transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
                      >
                        <Pencil size={12} />
                      </button>
                    )}
                    {onDeleteChat && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingId(null);
                          setConfirmingId(c.id);
                        }}
                        title="Delete conversation"
                        aria-label="Delete conversation"
                        className="flex items-center justify-center rounded p-1 text-octo-mute transition hover:bg-octo-rouge/15 hover:text-octo-rouge focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
                      >
                        <X size={14} />
                      </button>
                    )}
                  </span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
