import { useEffect, useState } from "react";
import { MessageSquare, X } from "lucide-react";
import { commentLocation, isOutdated, quoteCutNote, type ReviewComment } from "../../lib/reviewComments";
import { commentTarget, sendReviewComments } from "../../lib/sendReviewComments";
import { selectComments, useReviewComments } from "../../stores/reviewCommentsStore";
import { useRunsStore } from "../../stores/runsStore";
import { useChatStore } from "../../stores/chatStore";
import { Reveal } from "../primitives/Reveal";

const QUOTE_SHOWN = 3;

/** The Review Companion's tray of "Ask for a change" comments (#956): each
 *  comment's place, the lines it quotes and its note, and one action that
 *  sends them all to the agent. Unfolds on the grid-rows Reveal while there
 *  is a comment; the last list stays mounted while it folds away. */
export function CommentTray({
  workspaceId,
  workspacePath,
  onJump,
}: {
  workspaceId: string;
  workspacePath: string;
  onJump?: (file: string, line: number | null) => void;
}) {
  const comments = useReviewComments(selectComments(workspaceId));
  const live = useReviewComments((s) => s.liveByWs[workspaceId] ?? null);
  const latest = useRunsStore((s) => s.runsByWs[workspaceId]?.[0] ?? null);
  const latestDetail = useRunsStore((s) => (latest ? s.detailByRun[latest.id] : undefined));
  const talkBusy = useChatStore((s) => s.streamingByWs[workspaceId] ?? false);
  const [shown, setShown] = useState(comments);
  useEffect(() => {
    if (comments.length > 0) setShown(comments);
  }, [comments]);
  const has = comments.length > 0;

  // Where the comments go depends on the latest Direct run: read it once the
  // tray has something to send.
  useEffect(() => {
    if (has) void useRunsStore.getState().loadRuns(workspaceId, { background: true }).catch(() => {});
  }, [has, workspaceId]);
  useEffect(() => {
    if (has && latest && !latestDetail) void useRunsStore.getState().refreshDetail(latest.id).catch(() => {});
  }, [has, latest, latestDetail]);

  const target = commentTarget(workspaceId);
  const blocked = target.kind === "talk" && talkBusy;
  const view = has ? comments : shown;
  const n = view.length;

  return (
    <Reveal open={has}>
      <section data-tour="review-companion-comments" className="border-b border-octo-hairline">
        <div className="flex h-9 items-center px-4">
          <h3 className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.3em] text-octo-brass">
            <MessageSquare size={11} aria-hidden />
            For the agent · <span className="octo-tabular">{n}</span>
          </h3>
        </div>
        <div className="px-4 pb-3">
          <ul aria-label="Comments for the agent" className="space-y-2">
            {view.map((c) => (
              <TrayComment key={c.id} c={c} outdated={isOutdated(c, live)} onJump={onJump} workspaceId={workspaceId} />
            ))}
          </ul>
          <div className="mt-2.5 flex items-center gap-2">
            <button
              type="button"
              data-tour="review-companion-send-comments"
              disabled={!has || blocked}
              onClick={() => void sendReviewComments(workspaceId, workspacePath)}
              title={blocked ? "Talk is still answering. Send when it finishes." : undefined}
              className="rounded-md border border-[var(--brass-dim)] px-2.5 py-1 font-serif text-[12px] text-octo-brass transition-colors duration-[var(--dur-quick)] hover:bg-[var(--brass-ghost)] disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
            >
              Send to the agent
            </button>
            <span className="min-w-0 truncate font-mono text-[10px] text-octo-mute">
              {target.kind === "gate" ? `as send-back to ${target.role}` : "in Talk"}
            </span>
          </div>
        </div>
      </section>
    </Reveal>
  );
}

function TrayComment({
  c,
  outdated,
  workspaceId,
  onJump,
}: {
  c: ReviewComment;
  outdated: boolean;
  workspaceId: string;
  onJump?: (file: string, line: number | null) => void;
}) {
  const where = commentLocation(c);
  return (
    <li className="octo-rise-in border-l-2 border-[var(--brass-rule-dim)] pl-2">
      <div className="flex min-w-0 items-center gap-1.5 font-mono text-[10px]">
        <button
          type="button"
          onClick={() => onJump?.(c.filePath, c.removed ? null : c.startLine)}
          title={`Jump to ${where}`}
          className="min-w-0 truncate text-left text-octo-sage transition-colors hover:text-octo-brass focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
        >
          {where}
        </button>
        {outdated && (
          <span
            title="This hunk changed or left the diff since you commented. The comment still goes with its quoted lines."
            className="octo-pop-in shrink-0 rounded border border-octo-hairline px-1 text-[9px] uppercase tracking-[0.12em] text-octo-mute"
          >
            outdated
          </span>
        )}
        <button
          type="button"
          onClick={() => useReviewComments.getState().remove(workspaceId, c.id)}
          aria-label="Remove comment"
          title="Remove comment"
          className="ml-auto shrink-0 text-octo-mute transition-colors hover:text-octo-rouge focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
        >
          <X size={11} />
        </button>
      </div>
      <pre className="mt-0.5 overflow-hidden font-mono text-[10px] leading-[1.5] text-octo-mute">
        {c.quote.slice(0, QUOTE_SHOWN).map((l, i) => (
          <div key={i} className="truncate">{l}</div>
        ))}
        {c.quote.length > QUOTE_SHOWN && !c.quoteCut && <div>…</div>}
        {!!c.quoteCut && <div data-quote-cut title="The message quotes the first lines only and says how many it left out.">{quoteCutNote(c.quoteCut)}</div>}
      </pre>
      <p className="mt-0.5 whitespace-pre-wrap break-words text-[11.5px] leading-[1.5] text-octo-sage">{c.note}</p>
    </li>
  );
}
