import { clsx } from "clsx";
import { Plus, X, Coins } from "lucide-react";
import { useSessionStore } from "../stores/sessionStore";
import type { Session, SessionStatus } from "../lib/types";
import { useTokenStore } from "../stores/tokenStore";
import { useEffect } from "react";
import { OctoMark } from "./icons/OctoMark";

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

const STATUS_LABEL: Record<SessionStatus, string> = {
  active: "Active now",
  idle: "Idle",
  paused: "Paused",
  completed: "Completed",
  error: "Error",
};

export function SessionSidebar({ onNewSession }: Props) {
  const { sessions, activeId, select, remove } = useSessionStore();
  const report = useTokenStore((s) => s.report);
  const refreshTokens = useTokenStore((s) => s.refresh);

  // Keep token data fresh for sidebar cost display.
  useEffect(() => {
    refreshTokens();
    const id = setInterval(refreshTokens, 15_000);
    return () => clearInterval(id);
  }, [refreshTokens]);

  // Build a cost lookup from the global report.
  const costMap = new Map<string, number>();
  report?.costBySession.forEach((e) => costMap.set(e.label, e.costUsd));

  return (
    <aside className="flex h-full w-72 flex-col border-r border-octo-border bg-octo-panel">
      <header className="flex items-center justify-between border-b border-octo-border px-4 py-3">
        <div className="flex items-center gap-2">
          <OctoMark size={18} className="[--octo-eye:var(--color-octo-panel)]" />
          <span className="font-semibold tracking-tight">Octopush</span>
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
              cost={costMap.get(s.name) ?? 0}
              active={s.id === activeId}
              onSelect={() => select(s.id)}
              onRemove={() => remove(s.id)}
            />
          ))
        )}
      </div>

      <footer className="border-t border-octo-border px-4 py-2 text-[10px] uppercase tracking-wider text-zinc-500">
        {sessions.length} session{sessions.length === 1 ? "" : "s"}
        {report && report.totalCostUsd > 0 && (
          <span className="float-right">
            ${report.totalCostUsd.toFixed(2)} total
          </span>
        )}
      </footer>
    </aside>
  );
}

function SessionRow({
  session,
  cost,
  active,
  onSelect,
  onRemove,
}: {
  session: Session;
  cost: number;
  active: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const projectBasename = session.projectRoot.split("/").filter(Boolean).pop() ?? session.projectRoot;
  const budgetPct =
    session.tokenBudget && session.tokenBudget > 0
      ? Math.min(
          ((session.tokensInput + session.tokensOutput) / session.tokenBudget) *
            100,
          100,
        )
      : null;

  return (
    <div
      onClick={onSelect}
      className={clsx(
        "group mb-1 cursor-pointer rounded-lg border px-3 py-2.5 transition",
        active
          ? "border-octo-accent/40 bg-octo-accent/10"
          : "border-transparent hover:border-octo-border hover:bg-zinc-900/40",
      )}
    >
      {/* Row 1: status + icon + name + delete */}
      <div className="flex items-center gap-2">
        <span
          className={clsx(
            "h-2 w-2 shrink-0 rounded-full",
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
          aria-label="Delete session"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-octo-mute opacity-0 transition-colors hover:bg-octo-rouge/15 hover:text-octo-rouge group-hover:opacity-100"
          title="Delete session"
        >
          <X size={14} />
        </button>
      </div>

      {/* Row 2: project • model */}
      <div className="mt-1 flex items-center gap-1.5 pl-4 text-[11px] text-zinc-500">
        <span className="truncate">{projectBasename}</span>
        <span className="text-zinc-700">•</span>
        <span className="truncate">{shortModel(session.agent.model)}</span>
      </div>

      {/* Row 3: cost • tokens */}
      <div className="mt-0.5 flex items-center gap-1.5 pl-4 text-[11px] text-zinc-500">
        <Coins size={10} className="shrink-0 text-zinc-600" />
        <span>${cost.toFixed(2)}</span>
        <span className="text-zinc-700">•</span>
        <span>{formatTokens(session.tokensUsed)} tok</span>
      </div>

      {/* Row 4: tags */}
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

      {/* Row 5: budget gauge (if budget set) */}
      {budgetPct !== null && (
        <div className="mt-1.5 pl-4">
          <div className="flex items-center justify-between text-[9px] text-zinc-600">
            <span>Budget</span>
            <span>{budgetPct.toFixed(0)}% used</span>
          </div>
          <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-zinc-800">
            <div
              className={clsx(
                "h-full rounded-full transition-all",
                budgetPct > 90
                  ? "bg-octo-danger"
                  : budgetPct > 70
                    ? "bg-octo-warning"
                    : "bg-octo-success",
              )}
              style={{ width: `${budgetPct}%` }}
            />
          </div>
        </div>
      )}

      {/* Row 6: status / time ago */}
      <div className="mt-1 pl-4 text-[10px] text-zinc-600">
        {session.status === "active"
          ? STATUS_LABEL.active
          : timeAgo(session.lastActive)}
      </div>
    </div>
  );
}

function EmptyState({ onNewSession }: { onNewSession: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <OctoMark size={40} state="idle" className="[--octo-eye:var(--color-octo-panel)] opacity-80" />
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

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function shortModel(model: string): string {
  return model
    .replace("claude-", "")
    .replace("gpt-", "GPT ")
    .replace(/-\d{8}$/, "");
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "Just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}
