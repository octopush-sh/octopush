import { useEffect, useRef, useState } from "react";
import { ipc } from "../lib/ipc";
import type { SessionUsage } from "../lib/types";

/**
 * What the Claude Code session in one Run terminal has used
 * (`get_session_usage`), for the Run Companion's Context section. Null for
 * no terminal, and whenever the backend can't say the figures are certainly
 * this terminal's (no session known for it, nothing metered yet, or another
 * session may have taken its place).
 *
 * Re-read on the edges that can change it, never on a timer: the terminal
 * changing (the Companion follows the focused pane), a transcript ingest
 * pass moving the ledger (`octo://spend-ingested`), and a Claude Code turn
 * ending in any Run terminal (`pty://settled`): that is when a session's
 * hooks say which terminal it runs in, which names this terminal's session
 * or clears a doubt about it, and when its last prompt is final.
 *
 * A terminal's last answer is kept, so returning to it shows that answer
 * at once and the fresh one replaces it in place; one terminal's figures
 * are never shown for another. A failed read leaves what was there.
 */
export function useSessionUsage(terminalId: string | null): SessionUsage | null {
  const [state, setState] = useState<{ id: string | null; usage: SessionUsage | null }>({ id: null, usage: null });
  const [tick, setTick] = useState(0);
  const cache = useRef(new Map<string, SessionUsage | null>());
  const seq = useRef(0);

  useEffect(() => {
    let disposed = false;
    const unlisten: Array<() => void> = [];
    const keep = (p: Promise<() => void>) =>
      void p
        .then((u) => {
          if (disposed) u();
          else unlisten.push(u);
        })
        .catch(() => {});
    keep(ipc.onSpendIngested(() => setTick((t) => t + 1)));
    keep(ipc.onPtySettled(() => setTick((t) => t + 1)));
    return () => {
      disposed = true;
      unlisten.forEach((u) => u());
    };
  }, []);

  useEffect(() => {
    const token = ++seq.current;
    if (!terminalId) {
      setState({ id: null, usage: null });
      return;
    }
    setState((prev) =>
      prev.id === terminalId ? prev : { id: terminalId, usage: cache.current.get(terminalId) ?? null },
    );
    void ipc
      .getSessionUsage(terminalId)
      .then((usage) => {
        cache.current.set(terminalId, usage);
        if (seq.current === token) setState({ id: terminalId, usage });
      })
      .catch(() => {
        /* the section keeps what it had */
      });
  }, [terminalId, tick]);

  return state.id === terminalId ? state.usage : null;
}
