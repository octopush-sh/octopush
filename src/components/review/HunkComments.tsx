import { MessageSquare, X } from "lucide-react";
import { commentLocation, type ReviewComment } from "../../lib/reviewComments";
import { CommentComposer } from "../comments/CommentComposer";
import { tourId } from "../../lib/tour/ids";

/** The inline "Ask for a change" field under a hunk (#956), on the shared
 *  composer. ⌘⏎ adds the comment to the Companion's tray; Escape drops the
 *  draft; ⌥↑ ⌥↓ move the picked line and ⌥⇧↑ ⌥⇧↓ extend the range, the
 *  keyboard's way to what a line number's click and shift-click do. The note
 *  is the caller's state, so it outlives this field: picking another line,
 *  folding the file or a refetch that moves the hunk remounts the field with
 *  what was typed. `stale` = the hunk changed since the place was picked. */
export function HunkCommentComposer({
  location,
  note,
  stale = false,
  onNoteChange,
  onSubmit,
  onCancel,
  onMovePick,
}: {
  location: string;
  note: string;
  stale?: boolean;
  onNoteChange: (note: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onMovePick?: (dir: -1 | 1, extend: boolean) => void;
}) {
  return (
    <CommentComposer
      tour={{ root: tourId("review-comment-composer"), submit: tourId("review-comment-add") }}
      className="mt-1 border-l-2 border-[var(--brass-dim)]"
      context={
        <div className="flex min-w-0 items-baseline gap-2 font-mono text-[10px] text-octo-mute">
          <span className="min-w-0 flex-1">
            {location}
            {stale && <span data-comment-stale> · this hunk changed; the comment keeps the lines it quoted</span>}
          </span>
          {onMovePick && (
            <span data-tour="review-comment-pick-keys" className="shrink-0" title="Move the picked line with ⌥↑ ⌥↓; add ⇧ to extend the range">
              ⌥↑ ⌥↓ lines · ⇧ extends
            </span>
          )}
        </div>
      }
      note={note}
      onNoteChange={onNoteChange}
      onSubmit={onSubmit}
      onCancel={onCancel}
      onMovePlace={onMovePick}
      label="What should change"
      submitLabel="Ask for this change"
      submitTitle="Add to the comments for the agent (⌘⏎)"
    />
  );
}

/** The comments already left on one hunk, under its lines. */
export function HunkCommentList({ comments, onRemove }: { comments: ReviewComment[]; onRemove: (id: string) => void }) {
  if (comments.length === 0) return null;
  return (
    <ul aria-label="Comments on this hunk" className="mt-1 space-y-0.5">
      {comments.map((c) => (
        <li key={c.id} className="octo-rise-in group flex items-start gap-1.5 border-l-2 border-[var(--brass-rule-dim)] px-3 py-1 text-[11.5px] text-octo-sage">
          <MessageSquare size={11} aria-hidden className="mt-[3px] shrink-0 text-octo-mute" />
          <span className="shrink-0 font-mono text-[10px] leading-[1.7] text-octo-mute">{commentLocation(c).split(":").pop()}</span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{c.note}</span>
          <button
            type="button"
            onClick={() => onRemove(c.id)}
            aria-label="Remove comment"
            title="Remove comment"
            className="shrink-0 text-octo-mute transition-colors hover:text-octo-rouge focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-octo-brass"
          >
            <X size={11} />
          </button>
        </li>
      ))}
    </ul>
  );
}
