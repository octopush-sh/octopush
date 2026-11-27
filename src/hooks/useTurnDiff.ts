/**
 * useTurnDiff — the diff Review's "This turn" scope shows (#1152): one Talk
 * turn's changes, between its two checkpoints. Those refs never move, so it
 * is read once per turn and whitespace mode, not on the 3 s git poll.
 * `null` until the answer for the turn on screen has landed.
 */
import { useEffect, useState } from "react";
import { ipc } from "../lib/ipc";
import type { TurnScope } from "../lib/turnChanges";

export function useTurnDiff(turn: TurnScope | null, ignoreWhitespace: boolean): string | null {
  const key = turn ? `${turn.threadId}:${turn.messageId}:${ignoreWhitespace}` : null;
  const [answer, setAnswer] = useState<{ key: string; diff: string } | null>(null);
  useEffect(() => {
    if (!turn || !key) return;
    let live = true;
    ipc
      .talkTurnDiff(turn.threadId, turn.messageId, ignoreWhitespace)
      .catch(() => "")
      .then((diff) => {
        if (live) setAnswer({ key, diff });
      });
    return () => {
      live = false;
    };
    // `key` carries the turn and the whitespace mode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return answer && answer.key === key ? answer.diff : null;
}
