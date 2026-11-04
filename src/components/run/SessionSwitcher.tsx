import { useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { ModalShell } from "../ModalShell";
import { RUN_PANES, useTerminalsStore } from "../../stores/terminalsStore";
import { besideReplaces, useTerminalLayoutStore } from "../../stores/terminalLayoutStore";
import { iconForSessionRole } from "../../lib/roleIcons";
import { ROLE_WORD } from "../../lib/sessionRole";
import { tourId } from "../../lib/tour/ids";

interface Props {
  workspaceId: string;
  onClose: () => void;
  /** Pairing mode (Open beside): lists only the sessions not on screen and
   *  puts the pick beside the panes instead of switching the focused one. */
  pairing?: boolean;
}

/**
 * ⌘⌥K — the session switcher.
 *
 * The rail answers "which sessions are there" at a glance; this answers "which
 * one do I want" when four icons aren't enough. It is the CommandPalette
 * pattern scoped to terminals: search across label, role and running command,
 * arrow to move, ⏎ to switch, ⌫ to close a session, and a last row that opens
 * a new one — so the palette can also *create* rather than only navigate.
 * ⌥⏎ opens the selected session beside instead of switching to it.
 *
 * In pairing mode (⌘D, Open beside) it leaves out the sessions already on
 * screen, and a pick goes beside the panes — or, with no room left, replaces
 * the focused pane's session, which its header line says.
 *
 * Design records: docs/superpowers/plans/2026-08-15-run-terminal-navigation-design.md,
 * docs/superpowers/specs/2026-11-03-run-session-pair-design.md
 */
export function SessionSwitcher({ workspaceId, onClose, pairing = false }: Props) {
  const allTerminals = useTerminalsStore((s) => s.getTerminals(workspaceId));
  const activeId = useTerminalsStore((s) => s.getActiveId(workspaceId));
  const setActive = useTerminalsStore((s) => s.setActive);
  const createTerminal = useTerminalsStore((s) => s.createTerminal);
  const createBeside = useTerminalsStore((s) => s.createBeside);
  const openBeside = useTerminalsStore((s) => s.openBeside);
  const deleteTerminal = useTerminalsStore((s) => s.deleteTerminal);
  const layout = useTerminalLayoutStore((s) => s.runByWs[workspaceId]);
  const replaces = pairing && !!layout && besideReplaces(layout, RUN_PANES);
  const terminals = useMemo(
    () =>
      pairing
        ? allTerminals.filter((t) => !(layout?.slots ?? [activeId]).includes(t.id))
        : allTerminals,
    [allTerminals, pairing, layout, activeId],
  );

  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  // Ids whose delete is in flight. `deleteTerminal` awaits IPC before the list
  // updates, so two fast ⌫ presses would fire the same delete twice and the
  // loser would raise a "couldn't close terminal" toast for a session that
  // closed perfectly well.
  const deleting = useRef(new Set<string>());

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    // The number is the session's rail address (⌘⌥N), also when pairing
    // leaves some sessions out.
    const rows = terminals.map((t) => ({ t, index: allTerminals.indexOf(t) }));
    if (!q) return rows;
    return rows.filter(({ t }) =>
      `${t.label} ${ROLE_WORD[t.role]} ${t.command ?? ""}`.toLowerCase().includes(q),
    );
  }, [terminals, allTerminals, query]);

  // The "open a new session" row sits one past the matches, so the selection
  // range is [0, matches.length].
  const maxSel = matches.length;
  const selected = Math.min(sel, maxSel);

  /** Open row `index`: beside the panes, or (switching) in the focused one. */
  const choose = (index: number, beside = pairing) => {
    if (index === maxSel) {
      (beside ? createBeside(workspaceId) : createTerminal(workspaceId)).catch(console.error);
      onClose();
      return;
    }
    const row = matches[index];
    if (!row) return;
    if (beside) openBeside(workspaceId, row.t.id);
    else setActive(workspaceId, row.t.id);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(maxSel, s + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter" && e.altKey) {
      // ⌥⏎ before plain ⏎: open beside, not switch.
      e.preventDefault();
      choose(selected, true);
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(selected);
    } else if (e.key === "Backspace" && query === "") {
      // Only with an empty query — otherwise Backspace is still editing text.
      const row = matches[selected];
      if (!row || deleting.current.has(row.t.id)) return;
      e.preventDefault();
      deleting.current.add(row.t.id);
      void deleteTerminal(workspaceId, row.t.id).finally(() => {
        deleting.current.delete(row.t.id);
      });
      setSel(0);
    }
  };

  return (
    <ModalShell
      onClose={onClose}
      align="top"
      topOffset="pt-[16vh]"
      ariaLabel={pairing ? "Open a session beside" : "Switch session"}
    >
      <div className="w-[470px] max-w-[92vw] overflow-hidden rounded-xl border border-octo-hairline bg-octo-panel">
        <div className="flex items-center gap-3 border-b border-octo-hairline px-4 py-3">
          <span className="font-mono text-[10px] tracking-[0.1em] text-octo-brass">
            {pairing ? "⌘D" : "⌘⌥K"}
          </span>
          <input
            autoFocus
            data-testid="session-switcher-input"
            data-tour={pairing ? tourId("run-pair-input") : undefined}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSel(0);
            }}
            onKeyDown={onKeyDown}
            placeholder={pairing ? "Which session sits beside this one?" : "Find a session…"}
            aria-label={pairing ? "Which session sits beside this one?" : "Find a session"}
            className="flex-1 bg-transparent font-serif text-[14px] text-octo-ivory outline-none placeholder:font-serif placeholder:text-octo-mute"
          />
        </div>

        {replaces && (
          <div
            data-testid="session-switcher-replaces"
            className="octo-fade-in border-b border-octo-hairline px-4 py-2 font-mono text-[10px] text-octo-mute"
          >
            Replaces the session in the focused pane
          </div>
        )}

        <div role="listbox" aria-label="Open sessions" className="max-h-[52vh] overflow-y-auto py-1">
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
                role="option"
                data-testid={`session-switcher-row-${t.id}`}
                data-tour={pairing && i === 0 ? tourId("run-pair-pick") : undefined}
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
            role="option"
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
            <span className="font-serif text-[13px] text-octo-brass">
              {pairing ? "Open a new session beside" : "Open a new session"}
            </span>
          </button>
        </div>

        {/* The app's canonical key-hint voice: mono caps, `ESC · CLOSE`. */}
        <div className="flex gap-4 border-t border-octo-hairline px-4 py-2 font-mono text-[9px] uppercase tracking-[0.18em] text-octo-mute">
          <span>↑↓ · Move</span>
          {pairing ? (
            <span>⏎ · {replaces ? "Replace" : "Beside"}</span>
          ) : (
            <>
              <span>⏎ · Switch</span>
              <span>⌥⏎ · Beside</span>
            </>
          )}
          <span>⌫ · Close</span>
          <span>Esc · Dismiss</span>
        </div>
      </div>
    </ModalShell>
  );
}
