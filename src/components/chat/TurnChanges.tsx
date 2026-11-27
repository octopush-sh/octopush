import { useEffect, useState } from "react";
import { FileDiff, History } from "lucide-react";
import { ipc } from "../../lib/ipc";
import { navigate } from "../../lib/tour/surfaces";
import { turnChangesNames, turnChangesSummary, turnLabel, type TurnChange } from "../../lib/turnChanges";
import { useReviewSource } from "../../stores/reviewSourceStore";
import { MidTruncate } from "../primitives/MidTruncate";

/**
 * The ledger row under a finished Talk turn that changed files (#1152):
 * "4 files changed · +38 −6", the file names, then "Review these changes"
 * (Review's This turn scope, the diff between the turn's two checkpoints)
 * and Rewind files to here. The checkpoints snapshot the whole tree, so
 * shell and sub-agent edits count. A turn that changed nothing, or that
 * lacks either checkpoint, shows no row.
 */
export function TurnChanges({
  workspaceId,
  threadId,
  messageId,
  ask,
  onRewind,
  disabled,
}: {
  workspaceId: string;
  threadId: string;
  /** The turn's ask: its checkpoints are named after it. */
  messageId: number;
  ask: string;
  onRewind?: (messageId: number) => void;
  disabled?: boolean;
}) {
  const [changes, setChanges] = useState<TurnChange[]>([]);
  useEffect(() => {
    if (typeof ipc.talkTurnChanges !== "function") return;
    let live = true;
    ipc
      .talkTurnChanges(threadId, messageId)
      .then((c) => {
        if (live) setChanges(Array.isArray(c) ? c : []);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // A turn's two checkpoints never move once it has ended: one read.
  }, [threadId, messageId]);

  if (changes.length === 0) return null;
  const names = turnChangesNames(changes);

  const review = () => {
    useReviewSource.getState().openTurn(workspaceId, { threadId, messageId, label: turnLabel(ask) });
    navigate({ kind: "mode", mode: "review" });
  };

  return (
    <div
      data-tour="talk-turn-changes"
      data-testid="talk-turn-changes"
      className="octo-rise-in -mt-3 flex min-w-0 items-center gap-2 rounded-md border border-octo-hairline bg-octo-panel px-3 py-1.5"
    >
      <FileDiff size={13} className="shrink-0 text-octo-mute" aria-hidden />
      <span className="shrink-0 whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.15em] text-octo-sage octo-tabular">
        {turnChangesSummary(changes)}
      </span>
      <span title={changes.map((c) => c.path).join("\n")} className="flex min-w-0 flex-1 font-mono text-[11px] text-octo-mute">
        <MidTruncate text={names} tail={Math.min(24, names.length)} />
      </span>
      <button
        type="button"
        onClick={review}
        data-tour="talk-turn-changes-review"
        title="Open this turn's diff in Review"
        className="shrink-0 whitespace-nowrap rounded font-serif text-[13px] text-octo-brass transition-colors hover:text-octo-brass-hi focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
      >
        Review these changes
      </button>
      {onRewind && (
        <button
          type="button"
          onClick={() => onRewind(messageId)}
          disabled={disabled}
          aria-label="Rewind files to here"
          title="Rewind files to here"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded p-1 text-octo-mute transition hover:bg-[var(--brass-ghost)] hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass disabled:cursor-not-allowed disabled:opacity-30"
        >
          <History size={12} aria-hidden />
        </button>
      )}
    </div>
  );
}
