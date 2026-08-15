import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { ModalShell } from "../ModalShell";
import { useTerminalsStore } from "../../stores/terminalsStore";
import { iconForSessionRole } from "../../lib/roleIcons";
import { ROLE_WORD } from "../../lib/sessionRole";

interface Props {
  workspaceId: string;
  onClose: () => void;
}

/**
 * ⌘⌥K — the session switcher.
 *
 * The rail answers "which sessions are there" at a glance; this answers "which
 * one do I want" when four icons aren't enough. It is the CommandPalette
 * pattern scoped to terminals: search across label, role and running command,
 * arrow to move, ⏎ to switch, ⌫ to close a session, and a last row that opens
 * a new one — so the palette can also *create* rather than only navigate.
 *
 * Design record: docs/superpowers/plans/2026-08-15-run-terminal-navigation-design.md
 */
export function SessionSwitcher({ workspaceId, onClose }: Props) {
  const terminals = useTerminalsStore((s) => s.getTerminals(workspaceId));
  const activeId = useTerminalsStore((s) => s.getActiveId(workspaceId));
  const setActive = useTerminalsStore((s) => s.setActive);
  const createTerminal = useTerminalsStore((s) => s.createTerminal);
  const deleteTerminal = useTerminalsStore((s) => s.deleteTerminal);

  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = terminals.map((t, i) => ({ t, index: i }));
    if (!q) return rows;
    return rows.filter(({ t }) =>
      `${t.label} ${ROLE_WORD[t.role]} ${t.command ?? ""}`.toLowerCase().includes(q),
    );
  }, [terminals, query]);

  // The "open a new session" row sits one past the matches, so the selection
  // range is [0, matches.length].
  const maxSel = matches.length;
  const selected = Math.min(sel, maxSel);

  const choose = (index: number) => {
    if (index === maxSel) {
      createTerminal(workspaceId).catch(console.error);
      onClose();
      return;
    }
    const row = matches[index];
    if (!row) return;
    setActive(workspaceId, row.t.id);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(maxSel, s + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(selected);
    } else if (e.key === "Backspace" && query === "") {
      // Only with an empty query — otherwise Backspace is still editing text.
      const row = matches[selected];
      if (!row) return;
      e.preventDefault();
      void deleteTerminal(workspaceId, row.t.id);
      setSel(0);
    }
  };

  return (
    <ModalShell onClose={onClose} align="top" topOffset="pt-[16vh]" ariaLabel="Switch session">
      <div className="w-[470px] max-w-[92vw] overflow-hidden rounded-xl border border-octo-hairline bg-octo-panel">
        <div className="flex items-center gap-3 border-b border-octo-hairline px-4 py-3">
          <span className="font-mono text-[10px] tracking-[0.1em] text-octo-brass">⌘⌥K</span>
          <input
            autoFocus
            data-testid="session-switcher-input"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSel(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Find a session…"
            aria-label="Find a session"
            className="flex-1 bg-transparent font-serif text-[14px] text-octo-ivory outline-none placeholder:font-serif placeholder:text-octo-mute"
          />
        </div>

        <div className="max-h-[52vh] overflow-y-auto py-1">
          {matches.length === 0 && query.trim() !== "" && (
            <div className="px-4 py-6 text-center font-serif text-[13px] text-octo-mute">
              No session matches that.
            </div>
          )}

          {matches.map((row, i) => {
            const { t, index } = row;
            const Icon = iconForSessionRole(t.role);
            const state = t.busy ? (t.command ?? "running") : ROLE_WORD[t.role];
            return (
              <button
                key={t.id}
                type="button"
                data-testid={`session-switcher-row-${t.id}`}
                aria-selected={i === selected}
                onMouseEnter={() => setSel(i)}
                onClick={() => choose(i)}
                className={`flex w-full items-center gap-3 border-l-2 px-4 py-2 text-left transition-colors duration-[180ms] ${
                  i === selected
                    ? "border-octo-brass bg-[var(--brass-ghost)]"
                    : "border-transparent hover:bg-octo-panel-2"
                }`}
              >
                <span className="octo-tabular w-4 shrink-0 font-mono text-[10px] text-octo-mute">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <Icon
                      size={13}
                      strokeWidth={1.75}
                      aria-hidden
                      className={t.busy ? "text-octo-brass" : "text-octo-verdigris"}
                    />
                    <span className="min-w-0 flex-1 truncate font-serif text-[13px] text-octo-ivory">
                      {t.label}
                    </span>
                    {t.id === activeId && (
                      <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.18em] text-octo-brass">
                        here
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate font-mono text-[10px] text-octo-mute">
                    {state}
                  </span>
                </span>
              </button>
            );
          })}

          <button
            type="button"
            data-testid="session-switcher-new"
            aria-selected={selected === maxSel}
            onMouseEnter={() => setSel(maxSel)}
            onClick={() => choose(maxSel)}
            className={`flex w-full items-center gap-3 border-l-2 border-t border-t-octo-hairline px-4 py-2 text-left transition-colors duration-[180ms] ${
              selected === maxSel
                ? "border-l-octo-brass bg-[var(--brass-ghost)]"
                : "border-l-transparent hover:bg-octo-panel-2"
            }`}
          >
            <span className="flex w-4 shrink-0 justify-center text-octo-mute">
              <Plus size={12} strokeWidth={1.75} aria-hidden />
            </span>
            <span className="font-serif text-[13px] text-octo-brass">Open a new session</span>
          </button>
        </div>

        <div className="flex gap-4 border-t border-octo-hairline px-4 py-2 font-mono text-[9px] tracking-[0.1em] text-octo-mute">
          <span>↑↓ move</span>
          <span>⏎ switch</span>
          <span>⌫ close session</span>
          <span>esc dismiss</span>
        </div>
      </div>
    </ModalShell>
  );
}
