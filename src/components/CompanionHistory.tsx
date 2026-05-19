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
}

export function CompanionHistory({ chats, activeChatId, onSelectChat, onNewChat }: Props) {
  return (
    <section>
      <div className="flex items-center justify-between border-b border-octo-hairline pb-2">
        <h3 className="font-mono text-[8px] uppercase tracking-[0.3em] text-octo-brass">
          History
        </h3>
        <button
          type="button"
          onClick={onNewChat}
          className="font-mono text-[10px] text-octo-mute transition hover:text-octo-brass"
          title="New chat"
        >
          +
        </button>
      </div>
      <ul className="mt-2 space-y-1">
        {chats.length === 0 && (
          <li className="px-2 py-1 text-[11px] text-octo-mute">No previous chats.</li>
        )}
        {chats.map((c) => {
          const active = c.id === activeChatId;
          return (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onSelectChat(c.id)}
                className="w-full rounded-md px-2 py-1.5 text-left transition"
                style={
                  active
                    ? { borderLeft: "1px solid var(--brass-dim)", background: "var(--brass-ghost)" }
                    : undefined
                }
              >
                <div className="font-serif text-[12px] leading-tight text-octo-ivory">
                  {c.title}
                </div>
                <div className="mt-0.5 font-mono text-[8px] uppercase tracking-[0.15em] text-octo-mute">
                  {c.meta}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
