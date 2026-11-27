/**
 * useTurnDiff — the diff Review's "This turn" scope shows (#1152): one Talk
 * turn's changes, between its two checkpoints. Those refs never move, so it
 * is read once per turn and whitespace mode, not on the 3 s git poll.
 * `null` until the answer for the turn on screen has landed; a failed read
 * is `{ error }`, never an empty diff, so the view can't claim the turn
 * changed nothing when it only couldn't tell.
 */
import { useEffect, useState } from "react";
import { ipc } from "../lib/ipc";
import type { TurnScope } from "../lib/turnChanges";

export type TurnDiff = { diff: string } | { error: string };

export function useTurnDiff(turn: TurnScope | null, ignoreWhitespace: boolean): TurnDiff | null {
  const key = turn ? `${turn.threadId}:${turn.messageId}:${ignoreWhitespace}` : null;
  const [answer, setAnswer] = useState<{ key: string; value: TurnDiff } | null>(null);
  useEffect(() => {
    if (!turn || !key) return;
    let live = true;
    ipc
      .talkTurnDiff(turn.threadId, turn.messageId, ignoreWhitespace)
      .then(
        (diff): TurnDiff => ({ diff }),
        (e): TurnDiff => ({ error: String(e) }),
      )
      .then((value) => {
        if (live) setAnswer({ key, value });
      });
    return () => {
      live = false;
    };
    // `key` carries the turn and the whitespace mode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return answer && answer.key === key ? answer.value : null;
}
