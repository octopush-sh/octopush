import { clsx } from "clsx";
import { Plus, X } from "lucide-react";
import { useSessionStore } from "../stores/sessionStore";
import type { Session, SessionStatus } from "../lib/types";

interface Props {
  onNewSession: () => void;
}

const STATUS_DOT: Record<SessionStatus, string> = {
  active: "bg-octo-success",
  idle: "bg-zinc-500",
  paused: "bg-octo-warning",
  completed: "bg-zinc-600",
  error: "bg-octo-danger",
};

export function SessionSidebar({ onNewSession }: Props) {
  const { sessions, activeId, select, remove } = useSessionStore();

  return (
    <aside className="flex h-full w-72 flex-col border-r border-octo-border bg-octo-panel">
      <header className="flex items-center justify-between border-b border-octo-border px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-lg">🐙</span>
          <span className="font-semibold tracking-tight">Octopus sh</span>
        </div>
        <button
          onClick={onNewSession}
          className="rounded-md p-1.5 text-zinc-400 transition hover:bg-zinc-800 hover:text-octo-accent"
          title="New session (⌘T)"
        >
          <Plus size={16} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {sessions.length === 0 ? (
          <EmptyState onNewSession={onNewSession} />
        ) : (
          sessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              active={s.id === activeId}
              onSelect={() => select(s.id)}
              onRemove={() => remove(s.id)}
            />
          ))
        )}
      </div>

      <footer className="border-t border-octo-border px-4 py-2 text-[10px] uppercase tracking-wider text-zinc-500">
        {sessions.length} session{sessions.length === 1 ? "" : "s"}
      </footer>
    </aside>
  );
}

function SessionRow({
  session,
  active,
  onSelect,
  onRemove,
}: {
  session: Session;
  active: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      onClick={onSelect}
      className={clsx(
        "group mb-1 cursor-pointer rounded-lg border px-3 py-2 transition",
        active
          ? "border-octo-accent/40 bg-octo-accent/10"
          : "border-transparent hover:border-octo-border hover:bg-zinc-900/40",
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={clsx(
            "h-2 w-2 rounded-full",
            STATUS_DOT[session.status],
          )}
        />
        <span className="text-sm">{session.icon}</span>
        <span className="flex-1 truncate text-sm font-medium">
          {session.name}
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="opacity-0 transition hover:text-octo-danger group-hover:opacity-100"
          title="Delete session"
        >
          <X size={14} />
        </button>
      </div>
      <div className="mt-1 flex items-center gap-2 pl-4 text-[11px] text-zinc-500">
        <span className="truncate">{session.agent.model}</span>
        <span className="text-zinc-700">•</span>
        <span>{(session.tokensUsed / 1000).toFixed(1)}K tok</span>
      </div>
      {session.tags.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1 pl-4">
          {session.tags.map((t) => (
            <span
              key={t}
              className="rounded-sm bg-zinc-800/80 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-zinc-400"
            >
              {t}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyState({ onNewSession }: { onNewSession: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="text-4xl">🐙</div>
      <div className="text-sm text-zinc-400">No sessions yet</div>
      <button
        onClick={onNewSession}
        className="rounded-md border border-octo-accent/40 bg-octo-accent/10 px-3 py-1.5 text-xs font-medium text-octo-accent transition hover:bg-octo-accent/20"
      >
        + New session
      </button>
    </div>
  );
}
