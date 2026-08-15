import { useCallback, useRef, useState } from "react";
import { Pencil, X } from "lucide-react";
import { useTerminalsStore } from "../stores/terminalsStore";
import { iconForSessionRole } from "../lib/roleIcons";
import { ROLE_WORD } from "../lib/sessionRole";

interface Props {
  workspaceId: string;
}

/**
 * Run mode's Companion panel: the active session's detail.
 *
 * Navigation between sessions moved to the canvas rail (and ⌘⌥K), which is
 * what frees this panel to answer the questions a 44px cell cannot — what the
 * session is doing, where it is rooted, how to jump back to it — while keeping
 * every capability the old Terminals list had (rename, close, the restored
 * badge). Collapsing the Companion now costs detail, not the way back.
 *
 * Design record: docs/superpowers/plans/2026-08-15-run-terminal-navigation-design.md
 */
export function CompanionSession({ workspaceId }: Props) {
  const terminals = useTerminalsStore((s) => s.getTerminals(workspaceId));
  const activeId = useTerminalsStore((s) => s.getActiveId(workspaceId));
  const renameTerminal = useTerminalsStore((s) => s.renameTerminal);
  const deleteTerminal = useTerminalsStore((s) => s.deleteTerminal);

  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const session = terminals.find((t) => t.id === activeId) ?? null;

  const startEdit = useCallback((label: string) => {
    setEditValue(label);
    setEditing(true);
    requestAnimationFrame(() => inputRef.current?.select());
  }, []);

  const commitEdit = useCallback(() => {
    if (!session) return;
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== session.label) {
      renameTerminal(workspaceId, session.id, trimmed).catch(console.error);
    }
    setEditing(false);
  }, [editValue, renameTerminal, session, workspaceId]);

  return (
    <section>
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-octo-hairline px-4">
        <h3 className="font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass">Session</h3>

      </div>

      {!session ? (
        <p className="px-4 py-3 font-serif text-[12px] text-octo-mute">No sessions open.</p>
      ) : (
        <div className="flex flex-col gap-3 px-4 py-3">
          {/* Identity — the same role icon the rail and the switcher use. */}
          <div className="flex items-center gap-2">
            {/* No `title` here: the Doing row below prints the same phrase,
                and the doctrine says a state shown by a glyph isn't also
                labelled twice. */}
            <span className="flex shrink-0">
              {(() => {
                const Icon = iconForSessionRole(session.role);
                return (
                  <Icon
                    size={15}
                    strokeWidth={1.75}
                    aria-hidden
                    className={session.busy ? "text-octo-brass" : "text-octo-verdigris"}
                  />
                );
              })()}
            </span>
            {editing ? (
              <input
                ref={inputRef}
                data-testid="session-detail-rename"
                className="min-w-0 flex-1 rounded bg-transparent font-serif text-[14px] text-octo-ivory outline outline-1 outline-octo-brass"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={commitEdit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitEdit();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setEditing(false);
                  }
                }}
                autoFocus
              />
            ) : (
              <span
                data-testid="session-detail-label"
                className="min-w-0 flex-1 truncate font-serif text-[14px] text-octo-ivory"
                onDoubleClick={() => startEdit(session.label)}
              >
                {session.label}
              </span>
            )}
            {session.restored && (
              <span
                data-testid="session-detail-restored"
                className="octo-pop-in shrink-0 font-mono text-[9px] uppercase tracking-[0.25em]"
                style={{ color: "var(--brass-dim)" }}
                title="Session restored from a previous Octopush run"
              >
                ↺ Restored
              </span>
            )}
          </div>

          <dl className="grid grid-cols-[58px_minmax(0,1fr)] gap-x-3 gap-y-1 font-mono text-[10px]">
            <dt className="uppercase tracking-[0.12em] text-octo-mute">Doing</dt>
            <dd className="m-0 truncate text-octo-sage" title={ROLE_WORD[session.role]}>
              {ROLE_WORD[session.role]}
            </dd>

            <dt className="uppercase tracking-[0.12em] text-octo-mute">State</dt>
            <dd
              className={`m-0 truncate ${session.busy ? "text-octo-brass" : session.running ? "text-octo-verdigris" : "text-octo-mute"}`}
            >
              {session.busy ? "running" : session.running ? "shell idle" : "stopped"}
            </dd>

            <dt className="uppercase tracking-[0.12em] text-octo-mute">Command</dt>
            <dd className="m-0 truncate text-octo-sage" title={session.command ?? undefined}>
              {session.command ?? "—"}
            </dd>

            <dt className="uppercase tracking-[0.12em] text-octo-mute">Jump</dt>
            <dd className="m-0 truncate text-octo-sage">
              {terminals.findIndex((t) => t.id === session.id) < 9
                ? `⌘⌥${terminals.findIndex((t) => t.id === session.id) + 1}`
                : "⌘⌥K"}
            </dd>
          </dl>

          <div className="flex items-center gap-2 border-t border-octo-hairline pt-3">
            <button
              type="button"
              onClick={() => startEdit(session.label)}
              title="Rename session"
              aria-label="Rename session"
              className="flex items-center justify-center rounded p-1 text-octo-mute transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
            >
              <Pencil size={12} strokeWidth={1.75} aria-hidden />
            </button>
            <button
              type="button"
              data-testid="session-detail-close"
              onClick={() => void deleteTerminal(workspaceId, session.id)}
              title="Close session"
              aria-label="Close session"
              className="flex items-center justify-center rounded p-1 text-octo-mute transition hover:bg-octo-rouge/15 hover:text-octo-rouge focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
            >
              <X size={12} strokeWidth={1.75} aria-hidden />
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
