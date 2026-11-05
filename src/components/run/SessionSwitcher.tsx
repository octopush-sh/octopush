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
  /** Pairing for Talk's seat: lists every session but the seat's own, and a
   *  pick goes in the seat. Run's layout and focus are never touched. */
  talk?: boolean;
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
export function SessionSwitcher({ workspaceId, onClose, pairing: pairingProp = false, talk = false }: Props) {
  const pairing = pairingProp || talk;
  const allTerminals = useTerminalsStore((s) => s.getTerminals(workspaceId));
  const runActiveId = useTerminalsStore((s) => s.getActiveId(workspaceId));
  const seatId = useTerminalLayoutStore((s) => s.talkByWs[workspaceId]?.terminalId ?? null);
  const seatTalkSession = useTerminalLayoutStore((s) => s.seatTalkSession);
  // "here" is the session in the place the pick goes.
  const activeId = talk ? seatId : runActiveId;
  const setActive = useTerminalsStore((s) => s.setActive);
  const createTerminal = useTerminalsStore((s) => s.createTerminal);
  const createBeside = useTerminalsStore((s) => s.createBeside);
  const createInTalkSeat = useTerminalsStore((s) => s.createInTalkSeat);
  const openBeside = useTerminalsStore((s) => s.openBeside);
  const deleteTerminal = useTerminalsStore((s) => s.deleteTerminal);
  const layout = useTerminalLayoutStore((s) => s.runByWs[workspaceId]);
  // With no room left, a beside pick (⏎ when pairing, ⌥⏎ when switching)
  // replaces the focused pane's session.
  const replaces = !talk && !!layout && besideReplaces(layout, RUN_PANES);
  const full = replaces;
  // A new session never lands in the focused pane from here (spec): when Run
  // is full, pairing mode drops the "Open a new session beside" row.
  const showNew = !(pairing && full);
  // Talk's seat may hold a session Run also shows (only one mode is visible).
  const terminals = useMemo(
    () =>
      talk
        ? allTerminals.filter((t) => t.id !== seatId)
        : pairing
          ? allTerminals.filter((t) => !(layout?.slots ?? [runActiveId]).includes(t.id))
          : allTerminals,
    [allTerminals, pairing, talk, seatId, layout, runActiveId],
  );

  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  // Ids whose delete is in flight. `deleteTerminal` awaits IPC before the list
  // updates, so two fast ⌫ presses would fire the same delete twice and the
  // loser would raise a "couldn't close terminal" toast for a session that
  // closed perfectly well.
  const deleting = useRef(new Set<string>());
  const inputRef = useRef<HTMLInputElement>(null);

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
  const maxSel = showNew ? matches.length : matches.length - 1;
  const selected = Math.max(0, Math.min(sel, maxSel));

  /** Open row `index`: beside the panes, or (switching) in the focused one. */
  const choose = (index: number, beside = pairing) => {
    if (talk) {
      const row = matches[index];
      if (row) seatTalkSession(workspaceId, row.t.id);
      else if (index === matches.length) createInTalkSeat(workspaceId).catch(console.error);
      else return;
      onClose();
      return;
    }
    if (showNew && index === matches.length) {
      (beside && !full ? createBeside(workspaceId) : createTerminal(workspaceId)).catch(console.error);
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
      initialFocus={inputRef}
    >
      <div className="w-[470px] max-w-[92vw] overflow-hidden rounded-xl border border-octo-hairline bg-octo-panel">
        <div className="flex items-center gap-3 border-b border-octo-hairline px-4 py-3">
          <span className="font-mono text-[10px] tracking-[0.1em] text-octo-brass">
            {pairing ? "⌘D" : "⌘⌥K"}
          </span>
          <input
            ref={inputRef}
            autoFocus
            data-testid="session-switcher-input"
            data-tour={pairing && !talk ? tourId("run-pair-input") : undefined}
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

        {pairing && replaces && (
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
                data-tour={pairing && !talk && i === 0 ? tourId("run-pair-pick") : undefined}
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

          {showNew && (
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
          )}
        </div>

        {/* The app's canonical key-hint voice: mono caps, `ESC · CLOSE`. */}
        <div className="flex gap-4 border-t border-octo-hairline px-4 py-2 font-mono text-[9px] uppercase tracking-[0.18em] text-octo-mute">
          <span>↑↓ · Move</span>
          {pairing ? (
            <span>⏎ · {replaces ? "Replace" : "Beside"}</span>
          ) : (
            <>
              <span>⏎ · Switch</span>
              <span data-testid="session-switcher-alt-hint">⌥⏎ · {replaces ? "Replace" : "Beside"}</span>
            </>
          )}
          <span>⌫ · Close</span>
          <span>Esc · Dismiss</span>
        </div>
      </div>
    </ModalShell>
  );
}
