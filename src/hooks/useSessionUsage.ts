import { useEffect, useRef, useState } from "react";
import { ipc } from "../lib/ipc";
import type { SessionUsage } from "../lib/types";

/**
 * What the Claude Code session in one Run terminal has used
 * (`get_session_usage`), for the Run Companion's Context section. Null for
 * no terminal, and whenever the backend has no figures it can call this
 * terminal's current session's (it runs none, nothing is metered yet, or
 * another session may have taken its place).
 *
 * Re-read on the edges that can change it, never on a timer: the terminal
 * changing (the Companion follows the focused pane); Claude Code's session
 * hooks (`pty://claude-session`: a session started, was cleared or resumed,
 * or ended, in any Run terminal); a turn ending (`pty://settled`: its last
 * prompt is final, and for a session whose hooks predate the session events
 * this is when it says which terminal it runs in); and a transcript ingest
 * pass moving the ledger (`octo://spend-ingested`).
 *
 * Only the answer to the latest read for the current terminal is ever
 * returned. A terminal change, an empty answer and a failed read all clear
 * it: figures that can't be confirmed are not kept on screen.
 */
export function useSessionUsage(terminalId: string | null): SessionUsage | null {
  const [state, setState] = useState<{ id: string | null; usage: SessionUsage | null }>({ id: null, usage: null });
  const [tick, setTick] = useState(0);
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
    const again = () => setTick((t) => t + 1);
    keep(ipc.onClaudeSessionChanged(again));
    keep(ipc.onPtySettled(again));
    keep(ipc.onSpendIngested(again));
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
    // Another terminal's answer is dropped at once; this terminal's own
    // stays until the fresh one replaces it or says there is none.
    setState((prev) => (prev.id === terminalId ? prev : { id: terminalId, usage: null }));
    const settle = (usage: SessionUsage | null) => {
      if (seq.current === token) setState({ id: terminalId, usage });
    };
    void ipc.getSessionUsage(terminalId).then(settle, () => settle(null));
  }, [terminalId, tick]);

  return state.id === terminalId ? state.usage : null;
}
