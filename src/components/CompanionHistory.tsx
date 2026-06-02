import { Plus, X } from "lucide-react";

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
}

export function CompanionHistory({ chats, activeChatId, onSelectChat, onNewChat, onDeleteChat }: Props) {
  return (
    <section>
      <div className="flex items-center justify-between border-b border-octo-hairline pb-2">
        <h3 className="font-mono text-[8px] uppercase tracking-[0.3em] text-octo-brass">
          History
        </h3>
        <button
          type="button"
          onClick={onNewChat}
          aria-label="New chat"
          title="New chat"
          className="flex items-center justify-center rounded p-1 text-octo-mute transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass"
        >
          <Plus size={16} />
        </button>
      </div>
      <ul className="mt-2 space-y-1">
        {chats.length === 0 && (
          <li className="px-2 py-1 text-[11px] text-octo-mute">No previous chats.</li>
        )}
        {chats.map((c) => {
          const active = c.id === activeChatId;
          const deletable = !!onDeleteChat;
          return (
            <li key={c.id} className="group relative">
              <button
                type="button"
                onClick={() => onSelectChat(c.id)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition"
                style={
                  active
                    ? { borderLeft: "1px solid var(--brass-dim)", background: "var(--brass-ghost)" }
                    : undefined
                }
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-serif text-[12px] leading-tight text-octo-ivory">
                    {c.title}
                  </div>
                  <div className="mt-0.5 font-mono text-[8px] uppercase tracking-[0.15em] text-octo-mute">
                    {c.meta}
                  </div>
                </div>
                {deletable && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteChat?.(c.id);
                    }}
                    title="Delete conversation"
                    aria-label="Delete conversation"
                    className="flex flex-shrink-0 items-center justify-center rounded p-1 text-octo-mute opacity-0 transition hover:bg-octo-rouge/15 hover:text-octo-rouge group-hover:opacity-100"
                  >
                    <X size={14} />
                  </button>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
