import { useRef, useState } from "react";
import { useTerminalsStore, type TerminalState } from "../../stores/terminalsStore";
import { ModalShell } from "../ModalShell";

/** True when closing `session` asks first: something is running in it. */
export function closeAsksFirst(session: Pick<TerminalState, "busy">): boolean {
  return session.busy;
}

/**
 * Closing a Run session, guarded. A closed session can't be brought back —
 * its shell is killed and its scrollback deleted — so one that is busy (an
 * agent or a command running in it) asks first; an idle one, a prompt and
 * nothing else, closes at once as it always has.
 *
 * Returns the guarded trigger and the confirm dialog to render beside it: a
 * `ModalShell` like the Abort confirm's (RunControlBar's `useAbortConfirm`),
 * with the safe answer focused and Escape keeping the session.
 *
 * `close` replaces the plain `deleteTerminal` for a caller with bookkeeping
 * of its own around the delete (the ⌘⌥K switcher's double-press guard).
 */
export function useCloseSession(
  workspaceId: string,
  close?: (id: string) => void,
): [(session: TerminalState) => void, React.ReactNode] {
  const deleteTerminal = useTerminalsStore((s) => s.deleteTerminal);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  // Read live, so the dialog names what runs now and goes if the session does.
  const pending = useTerminalsStore((s) =>
    pendingId === null ? null : (s.getTerminals(workspaceId).find((t) => t.id === pendingId) ?? null),
  );

  const run = (id: string) => {
    if (close) close(id);
    else void deleteTerminal(workspaceId, id);
  };

  const request = (session: TerminalState) => {
    if (closeAsksFirst(session)) setPendingId(session.id);
    else run(session.id);
  };

  const keep = () => setPendingId(null);

  const dialog = pending ? (
    <ModalShell
      onClose={keep}
      closeOnBackdrop={false}
      ariaLabel="Confirm closing the session"
      // The safe answer takes the focus, and takes it again if the shell's
      // focus hand-off runs twice (React's development double-mount).
      initialFocus={keepRef}
      panelClassName="w-[420px] max-w-[92vw] rounded-lg border border-octo-hairline bg-octo-panel p-6"
    >
      <p className="font-serif text-[17px] text-octo-ivory">Close this session while it works?</p>
      <p className="mt-2 text-sm text-octo-sage">
        {pending.command ? (
          <span className="break-all font-mono text-[12px] text-octo-ivory">{pending.command}</span>
        ) : (
          "A command"
        )}{" "}
        is still running in <span className="text-octo-ivory">{pending.label}</span>. Closing ends it now, and the
        session can&apos;t be reopened: its scrollback goes with it.
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button
          ref={keepRef}
          type="button"
          autoFocus
          onClick={keep}
          className="rounded-md border border-octo-hairline px-3 py-1.5 font-mono text-xs text-octo-mute transition-colors duration-[180ms] hover:text-octo-ivory focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
        >
          Keep the session
        </button>
        <button
          type="button"
          onClick={() => {
            const id = pending.id;
            setPendingId(null);
            run(id);
          }}
          className="rounded-md border border-[color:var(--rouge-border)] px-3 py-1.5 font-serif text-sm text-octo-rouge transition-colors duration-[180ms] hover:bg-[var(--rouge-ghost)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-rouge"
        >
          Close the session
        </button>
      </div>
    </ModalShell>
  ) : null;

  return [request, dialog];
}
