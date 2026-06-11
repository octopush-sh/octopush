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
      {/* Body inset matches CompanionFileTree's (px-2 py-2) — the bar above
          stays full-bleed. */}
      <ul className="space-y-1 px-2 py-2">
        {chats.length === 0 && (
          <li className="px-2 py-1 text-[11px] text-octo-mute">No active chats.</li>
        )}
        {chats.map((c) => {
          const active = c.id === activeChatId;
          const deletable = !!onDeleteChat;
          return (
            <li key={c.id}>
              {/* Row: outer div so the select and delete buttons are valid
                  siblings (no button-in-button nesting). The border-l slot is
                  always reserved — transparent when inactive — so selection
                  never shifts layout by 1px. */}
              <div
                className={`octo-rise-in group relative flex items-center rounded-md border-l pr-1 transition-colors duration-[220ms] hover:bg-[var(--brass-ghost)] ${
                  active
                    ? "border-l-[color:var(--brass-dim)] bg-[var(--brass-ghost)]"
                    : "border-l-transparent"
                }`}
              >
                <button
                  type="button"
                  onClick={() => onSelectChat(c.id)}
                  className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
                >
                  <div className="truncate font-serif text-[12px] leading-tight text-octo-ivory">
                    {c.title}
                  </div>
                  <div className="mt-0.5 font-mono text-[8px] uppercase tracking-[0.15em] text-octo-mute">
                    {c.meta}
                  </div>
                </button>
                {deletable && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteChat?.(c.id);
                    }}
                    title="Delete conversation"
                    aria-label="Delete conversation"
                    className="flex flex-shrink-0 items-center justify-center rounded p-1 text-octo-mute opacity-0 transition hover:bg-octo-rouge/15 hover:text-octo-rouge focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass group-hover:opacity-100"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
